import { createHash } from 'node:crypto';
import type { DuplicateOrderInput } from '../../domain/datasources/order-duplicate-data-source.js';
import { duplicateCaptureInput, duplicateStale, todayInMexico } from '../../domain/entities/order-duplicate.js';
import { normalizeOrderWarehouse } from '../../domain/entities/order-warehouse.js';
import { customerAllowed, requireCustomer } from '../../../../../shared/infrastructure/http/customer-scope.js';
import { orderPanelLabels } from '../../domain/entities/order-panel-labels.js';
import { Order, type OrderProps } from '../../domain/entities/order.js';
import { amountInWords, captureCurrencyId, captureCurrencyName, captureMinimumPrice, captureTotals, convertCaptureAmount, roundAmount, roundCapturePrice } from '../../domain/entities/order-capture-totals.js';
import type { OrdersDataSource } from '../../domain/datasources/orders-data-source.js';
import type { OrderCaptureDataSource } from '../../domain/datasources/order-capture-data-source.js';
import type { OrderPanelsDataSource } from '../../domain/datasources/order-panels-data-source.js';
import type { OrderOverlay, OrderOverlayDataSource } from '../../domain/datasources/order-overlay-data-source.js';
import type { OrderReferenceDataSource } from '../../domain/datasources/order-reference-data-source.js';
import type { CaptureCurrencyId, CaptureInput, CaptureLine, CaptureCustomer, CaptureOrderDiscounts, OrderAuthorizationCommand } from '../../domain/repositories/order-capture-repository.js';
import type { DeleteOrderResult, OrderCreateValues, OrderLineWriteValues, OrderNavigationDirection, OrderSearchCriteria, OrderUpdateValues } from '../../domain/repositories/orders-repository.js';
import type { OrderPanelKey, OrderPanelResult } from '../../domain/repositories/order-panels-repository.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { readSalesRemissions } from '../../../invoicing/infrastructure/datasources/postgres-sales-remissions.js';
import { salesTicketConversionSql } from '../../../invoicing/infrastructure/datasources/sales-ticket-conversion-reads.js';
import { compareOrders, matchesOrder } from './order-overlay-filter.js';

type LegacyRead = Pick<OrdersDataSource,'findById'|'findByNumber'|'search'|'findAdjacent'|'customerExists'>;
const localDocument = (row: OrderOverlay): OrderProps => ({...row.document,warehouse:normalizeOrderWarehouse(row.document.warehouse),storage:{source:'postgres',legacyId:row.base?.id ?? null,revision:row.revision}});
const auditDate = new Intl.DateTimeFormat('es-MX', { dateStyle: 'short', timeStyle: 'short', timeZone: 'America/Mexico_City' });

