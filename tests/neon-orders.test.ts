import { PGlite } from '@electric-sql/pglite';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Order, type OrderProps } from '../src/modules/sales/orders/domain/entities/order.js';
import type { CaptureInput } from '../src/modules/sales/orders/domain/repositories/order-capture-repository.js';
import type { OrdersDataSource } from '../src/modules/sales/orders/domain/datasources/orders-data-source.js';
import type { OrderReferenceDataSource } from '../src/modules/sales/orders/domain/datasources/order-reference-data-source.js';
import { HybridOrdersDataSource } from '../src/modules/sales/orders/infrastructure/datasources/hybrid-orders-data-source.js';
import { PostgresOrderOverlayDataSource } from '../src/modules/sales/orders/infrastructure/datasources/postgres-order-overlay-data-source.js';
import { compareOrders, matchesOrder } from '../src/modules/sales/orders/infrastructure/datasources/order-overlay-filter.js';
import type { PostgresConnectionFactory } from '../src/shared/infrastructure/database/postgres-pool.js';
import { postgresWriteBoundary } from '../src/shared/infrastructure/http/postgres-write-boundary.js';
import { errorHandler } from '../src/shared/infrastructure/http/error-handler.js';
import { createOrdersModule } from '../src/modules/sales/orders/orders-module.js';

// Real PostgreSQL engine in isolated WASM memory: no Neon URL or MySQL credentials used.
const db = new PGlite();
let failAudit = false;
const connect: PostgresConnectionFactory = async () => ({
  query: async <T extends object>(sql: string, values?: unknown[]) => {
    if (failAudit && sql.startsWith('INSERT INTO tuvansa.order_changes')) throw new Error('Simulated failure');
    if (!values) {
      const results = await db.exec(sql);
      return {rows: (results.at(-1)?.rows ?? []) as T[]};
    }
    return db.query<T>(sql,values);
  }, release() {},
});
const store = new PostgresOrderOverlayDataSource(connect,()=>true);
const base = (id=10, number='P000010'): OrderProps => ({id,number,customerOrderNumber:'ORIGINAL',customer:{id:15331,code:'000001',name:'Cliente original'},
  documentKind:'order',status:'',fulfilledAmount:0,branch:0,department:'',dates:{orderedAt:'2026-09-14',from:'2026-09-14',dueAt:'2026-09-14'},
  attention:'Agente',termsDays:30,authorization:'',initial:false,warehouse:'01',currencyId:2,exchangeRate:1,minimumFulfillmentPercentage:0,
  observations:'',classifications:['1202','211','302'],totals:{quantity:1,ordered:1,fulfilled:0,remaining:1,subtotal:59.05,discount:0,freight:0,insurance:0,other:0,tax:9.45,total:68.5},
  lines:[{id:99,productId:13288,productCode:'01300958',description:'Producto',ordered:1,fulfilled:0,remaining:1,unit:'M',assigned:0,branch:0,price:59.05,classCode:'',currencyId:2,piecesAssignment:'',discount:0,publicPrice:59.05,sku:'',color:'',size:''}]});
const originals = [base(),base(11,'P000011')];
const forbidden = vi.fn(async () => {throw new Error('A MySQL write was attempted');});
const legacy: OrdersDataSource = {
  findById: async id => {const row=originals.find(o=>o.id===id);return row ? Order.create(row) : null;},
  findByNumber: async number=>{const row=originals.find(o=>o.number===number);return row ? Order.create(row) : null;},
  search: async c => {const rows=originals.filter(o=>!c.excludeIds?.includes(o.id)&&matchesOrder(o,c)).sort((a,b)=>compareOrders(a,b)*(c.descending ? -1 : 1));return {items:rows.slice(c.offset,c.offset+c.limit).map(Order.create),total:rows.length};},
  findAdjacent:async()=>null,customerExists:async()=>true,numberExists:async()=>false,
  create:forbidden,update:forbidden,delete:forbidden,
};
const customer = {id:15331,code:'000001',name:'Cliente',agentCode:'1202',agentName:'Agente',termsDays:30,store:'302',classification:'211',branches:[]};
const references: OrderReferenceDataSource = {
  options:async()=>({warehouses:[{code:'01',description:'México'},{code:'02',description:'Otro'}],types:[],agents:[{code:'1202',displayCode:'202',name:'Agente'}]}),
  customer:async()=>customer,searchCustomers:async()=>[],searchProducts:async()=>[],customerById:async()=>customer,productCodeById:async()=> '01300958',hasInvoices:async()=>false,
  product:async()=>({id:13288,code:'01300958',description:'Producto',unit:'M',price:59.05,cost:40,costCurrencyId:1,taxPercentage:16,excisePercentage:0,currencyId:1,stock:50,assigned:0,available:50,weight:16.08,volume:0}),
};
const make = (s=store) => new HybridOrdersDataSource(legacy,s,references,{getPanel:async()=>null});
const input: CaptureInput = {warehouse:'01',typeCode:'P',customerCode:'000001',customerOrderNumber:'LOCAL',orderedAt:'2026-09-14',from:'2026-09-14',dueAt:'2026-09-14',department:'',initial:false,agentCode:'1202',termsDays:30,store:'302',observations:'Prueba',exchangeRate:1.2,boxes:3,branch:4,collectionCurrency:'PESOS',orderDiscounts:[0,0,0,0],commission:2.5,noPartialDeliveries:true,transportation:'Flete de prueba',deliveryAddress:['Calle 1','Bodega 2','México'],contact:'Compras',additionalComments:'Entregar por la mañana',documentKind:'quote',lines:[{productCode:'01300958',quantity:1,price:59.05,discount:0}]};

