import { normalizeOrderWarehouse } from '../../domain/entities/order-warehouse.js';
import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import { customerAllowed, customerScope, customerSql, requireCustomer } from '../../../../../shared/infrastructure/http/customer-scope.js';
import { allClientCatalogRecords, findClientCatalogByCode } from '../../../../accounts-receivable/clients/infrastructure/datasources/postgres-client-catalog.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import {
  catalogProductByIdentifier, catalogProductsById, isNewCatalogProduct, searchChangedCatalogProducts,
} from '../../../../inventories/products/infrastructure/datasources/product-catalog-references.js';
import type { OrderCaptureDataSource } from '../../domain/datasources/order-capture-data-source.js';
import type { CaptureCustomer, CaptureCustomerMatch, CaptureCustomerSearchCriteria, CaptureInput, CaptureOptions, CaptureProduct, CaptureProductFamily, CaptureProductMatch, CaptureProductSearchCriteria } from '../../domain/repositories/order-capture-repository.js';
import { amountInWords, captureTotals } from '../../domain/entities/order-capture-totals.js';
import { readLocalWarehouseStock, scaledStock } from './sales-order-inventory-stock.js';
import { LegacyMysqlOrdersDataSource } from './legacy-mysql-orders-data-source.js';

type Db = Pick<PoolConnection, 'execute'>;
type Row<T> = RowDataPacket & T;
type Movement = { id: number; code: string; description: string; counter: number; width: number; tax0: number; tax1: number; tax2: number };
const movementFields = 'TISEQ AS id,TICLA AS code,TIDESCR AS description,TINUM AS counter,TICEROS AS width,TIIVA0 AS tax0,TIIVA1 AS tax1,TIIVA2 AS tax2';
const fail = (message: string) => new ConflictError(message, 'ORDER_CAPTURE_CONFLICT');
const supportedWarehouse = '01';
const nextNumber = (m: Movement) => {
  const digits = Math.max(1, Number(m.width) - m.code.length);
  const next = String(Number(m.counter) + 1);
  if (next.length > digits) throw fail('Se agotó el formato del folio; revisa el tipo de movimiento');
  return m.code + next.padStart(digits, '0');
};

export class LegacyMysqlOrderCaptureDataSource implements OrderCaptureDataSource {
  private readonly orders = new LegacyMysqlOrdersDataSource();

