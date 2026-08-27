import type { PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { OrdersDataSource } from '../../domain/datasources/orders-data-source.js';
import { Order, type OrderLine, type OrderProps } from '../../domain/entities/order.js';
import type {
  DeleteOrderResult,
  OrderCreateValues,
  OrderLineWriteValues,
  OrderNavigationDirection,
  OrderSearchCriteria,
  OrderSearchResult,
  OrderUpdateValues,
} from '../../domain/repositories/orders-repository.js';

interface HeaderRow extends RowDataPacket {
  id: number; number: string; customerOrderNumber: string; customerId: number;
  customerCode: string | null; customerName: string | null; documentType: number;
  status: string; fulfilledAmount: number; branch: number; department: string;
  orderedAt: string; fromDate: string; dueAt: string; attention: string;
  termsDays: number; authorization: string; initial: number; warehouse: string;
  currencyId: number; exchangeRate: number; minimumFulfillmentPercentage: number;
  observations: string; classification0: string; classification1: string;
  classification2: string; classification3: string; classification4: string;
  classification5: string; classification6: string; quantity: number; subtotal: number; discount: number;
  freight: number; insurance: number; other: number; tax: number; total: number;
}

interface LineRow extends RowDataPacket, OrderLine {}
interface CountRow extends RowDataPacket { total: number }
interface ExistsRow extends RowDataPacket { found: number }
interface IdNumberRow extends RowDataPacket { id: number; number: string }
interface ProductWriteRow extends RowDataPacket { unit: string; taxPercentage: number }
interface FulfilledRow extends RowDataPacket { fulfilled: number }
interface PendingLineRow extends RowDataPacket { productId: number; pending: number }
interface DeleteHeaderRow extends IdNumberRow { customerId: number }

const selectHeader = `
  FPENC.PESEQ AS id,
  PENUM AS number,
  PENUMELLOS AS customerOrderNumber,
  FPENC.CLISEQ AS customerId,
  FCLI.CLICOD AS customerCode,
  FCLI.CLINOM AS customerName,
  PESPEDIDO AS documentType,
  PESTATUS AS status,
  PESURT AS fulfilledAmount,
  PESUCURSAL AS branch,
  PEDEPTO AS department,
  PEFECHA AS orderedAt,
  PEDESDE AS fromDate,
  PEVENCE AS dueAt,
  COALESCE((SELECT AGDESCR FROM FAG WHERE AGTNUM = PEPAR1 LIMIT 1), PEPAR1) AS attention,
  PEPLAZO AS termsDays,
  CASE WHEN PEUSRAUT > 0 THEN 'O.K.' ELSE '' END AS authorization,
  PEINICIAL AS initial,
  PEALMACEN AS warehouse,
  PEMONEDA AS currencyId,
  PETIPOC AS exchangeRate,
  PEPORCMINSUR AS minimumFulfillmentPercentage,
  PEOBS AS observations,
  PEPAR1 AS classification0,
  PEPAR2 AS classification1,
  PEPAR3 AS classification2,
  PEPAR4 AS classification3,
  PEPAR5 AS classification4,
  PEPAR6 AS classification5,
  PEPAR7 AS classification6,
  PEPZAS AS quantity,
  PEBRUTO AS subtotal,
  PEDESC AS discount,
  PEFLETE AS freight,
  PESEGURO AS insurance,
  PEOTRO AS other,
  PEIVA AS tax,
  PECANT AS total
`;

const selectLines = `
  FPLIN.PLSEQ AS id,
  FPLIN.ISEQ AS productId,
  FINV.ICOD AS productCode,
  FINV.IDESCR AS description,
  PLCANT AS ordered,
  PLSURT AS fulfilled,
  (PLCANT - PLSURT) AS remaining,
  PLUNIDAD AS unit,
  PLASIGNADO AS assigned,
  PLSUC AS branch,
  PLPRECI AS price,
  PLCLASE AS classCode,
  PLMONEDA AS currencyId,
  PLASIGNPZAS AS piecesAssignment,
  PLDESC AS discount,
  PLPRPUB AS publicPrice,
  PLSKU AS sku,
  PLCOLOR AS color,
  PLTALLA AS size
`;

const nullableDate = (value: string): string | null => value === '1900-12-31' ? null : value;
const documentKind = (value: number): OrderProps['documentKind'] =>
  value === 1 ? 'order' : value === 4 ? 'quote' : 'unknown';

const toOrder = (row: HeaderRow, lines: OrderLine[]): Order => Order.create({
  id: row.id,
  number: row.number,
  customerOrderNumber: row.customerOrderNumber,
  customer: { id: row.customerId, code: row.customerCode ?? '', name: row.customerName ?? '' },
  documentKind: documentKind(row.documentType),
  status: row.status,
  fulfilledAmount: row.fulfilledAmount,
  branch: row.branch,
  department: row.department,
  dates: {
    orderedAt: nullableDate(row.orderedAt),
    from: nullableDate(row.fromDate),
    dueAt: nullableDate(row.dueAt),
  },
  attention: row.attention,
  termsDays: Number(row.termsDays),
  authorization: row.authorization,
  initial: row.initial === 1,
  warehouse: row.warehouse,
  currencyId: row.currencyId,
  exchangeRate: row.exchangeRate,
  minimumFulfillmentPercentage: row.minimumFulfillmentPercentage,
  observations: row.observations,
  classifications: [
    row.classification0, row.classification1, row.classification2,
    row.classification3, row.classification4, row.classification5, row.classification6,
  ],
  totals: {
    quantity: row.quantity,
    ordered: lines.reduce((total, line) => total + line.ordered, 0),
    fulfilled: lines.reduce((total, line) => total + line.fulfilled, 0),
    remaining: lines.reduce((total, line) => total + line.remaining, 0),
    subtotal: row.subtotal,
    discount: row.discount,
    freight: row.freight,
    insurance: row.insurance,
    other: row.other,
    tax: row.tax,
    total: row.total,
  },
  lines,
});

const headerAssignments: Record<string, string> = {
  customerId: 'CLISEQ', customerOrderNumber: 'PENUMELLOS', orderedAt: 'PEFECHA',
  from: 'PEDESDE', dueAt: 'PEVENCE', branch: 'PESUCURSAL', department: 'PEDEPTO',
  attentionCode: 'PEPAR1', termsDays: 'PEPLAZO', warehouse: 'PEALMACEN',
  currencyId: 'PEMONEDA', initial: 'PEINICIAL', observations: 'PEOBS', status: 'PESTATUS',
};

export class LegacyMysqlOrdersDataSource implements OrdersDataSource {
  private async lines(orderId: number): Promise<OrderLine[]> {
    const [rows] = await legacyMysqlPool.execute<LineRow[]>(
      `SELECT ${selectLines}
       FROM FPLIN
       LEFT JOIN FINV ON FPLIN.ISEQ = FINV.ISEQ
       WHERE FPLIN.PESEQ = ?
       ORDER BY FPLIN.PLSEQ`,
      [orderId],
    );
    return rows.map((row) => ({ ...row }));
  }

  async findById(orderId: number): Promise<Order | null> {
    const [rows] = await legacyMysqlPool.execute<HeaderRow[]>(
      `SELECT ${selectHeader}
       FROM FPENC
       LEFT JOIN FCLI ON FPENC.CLISEQ = FCLI.CLISEQ
       WHERE FPENC.PESEQ = ?
       LIMIT 1`,
      [orderId],
    );
    const row = rows[0];
    return row === undefined ? null : toOrder(row, await this.lines(orderId));
  }

  async search(criteria: OrderSearchCriteria): Promise<OrderSearchResult> {
    const conditions = ['PESPEDIDO IN (1, 4)'];
    const parameters: Array<string | number> = [];
    if (criteria.query !== undefined) {
      conditions.push('(UPPER(PENUM) LIKE UPPER(?) OR UPPER(PENUMELLOS) LIKE UPPER(?) OR UPPER(CLICOD) LIKE UPPER(?) OR UPPER(CLINOM) LIKE UPPER(?))');
      parameters.push(...Array(4).fill(`%${criteria.query}%`));
    }
    if (criteria.status !== undefined) { conditions.push('PESTATUS = ?'); parameters.push(criteria.status); }
    if (criteria.customerCode !== undefined) { conditions.push('CLICOD = ?'); parameters.push(criteria.customerCode); }
    if (criteria.from !== undefined) { conditions.push('PEFECHA >= ?'); parameters.push(criteria.from); }
    if (criteria.to !== undefined) { conditions.push('PEFECHA <= ?'); parameters.push(criteria.to); }
    const where = conditions.join(' AND ');
    const [rows] = await legacyMysqlPool.execute<HeaderRow[]>(
      `SELECT ${selectHeader}
       FROM FPENC
       LEFT JOIN FCLI ON FPENC.CLISEQ = FCLI.CLISEQ
       WHERE ${where}
       ORDER BY PENUM DESC, FPENC.PESEQ DESC
       LIMIT ? OFFSET ?`,
      [...parameters, criteria.limit, criteria.offset],
    );
    const [countRows] = await legacyMysqlPool.execute<CountRow[]>(
      `SELECT COUNT(*) AS total FROM FPENC LEFT JOIN FCLI ON FPENC.CLISEQ = FCLI.CLISEQ WHERE ${where}`,
      parameters,
    );
    return { items: rows.map((row) => toOrder(row, [])), total: countRows[0]?.total ?? 0 };
  }

  async findAdjacent(orderId: number, direction: OrderNavigationDirection): Promise<Order | null> {
    const [currentRows] = await legacyMysqlPool.execute<IdNumberRow[]>(
      'SELECT PESEQ AS id, PENUM AS number FROM FPENC WHERE PESEQ = ? LIMIT 1', [orderId],
    );
    const current = currentRows[0];
    if (current === undefined) return null;
    const operator = direction === 'previous' ? '<' : '>';
    const order = direction === 'previous' ? 'DESC' : 'ASC';
    const [rows] = await legacyMysqlPool.execute<IdNumberRow[]>(
      `SELECT PESEQ AS id, PENUM AS number FROM FPENC
       WHERE PESPEDIDO IN (1, 4) AND PENUM ${operator} ?
       ORDER BY PENUM ${order}, PESEQ ${order} LIMIT 1`, [current.number],
    );
    return rows[0] === undefined ? null : this.findById(rows[0].id);
  }

  async numberExists(number: string): Promise<boolean> {
    const [rows] = await legacyMysqlPool.execute<ExistsRow[]>(
      'SELECT 1 AS found FROM FPENC WHERE PENUM = ? LIMIT 1', [number],
    );
    return rows.length > 0;
  }

  async customerExists(customerId: number): Promise<boolean> {
    const [rows] = await legacyMysqlPool.execute<ExistsRow[]>(
      'SELECT 1 AS found FROM FCLI WHERE CLISEQ = ? LIMIT 1', [customerId],
    );
    return rows.length > 0;
  }

  private async insertLines(
    connection: PoolConnection,
    orderId: number,
    customerId: number,
    currencyId: number,
    lines: OrderLineWriteValues[],
  ): Promise<void> {
    for (const line of lines) {
      const [productRows] = await connection.execute<ProductWriteRow[]>(
        'SELECT IUM AS unit, IPORCIVA AS taxPercentage FROM FINV WHERE ISEQ = ? LIMIT 1',
        [line.productId],
      );
      const product = productRows[0];
      if (product === undefined) throw new Error(`No existe el producto ${line.productId}`);
      await connection.execute<ResultSetHeader>(
        `INSERT INTO FPLIN
          (PLTIPMV, PLCANT, PLPRECI, PLSURT, PLASIGNADO, PLDESC,
           PLFACTOR, PLUNIDAD, PLMONEDA, CLISEQ, ISEQ, PESEQ)
         VALUES ('P', ?, ?, 0, 0, ?, 1, ?, ?, ?, ?, ?)`,
        [line.quantity, line.price, line.discount ?? 0, product.unit, currencyId, customerId, line.productId, orderId],
      );
      await connection.execute<ResultSetHeader>(
        'UPDATE FINV SET IPEDCLI = IPEDCLI + ? WHERE ISEQ = ?',
        [line.quantity, line.productId],
      );
    }
  }

  private async recalculate(connection: PoolConnection, orderId: number): Promise<void> {
    await connection.execute<ResultSetHeader>(
      `UPDATE FPENC SET
         PEPZAS = (SELECT COALESCE(SUM(PLCANT), 0) FROM FPLIN WHERE PESEQ = ?),
         PEBRUTO = (SELECT COALESCE(SUM(PLCANT * PLPRECI), 0) FROM FPLIN WHERE PESEQ = ?),
         PEDESC = (SELECT COALESCE(SUM(PLCANT * PLPRECI * PLDESC / 100), 0) FROM FPLIN WHERE PESEQ = ?),
         PEIVA = (SELECT COALESCE(SUM((PLCANT * PLPRECI * (1 - PLDESC / 100)) * FINV.IPORCIVA / 100), 0)
                  FROM FPLIN LEFT JOIN FINV ON FPLIN.ISEQ = FINV.ISEQ WHERE FPLIN.PESEQ = ?)
       WHERE PESEQ = ?`,
      [orderId, orderId, orderId, orderId, orderId],
    );
    await connection.execute<ResultSetHeader>(
      'UPDATE FPENC SET PECANT = PEBRUTO - PEDESC + PEFLETE + PESEGURO + PEOTRO + PEIVA WHERE PESEQ = ?',
      [orderId],
    );
  }

  async create(values: OrderCreateValues): Promise<Order> {
    const connection = await legacyMysqlPool.getConnection();
    try {
      await connection.beginTransaction();
      const [result] = await connection.execute<ResultSetHeader>(
        `INSERT INTO FPENC
          (PENUM, PENUMELLOS, CLISEQ, PECLINO, PEFECHA, PEDESDE, PEVENCE,
           PESPEDIDO, PESTATUS, PESUCURSAL, PEDEPTO, PEPAR1, PEPLAZO,
           PEALMACEN, PEMONEDA, PEFACTOR, PEINICIAL, PEOBS, PEMULTICIA)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, '', ?, ?, ?, ?, ?, ?, 1, ?, ?, 1)`,
        [values.number, values.customerOrderNumber ?? '', values.customerId, String(values.customerId),
          values.orderedAt, values.from ?? values.orderedAt, values.dueAt ?? values.orderedAt,
          values.branch ?? 0, values.department ?? '', values.attentionCode ?? '', values.termsDays ?? 0,
          values.warehouse ?? '01', values.currencyId ?? 1, values.initial ? 1 : 0, values.observations ?? ''],
      );
      await this.insertLines(connection, result.insertId, values.customerId, values.currencyId ?? 1, values.lines);
      await this.recalculate(connection, result.insertId);
      await connection.execute<ResultSetHeader>(
        'UPDATE FCLI SET CLIULTPED = ? WHERE CLISEQ = ?',
        [values.orderedAt, values.customerId],
      );
      await connection.execute<ResultSetHeader>(
        'INSERT INTO FCOMENT (COMSEQFACT) VALUES (?)',
        [10_000_000 + result.insertId],
      );
      await connection.commit();
      const created = await this.findById(result.insertId);
      if (created === null) throw new Error('No fue posible recuperar el pedido creado');
      return created;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { connection.release(); }
  }

  async update(orderId: number, values: OrderUpdateValues): Promise<Order | null> {
    const connection = await legacyMysqlPool.getConnection();
    try {
      await connection.beginTransaction();
      const [exists] = await connection.execute<ExistsRow[]>(
        'SELECT 1 AS found FROM FPENC WHERE PESEQ = ? LIMIT 1 FOR UPDATE', [orderId],
      );
      if (exists.length === 0) { await connection.rollback(); return null; }
      const entries = Object.entries(values).filter(([key, value]) =>
        key !== 'lines' && key !== 'classifications' && value !== undefined);
      const assignments = entries.map(([key]) => `${headerAssignments[key] ?? key} = ?`);
      const parameters = entries.map(([, value]) => typeof value === 'boolean' ? (value ? 1 : 0) : value) as Array<string | number>;
      if (values.classifications !== undefined) {
        values.classifications.slice(0, 7).forEach((value, index) => {
          assignments.push(`PEPAR${index + 1} = ?`); parameters.push(value);
        });
      }
      if (assignments.length > 0) {
        await connection.execute<ResultSetHeader>(
          `UPDATE FPENC SET ${assignments.join(', ')} WHERE PESEQ = ?`, [...parameters, orderId],
        );
      }
      if (values.lines !== undefined) {
        const [fulfilled] = await connection.execute<FulfilledRow[]>(
          'SELECT COALESCE(SUM(PLSURT), 0) AS fulfilled FROM FPLIN WHERE PESEQ = ?', [orderId],
        );
        if ((fulfilled[0]?.fulfilled ?? 0) > 0) throw new Error('No se pueden sustituir partidas surtidas');
        const current = await this.findById(orderId);
        if (current === null) throw new Error('Pedido no encontrado');
        const primitive = current.toPrimitives();
        const [pendingLines] = await connection.execute<PendingLineRow[]>(
          `SELECT ISEQ AS productId, SUM(GREATEST(PLCANT - PLSURT, 0)) AS pending
           FROM FPLIN WHERE PESEQ = ? GROUP BY ISEQ`,
          [orderId],
        );
        for (const line of pendingLines) {
          await connection.execute<ResultSetHeader>(
            'UPDATE FINV SET IPEDCLI = GREATEST(IPEDCLI - ?, 0) WHERE ISEQ = ?',
            [line.pending, line.productId],
          );
        }
        await connection.execute<ResultSetHeader>('DELETE FROM FPLIN WHERE PESEQ = ?', [orderId]);
        await this.insertLines(connection, orderId, values.customerId ?? primitive.customer.id,
          primitive.currencyId, values.lines);
      }
      await this.recalculate(connection, orderId);
      await connection.commit();
      return this.findById(orderId);
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { connection.release(); }
  }

  async delete(orderId: number): Promise<DeleteOrderResult> {
    const connection = await legacyMysqlPool.getConnection();
    try {
      await connection.beginTransaction();
      const [orders] = await connection.execute<DeleteHeaderRow[]>(
        `SELECT PESEQ AS id, PENUM AS number, CLISEQ AS customerId
         FROM FPENC WHERE PESEQ = ? LIMIT 1 FOR UPDATE`, [orderId],
      );
      const order = orders[0];
      if (order === undefined) { await connection.rollback(); return { status: 'not-found' }; }
      const [invoices] = await connection.execute<ExistsRow[]>(
        'SELECT 1 AS found FROM FDOC WHERE DREFER = ? LIMIT 1', [order.number],
      );
      if (invoices.length > 0) { await connection.rollback(); return { status: 'in-use', relation: 'fdoc' }; }
      const [fulfilled] = await connection.execute<FulfilledRow[]>(
        'SELECT COALESCE(SUM(PLSURT), 0) AS fulfilled FROM FPLIN WHERE PESEQ = ?', [orderId],
      );
      if ((fulfilled[0]?.fulfilled ?? 0) > 0) { await connection.rollback(); return { status: 'in-use', relation: 'fplin.PLSURT' }; }
      const [pendingLines] = await connection.execute<PendingLineRow[]>(
        `SELECT ISEQ AS productId, SUM(GREATEST(PLCANT - PLSURT, 0)) AS pending
         FROM FPLIN WHERE PESEQ = ? GROUP BY ISEQ`,
        [orderId],
      );
      for (const line of pendingLines) {
        await connection.execute<ResultSetHeader>(
          'UPDATE FINV SET IPEDCLI = GREATEST(IPEDCLI - ?, 0) WHERE ISEQ = ?',
          [line.pending, line.productId],
        );
      }
      await connection.execute<ResultSetHeader>('DELETE FROM FCOMENT WHERE COMSEQFACT = ?', [10_000_000 + orderId]);
      await connection.execute<ResultSetHeader>('DELETE FROM FPLIN WHERE PESEQ = ?', [orderId]);
      await connection.execute<ResultSetHeader>('DELETE FROM FPENC WHERE PESEQ = ?', [orderId]);
      await connection.execute<ResultSetHeader>(
        `UPDATE FCLI SET CLIULTPED = COALESCE(
           (SELECT MAX(PEFECHA) FROM FPENC WHERE CLISEQ = ?), '1900-12-31'
         ) WHERE CLISEQ = ?`,
        [order.customerId, order.customerId],
      );
      await connection.commit();
      return { status: 'deleted' };
    } catch (error) {
      await connection.rollback(); throw error;
    } finally { connection.release(); }
  }
}
