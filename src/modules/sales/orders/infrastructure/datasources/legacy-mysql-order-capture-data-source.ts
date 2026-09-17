import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import type { OrderCaptureDataSource } from '../../domain/datasources/order-capture-data-source.js';
import type { CaptureCustomer, CaptureInput, CaptureOptions, CaptureProduct } from '../../domain/repositories/order-capture-repository.js';
import { amountInWords, captureTotals } from '../../domain/entities/order-capture-totals.js';
import { LegacyMysqlOrdersDataSource } from './legacy-mysql-orders-data-source.js';

type Db = Pick<PoolConnection, 'execute'>;
type Row<T> = RowDataPacket & T;
type Movement = { id: number; code: string; description: string; counter: number; width: number; tax0: number; tax1: number; tax2: number };
const movementFields = 'TISEQ AS id,TICLA AS code,TIDESCR AS description,TINUM AS counter,TICEROS AS width,TIIVA0 AS tax0,TIIVA1 AS tax1,TIIVA2 AS tax2';
const fail = (message: string) => new ConflictError(message, 'ORDER_CAPTURE_CONFLICT');
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

  async options(): Promise<CaptureOptions> {
    // Derivada de 03-NEW: la API no dispone de identidad/permisos del usuario OMNIS.
    const [warehouses] = await legacyMysqlPool.execute<Row<{ code: string; description: string }>[]>(
      "SELECT CATALM AS code,CATDESCR AS description FROM FALMCAT WHERE CATTIPO='' AND CATMULTICIA IN (0,1) ORDER BY CATTIPO,CATSEQ");
    const movement = await this.movement(legacyMysqlPool, 'P');
    const [agents] = await legacyMysqlPool.execute<Row<{code: string; displayCode: string; name: string}>[]>(
      "SELECT AGTNUM AS code,AGNUM AS displayCode,AGDESCR AS name FROM FAG WHERE AGT='1' AND AGTIPO IN (0,1) ORDER BY AGTNUM");
    return { warehouses, agents, types: [{ code: movement.code, description: movement.description, nextNumber: nextNumber(movement), taxPercentage: Number(movement.tax0) }] };
  }

  private async readCustomer(db: Db, code: string): Promise<CaptureCustomer> {
    // Adaptada: 05-CUSTOMER; proyección explícita y agente consolidado (JOIN derivado).
    const [rows] = await db.execute<Row<Omit<CaptureCustomer, 'branches'>>[]>(
      `SELECT CLISEQ AS id,CLICOD AS code,CLINOM AS name,CLIPAR1 AS agentCode,
       COALESCE(AGDESCR,'') AS agentName,CLIPLAZO0 AS termsDays,CLIPAR3 AS store,CLIPAR2 AS classification
       FROM FCLI LEFT JOIN FAG ON FAG.AGTNUM=FCLI.CLIPAR1 WHERE CLICOD=? LIMIT 1`, [code]);
    if (!rows[0]) throw new NotFoundError('Cliente');
    const [branches] = await db.execute<Row<{code: number; name: string}>[]>(
      `SELECT SUCCOD AS code,SUCNOM AS name FROM FSUCURSALES
       WHERE CLISEQ=? AND SUCBAJA='1900-12-31' ORDER BY CLISEQ,SUCSEQ`, [rows[0].id]);
    return { ...rows[0], termsDays: Number(rows[0].termsDays), branches };
  }
  customer(code: string) { return this.readCustomer(legacyMysqlPool, code); }

  private async warehouse(db: Db, code: string) {
    const [rows] = await db.execute<Row<{ code: string }>[]>(
      "SELECT CATALM AS code FROM FALMCAT WHERE CATALM=? AND CATTIPO='' AND CATMULTICIA IN (0,1) LIMIT 1", [code]);
    if (!rows[0]) throw new NotFoundError('Almacén');
  }

  private async readProduct(db: Db, code: string, warehouse: string, movement: Movement, customerCode: string): Promise<CaptureProduct> {
    // Adaptada: código exacto FINV/FUNIDAD de 07-PRODUCT. Búsqueda de SKU/serie pendiente.
    const [rows] = await db.execute<Row<Omit<CaptureProduct, 'taxPercentage' | 'stock' | 'assigned' | 'available'> & { taxCode: number; family: string }>[]>(
      `SELECT FINV.ISEQ AS id,ICOD AS code,IDESCR AS description,COALESCE(NULLIF(UCOD,''),IUM) AS unit,
       ILISTA1 AS price,IMONEDA1 AS currencyId,IPORCIVA AS taxCode,IPORCIEPES AS excisePercentage,
       IPESO AS weight,IVOLUMEN AS volume,IFAM AS family
       FROM FINV LEFT JOIN FUNIDAD ON FINV.USEQ=FUNIDAD.USEQ WHERE ICOD=? ORDER BY FINV.ISEQ LIMIT 1`, [code]);
    const p = rows[0];
    if (!p) throw new NotFoundError('Producto');
    const taxCode = Number(p.taxCode);
    if (![0, 1, 2].includes(taxCode)) throw fail('El código de IVA del producto requiere configuración adicional');
    if (Number(p.excisePercentage) !== 0) throw fail('El alta de productos con IEPS requiere validar su cálculo en PROSCAI');
    if (Number(p.currencyId) !== 2) throw fail('La captura disponible corresponde a PESOS; falta validar la conversión de moneda de este producto');
    // Adaptada: las cuatro claves de 08-QUANTITY. La captura no tuvo coincidencias;
    // no inventar la prioridad, vigencia o combinación de DES1/DES2/DES3.
    const [discounts] = await db.execute<Row<{id: number}>[]>(
      'SELECT DESSEQ AS id FROM FDESCTOS WHERE DESKEY IN (?,?,?,?) ORDER BY DESSEQ LIMIT 1',
      [`${customerCode}+${p.code}`,`${customerCode}+${p.family}`,`*+${p.code}`,`${customerCode}+*`]);
    if (discounts.length) throw fail('Este cliente/producto tiene reglas de descuento comercial que aún requieren validar en PROSCAI');
    const [stock] = await db.execute<Row<{ stock: number; assigned: number }>[]>(
      'SELECT ALMCANT AS stock,ALMASIGNADO AS assigned FROM FALM WHERE ALMKEY=? LIMIT 1', [p.code.padEnd(13, ' ') + warehouse]);
    if (!stock[0]) throw fail(`El producto ${code} no tiene registro en el almacén ${warehouse}`);
    return { id: p.id, code: p.code, description: p.description, unit: p.unit,
      price: Number(p.price), currencyId: Number(p.currencyId), taxPercentage: Number([movement.tax0, movement.tax1, movement.tax2][taxCode]),
      excisePercentage: Number(p.excisePercentage), weight: Number(p.weight), volume: Number(p.volume),
      stock: Number(stock[0].stock), assigned: Number(stock[0].assigned), available: Number(stock[0].stock) - Number(stock[0].assigned) };
  }
  async product(code: string, warehouse: string, typeCode: string, customerCode: string) {
    await this.warehouse(legacyMysqlPool, warehouse);
    return this.readProduct(legacyMysqlPool, code, warehouse, await this.movement(legacyMysqlPool, typeCode), customerCode);
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
      await this.warehouse(c, input.warehouse);
      const customer = await this.readCustomer(c, input.customerCode);
      const [agents] = await c.execute<Row<{ code: string }>[]>('SELECT AGTNUM AS code FROM FAG WHERE AGTNUM=? LIMIT 1', [input.agentCode]);
      if (!agents[0]) throw new NotFoundError('Agente');
      const lines = [];
      for (const line of input.lines) lines.push({ input: line, product: await this.readProduct(c, line.productCode, input.warehouse, movement, customer.code) });
      const totals = captureTotals(lines);
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