beforeAll(async()=>{await store.initialize();},30_000);
beforeEach(async()=>{
  failAudit=false; forbidden.mockClear();
  await db.exec('TRUNCATE tuvansa.order_changes,tuvansa.order_stock_deltas,tuvansa.orders; ALTER SEQUENCE tuvansa.order_ids RESTART WITH 5000000000;');
});
afterAll(async()=>{await db.close();});

describe('Neon orders / real embedded PostgreSQL',()=>{
  it('applies migrations once and preserves their checksum',async()=>{
    await new PostgresOrderOverlayDataSource(connect,()=>true).initialize();
    const result=await db.query('SELECT id,checksum FROM tuvansa.schema_migrations');
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({id:'001_orders_overlay'});
  });
  it('creates, reads, edits and deletes local orders without a MySQL write',async()=>{
    const api=make();const created=(await api.create(input)).toPrimitives();
    expect(created.id).toBe(5000000000);expect(created.number).toBe('NP5000000000');expect(created.totals.total).toBe(68.5);
    expect(created).toMatchObject({branch:4,exchangeRate:1.2,captureDetails:{boxes:3,commission:2.5,noPartialDeliveries:true,transportation:'Flete de prueba',contact:'Compras',additionalComments:'Entregar por la mañana'}});
    expect((await api.findById(created.id))?.toPrimitives().number).toBe(created.number);
    expect((await api.findByNumber(created.number))?.toPrimitives().id).toBe(created.id);
    const edited=await api.update(created.id,{observations:'Editado',lines:[{productId:13288,quantity:2,price:59.05}]});
    expect(edited?.toPrimitives().totals).toMatchObject({quantity:2,total:137});
    expect(await api.delete(created.id)).toEqual({status:'deleted'});
    expect(await api.findById(created.id)).toBeNull();expect(await api.findByNumber(created.number)).toBeNull();
    expect(await api.numberExists(created.number)).toBe(true);
    expect((await db.query('SELECT operation FROM tuvansa.order_changes ORDER BY revision')).rows).toEqual([{operation:'create'},{operation:'update'},{operation:'delete'}]);
    expect(forbidden).not.toHaveBeenCalled();
  });
  it('persists four cascading order discounts and their recalculated total',async()=>{
    const created=(await make().create({...input,orderDiscounts:[10,20,0,0]})).toPrimitives();
    expect(created.captureDetails?.orderDiscounts).toEqual([10,20,0,0]);
    expect(created.totals).toMatchObject({subtotal:59.05,discount:16.53,tax:6.8,total:49.32});
    expect(forbidden).not.toHaveBeenCalled();
  });
  it('overrides and tombstones legacy records, including filtered counts and pagination',async()=>{
    const api=make(); await api.update(10,{customerOrderNumber:'CAMBIO',observations:'Local'});
    expect((await api.findById(10))?.toPrimitives().observations).toBe('Local');
    expect(originals[0]!.observations).toBe('');
    expect((await api.search({customerOrderNumber:'ORIGINAL',offset:0,limit:1})).total).toBe(1);
    expect((await api.search({customerOrderNumber:'CAMBIO',offset:0,limit:1})).items[0]?.toPrimitives().id).toBe(10);
    await api.delete(11);const newOrder=(await api.create(input)).toPrimitives();
    const first=await api.search({offset:0,limit:1}),second=await api.search({offset:1,limit:1});
    expect(first.total).toBe(2); expect(first.items[0]?.toPrimitives().id).toBe(newOrder.id);expect(second.items[0]?.toPrimitives().id).toBe(10);
    expect(await api.findById(11)).toBeNull();expect(await api.findByNumber('P000011')).toBeNull();
    expect((await api.findAdjacent(newOrder.id,'next'))?.toPrimitives().id).toBe(10);
    expect((await api.findAdjacent(10,'previous'))?.toPrimitives().id).toBe(newOrder.id);
    expect(forbidden).not.toHaveBeenCalled();
  });
  it('stores inventory differences and conversion without touching legacy counters',async()=>{
    const api=make(); const id=(await api.create(input)).toPrimitives().id;
    let rows=(await db.query<{ordered:string;quoted:string}>('SELECT ordered,quoted FROM tuvansa.order_stock_deltas WHERE order_id=$1',[id])).rows;
    expect(Number(rows[0]!.quoted)).toBe(1);expect(Number(rows[0]!.ordered)).toBe(0);
    await api.convertQuote(id);
    rows=(await db.query<{ordered:string;quoted:string}>('SELECT ordered,quoted FROM tuvansa.order_stock_deltas WHERE order_id=$1',[id])).rows;
    expect(Number(rows[0]!.quoted)).toBe(0);expect(Number(rows[0]!.ordered)).toBe(1);
    await api.convertQuote(id);
    rows=(await db.query<{ordered:string;quoted:string}>('SELECT ordered,quoted FROM tuvansa.order_stock_deltas WHERE order_id=$1',[id])).rows;
    expect(Number(rows[0]!.quoted)).toBe(1);expect(Number(rows[0]!.ordered)).toBe(0);
    await api.delete(10);
    const removed=(await db.query<{ordered:string}>('SELECT ordered FROM tuvansa.order_stock_deltas WHERE order_id=10')).rows;
    expect(Number(removed[0]!.ordered)).toBe(-1);expect(forbidden).not.toHaveBeenCalled();
  });
  it('rolls back the order and stock deltas if auditing fails',async()=>{
    failAudit=true;
    await expect(make().create(input)).rejects.toMatchObject({code:'POSTGRES_UNAVAILABLE'});
    expect((await db.query('SELECT * FROM tuvansa.orders')).rows).toHaveLength(0);
    expect((await db.query('SELECT * FROM tuvansa.order_stock_deltas')).rows).toHaveLength(0);
  });
  it('rolls back a first legacy copy if validation rejects the edit',async()=>{
    const api=new HybridOrdersDataSource(legacy,store,{...references,hasInvoices:async()=>true},{getPanel:async()=>null});
    await expect(api.update(10,{observations:'Forbidden'})).rejects.toMatchObject({code:'ORDER_IN_USE'});
    expect((await db.query('SELECT * FROM tuvansa.orders')).rows).toHaveLength(0);
  });
  it('keeps reads available without URL and never falls back to MySQL on writes',async()=>{
    const neverConnect=vi.fn();const api=make(new PostgresOrderOverlayDataSource(neverConnect,()=>false));
    expect((await api.findById(10))?.toPrimitives().number).toBe('P000010');
    await expect(api.create(input)).rejects.toMatchObject({code:'POSTGRES_NOT_CONFIGURED'});
    await expect(api.update(10,{observations:'x'})).rejects.toMatchObject({code:'POSTGRES_NOT_CONFIGURED'});
    await expect(api.delete(10)).rejects.toMatchObject({code:'POSTGRES_NOT_CONFIGURED'});
    expect(neverConnect).not.toHaveBeenCalled();expect(forbidden).not.toHaveBeenCalled();
  });
  it('does not resurrect legacy records when configured Neon is unavailable',async()=>{
    const unavailable=new PostgresOrderOverlayDataSource(async()=>{throw new Error('postgresql://private:password@host/db');},()=>true);
    await expect(make(unavailable).findById(10)).rejects.toMatchObject({code:'POSTGRES_UNAVAILABLE',statusCode:503});
  });
  it('enforces unique folios and does not replace an existing record',async()=>{
    await store.create(async id=>({...base(id,'LOCAL'),lines:[]}));
    await expect(store.create(async id=>({...base(id,'LOCAL'),lines:[]}))).rejects.toMatchObject({code:'ORDER_NUMBER_EXISTS'});
    expect((await db.query('SELECT * FROM tuvansa.orders')).rows).toHaveLength(1);
  });
  it('serves local comments and hides panels for deleted orders',async()=>{
    const api=make();const id=(await api.create(input)).toPrimitives().id;
    expect(await api.getPanel(id,'comments')).toMatchObject({source:'postgres',available:true,summary:{observations:'Prueba'}});
    await api.delete(id); expect(await api.getPanel(id,'comments')).toBeNull();
  });
  it('enforces authorization, assignment, deauthorization and edit rules',async()=>{
    const api=make();const id=(await api.create({...input,documentKind:'order'})).toPrimitives().id;
    await expect(api.setAssignment(id,[{lineId:1,assigned:1}])).rejects.toMatchObject({code:'ORDER_AUTHORIZATION_REQUIRED'});
    let order=(await api.setAuthorization(id,true)).toPrimitives();
    expect(order.authorization).toBe('O.K.');
    await expect(api.update(id,{lines:[{productId:13288,quantity:2,price:59.05}]})).rejects.toMatchObject({code:'ORDER_IN_USE'});
    order=(await api.setAssignment(id,[{lineId:1,assigned:1}])).toPrimitives();
    expect(order.status).toBe('ASIGNAD');expect(order.lines[0]?.assigned).toBe(1);
    await expect(api.setAuthorization(id,false)).rejects.toMatchObject({code:'ORDER_ASSIGNED'});
    order=(await api.setAssignment(id,[{lineId:1,assigned:0}])).toPrimitives();
    expect(order.status).toBe('');
    order=(await api.setAuthorization(id,false)).toPrimitives();
    expect(order.authorization).toBe('');
  });
  it('rejects prices below the warehouse cost',async()=>{
    await expect(make().create({...input,lines:[{...input.lines[0]!,price:1}]})).rejects.toMatchObject({code:'ORDER_PRICE_BELOW_COST'});
  });
  it('converts dollar and peso products to the selected collection currency',async()=>{
    const usdProduct={id:13288,code:'01300958',description:'Producto USD',unit:'M',price:10,cost:8,costCurrencyId:2 as const,
      taxPercentage:16,excisePercentage:0,currencyId:2 as const,stock:50,assigned:0,available:50,weight:1,volume:0};
    const api=new HybridOrdersDataSource(legacy,store,{...references,product:async()=>usdProduct},{getPanel:async()=>null});
    const pesos=(await api.create({...input,exchangeRate:20,collectionCurrency:'PESOS',lines:[{productCode:'01300958',quantity:2,price:10,discount:0,currencyId:2}]})).toPrimitives();
    expect(pesos).toMatchObject({currencyId:0,exchangeRate:20,totals:{subtotal:400,tax:64,total:464}});
    expect(pesos.lines[0]).toMatchObject({price:200,sourcePrice:10,sourceCurrencyId:2,publicPrice:200,currencyId:0});
    const nextRate=(await api.update(pesos.id,{exchangeRate:25,collectionCurrency:'PESOS'}))!.toPrimitives();
    expect(nextRate).toMatchObject({currencyId:0,exchangeRate:25,totals:{subtotal:500,tax:80,total:580}});
    expect(nextRate.lines[0]).toMatchObject({price:250,sourcePrice:10,sourceCurrencyId:2,currencyId:0});

    const dollars=(await api.create({...input,exchangeRate:20,collectionCurrency:'DOLARES',lines:[{productCode:'01300958',quantity:2,price:200,discount:0,currencyId:1}]})).toPrimitives();
    expect(dollars).toMatchObject({currencyId:1,exchangeRate:20,totals:{subtotal:20,tax:3.2,total:23.2}});
    expect(dollars.lines[0]).toMatchObject({price:10,currencyId:1});
    await expect(api.create({...input,exchangeRate:20,collectionCurrency:'PESOS',lines:[{productCode:'01300958',quantity:1,price:159,discount:0,currencyId:1}]}))
      .rejects.toMatchObject({code:'ORDER_PRICE_BELOW_COST'});
  });
  it('updates exchange rate and collection currency from Comentarios',async()=>{
    const api=make();
    const created=(await api.create({...input,exchangeRate:20,collectionCurrency:'PESOS'})).toPrimitives();
    const dollars=(await api.update(created.id,{exchangeRate:20,collectionCurrency:'DOLARES'}))!.toPrimitives();
    expect(dollars).toMatchObject({currencyId:1,exchangeRate:20,captureDetails:{collectionCurrency:'DOLARES'},totals:{subtotal:2.95,tax:0.47,total:3.42}});
    expect(dollars.lines[0]).toMatchObject({price:2.9525,currencyId:1});
    const pesos=(await api.update(created.id,{exchangeRate:20,collectionCurrency:'PESOS'}))!.toPrimitives();
    expect(pesos).toMatchObject({currencyId:0,captureDetails:{collectionCurrency:'PESOS'},totals:{subtotal:59.05,tax:9.45,total:68.5}});
    expect(pesos.lines[0]).toMatchObject({price:59.05,currencyId:0});
  });
  it('supports the existing HTTP capture contract with PostgreSQL persistence',async()=>{
    const app=express().use(express.json()).use('/api',postgresWriteBoundary)
      .use('/api/sales/orders',createOrdersModule(make())).use(errorHandler);
    const result=await request(app).post('/api/sales/orders/capture').send(input).expect(201);
    expect(result.body.data.number).toBe('NP5000000000');
    const comments=await request(app).patch(`/api/sales/orders/${result.body.data.id}/actions/comments`)
      .send({exchangeRate:20,collectionCurrency:'DOLARES'}).expect(200);
    expect(comments.body.data).toMatchObject({currencyId:1,exchangeRate:20,captureDetails:{collectionCurrency:'DOLARES'}});
    await request(app).post(`/api/sales/orders/${result.body.data.id}/actions/quote-conversion`).send({}).expect(200);
    await request(app).post(`/api/sales/orders/${result.body.data.id}/actions/authorization`).send({authorized:true}).expect(200);
    await request(app).post(`/api/sales/orders/${result.body.data.id}/actions/assignment`).send({lines:[{lineId:1,assigned:1}]}).expect(200);
    await request(app).patch('/api/accounts-receivable/clients/123').send({}).expect(503);
    expect(forbidden).not.toHaveBeenCalled();
  });
  it('keeps classic POST, PATCH, GET and DELETE contracts on PostgreSQL',async()=>{
    const app=express().use(express.json()).use('/api',postgresWriteBoundary)
      .use('/api/sales/orders',createOrdersModule(make())).use(errorHandler);
    const created=await request(app).post('/api/sales/orders').send({number:'NEON-TEST',customerId:15331,orderedAt:'2026-09-14',
      lines:[{productId:13288,quantity:1,price:59.05}]}).expect(201);
    const id=created.body.data.id;
    expect(created.body.data.storage).toEqual({source:'postgres',legacyId:null,revision:1});
    await request(app).patch(`/api/sales/orders/${id}`).send({lines:[{productId:13288,quantity:2,price:59.05}]}).expect(200);
    const loaded=await request(app).get(`/api/sales/orders/${id}`).expect(200);
    expect(loaded.body.data.totals.quantity).toBe(2);
    await request(app).delete(`/api/sales/orders/${id}`).expect(204);
    await request(app).get(`/api/sales/orders/${id}`).expect(404);
    await request(app).get('/api/sales/orders/by-number/NEON-TEST').expect(404);
    expect(forbidden).not.toHaveBeenCalled();
  });
  it('paginates correctly when local folios fall before, between and after legacy folios',async()=>{
    const api=make();const local=[];
    for (const number of ['P000009','P000010A','P000012','NP5000000099']) {
      local.push(await store.create(async id=>base(id,number)));
    }
    const expected=[...originals,...local].sort(compareOrders).map(d=>d.number);
    for(let offset=0;offset<9;offset++) {
      const page=await api.search({offset,limit:2});
      expect(page.total).toBe(6);expect(page.items.map(o=>o.toPrimitives().number)).toEqual(expected.slice(offset,offset+2));
    }
  });
  it('rejects replacing the applied migration checksum',async()=>{
    const original=(await db.query<{checksum:string}>('SELECT checksum FROM tuvansa.schema_migrations')).rows[0]!.checksum;
    try {
      await db.query("UPDATE tuvansa.schema_migrations SET checksum='changed' WHERE id='001_orders_overlay'");
      await expect(new PostgresOrderOverlayDataSource(connect,()=>true).initialize()).rejects.toMatchObject({code:'POSTGRES_UNAVAILABLE'});
    } finally {await db.query('UPDATE tuvansa.schema_migrations SET checksum=$1',[original]);}
  });
});