export class HybridOrdersDataSource implements OrdersDataSource, OrderCaptureDataSource, OrderPanelsDataSource {
  constructor(private readonly legacy: LegacyRead, private readonly local: OrderOverlayDataSource,
    private readonly references: OrderReferenceDataSource, private readonly legacyPanels: OrderPanelsDataSource) {}
  private writable() {
    if (!this.local.configured) throw new ApplicationError('Configura NEON_DATABASE_URL para guardar los cambios.', 'POSTGRES_NOT_CONFIGURED',503);
  }
  async findById(id: number): Promise<Order | null> {
    const local = await this.local.get(id);
    if (local) return local.deleted || !customerAllowed(local.document.customer.id) ? null : Order.create(localDocument(local));
    const original = id >= 5_000_000_000 ? null : await this.legacy.findById(id);
    return original && customerAllowed(original.toPrimitives().customer.id) ? original : null;
  }
  async findByNumber(number: string): Promise<Order | null> {
    const local = await this.local.list();
    const match = local.find(r => r.document.number.toUpperCase() === number.toUpperCase());
    if (match) return match.deleted || !customerAllowed(match.document.customer.id) ? null : Order.create(localDocument(match));
    const original = await this.legacy.findByNumber(number);
    return original ? this.findById(original.toPrimitives().id) : null;
  }
  async search(criteria: OrderSearchCriteria) {
    const local = await this.local.list();
    const overrides = local.flatMap(({base}) => base ? [base.id] : []);
    const matches = local.filter(r => !r.deleted && matchesOrder(r.document,criteria)).map(localDocument);
    const legacyOffset = Math.max(0,criteria.offset-matches.length);
    const legacy = await this.legacy.search({...criteria,excludeIds:overrides,offset:legacyOffset,limit:criteria.limit+matches.length});
    const merged = [...legacy.items.map(o=>o.toPrimitives()),...matches].sort(compareOrders);
    const start=criteria.offset-legacyOffset;
    return {items:merged.slice(start,start+criteria.limit).map(Order.create),total:legacy.total+matches.length};
  }
  async findAdjacent(id: number, direction: OrderNavigationDirection): Promise<Order | null> {
    const current = await this.findById(id);
    if (!current) return null;
    const target = current.toPrimitives();
    const local = await this.local.list();
    const bound={number:target.number,id:target.id};
    const page=await this.legacy.search({offset:0,limit:1,excludeIds:local.flatMap(({base}) => base ? [base.id] : []),
      ...(direction==='next' ? {after:bound} : {before:bound,descending:true})});
    const candidates=[...page.items.map(o=>o.toPrimitives()),...local.filter(r=>!r.deleted).map(r=>r.document)]
      .filter(o=>direction==='next' ? compareOrders(o,target)>0 : compareOrders(o,target)<0).sort(compareOrders);
    const candidate=direction==='next' ? candidates[0] : candidates.at(-1);
    // Legacy search rows omit detail lines; return the full canonical record.
    return candidate ? this.findById(candidate.id) : null;
  }
  async numberExists(number: string) {
    // Deleted folios remain reserved: never recycle document identities.
    if ((await this.local.list()).some(r=>r.document.number.toUpperCase()===number.toUpperCase())) return true;
    return (await this.legacy.findByNumber(number)) !== null;
  }
  customerExists(id: number) { return this.legacy.customerExists(id); }
  async options(companyId = 1) {
    const [options, series] = await Promise.all([
      this.references.options(), this.references.orderNumberSeries(companyId),
    ]);
    const { code, description, taxPercentage } = series;
    return { ...options, types: [{ code, description, taxPercentage, nextNumber: await this.local.previewNumber(series) }] };
  }
  customer(code: string) { return this.references.customer(code); }
  searchCustomers(criteria: Parameters<OrderReferenceDataSource['searchCustomers']>[0], limit: number) { return this.references.searchCustomers(criteria, limit); }
  searchProducts(criteria: Parameters<OrderReferenceDataSource['searchProducts']>[0], warehouse: string, limit: number) { return this.references.searchProducts(criteria, normalizeOrderWarehouse(warehouse), limit); }
  productFamilies() { return this.references.productFamilies(); }
  product(code: string, warehouse: string, type: string, customerCode: string) { return this.references.product(code,normalizeOrderWarehouse(warehouse),type,customerCode); }

