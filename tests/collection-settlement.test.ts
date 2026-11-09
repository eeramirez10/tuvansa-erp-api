import { describe, expect, it } from 'vitest';
import { buildCollectionSettlement } from '../src/modules/sales/commissions/domain/entities/collection-settlement.js';
const period = { from:'2026-09-01',to:'2026-09-30' };
type Invoice = Parameters<typeof buildCollectionSettlement>[0][number];
const invoice: Invoice = { agentCode:'1231',agentName:'TEST',branch:'01',displayPaymentAmount:500000,paymentAmount:-500000,cost:400000,realCost:400000,freightAmount:0,
  customerStatus:'Recurrente',customerBonusEligible:false,customerBonus:0,customerBonusBase:0,lmAmount:0 };
const additional = { bonusMode:'additional' as const,agents:[] };
describe('Liquidación configurable del ejemplo Excel',()=>{
  it.each([[270000.99,0],[270001,4],[500000.99,4],[500001,5],[750001,7],[1142502,8],[1785003,9],[4085004,12]])('usa los límites inferiores de VLOOKUP para %s', (payment,rate)=>{
    const row=buildCollectionSettlement([{...invoice,displayPaymentAmount:payment,paymentAmount:-payment,realCost:Math.round(payment*0.7*100)/100}],period,additional).agents[0]!;
    expect(row.rate).toBe(rate);expect(row.ready).toBe(true);
  });
  it('exige margen neto estrictamente mayor a 16%, después de flete y gratificaciones',()=>{
    const settings={...additional,agents:[{code:'1231',freight:10000,gratuities:10000}]};
    expect(buildCollectionSettlement([{...invoice,realCost:400000}],period,settings).agents[0]).toMatchObject({netProfit:80000,netMargin:16,rate:0,regularCommission:0});
    expect(buildCollectionSettlement([{...invoice,realCost:399999.99}],period,settings).agents[0]).toMatchObject({netProfit:80000.01,rate:4,regularCommission:3200});
  });
  it('distingue bono adicional de sustitución de comisión normal sin duplicar pagos o costos',()=>{
    const rows:Invoice[]=[{...invoice,displayPaymentAmount:1000,paymentAmount:-1000,realCost:600,customerStatus:'Nuevo',customerBonusEligible:true,customerBonusBase:1000,customerBonus:10,lmAmount:5},
      {...invoice,displayPaymentAmount:1000,paymentAmount:-1000,realCost:800}];
    const agents=[{code:'1231',plan:'fixed' as const,fixedRate:10}];
    expect(buildCollectionSettlement(rows,period,{bonusMode:'additional',agents}).agents[0]).toMatchObject({payment:2000,cost:1400,regularCommission:60,customerBonus:10,lmBonus:5,totalCommission:75});
    expect(buildCollectionSettlement(rows,period,{bonusMode:'exclusive',agents}).agents[0]).toMatchObject({payment:1000,cost:800,normalInvoices:1,regularCommission:20,customerBonus:10,lmBonus:5,totalCommission:35});
  });
  it('calcula la comisión conocida aunque el tratamiento del bono siga pendiente y no asigna perfiles a otras sucursales',()=>{
    expect(buildCollectionSettlement([invoice],period).agents[0]).toMatchObject({netProfit:100000,rate:4,regularCommission:4000,totalCommission:4000,ready:false});
    expect(buildCollectionSettlement([{...invoice,branch:'02'}],period,additional).agents[0]).toMatchObject({rate:null,ready:false});
  });
  it('muestra utilidad neta por porcentaje para todos los agentes con tasa, incluido el ejemplo del 9%',()=>{
    const rows=buildCollectionSettlement([
      {...invoice,displayPaymentAmount:2846786.88,paymentAmount:-2846786.88,realCost:2336804.12},
      {...invoice,agentCode:'1235',displayPaymentAmount:1000,paymentAmount:-1000,realCost:600},
      {...invoice,agentCode:'NO_PLAN',displayPaymentAmount:1000,paymentAmount:-1000,realCost:600},
    ],period).agents;
    expect(rows[0]).toMatchObject({netProfit:509982.76,rate:9,regularCommission:45898.45,ready:false});
    expect(rows[1]).toMatchObject({netProfit:400,rate:0,regularCommission:0});
    expect(rows[2]).toMatchObject({netProfit:400,rate:null,regularCommission:null});
  });
  it('no usa el tabulador mensual para acumular meses distintos',()=>{
    const row=buildCollectionSettlement([invoice],{...period,to:'2026-10-31'},{...additional,agents:[{code:'1231',plan:'salary'}]}).agents[0]!;
    expect(row.rate).toBeNull();expect(row.pending.join(' ')).toContain('mensual');
  });
  it('no extrapola los perfiles observados en septiembre de México a otros periodos',()=>{
    const row=buildCollectionSettlement([invoice],{from:'2026-10-01',to:'2026-10-31'},additional).agents[0]!;
    expect(row.config.plan).toBe('unconfirmed');expect(row.totalCommission).toBeNull();
  });
  it('separa costo de origen y ajuste manual, incluyendo un ajuste válido de cero',()=>{
    const row=buildCollectionSettlement([invoice],period,{...additional,agents:[{code:'1231',plan:'fixed',fixedRate:6,costOverride:0,freight:5000,gratuities:1000}]}).agents[0]!;
    expect(row).toMatchObject({sourceCost:400000,cost:0,netProfit:494000,rate:6,regularCommission:29640});
  });
  it('no convierte marcas o costos desconocidos en liquidaciones completas y permite excluir PLM',()=>{
    const row=buildCollectionSettlement([{...invoice,realCost:null,customerStatus:'Sin clasificar',customerBonus:null,customerBonusBase:null,lmAmount:null}],period,{...additional,agents:[{code:'1231',includeLm:false}]}).agents[0]!;
    expect(row).toMatchObject({cost:null,customerBonus:null,totalCommission:null,lmBonus:0,ready:false});
  });
  it('conserva el sentido financiero de PA opuestos aunque el pago visible sea positivo',()=>{
    const row=buildCollectionSettlement([{...invoice,paymentAmount:100,displayPaymentAmount:100,realCost:10,customerStatus:'Nuevo',customerBonusEligible:true,customerBonusBase:-100,customerBonus:-1}],period,
      {...additional,agents:[{code:'1231',plan:'fixed',fixedRate:10}]}).agents[0]!;
    expect(row).toMatchObject({payment:-100,cost:10,netProfit:-110,regularCommission:-11,customerBonus:-1,totalCommission:-12});
  });
});
