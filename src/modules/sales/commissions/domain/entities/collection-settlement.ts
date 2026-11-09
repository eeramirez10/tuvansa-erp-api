import type { CollectionCustomerStatus } from './collection-customer-bonus.js';

export type SettlementPlan = 'salary' | 'fixed' | 'unconfirmed';
export type SettlementAgentSettings = { code: string; plan?: SettlementPlan | undefined; fixedRate?: number | undefined;
  costBasis?: 'proportional' | 'total' | undefined; costOverride?: number | null | undefined; freight?: number | undefined; gratuities?: number | undefined; includeLm?: boolean | undefined };
export type SettlementSettings = { bonusMode: 'additional' | 'exclusive' | 'unconfirmed'; agents: SettlementAgentSettings[] };
type Invoice = { agentCode: string; agentName: string; branch: string; displayPaymentAmount: number | null;
  paymentAmount: number | null;
  cost: number | null; realCost: number | null; freightAmount: number; customerStatus: CollectionCustomerStatus;
  customerBonusEligible: boolean; customerBonus: number | null; customerBonusBase: number | null; lmAmount: number | null };

// Lower bounds and commission percentages of A48:D54 in the supplied workbook.
export const collectionSalaryTiers = [
  { from: 0, rate: 0 }, { from: 270001, rate: 4 }, { from: 500001, rate: 5 },
  { from: 750001, rate: 7 }, { from: 1142502, rate: 8 }, { from: 1785003, rate: 9 }, { from: 4085004, rate: 12 },
] as const;
const cents = (n: number) => Math.round(n * 100);
const amount = (n: number | null) => n === null ? null : n / 100;
const sum = (rows: Invoice[], key: 'paymentAmount' | 'cost' | 'realCost' | 'customerBonus' | 'customerBonusBase' | 'lmAmount') =>
  rows.some(r => r[key] === null) ? null : rows.reduce((total, r) => total + cents(r[key]!), 0);