  private async prepareLines(lines: CaptureLine[], customer: CaptureCustomer, warehouse: string, exchangeRate: number) {
    const prepared = [];
    for (const input of lines) {
      const product = await this.references.product(input.productCode,warehouse,'P',customer.code);
      const currencyId = input.currencyId ?? product.currencyId;
      if (input.price < captureMinimumPrice(product,currencyId,exchangeRate)) {
        throw new ConflictError(`No se puede vender ${product.code} abajo del costo`, 'ORDER_PRICE_BELOW_COST');
      }
      prepared.push({input:{...input,currencyId},product});
    }
    return prepared;
  }
  private async fromClassic(values: OrderCreateValues): Promise<CaptureInput> {
    const customer = await this.references.customerById(values.customerId);
    const lines: CaptureLine[] = [];
    const captureLineCurrencyId = values.currencyId === 1 ? 2 : 1;
    for (const line of values.lines) lines.push({productCode:await this.references.productCodeById(line.productId),quantity:line.quantity,price:line.price,discount:line.discount ?? 0,currencyId:captureLineCurrencyId});
    return {customerCode:customer.code,warehouse:values.warehouse ?? '01',typeCode:'P',customerOrderNumber:values.customerOrderNumber ?? '',
      orderedAt:values.orderedAt,from:values.from ?? values.orderedAt,dueAt:values.dueAt ?? values.orderedAt,
      department:values.department ?? '',initial:values.initial ?? false,agentCode:values.attentionCode ?? customer.agentCode,
      termsDays:values.termsDays ?? customer.termsDays,store:customer.store,observations:values.observations ?? '',
      exchangeRate:1,boxes:0,branch:values.branch ?? 0,collectionCurrency:captureCurrencyName(captureLineCurrencyId),orderDiscounts:[0,0,0,0],commission:0,noPartialDeliveries:false,
      transportation:'',deliveryAddress:['','',''],contact:'',additionalComments:'',documentKind:'order',lines};
  }
  private async prepareCreation(source: CaptureInput, original?: OrderProps) {
    const input = {...source,warehouse:normalizeOrderWarehouse(source.warehouse)};
    const customer = await this.references.customer(input.customerCode);
    requireCustomer(customer.id);
    if (original && customer.id !== original.customer.id) {
      throw new ConflictError('El código del cliente ya no corresponde al documento original.', 'ORDER_DUPLICATE_CUSTOMER_CHANGED');
    }
    const options = await this.references.options();
    const agent = options.agents.find(item => item.code === input.agentCode);
    if (!options.warehouses.some(w=>w.code===input.warehouse) || !agent) {
      throw new ConflictError('Almacén o agente no válido.', 'ORDER_REFERENCE_INVALID');
    }
    const currencyId = captureCurrencyId(input.collectionCurrency);
    const documentCurrencyId = input.collectionCurrency === 'DOLARES' ? 1 : 0;
    const prepared = await this.prepareLines(input.lines,customer,input.warehouse,input.exchangeRate);
    if (original && prepared.some(({product}, index) =>
      product.id !== original.lines[index]?.productId || product.unit.trim() !== original.lines[index].unit.trim())) {
      throw new ConflictError('Cambió el producto o la unidad de una partida del origen.', 'ORDER_DUPLICATE_PRODUCT_CHANGED');
    }
    if (original && !(original.exchangeRate > 0) && prepared.some(({input: line,product}) => line.currencyId !== product.costCurrencyId)) {
      throw new ConflictError('El documento requiere un tipo de cambio válido para comprobar el costo.', 'ORDER_DUPLICATE_UNSUPPORTED');
    }
    const totals = captureTotals(prepared,currencyId,input.exchangeRate,input.orderDiscounts);
    if (!Number.isFinite(totals.total) || totals.total > 999999999) throw new ConflictError('El total excede el límite de captura.');
    const companyId = input.companyId ?? 1;
    const build = async (id: number, number?: string): Promise<OrderProps> => {
      if (!number) throw new ConflictError('No se pudo asignar el folio del pedido.', 'ORDER_NUMBER_UNAVAILABLE');
      const lines = prepared.map(({input:l,product:p},index)=>({id:index+1,productId:p.id,productCode:p.code,description:p.description,
        ordered:l.quantity,fulfilled:0,remaining:l.quantity,unit:p.unit,assigned:0,branch:0,
        price:roundCapturePrice(convertCaptureAmount(l.price,l.currencyId ?? p.currencyId,currencyId,input.exchangeRate)),
        sourcePrice:l.price,sourceCurrencyId:l.currencyId ?? p.currencyId,classCode:'',currencyId:documentCurrencyId,
        piecesAssignment:'',discount:l.discount,publicPrice:roundCapturePrice(convertCaptureAmount(p.price,p.currencyId,currencyId,input.exchangeRate)),sku:'',color:'',size:''}));
      return {id,number,companyId,customerOrderNumber:input.customerOrderNumber,customer:{id:customer.id,code:customer.code,name:customer.name},
        documentKind:input.documentKind,status:'',fulfilledAmount:0,branch:input.branch,department:input.department,
        dates:{orderedAt:input.orderedAt,from:input.from,dueAt:input.dueAt},attention:original ? agent.name : customer.agentName,termsDays:input.termsDays,
        authorization:'',initial:input.initial,warehouse:input.warehouse,currencyId:documentCurrencyId,exchangeRate:input.exchangeRate,minimumFulfillmentPercentage:0,
        observations:input.observations,captureDetails:{boxes:input.boxes,collectionCurrency:input.collectionCurrency,orderDiscounts:input.orderDiscounts,commission:input.commission,
          noPartialDeliveries:input.noPartialDeliveries,transportation:input.transportation,deliveryAddress:input.deliveryAddress,
          contact:input.contact,additionalComments:input.additionalComments},classifications:[input.agentCode,customer.classification,input.store,'','','','7'],
        totals:{quantity:totals.quantity,ordered:totals.quantity,fulfilled:0,remaining:totals.quantity,subtotal:totals.subtotal,discount:totals.discount,
          freight:0,insurance:0,other:0,tax:totals.tax,total:totals.total},lines};
    };
    return { build, totals, prepared };
  }

