import type {
  FinancialIncomeStatement,
  FinancialIncomeStatementRow,
  IncomeStatementAccount,
} from './income-statement.js';

type Amounts = { month: number; accumulated: number };
const zero = (): Amounts => ({ month: 0, accumulated: 0 });
const add = (...values: Amounts[]): Amounts => values.reduce((sum, value) => ({
  month: sum.month + value.month,
  accumulated: sum.accumulated + value.accumulated,
}), zero());
const negate = (value: Amounts): Amounts => ({ month: -value.month, accumulated: -value.accumulated });
const subtract = (value: Amounts, ...others: Amounts[]): Amounts => add(value, ...others.map(negate));
const money = (cents: number) => cents === 0 ? 0 : cents / 100;

// DERIVADA: regrouping requested in the spreadsheet; uses original accounting signs.
// Parents already include children. All arithmetic below uses integer cents.
export function buildFinancialIncomeStatement(
  accounts: IncomeStatementAccount[],
  options: { scopeLabel?: string; zeroProvisions?: boolean } = {},
): FinancialIncomeStatement {
  const byCode = new Map<string, Amounts>();
  for (const account of accounts) {
    if (byCode.has(account.code)) throw new Error('Duplicate accounting code in financial statement');
    byCode.set(account.code, {
      month: Math.round(account.debit * 100) - Math.round(account.credit * 100),
      accumulated: Math.round(account.balance * 100),
    });
  }
  const raw = (code: string): Amounts => byCode.get(code) ?? zero();
  const income = negate(raw('4'));
  const cost = raw('5');
  const depreciation = raw('6004');
  const amortization = raw('6005');
  const operatingExpenses = subtract(raw('6'), depreciation, amortization);
  const otherExpense = raw('7003');
  const otherIncome = raw('7004');
  const financing = subtract(raw('7'), otherExpense, otherIncome);
  const grossProfit = subtract(income, cost);
  const operatingProfit = subtract(grossProfit, operatingExpenses);
  const beforeOther = subtract(operatingProfit, depreciation, amortization, financing, otherExpense, otherIncome);
  const other = raw('8');
  const beforeTax = subtract(beforeOther, other);
  const legacy = negate(add(raw('4'), raw('5'), raw('6'), raw('7'), raw('8')));
  const rows: FinancialIncomeStatementRow[] = [];
  const row = (key: string, label: string, value: Amounts | null, kind: FinancialIncomeStatementRow['kind'] = 'detail', sourceCodes: string[] = []) => {
    rows.push({ key, label, kind, sourceCodes,
      month: value === null ? null : money(value.month),
      accumulated: value === null ? null : money(value.accumulated),
      monthPercent: value === null || income.month === 0 ? null : value.month / income.month,
      accumulatedPercent: value === null || income.accumulated === 0 ? null : value.accumulated / income.accumulated,
    });
  };
  const space = (key: string) => row('space:' + key, '', null, 'spacer');
  const residual = (key: string, label: string, total: Amounts, codes: string[]) => {
    const remainder = subtract(total, ...codes.map(raw));
    if (remainder.month !== 0 || remainder.accumulated !== 0) row(key, label, remainder, 'detail');
  };

  row('sales', 'VENTAS', negate(raw('4001')), 'detail', ['4001']);
  row('other-sales', 'VENTAS OTROS INGRESOS', negate(raw('4003')), 'detail', ['4003']);
  row('returns', 'DESCUENTOS Y DEVOLUCIONES S/VENTAS', negate(raw('4002')), 'detail', ['4002']);
  const otherSales = subtract(income, negate(add(raw('4001'), raw('4002'), raw('4003'))));
  if (otherSales.month !== 0 || otherSales.accumulated !== 0) row('unclassified-income', 'OTROS INGRESOS NO CLASIFICADOS', otherSales);
  row('total-sales', 'TOTAL VENTAS', income, 'total', ['4']);
  space('after-sales');
  row('total-income', 'Total de ingresos', income, 'total', ['4']);
  space('before-cost');
  row('cost-detail', 'COSTO DE VENTAS', raw('5001'), 'detail', ['5001']);
  residual('other-costs', 'OTROS COSTOS Y AJUSTES', cost, ['5001']);
  row('total-cost', 'COSTO DE VENTAS', cost, 'total', ['5']);
  space('before-gross');
  row('gross-profit', 'Utilidad Bruta', grossProfit, 'result', ['4', '5']);
  space('before-expenses');
  for (const [code, label] of [
    ['6002', 'GASTOS DE OPERACION'], ['6003', 'GASTOS DE ADMINISTRACION'],
    ['6001', 'GASTOS CENTRALIZADOS'], ['6006', 'GASTOS DE ALMACEN'], ['6007', 'GASTOS DE COMPRAS'],
  ] as const) row('expense-' + code, label, raw(code), 'detail', [code]);
  residual('unclassified-expenses', 'OTROS GASTOS DE OPERACION', operatingExpenses, ['6001', '6002', '6003', '6006', '6007']);
  row('total-expenses', 'Total gastos', operatingExpenses, 'result', ['6', '6004', '6005']);
  space('before-operating');
  row('operating-profit', 'Utilidad de operación', operatingProfit, 'result');
  space('before-depreciation');
  row('depreciation', 'DEPRECIACIONES', depreciation, 'detail', ['6004']);
  row('amortization', 'AMORTIZACIONES', amortization, 'detail', ['6005']);
  row('financing', 'RESULTADO INTEGRAL DE FINANCIAMIENTO', financing, 'detail', ['7', '7003', '7004']);
  row('other-expenses', 'OTROS GASTOS', otherExpense, 'detail', ['7003']);
  row('other-products', 'OTROS PRODUCTOS', otherIncome, 'detail', ['7004']);
  row('before-other', 'Utilidad Antes de Impuestos', beforeOther, 'result');
  space('before-other-adjustments');
  row('other', 'OTROS', other, 'detail', ['8']);
  space('before-tax');
  row('before-tax', 'Utilidad antes de Impuestos', beforeTax, 'result');
  space('before-provisions');
  // The supplied Mexico worksheet leaves provisions blank; Excel treats those blanks as zero.
  const provisions=options.zeroProvisions ? zero() : null;
  row('isr', 'ISR', provisions);
  row('ptu', 'PTU', provisions);
  row('additional-centralized', 'GASTOS CENTRALIZADOS ADICIONALES', provisions);
  row('net-profit', 'Utilidad Neta', options.zeroProvisions ? beforeTax : null, 'result');
  space('before-reconciliation');
  row('erp-result', 'RESULTADO DEL ERP (ANTES DE ISR/PTU)', legacy, 'total');
  row('reconciliation', 'DIFERENCIA CONTRA ERP', subtract(beforeTax, legacy), 'total');

  return {
    scopeLabel: options.scopeLabel ?? 'COMPAÑÍA 1 · TODOS LOS CENTROS DE COSTOS', rows,
    notices: [
      options.zeroProvisions ? 'ISR, PTU y gastos centralizados adicionales se toman en cero, como las celdas vacías del Excel; no se estiman provisiones fiscales.' : 'ISR y PTU sin cuentas asignadas: la utilidad neta queda pendiente. N/D indica un importe no disponible.',
      'Los gastos centralizados ya están incluidos en Total gastos; no se descuentan nuevamente.',
      'Porcentajes calculados sobre Total de ingresos de cada columna. Sin ingresos, el porcentaje se deja en blanco.',
    ],
    reconciliation: { month: money(legacy.month), accumulated: money(legacy.accumulated),
      differenceMonth: money(beforeTax.month - legacy.month),
      differenceAccumulated: money(beforeTax.accumulated - legacy.accumulated) },
  };
}