function percentage(value: number, rate: number) {
  const raw = BigInt(value) * BigInt(Math.round(rate * 100)), sign = raw < 0n ? -1n : 1n;
  return Number(((raw < 0n ? -raw : raw) + 5000n) / 10000n * sign);
}
function defaults(code: string, referenceApplies: boolean): SettlementAgentSettings {
  // Only agent codes whose profile is identifiable in the provided Mexico file.
  // Unknown teams/branches require a selection; do not invent their payout rules.
  if (!referenceApplies) return { code, plan: 'unconfirmed', fixedRate: 0 };
  if (code === '1292') return { code, plan: 'fixed', fixedRate: 6 };
  if (code === '1235') return { code, plan: 'fixed', fixedRate: 0 };
  return { code, plan: ['1216','1223','1231','1279','1284'].includes(code) ? 'salary' : 'unconfirmed', fixedRate: 0 };
}
export function buildCollectionSettlement(invoices: Invoice[], period: { from: string; to: string }, settings: SettlementSettings = { bonusMode: 'unconfirmed', agents: [] }) {
  const agents = [...new Set(invoices.map(r => r.agentCode))].map(code => {
    const docs = invoices.filter(r => r.agentCode === code), override = settings.agents.find(a => a.code === code);
    const original = defaults(code, docs.every(r => r.branch === '01') && period.from === '2026-09-01' && period.to === '2026-09-30');
    const config = { code, plan: override?.plan ?? original.plan ?? 'unconfirmed', fixedRate: override?.fixedRate ?? original.fixedRate ?? 0,
      costBasis: override?.costBasis ?? 'proportional', costOverride: override?.costOverride ?? null,
      freight: override?.freight ?? docs.reduce((total, r) => total + cents(r.freightAmount), 0) / 100, gratuities: override?.gratuities ?? 0, includeLm: override?.includeLm ?? true };
    const pending: string[] = [];
    if (settings.bonusMode === 'unconfirmed') pending.push('Elige si el 1% se suma o sustituye a la comisión normal.');
    if (config.plan === 'unconfirmed') pending.push('Confirma el plan del agente; no se infiere para equipos o sucursales sin regla documentada.');
    const unknown = docs.some(r => r.customerStatus === 'Sin clasificar');
    const normalDocs = settings.bonusMode === 'exclusive' ? docs.filter(r => !r.customerBonusEligible) : docs;
    const signedPayment = settings.bonusMode === 'exclusive' && unknown ? null : sum(normalDocs, 'paymentAmount');
    // The source workbook uses -PA, not ABS(PA). Opposite-signed movements must
    // offset collected cash in financial calculations even if display is positive.
    const payment = signedPayment === null ? null : signedPayment === 0 ? 0 : -signedPayment;
    const sourceCost = settings.bonusMode === 'exclusive' && unknown ? null : sum(normalDocs, config.costBasis === 'total' ? 'cost' : 'realCost');
    const cost = config.costOverride === null ? sourceCost : cents(config.costOverride);
    const gross = payment === null || cost === null ? null : payment - cost;
    const net = gross === null ? null : gross - cents(config.freight) - cents(config.gratuities);
    const grossMargin = !payment || gross === null ? null : gross / payment * 100;
    const netMargin = !payment || net === null ? null : net / payment * 100;
    let rate: number | null = null;
    if (config.plan === 'fixed') rate = config.fixedRate ?? 0;
    else if (config.plan === 'salary') {
      if (period.from.slice(0,7) !== period.to.slice(0,7)) pending.push('El tabulador es mensual: selecciona un solo mes o una tasa fija.');
      else if (payment !== null && net !== null) rate = payment > 0 && net * 100 > payment * 16 ? [...collectionSalaryTiers].reverse().find(t => payment >= t.from * 100)!.rate : 0;
    }
    const regular = settings.bonusMode === 'unconfirmed' || net === null || rate === null ? null : percentage(net, rate);
    const bonusBase = sum(docs, 'customerBonusBase'), bonus = bonusBase === null ? null : percentage(bonusBase, 1), lm = config.includeLm ? sum(docs, 'lmAmount') : 0;
    if (payment === null || cost === null) pending.push('Hay importes de cobranza o costo no disponibles.');
    if (bonus === null) pending.push('Hay pagos o marcas de cliente pendientes.');
    if (lm === null) pending.push('El bono de lento movimiento no está disponible.');
    const total = regular === null || bonus === null || lm === null ? null : regular + bonus + lm;
    return { code, name: docs[0]!.agentName, config, invoices: docs.length, normalInvoices: normalDocs.length,
      payment: amount(payment), sourceCost: amount(sourceCost), cost: amount(cost), grossProfit: amount(gross), grossMargin,
      freight: config.freight, gratuities: config.gratuities, netProfit: amount(net), netMargin, rate,
      regularCommission: amount(regular), customerBonusBase: amount(bonusBase), customerBonus: amount(bonus), lmBonus: amount(lm),
      totalCommission: amount(total), ready: pending.length === 0 && total !== null, pending };
  });
  const total = (key: 'payment' | 'cost' | 'grossProfit' | 'freight' | 'gratuities' | 'netProfit' | 'regularCommission' | 'customerBonusBase' | 'customerBonus' | 'lmBonus' | 'totalCommission') =>
    agents.some(a => a[key] === null) ? null : agents.reduce((sum, a) => sum + cents(a[key]!), 0) / 100;
  return { bonusMode: settings.bonusMode, minimumNetMargin: 16, salaryTiers: collectionSalaryTiers, agents,
    ready: agents.every(a => a.ready), totals: { payment: total('payment'), cost: total('cost'), grossProfit: total('grossProfit'), freight: total('freight'),
      gratuities: total('gratuities'), netProfit: total('netProfit'), regularCommission: total('regularCommission'), customerBonusBase: total('customerBonusBase'),
      customerBonus: total('customerBonus'), lmBonus: total('lmBonus'), totalCommission: total('totalCommission') } };
}