  private async movement(db: Db, code: string, lock = false): Promise<Movement> {
    const [rows] = await db.execute<Row<Movement>[]>(
      `SELECT ${movementFields} FROM FTIPMV WHERE TICLA=? ORDER BY TISEQ LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [code]);
    if (!rows[0]) throw new NotFoundError('Tipo de movimiento');
    return rows[0];
  }

  async options(warehouseCodes: readonly string[] = [supportedWarehouse]): Promise<CaptureOptions> {
    // Adaptada del selector de Nuevo. El alcance configurado sustituye el filtro de usuario de Omnis.
    const codes = [...new Set(warehouseCodes.map(normalizeOrderWarehouse))];
    const [rows] = codes.length ? await legacyMysqlPool.execute<Row<CaptureOptions['warehouses'][number]>[]>(
      `SELECT TRIM(CATALM) AS code,CATDESCR AS description FROM FALMCAT
       WHERE CATTIPO='' AND CATMULTICIA=1 AND CATCIA IN (0,1)
         AND CATALM IN (${codes.map(() => '?').join(',')})
       ORDER BY CATALM,CATSEQ`, codes,
    ) : [[]];
    const warehouses = new Map<string, CaptureOptions['warehouses'][number]>();
    for (const row of rows) {
      if (!warehouses.has(row.code)) warehouses.set(row.code, { code: row.code, description: row.description });
    }
    const movement = await this.movement(legacyMysqlPool, 'P');
    const [agents] = await legacyMysqlPool.execute<Row<{code: string; displayCode: string; name: string}>[]>(
      "SELECT AGTNUM AS code,AGNUM AS displayCode,AGDESCR AS name FROM FAG WHERE AGT='1' AND AGTIPO IN (0,1) ORDER BY AGTNUM");
    return { warehouses: [...warehouses.values()], agents, types: [{ code: movement.code, description: movement.description, nextNumber: nextNumber(movement), taxPercentage: Number(movement.tax0) }] };
  }

  private async readCustomer(db: Db, code: string, unblocked = false): Promise<CaptureCustomer> {
    // Adaptada: 05-CUSTOMER; proyección explícita y agente consolidado (JOIN derivado).
    const [rows] = await db.execute<Row<Omit<CaptureCustomer, 'branches'>>[]>(
      `SELECT CLISEQ AS id,CLICOD AS code,CLINOM AS name,CLIPAR1 AS agentCode,
       COALESCE(AGDESCR,'') AS agentName,CLIPLAZO0 AS termsDays,CLIPAR3 AS store,CLIPAR2 AS classification
       FROM FCLI LEFT JOIN FAG ON FAG.AGTNUM=FCLI.CLIPAR1
       WHERE CLICOD=? ${unblocked ? '' : "AND CLIBAJA='1900-12-31'"} AND CLISOLOPOS<>2 LIMIT 1`, [code]);
    if (!rows[0]) throw new NotFoundError('Cliente');
    requireCustomer(rows[0].id);
    const [branches] = await db.execute<Row<{code: number; name: string}>[]>(
      `SELECT SUCCOD AS code,SUCNOM AS name FROM FSUCURSALES
       WHERE CLISEQ=? AND SUCBAJA='1900-12-31' ORDER BY CLISEQ,SUCSEQ`, [rows[0].id]);
    return { ...rows[0], termsDays: Number(rows[0].termsDays), branches };
  }
  async customer(code: string): Promise<CaptureCustomer> {
    const record = await findClientCatalogByCode(code);
    if (!record) return this.readCustomer(legacyMysqlPool, code);
    if (record.deleted || record.blocked === true || record.document.code.toUpperCase() !== code.toUpperCase()) throw new NotFoundError('Cliente');
    const { id, name, terms } = record.document;
    requireCustomer(id);
    if (!record.legacy) return { id, name, code: record.document.code, agentCode: '', agentName: '', store: '', classification: '', branches: [], termsDays: terms.paymentTermDays };
    const base = await this.readCustomer(legacyMysqlPool, record.originalCode ?? code, record.blocked === false);
    return { ...base, code: record.document.code, name: record.changes.name ?? base.name, termsDays: record.changes.paymentTermDays ?? base.termsDays };
  }

  async searchCustomers(criteria: CaptureCustomerSearchCriteria, limit: number): Promise<CaptureCustomerMatch[]> {
    // Código: adaptada de ORDERS_CUSTOMER_MATCHES_00000. Nombre y RFC: filtros derivados para la ventana de búsqueda.
    const code = criteria.code ?? '';
    const name = criteria.name ?? '';
    const taxId = criteria.taxId ?? '';
    const scope = customerSql('CLISEQ');
    const [rows] = await legacyMysqlPool.execute<Row<CaptureCustomerMatch>[]>(
      `SELECT CLISEQ AS id,CLICOD AS code,CLINOM AS name,CLISUCURSAL AS branch,
       CLIRFC AS taxId,CLIEAN AS ean,CLITEL AS phone,CLITEL3 AS mobile,CLICELULAR AS email
       FROM FCLI
       WHERE CLICURP<>'T' AND CLIBAJA='1900-12-31' AND CLISOLOPOS<>2
       AND (?='' OR (CLICOD>=? AND CLICOD<=CONCAT(?,'zzzzzzzzzzzz')))
       AND (?='' OR CLINOM LIKE CONCAT('%',?,'%'))
       AND (?='' OR CLIRFC LIKE CONCAT(?,'%'))${scope.condition}
       ORDER BY CLICOD,FCLI.CLISEQ LIMIT ?`,
      [code, code, code, name, name, taxId, taxId, ...scope.values, limit]);
    const local = (await allClientCatalogRecords()).filter(record => customerAllowed(record.document.id));
    if (!local.length) return rows;
    const records = new Map(local.map((record) => [record.document.id, record]));
    const matches = new Map<number, CaptureCustomerMatch>();
    const includes = ({ code: foundCode, name: foundName, taxId: foundTaxId }: CaptureCustomerMatch) =>
      foundCode.toUpperCase().startsWith(code.toUpperCase()) && foundName.toUpperCase().includes(name.toUpperCase())
      && foundTaxId.toUpperCase().startsWith(taxId.toUpperCase());
    const project = (row: CaptureCustomerMatch, record: Exclude<ReturnType<typeof records.get>, undefined>): CaptureCustomerMatch => {
      const { document, changes } = record;
      return { ...row, code: document.code, name: changes.name ?? row.name,
        taxId: changes.taxId ?? row.taxId, branch: changes.branch ?? row.branch, phone: changes.phones ?? row.phone,
        email: changes.email ?? row.email };
    };
    for (const row of rows) {
      const record = records.get(row.id);
      if (record?.deleted || record?.blocked === true) continue;
      const projected = record ? project(row, record) : row;
      if (includes(projected)) matches.set(row.id, projected);
    }
    for (const record of local) {
      if (record.deleted || record.blocked === true || matches.has(record.document.id)) continue;
      const { id, code, name, fiscal, contact } = record.document;
      const option = { id, code, name, branch: fiscal.branch, taxId: fiscal.taxId, ean: '', phone: contact.phones, mobile: '', email: contact.email };
      if (!includes(option)) continue;
      if (record.legacy && !await this.readCustomer(legacyMysqlPool, record.originalCode ?? code, record.blocked === false).catch((error: unknown) => {
        if (error instanceof NotFoundError) return null;
        throw error;
      })) continue;
      matches.set(id, option);
    }
    return [...matches.values()].sort((a, b) => a.code.localeCompare(b.code) || a.id - b.id).slice(0, limit);
  }

  private async warehouse(db: Db, code: string) {
    code = normalizeOrderWarehouse(code);
    if (code !== supportedWarehouse) throw fail('La captura de pedidos está habilitada sólo para el almacén 01 México');
    const [rows] = await db.execute<Row<{ code: string }>[]>(
      "SELECT CATALM AS code FROM FALMCAT WHERE CATALM=? AND CATTIPO='' AND CATMULTICIA IN (0,1) LIMIT 1", [code]);
    if (!rows[0]) throw new NotFoundError('Almacén');
    return code;
  }

  async productFamilies(): Promise<CaptureProductFamily[]> {
    const positions = Array.from({ length: 9 }, (_, index) => index + 1);
    const [options, titles] = await Promise.all([
      legacyMysqlPool.execute<Row<{ position: string; code: string; description: string }>[]>(
        `SELECT FAMT AS position,FAMNUM AS code,FAMDESCR AS description FROM FFAM
         WHERE FAMT BETWEEN '1' AND '9' ORDER BY FAMT,FAMNUM`,
      ),
      legacyMysqlPool.execute<Row<Record<string, string>>[]>(
        `SELECT ${positions.map((position) => `CIAFAMPAR${position}`).join(',')} FROM FCIA WHERE CIASEQ=1`,
      ),
    ]);
    let start = 0;
    const families: CaptureProductFamily[] = [];
    for (const position of positions) {
      const group = options[0].filter((row) => Number(row.position) === position);
      const width = group[1]?.code.trim().length ?? 0;
      if (start < 13 && width > 0) {
        families.push({ position, label: titles[0][0]?.[`CIAFAMPAR${position}`]?.trim() || `Familia ${position}`,
          start, width, options: group.map(({ code, description }) => ({ code: code.trim(), description: description.trim() })) });
      }
      start += width;
    }
    return families;
  }

  async searchProducts(criteria: CaptureProductSearchCriteria, warehouse: string, limit: number): Promise<CaptureProductMatch[]> {
    warehouse = normalizeOrderWarehouse(warehouse);
    // Derivada: búsqueda de la ventana "Encuentra producto". La captura confirmó la vista y sus columnas,
    // pero no una sentencia literal de OMNIS para sus filtros.
    const code = criteria.code ?? '';
    const description = criteria.description ?? '';
    const supplierCode = criteria.supplierCode ?? '';
    const exactCode = criteria.exactCode;
    const familyPattern = criteria.familyPattern?.replace(/[\\%_]/g, '\\$&').replace(/\*/g, '_');
    const [rows] = await legacyMysqlPool.execute<Row<CaptureProductMatch>[]>(
      `SELECT FINV.ISEQ AS id,FINV.ICOD AS code,FINV.IDESCR AS description,
       (FALM.ALMCANT-FALM.ALMASIGNADO) AS available,FINV.ILISTA1 AS price,FINV.IMONEDA1 AS currencyId,
       FALM.ALMNUM AS warehouse,FINV.IFAM AS family,FINV.IFAM1 AS secondaryFamily,
       CAST(NULLIF(FINV.IPROXRECEP,'1900-12-31') AS DATE) AS nextReceipt,FINV.ICODPRV AS supplierCode
       FROM FINV INNER JOIN FALM ON FALM.ISEQ=FINV.ISEQ
       WHERE FALM.ALMNUM=? AND FINV.IBAJA='1900-12-31'
       AND (?='' OR UPPER(FINV.ICOD) LIKE CONCAT(UPPER(?),'%') OR UPPER(FINV.IEAN) LIKE CONCAT(UPPER(?),'%'))
       AND (?='' OR UPPER(FINV.IDESCR) LIKE CONCAT('%',UPPER(?),'%'))
       AND (?='' OR FINV.ICODPRV LIKE CONCAT(?,'%'))
       ${familyPattern ? "AND RPAD(COALESCE(FINV.IFAM,''),13,' ') LIKE ? AND (FINV.ICOLOR='' OR FINV.ITIPO<>1)" : ''}
       ${exactCode ? 'AND FINV.ICOD=?' : ''}
       ORDER BY FINV.ICOD,FINV.ISEQ LIMIT ?`,
      [warehouse, code, code, code, description, description, supplierCode, supplierCode,
        ...(familyPattern ? [familyPattern] : []), ...(exactCode ? [exactCode] : []), limit]);
    const [current, changed] = await Promise.all([
      catalogProductsById(rows.map(({ id }) => id)),
      supplierCode || familyPattern || exactCode ? [] : searchChangedCatalogProducts(code, description, limit),
    ]);
    const matches = new Map<number, CaptureProductMatch>();
    for (const row of rows) {
      const reference = current.get(row.id);
      if (reference?.deleted || reference?.document.isActive === false) continue;
      const product = reference?.document;
      const updated = { ...row, available: Number(row.available), price: Number(row.price) };
      if (product) {
        if (exactCode && product.code.trim().toUpperCase() !== exactCode.toUpperCase()) continue;
        if (code && ![product.code, product.warehouse.ean].some((value) => value.toUpperCase().startsWith(code.toUpperCase()))) continue;
        if (description && !product.description.toUpperCase().includes(description.toUpperCase())) continue;
        updated.code = product.code;
        updated.description = product.description;
        updated.family = product.classification.familyCode;
        updated.price = product.prices.sale[0].amount;
        const currency = product.prices.sale[0].currencyId;
        if (currency === 1 || currency === 2) updated.currencyId = currency;
      }
      matches.set(updated.id, updated);
    }
    for (const { document } of changed) {
      if (matches.has(document.id)) continue;
      const currency = document.prices.sale[0].currencyId;
      if (currency !== 1 && currency !== 2) continue;
      if (!isNewCatalogProduct(document.id)) {
        const [rows] = await legacyMysqlPool.execute<Row<Pick<CaptureProductMatch, 'available' | 'secondaryFamily' | 'nextReceipt' | 'supplierCode'>>[]>(
          `SELECT (a.ALMCANT-a.ALMASIGNADO) AS available, i.IFAM1 AS secondaryFamily,
             CAST(NULLIF(i.IPROXRECEP,'1900-12-31') AS DATE) AS nextReceipt,i.ICODPRV AS supplierCode
           FROM FINV i JOIN FALM a ON a.ISEQ=i.ISEQ AND a.ALMNUM=? WHERE i.ISEQ=? LIMIT 1`, [warehouse, document.id],
        );
        if (!rows[0]) continue;
        matches.set(document.id, { ...rows[0], id: document.id, code: document.code, description: document.description,
          price: document.prices.sale[0].amount, currencyId: currency,
          family: document.classification.familyCode, warehouse, available: Number(rows[0].available) });
        continue;
      }
      matches.set(document.id, { id: document.id, code: document.code, description: document.description,
        price: document.prices.sale[0].amount, currencyId: currency,
        warehouse, family: document.classification.familyCode, secondaryFamily: '', nextReceipt: null,
        supplierCode: '', available: 0 });
    }
    const result = [...matches.values()].sort((left, right) => left.code.localeCompare(right.code) || left.id - right.id).slice(0, limit);
    const stock = await readLocalWarehouseStock(warehouse, result.map(({ id }) => id));
    return result.map((product) => {
      const delta = stock.get(product.id);
      return delta ? { ...product, available: scaledStock(product.available + delta.quantity - delta.assigned) } : product;
    });
  }

  private async readProduct(db: Db, identifier: string, warehouse: string, movement: Movement, customerCode: string): Promise<CaptureProduct> {
    const selected = await catalogProductByIdentifier(identifier, true);
    if (selected?.deleted || selected?.document.isActive === false) throw new NotFoundError('Producto');
    // Adaptada de 07-PRODUCT: OMNIS intenta IEAN antes de ICOD y luego consulta FALM para el almacén activo.
    const [eanMatches] = selected ? [[]] : await db.execute<Row<{code: string}>[]>(
      `SELECT FINV.ICOD AS code FROM FINV
       INNER JOIN FALM ON FALM.ISEQ=FINV.ISEQ
       WHERE UPPER(FINV.IEAN)=UPPER(?) AND FALM.ALMNUM=?
       ORDER BY FINV.ISEQ LIMIT 1`, [identifier, warehouse]);
    const code = eanMatches[0]?.code ?? identifier;
    // Proyección explícita de la consulta posterior por ICOD. SKU y serie siguen pendientes.
    const isNew = selected ? isNewCatalogProduct(selected.document.id) : false;
    if (isNew) await this.warehouse(db, warehouse);
    const [rows] = isNew ? [[]] : await db.execute<Row<Omit<CaptureProduct, 'taxPercentage' | 'stock' | 'assigned' | 'available' | 'cost' | 'costCurrencyId'> & { taxCode: number; family: string; pesoCost: number; dollarCost: number }>[]>(
      `SELECT FINV.ISEQ AS id,ICOD AS code,IDESCR AS description,COALESCE(NULLIF(UCOD,''),IUM) AS unit,
       ILISTA1 AS price,IMONEDA1 AS currencyId,ILISTA5 AS pesoCost,ILISTA6 AS dollarCost,
       IPORCIVA AS taxCode,IPORCIEPES AS excisePercentage,
       IPESO AS weight,IVOLUMEN AS volume,IFAM AS family
       FROM FINV LEFT JOIN FUNIDAD ON FINV.USEQ=FUNIDAD.USEQ
       WHERE ${selected ? 'FINV.ISEQ=?' : 'UPPER(ICOD)=UPPER(?)'} ORDER BY FINV.ISEQ LIMIT 1`, [selected?.document.id ?? code]);
    const original = rows[0];
    const reference = selected ?? (original ? (await catalogProductsById([original.id])).get(original.id) : undefined);
    if (reference?.deleted || reference?.document.isActive === false
      || (original && !selected && reference && reference.document.code !== original.code)) throw new NotFoundError('Producto');
    const product = reference?.document;
    const p = product ? {
      id: product.id, code: product.code, description: product.description, unit: product.classification.unit.code,
      price: product.prices.sale[0].amount, currencyId: product.prices.sale[0].currencyId,
      pesoCost: product.prices.costs.last, dollarCost: product.prices.costs.previous, family: product.classification.familyCode,
      taxCode: original?.taxCode ?? 0, excisePercentage: original?.excisePercentage ?? 0,
      weight: original?.weight ?? 0, volume: original?.volume ?? 0,
    } : original;
    if (!p) throw new NotFoundError('Producto');
    const taxCode = Number(p.taxCode);
    if (![0, 1, 2].includes(taxCode)) throw fail('El código de IVA del producto requiere configuración adicional');
    if (Number(p.excisePercentage) !== 0) throw fail('El alta de productos con IEPS requiere validar su cálculo en PROSCAI');
    if (![1,2].includes(Number(p.currencyId))) throw fail('La moneda del precio del producto no es PESOS ni DOLARES');
    // Adaptada: las cuatro claves de 08-QUANTITY. La captura no tuvo coincidencias;
    // no inventar la prioridad, vigencia o combinación de DES1/DES2/DES3.
    const oldCode = original?.code ?? p.code;
    const discountKeys = [`${customerCode}+${p.code}`,`${customerCode}+${p.family}`,`*+${p.code}`,`${customerCode}+*`];
    if (oldCode !== p.code) discountKeys.push(`${customerCode}+${oldCode}`, `*+${oldCode}`);
    const [discounts] = await db.execute<Row<{id: number}>[]>(
      `SELECT DESSEQ AS id FROM FDESCTOS WHERE DESKEY IN (${discountKeys.map(() => '?').join(',')}) ORDER BY DESSEQ LIMIT 1`,
      discountKeys);
    if (discounts.length) throw fail('Este cliente/producto tiene reglas de descuento comercial que aún requieren validar en PROSCAI');
    const [stock] = isNew ? [[{ stock: 0, assigned: 0 }]] : await db.execute<Row<{ stock: number; assigned: number }>[]>(
      'SELECT ALMCANT AS stock,ALMASIGNADO AS assigned FROM FALM WHERE ALMKEY=? LIMIT 1', [oldCode.padEnd(13, ' ') + warehouse]);
    if (!stock[0]) throw new NotFoundError('Producto en el almacén activo');
    const currencyId = Number(p.currencyId) as 1 | 2;
    const cost = currencyId === 1 ? Number(p.pesoCost) : Number(p.dollarCost);
    const changes = (await readLocalWarehouseStock(warehouse, [p.id])).get(p.id);
    const onHand = scaledStock(Number(stock[0].stock) + (changes?.quantity ?? 0));
    const assigned = scaledStock(Math.max(0, Number(stock[0].assigned) + (changes?.assigned ?? 0)));
    return { id: p.id, code: p.code, description: p.description, unit: p.unit,
      price: Number(p.price), cost, currencyId, costCurrencyId: currencyId,
      taxPercentage: Number([movement.tax0, movement.tax1, movement.tax2][taxCode]),
      excisePercentage: Number(p.excisePercentage), weight: Number(p.weight), volume: Number(p.volume),
      stock: onHand, assigned, available: scaledStock(onHand - assigned) };
  }
  async product(code: string, warehouse: string, typeCode: string, customerCode: string) {
    if (customerScope.getStore()) await this.customer(customerCode);
    warehouse = normalizeOrderWarehouse(warehouse);
    return this.readProduct(legacyMysqlPool, code, warehouse, await this.movement(legacyMysqlPool, typeCode), customerCode);
  }

  setAuthorization(): Promise<never> {
    throw new ApplicationError('Las acciones de pedidos se guardan exclusivamente en PostgreSQL.', 'POSTGRES_WRITE_REQUIRED', 503);
  }
  setAssignment(): Promise<never> {
    throw new ApplicationError('Las acciones de pedidos se guardan exclusivamente en PostgreSQL.', 'POSTGRES_WRITE_REQUIRED', 503);
  }

  private async transaction<T>(operation: (connection: PoolConnection) => Promise<T>): Promise<T> {
    const c = await legacyMysqlPool.getConnection();
    try {
      // Derivada: no prometer rollback en respaldos con tablas no transaccionales.
      const [engines] = await c.execute<Row<{ engine: string }>[]>(
        `SELECT ENGINE AS engine FROM information_schema.tables WHERE TABLE_SCHEMA=DATABASE()
         AND LOWER(TABLE_NAME) IN ('fpenc','fplin','fcoment','finv','falm','fcli','ftipmv')`);
      if (engines.length !== 7 || engines.some(r => r.engine !== 'InnoDB')) throw fail('El alta requiere tablas InnoDB para guardar todos los cambios de forma atómica');
      await c.beginTransaction();
      const result = await operation(c);
      await c.commit();
      return result;
    } catch (error) {
      await c.rollback();
      if (typeof error === 'object' && error !== null && 'code' in error &&
          ['ER_TABLEACCESS_DENIED_ERROR', 'ER_COLUMNACCESS_DENIED_ERROR', 'ER_SPECIFIC_ACCESS_DENIED_ERROR'].includes(String(error.code))) {
        throw new ApplicationError('La conexión de la API no tiene los permisos de escritura necesarios para guardar pedidos.', 'ORDER_CAPTURE_WRITE_UNAVAILABLE', 503);
      }
      throw error;
    }
    finally { c.release(); }
  }

  async create(input: CaptureInput) {
    return this.transaction(async c => {
      // Derivada: bloqueo del contador para serializar altas de la API y verificar colisiones.
      const movement = await this.movement(c, input.typeCode, true);
      const number = nextNumber(movement);
      const [duplicates] = await c.execute<Row<{ id: number }>[]>('SELECT PESEQ AS id FROM FPENC WHERE PENUM=? LIMIT 1', [number]);
      if (duplicates.length) throw fail('El siguiente folio ya existe; revisa el contador de PROSCAI');
      input = {...input,warehouse:await this.warehouse(c, input.warehouse)};
      const customer = await this.readCustomer(c, input.customerCode);
      const [agents] = await c.execute<Row<{ code: string }>[]>('SELECT AGTNUM AS code FROM FAG WHERE AGTNUM=? LIMIT 1', [input.agentCode]);
      if (!agents[0]) throw new NotFoundError('Agente');
      const lines = [];
      for (const line of input.lines) lines.push({ input: line, product: await this.readProduct(c, line.productCode, input.warehouse, movement, customer.code) });
      const totals = captureTotals(lines,1,1,input.orderDiscounts);
      if (totals.total > 999999999) throw fail('El total excede el límite de captura');
      // Adaptada: 11-SAVE_OPEN_COMMENTS. No se suplanta PEUSRALTA de la sesión OMNIS.
      const [header] = await c.execute<ResultSetHeader>(
        `INSERT INTO FPENC (CLISEQ,PENUM,PEFECHA,PEDESDE,PEPAR0,PEPAR1,PEPARA,PESPEDIDO,PEPORCIVA,PEVENCE,
         PEPAR2,PEPAR3,PENUMELLOS,PEPLAZO,PEALMACEN,PEDATE2,PEMES,PEYEAR,PEMULTICIA,PEDEPTO,PEINICIAL)
         VALUES (?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,NOW(),?,?,1,?,?)`,
        [customer.id,number,input.orderedAt,input.from,customer.code,input.agentCode,customer.code,Number(movement.tax0),input.dueAt,
          customer.classification,input.store,input.customerOrderNumber,input.termsDays,input.warehouse,
          Number(input.orderedAt.slice(5,7)),Number(input.orderedAt.slice(0,4)),input.department,input.initial ? 1 : 0]);
      const id = header.insertId;
      await c.execute('UPDATE FCLI SET CLIULTPED=? WHERE CLISEQ=?', [input.orderedAt,customer.id]);
      for (const { input: line, product } of lines) {
        const [stockUpdate] = await c.execute<ResultSetHeader>('UPDATE FALM SET ALMPEDIDO=ALMPEDIDO+? WHERE ALMKEY=?', [line.quantity,product.code.padEnd(13, ' ')+input.warehouse]);
        if (stockUpdate.affectedRows !== 1) throw fail('Cambió el registro de inventario por almacén; vuelve a cargar la partida');
        await c.execute(`INSERT INTO FPLIN (CLISEQ,ISEQ,PESEQ,PLTIPMV,PLCANT,PLPRECI,PLFACTOR,PLUNIDAD,PLDESC)
          VALUES (?,?,?,'P',?,?,1,?,?)`, [customer.id,product.id,id,line.quantity,line.price,product.unit,line.discount]);
        await c.execute('UPDATE FINV SET IPEDCLI=IPEDCLI+? WHERE ISEQ=?', [line.quantity,product.id]);
      }
      // Adaptada: totales capturados parametrizados; cálculo puro separado del acceso a datos.
      await c.execute('UPDATE FPENC SET PEPZAS=?,PEBRUTO=?,PEDESC=?,PEIVA=?,PEIEPES=?,PECANT=? WHERE PESEQ=?',
        [totals.quantity,totals.subtotal,totals.discount,totals.tax,totals.excise,totals.total,id]);
      await c.execute('UPDATE FTIPMV SET TINUM=TINUM+1 WHERE TISEQ=?', [movement.id]);
      await c.execute('UPDATE FPENC SET PENUM=?,PECLINO=? WHERE PESEQ=?', [number,`${customer.id}.${number}`,id]);
      // Adaptada: 13-COMMENTS_OK. COMLETRA se calcula en la API (derivada).
      await c.execute('INSERT INTO FCOMENT (COMSEQFACT,COMDNUM,COMLETRA) VALUES (?,?,?)', [1_000_000_000+id,number,amountInWords(totals.total)]);
      await c.execute('UPDATE FPENC SET PEOBS=?,PEPAR7=? WHERE PESEQ=?', [input.observations,'7',id]);
      if (input.documentKind === 'quote') {
        await c.execute('UPDATE FPENC SET PESPEDIDO=4 WHERE PESEQ=?', [id]);
        for (const { input: line, product } of lines) {
          await c.execute('UPDATE FALM SET ALMPEDIDO=ALMPEDIDO-? WHERE ALMKEY=?', [line.quantity,product.code.padEnd(13,' ')+input.warehouse]);
          await c.execute('UPDATE FINV SET IPEDCLI=IPEDCLI-?,IPEDCOTIZ=IPEDCOTIZ+? WHERE ISEQ=?', [line.quantity,line.quantity,product.id]);
        }
      }
      const saved = await this.orders.findById(id,c);
      if (!saved) throw new NotFoundError('Pedido guardado');
      return saved;
    });
  }

  async convertQuote(id: number) {
    return this.transaction(async c => {
      const [headers] = await c.execute<Row<{kind: number; warehouse: string; authorized: number}>[]>(
        'SELECT PESPEDIDO AS kind,PEALMACEN AS warehouse,PEUSRAUT AS authorized FROM FPENC WHERE PESEQ=? FOR UPDATE', [id]);
      const header = headers[0];
      if (!header) throw new NotFoundError('Pedido');
      // Repetir el POST de una conversión ya completada no duplica acumulados.
      if (Number(header.kind) !== 1) {
        if (Number(header.kind) !== 4 || header.authorized) throw fail('Sólo se puede convertir una cotización sin autorizar');
        const [lines] = await c.execute<Row<{productId: number; code: string; quantity: number; fulfilled: number; assigned: number}>[]>(
          `SELECT FPLIN.ISEQ AS productId,ICOD AS code,PLCANT AS quantity,PLSURT AS fulfilled,PLASIGNADO AS assigned
           FROM FPLIN LEFT JOIN FINV ON FPLIN.ISEQ=FINV.ISEQ WHERE PESEQ=? ORDER BY PLSEQ FOR UPDATE`, [id]);
        if (lines.some(l => Number(l.fulfilled) !== 0 || Number(l.assigned) !== 0)) throw fail('La cotización tiene partidas surtidas o asignadas');
        for (const line of lines) {
          const [result] = await c.execute<ResultSetHeader>('UPDATE FALM SET ALMPEDIDO=ALMPEDIDO+? WHERE ALMKEY=?', [line.quantity,line.code.padEnd(13,' ')+header.warehouse]);
          if (result.affectedRows !== 1) throw fail('Falta el registro de inventario por almacén');
          await c.execute('UPDATE FINV SET IPEDCLI=IPEDCLI+?,IPEDCOTIZ=IPEDCOTIZ-? WHERE ISEQ=?', [line.quantity,line.quantity,line.productId]);
        }
        await c.execute('UPDATE FPENC SET PESPEDIDO=1 WHERE PESEQ=?', [id]);
      }
      const order = await this.orders.findById(id,c);
      if (!order) throw new NotFoundError('Pedido');
      return order;
    });
  }
}