  private created(document: OrderProps): Order {
    return Order.create(localDocument({document,base:null,deleted:false,revision:1}));
  }

  async create(values: CaptureInput | OrderCreateValues): Promise<Order> {
    this.writable();
    const input = 'customerCode' in values ? values : await this.fromClassic(values);
    const { build } = await this.prepareCreation(input);
    const explicitNumber = 'number' in values ? values.number : undefined;
    if (explicitNumber && await this.numberExists(explicitNumber)) throw new ConflictError('El número ya existe.', 'ORDER_NUMBER_EXISTS');
    const numbering = explicitNumber ?? await this.references.orderNumberSeries(input.companyId ?? 1);
    return this.created(await this.local.create(build, numbering));
  }

  private async duplicatePreview(id: number, companyId: number, date: string) {
    const local = await this.local.get(id);
    if (local?.deleted) throw new NotFoundError('Pedido');
    const order = local ? localDocument(local) : await this.original(id);
    if (!order || !customerAllowed(order.customer.id)) throw new NotFoundError('Pedido');
    const discounts: CaptureOrderDiscounts = [0, 0, 0, 0];
    if (!order.captureDetails) {
      const comments = (await this.legacyPanels.getPanel(id, 'comments'))?.summary;
      discounts[0] = Number(comments?.discount1 ?? 0);
      discounts[1] = Number(comments?.discount2 ?? 0);
      discounts[2] = Number(comments?.discount3 ?? 0);
    }
    // Omnis persists the header but skips lines with zero quantity when duplicating.
    const lines = order.lines.filter(line => line.ordered !== 0);
    const source = { ...order, lines };
    const input = duplicateCaptureInput(source, companyId, date, discounts);
    const { build, totals, prepared } = await this.prepareCreation(input, source);
    const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
    const sourceVersion = hash(order);
    const revision = hash([sourceVersion, input, prepared.map(({product}) => [product.taxPercentage, product.excisePercentage]), totals]);
    return { order, lines, sourceVersion, revision, input, totals, build, localRevision: local?.revision ?? null };
  }

  async previewDuplicate(id: number, companyId: number): Promise<OrderPanelResult> {
    this.writable();
    const date = todayInMexico();
    const { order, lines, input, totals, revision } = await this.duplicatePreview(id, companyId, date);
    const series = await this.references.orderNumberSeries(companyId);
    await this.local.previewNumber(series);
    return {
      order: { id, number: order.number }, ...orderPanelLabels.duplicate, key: 'duplicate',
      available: true, source: order.storage ? 'postgres' : 'mysql',
      summary: { sourceOrder: order.number, percentage: 100, revision, orderedAt: date, customer: order.customer,
        warehouse: input.warehouse, branch: input.branch, agent: input.agentCode, currency: input.collectionCurrency, total: totals.total },
      items: lines.map(line => ({ productCode: line.productCode, description: line.description, quantity: line.ordered, unit: line.unit })),
    };
  }

  async duplicate(id: number, companyId: number, input: DuplicateOrderInput): Promise<Order> {
    this.writable();
    const saved = await this.local.findDuplicate(id, input);
    if (saved) return this.created(saved);
    if (input.orderedAt !== todayInMexico()) throw duplicateStale();
    const current = await this.duplicatePreview(id, companyId, input.orderedAt);
    if (input.revision !== current.revision) throw duplicateStale();
    const series = await this.references.orderNumberSeries(companyId);
    if (current.localRevision === null) {
      const original = await this.original(id);
      if (createHash('sha256').update(JSON.stringify(original)).digest('hex') !== current.sourceVersion) throw duplicateStale();
    }
    return this.created(await this.local.createDuplicate(id, input, current.localRevision, current.build, series));
  }

  private async original(id: number) {
    return id >= 5_000_000_000 ? null : (await this.legacy.findById(id))?.toPrimitives() ?? null;
  }
  private async assertMutable(order: OrderProps) {
    if (!['order','quote'].includes(order.documentKind)) throw new ConflictError('El documento no es un pedido ni una cotización.');
    if (order.authorization || order.lines.some(l=>l.fulfilled>0 || l.assigned>0) || await this.references.hasInvoices(order.number)) {
      throw new ConflictError('No se puede modificar un pedido autorizado, asignado, surtido o facturado.', 'ORDER_IN_USE');
    }
  }
  async update(id: number, values: OrderUpdateValues): Promise<Order | null> {
    this.writable();
    values = {...values,...(values.warehouse !== undefined ? {warehouse:normalizeOrderWarehouse(values.warehouse)} : {})};
    const result = await this.local.change(id,await this.original(id),'update',async doc => {
      await this.assertMutable(doc);
      doc.warehouse = normalizeOrderWarehouse(doc.warehouse);
      const commentsReprice = values.exchangeRate !== undefined || values.collectionCurrency !== undefined;
      const reprice = values.lines !== undefined ||
        (values.customerId !== undefined && values.customerId !== doc.customer.id) ||
        (values.warehouse !== undefined && values.warehouse !== doc.warehouse) || commentsReprice;
      if (values.currencyId !== undefined && values.currencyId !== doc.currencyId) throw new ConflictError('El cambio de moneda requiere conversión de importes.');
      if (values.customerId !== undefined) {
        const c = await this.references.customerById(values.customerId);
        requireCustomer(c.id);
        doc.customer = {id:c.id,code:c.code,name:c.name};
      }
      if (values.customerOrderNumber !== undefined) doc.customerOrderNumber=values.customerOrderNumber;
      if (values.orderedAt !== undefined) doc.dates.orderedAt=values.orderedAt;
      if (values.from !== undefined) doc.dates.from=values.from;
      if (values.dueAt !== undefined) doc.dates.dueAt=values.dueAt;
      if (values.branch !== undefined) doc.branch=values.branch;
      if (values.department !== undefined) doc.department=values.department;
      if (values.termsDays !== undefined) doc.termsDays=values.termsDays;
      if (values.initial !== undefined) doc.initial=values.initial;
      if (values.observations !== undefined) doc.observations=values.observations;
      if (values.status !== undefined) doc.status=values.status;
      if (values.warehouse !== undefined) {
        if (!(await this.references.options()).warehouses.some(w=>w.code===values.warehouse)) throw new NotFoundError('Almacén');
        doc.warehouse=values.warehouse;
      }
      if (values.classifications !== undefined) doc.classifications=values.classifications;
      if (values.attentionCode !== undefined) {
        const agent = (await this.references.options()).agents.find(a=>a.code===values.attentionCode);
        if (!agent) throw new NotFoundError('Agente');
        doc.classifications[0]=agent.code; doc.attention=agent.name;
      }
      if (reprice) {
        const customer = await this.references.customerById(doc.customer.id);
        const sourceCurrencyId = doc.currencyId === 1 ? 2 : 1;
        const collectionCurrency = values.collectionCurrency ?? doc.captureDetails?.collectionCurrency ?? captureCurrencyName(sourceCurrencyId);
        const targetCurrencyId = captureCurrencyId(collectionCurrency);
        const exchangeRate = values.exchangeRate ?? (doc.exchangeRate > 0 ? doc.exchangeRate : 1);
        const sourceLines: Array<OrderLineWriteValues & {currencyId: CaptureCurrencyId}> = values.lines
          ? values.lines.map(line=>({...line,currencyId:sourceCurrencyId}))
          : doc.lines.map(line=>({productId:line.productId,quantity:line.ordered,
              price:commentsReprice ? (line.sourcePrice ?? line.price) : line.price,discount:line.discount,
              currencyId:commentsReprice && (line.sourceCurrencyId === 1 || line.sourceCurrencyId === 2) ? line.sourceCurrencyId : sourceCurrencyId}));
        const inputs: CaptureLine[] = [];
        for (const l of sourceLines) inputs.push({productCode:await this.references.productCodeById(l.productId),quantity:l.quantity,price:l.price,discount:l.discount ?? 0,currencyId:l.currencyId});
        const prepared = await this.prepareLines(inputs,customer,doc.warehouse,exchangeRate);
        const totals = captureTotals(prepared,targetCurrencyId,exchangeRate,doc.captureDetails?.orderDiscounts ?? [0,0,0,0]);
        if (!Number.isFinite(totals.total) || totals.total > 999999999) throw new ConflictError('El total excede el límite de captura.');
        const freight = roundAmount(convertCaptureAmount(doc.totals.freight,sourceCurrencyId,targetCurrencyId,exchangeRate));
        const insurance = roundAmount(convertCaptureAmount(doc.totals.insurance,sourceCurrencyId,targetCurrencyId,exchangeRate));
        const other = roundAmount(convertCaptureAmount(doc.totals.other,sourceCurrencyId,targetCurrencyId,exchangeRate));
        const documentCurrencyId = collectionCurrency === 'DOLARES' ? 1 : 0;
        doc.lines=prepared.map(({input:l,product:p},i)=>({id:i+1,productId:p.id,productCode:p.code,description:p.description,ordered:l.quantity,
          fulfilled:0,remaining:l.quantity,unit:p.unit,assigned:0,branch:values.lines ? 0 : (doc.lines[i]?.branch ?? 0),
          price:roundCapturePrice(convertCaptureAmount(l.price,l.currencyId ?? sourceCurrencyId,targetCurrencyId,exchangeRate)),
          sourcePrice:l.price,sourceCurrencyId:l.currencyId ?? sourceCurrencyId,classCode:'',currencyId:documentCurrencyId,piecesAssignment:'',
          discount:l.discount,publicPrice:roundCapturePrice(convertCaptureAmount(p.price,p.currencyId,targetCurrencyId,exchangeRate)),sku:'',color:'',size:''}));
        doc.currencyId=documentCurrencyId; doc.exchangeRate=exchangeRate;
        doc.captureDetails={boxes:0,commission:0,noPartialDeliveries:false,transportation:'',deliveryAddress:['','',''],
          contact:'',additionalComments:'',...doc.captureDetails,collectionCurrency};
        doc.totals={...doc.totals,quantity:totals.quantity,ordered:totals.quantity,fulfilled:0,remaining:totals.quantity,subtotal:totals.subtotal,
          discount:totals.discount,freight,insurance,other,tax:totals.tax,total:roundAmount(totals.total+freight+insurance+other)};
      }
      if (doc.dates.from && doc.dates.dueAt && doc.dates.from>doc.dates.dueAt) throw new ConflictError('Desde no puede ser posterior a Vence.');
      return doc;
    });
    return result ? Order.create(localDocument(result)) : null;
  }
  async delete(id: number): Promise<DeleteOrderResult> {
    this.writable();
    try {
      const result = await this.local.change(id,await this.original(id),'delete',async doc => { await this.assertMutable(doc); return null; });
      return result ? {status:'deleted'} : {status:'not-found'};
    } catch (error) {
      if (error instanceof ConflictError && error.code==='ORDER_IN_USE') return {status:'in-use',relation:'autorización, partidas o facturas'};
      throw error;
    }
  }
  async convertQuote(id: number): Promise<Order> {
    this.writable();
    const result = await this.local.change(id,await this.original(id),'convert',async doc => {
      if (!['order','quote'].includes(doc.documentKind)) throw new ConflictError('El documento no es un pedido ni una cotización.');
      await this.assertMutable(doc);
      doc.documentKind=doc.documentKind==='quote' ? 'order' : 'quote';
      return doc;
    });
    if (!result) throw new NotFoundError('Pedido');
    return Order.create(localDocument(result));
  }
  private async verifyAuthorizationCosts(order: OrderProps, historical: boolean) {
    const pending = order.lines.filter((line) => line.ordered > line.fulfilled);
    const costs = await this.references.authorizationCosts([...new Set(pending.map((line) => line.productId))]);
    for (const line of pending) {
      const cost = costs.get(line.productId);
      const hasSource = line.sourcePrice !== undefined && line.sourceCurrencyId !== undefined;
      // PLMONEDA=0 delega a PEMONEDA en el legado. El overlay captura 0/1 como pesos/dólares.
      const currency = hasSource ? line.sourceCurrencyId
        : order.captureDetails ? captureCurrencyId(order.captureDetails.collectionCurrency)
          : historical ? line.currencyId || order.currencyId || 1 : line.currencyId + 1;
      const price = hasSource ? line.sourcePrice : line.price;
      if (!cost || (currency !== 1 && currency !== 2) || price === undefined || !Number.isFinite(price)
        || (currency !== cost.costCurrencyId && !(order.exchangeRate > 0))) {
        throw new ConflictError(`No se pudo comprobar el costo vigente de ${line.productCode}.`, 'ORDER_AUTHORIZATION_COST_UNAVAILABLE');
      }
      if (price < captureMinimumPrice(cost, currency, order.exchangeRate)) {
        throw new ConflictError(`No se puede autorizar el pedido. El precio de ${line.productCode} está abajo del costo vigente.`, 'ORDER_PRICE_BELOW_COST');
      }
    }
  }
  async setAuthorization(id: number, { authorized, revision, ...actor }: OrderAuthorizationCommand): Promise<Order> {
    this.writable();
    const original = await this.original(id);
    const result = await this.local.change(id, original, 'authorization', async (doc, currentRevision) => {
      if ((id < 5_000_000_000 ? original?.companyId : doc.companyId ?? 1) !== 1) {
        throw new ApplicationError('La autorización web está disponible para pedidos de TUVANSA México.', 'ORDER_AUTHORIZATION_COMPANY_FORBIDDEN', 403);
      }
      if (doc.documentKind !== 'order') throw new ConflictError('Sólo se puede autorizar un pedido.', 'ORDER_AUTHORIZATION_REQUIRED');
      if (revision !== currentRevision) throw new ConflictError('El pedido cambió. Vuelve a consultar la ficha antes de autorizar.', 'ORDER_AUTHORIZATION_STALE');
      const nextAuthorization = authorized ? 'O.K.' : '';
      if (doc.authorization === nextAuthorization) return doc;
      if (!authorized && doc.lines.some(line => line.assigned > 0)) {
        throw new ConflictError('No se puede des-autorizar un pedido asignado.', 'ORDER_ASSIGNED');
      }
      if (!authorized && (doc.fulfilledAmount > 0 || doc.totals.fulfilled > 0 || doc.lines.some(line => line.fulfilled > 0))) {
        throw new ConflictError('No se puede desautorizar un pedido ya surtido.', 'ORDER_ALREADY_FULFILLED');
      }
      if (authorized) {
        if (!await this.references.canAuthorizeCustomer(doc.customer.id)) {
          throw new ConflictError('El cliente está bloqueado o no está disponible para pedidos.', 'CLIENT_CREDIT_BLOCKED');
        }
        await this.verifyAuthorizationCosts(doc, original !== null);
        if (actor.userId) doc.authorizedBy = actor.userId;
        else delete doc.authorizedBy;
        if (actor.webUserId) doc.authorizedByWebUserId = actor.webUserId;
        else delete doc.authorizedByWebUserId;
        const name = actor.userName || actor.userIdentification;
        if (name) doc.authorizedByName = name;
        else delete doc.authorizedByName;
      }
      doc.authorization = nextAuthorization;
      doc.authorizationChange = { ...actor, changedAt: new Date().toISOString(), revision: currentRevision + 1 };
      return doc;
    });
    if (!result) throw new NotFoundError('Pedido');
    return Order.create(result.revision === 0 ? result.document : localDocument(result));
  }
  async setAssignment(id: number, values: Array<{ lineId: number; assigned: number }>): Promise<Order> {
    this.writable();
    const result = await this.local.change(id,await this.original(id),'assignment',async doc => {
      if (doc.documentKind !== 'order' || doc.authorization !== 'O.K.') {
        throw new ConflictError('Para asignar un pedido es necesario autorizarlo antes.', 'ORDER_AUTHORIZATION_REQUIRED');
      }
      const requested = new Map(values.map(value => [value.lineId, value.assigned]));
      if (requested.size !== values.length) throw new ConflictError('La asignación contiene partidas repetidas.', 'ORDER_ASSIGNMENT_INVALID');
      for (const lineId of requested.keys()) {
        if (!doc.lines.some(line => line.id === lineId)) throw new NotFoundError('Partida');
      }
      doc.lines = doc.lines.map(line => {
        const assigned = requested.get(line.id);
        if (assigned === undefined) return line;
        const maximum = Math.max(0, line.ordered - line.fulfilled);
        if (assigned < 0 || assigned > maximum) {
          throw new ConflictError(`La cantidad asignada de ${line.productCode} debe estar entre 0 y ${maximum}.`, 'ORDER_ASSIGNMENT_INVALID');
        }
        return {...line, assigned};
      });
      doc.status = doc.lines.some(line => line.assigned > 0) ? 'ASIGNAD' : '';
      return doc;
    });
    if (!result) throw new NotFoundError('Pedido');
    return Order.create(localDocument(result));
  }
  async getPanel(id: number, key: OrderPanelKey): Promise<OrderPanelResult | null> {
    const local = await this.local.get(id);
    if (!local) return id >= 5_000_000_000 ? null : this.legacyPanels.getPanel(id,key);
    if (local.deleted) return null;
    const doc = local.document;
    const {section,button} = orderPanelLabels[key];
    const result: OrderPanelResult = {order:{id,number:doc.number},key,section,button,available:false,source:'postgres',items:[],
      reason:'Este panel todavía no está implementado para la versión local del pedido.'};
    if (key === 'invoices') {
      const legacy = local.base ? await this.legacyPanels.getPanel(id, key) : null;
      const remissions = await readSalesRemissions<Record<string, unknown>[]>([], async (client) => {
        const conversion = await salesTicketConversionSql(client);
        const { rows } = await client.query<{ id: string; documentNumber: string; date: string }>(
          `SELECT remission.id::text,${conversion.number} AS "documentNumber",${conversion.issuedAt}::text AS date
           FROM tuvansa.sales_remissions remission ${conversion.join}
           WHERE remission.order_id=$1 AND remission.order_number=$2 ORDER BY remission.id`, [id, doc.number],
        );
        return rows.map((row) => ({ ...row, id: Number(row.id) }));
      });
      return { ...result, ...legacy, available: true, reason: '', items: [...(legacy?.items ?? []), ...remissions] };
    }
    if (key==='comments') {
      const entries = await this.local.authorizationHistory(id);
      const auditTrail = entries.map(({ authorized, userId, userName, userIdentification, changedAt }) =>
        `${authorized ? 'AUTORIZA' : 'DESAUTORIZA'} · Usuario ${userIdentification ?? userName ?? userId} · ${auditDate.format(new Date(changedAt))}`).join('\n');
      return {...result,button:'Comentarios',available:true,reason:'',items:[{comments:'',customerDocumentNumber:doc.number,
        amountInWords:amountInWords(doc.totals.total),auditTrail}],
        summary:{customerOrderNumber:doc.customerOrderNumber,orderedAt:doc.dates.orderedAt,fromDate:doc.dates.from,dueAt:doc.dates.dueAt,
          initial:doc.initial,department:doc.department,termsDays:doc.termsDays,warehouse:doc.warehouse,observations:doc.observations,
          branch:doc.branch,exchangeRate:doc.exchangeRate,authorizedBy:doc.authorizedBy,authorizedByName:doc.authorizedByName,...doc.captureDetails,localRevision:local.revision}};
    }
    if (key==='quote-conversion') return {...result,button:'Cotiz',available:true,items:[{documentKind:doc.documentKind}]};
    if (key==='authorize') return {...result,available:true,reason:'',items:[{authorized:doc.authorization==='O.K.',authorization:doc.authorization,
      authorizedBy:doc.authorizedBy, authorizedByName:doc.authorizedByName, lastChange:doc.authorizationChange}]};
    if (key==='assign-all') return {...result,available:true,reason:'',items:doc.lines.map(line=>({lineId:line.id,productCode:line.productCode,
      ordered:line.ordered,fulfilled:line.fulfilled,assigned:line.assigned,assignable:Math.max(0,line.ordered-line.fulfilled-line.assigned)}))};
    return result;
  }
}
