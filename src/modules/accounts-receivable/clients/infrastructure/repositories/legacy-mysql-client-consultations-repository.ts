import type { RowDataPacket } from 'mysql2';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type {
  ClientAnnualSale,
  ClientAnnualSalesSummaryItem,
  ClientBranchSale,
  ClientConsultationIdentity,
  ClientCtOrderedProduct,
  ClientCtSoldProduct,
  ClientEdiSale,
  ClientInvoice,
  ClientOrder,
  ClientOrderedProduct,
  ClientQuotedProduct,
  ClientSoldProduct,
  ClientSoldProductDetail,
  ClientWorkInProgressItem,
} from '../../domain/entities/client-consultation.js';
import type {
  ClientConsultationCriteria,
  ClientConsultationResult,
  ClientConsultationsRepository,
} from '../../domain/repositories/client-consultations-repository.js';

interface ClientRow extends RowDataPacket, ClientConsultationIdentity {}

interface CountRow extends RowDataPacket {
  total: number;
}

type DataRow<T> = RowDataPacket & T;

interface InvoiceRow extends Omit<ClientInvoice, 'affectsAccountsReceivable'> {
  affectsAccountsReceivable: number;
}

export class LegacyMysqlClientConsultationsRepository implements ClientConsultationsRepository {
  private async findClient(clientId: number): Promise<ClientConsultationIdentity | null> {
    const [rows] = await legacyMysqlPool.execute<ClientRow[]>(`
      SELECT
        CLISEQ AS id,
        CLICOD AS code,
        CLINOM AS name,
        CLISACT AS currentBalance
      FROM fcli
      WHERE CLISEQ = ?
      LIMIT 1
    `, [clientId]);

    return rows[0] ?? null;
  }

  private async search<TRow, TOutput = TRow>(
    criteria: ClientConsultationCriteria,
    selectSql: string,
    countSql: string,
    parameters: Array<number | string>,
    map: (row: DataRow<TRow>) => TOutput = (row) => row as unknown as TOutput,
  ): Promise<ClientConsultationResult<TOutput> | null> {
    const client = await this.findClient(criteria.clientId);
    if (client === null) return null;

    const [[rows], [countRows]] = await Promise.all([
      legacyMysqlPool.execute<DataRow<TRow>[]>(selectSql, [
        ...parameters,
        criteria.limit,
        criteria.offset,
      ]),
      legacyMysqlPool.execute<CountRow[]>(countSql, parameters),
    ]);

    return {
      client,
      items: rows.map(map),
      total: countRows[0]?.total ?? 0,
    };
  }

  findInvoices(
    criteria: ClientConsultationCriteria,
  ): Promise<ClientConsultationResult<ClientInvoice> | null> {
    return this.search<InvoiceRow, ClientInvoice>(criteria, `
      SELECT
        d.DSEQ AS id,
        d.DNUM AS number,
        DATE(d.DFECHA) AS date,
        DATE(d.DVENCE) AS dueDate,
        d.DCANTF AS amount,
        d.DREFER AS reference,
        NULLIF(DATE(d.DFECHAPAGO), '1900-12-31') AS paymentDate,
        d.DESCXC AS affectsAccountsReceivable,
        d.DTALON AS deliveryReceipt,
        NULLIF(DATE(d.DFECHATALON), '1900-12-31') AS deliveryReceiptDate,
        d.DRUTA AS route,
        d.DTIPOC AS exchangeRate,
        d.DMONEDA AS currencyId,
        d.DSUCURSAL AS branch,
        d.DREFERELLOS AS customerOrder,
        d.DDEPTO AS department,
        NULLIF(DATE(d.DFECHARUTA), '1900-12-31') AS routeDate,
        d.DPAR1 AS parameter1,
        NULLIF(DATE(d.DFECHAPROGR), '1900-12-31') AS scheduledDate
      FROM fdoc d
      WHERE d.CLISEQ = ?
        AND d.DESFACT = 1
        AND d.DEST = 0
        AND d.DMULTICIA = 1
      ORDER BY d.DSEQ
      LIMIT ? OFFSET ?
    `, `
      SELECT COUNT(*) AS total
      FROM fdoc d
      WHERE d.CLISEQ = ?
        AND d.DESFACT = 1
        AND d.DEST = 0
        AND d.DMULTICIA = 1
    `, [criteria.clientId], (row) => ({
      ...row,
      affectsAccountsReceivable: row.affectsAccountsReceivable === 1,
    }));
  }

  findOrders(
    criteria: ClientConsultationCriteria,
  ): Promise<ClientConsultationResult<ClientOrder> | null> {
    return this.search(criteria, `
      SELECT
        p.PESEQ AS id,
        p.PENUM AS number,
        DATE(p.PEFECHA) AS date,
        DATE(p.PEVENCE) AS dueDate,
        p.PEDESDE AS source,
        p.PESURT AS fulfilled,
        p.PENUMELLOS AS customerOrder,
        p.PEPAR7 AS parameter7,
        p.PECANT AS total,
        p.PEBRUTO AS gross,
        p.PEDESC AS discount,
        p.PEPAR9 AS parameter9
      FROM fpenc p
      WHERE p.CLISEQ = ?
        AND p.PEMULTICIA = 1
      ORDER BY p.PESEQ
      LIMIT ? OFFSET ?
    `, `
      SELECT COUNT(*) AS total
      FROM fpenc p
      WHERE p.CLISEQ = ?
        AND p.PEMULTICIA = 1
    `, [criteria.clientId]);
  }

  findOrderedProducts(
    criteria: ClientConsultationCriteria,
  ): Promise<ClientConsultationResult<ClientOrderedProduct> | null> {
    return this.search(criteria, `
      SELECT
        l.PLSEQ AS id,
        i.ICOD AS productCode,
        i.IDESCR AS description,
        l.PLCANT AS orderedQuantity,
        l.PLSURT AS fulfilledQuantity,
        i.ISTKACT AS stock,
        i.IASIGNADO AS inventoryAssigned,
        p.PENUM AS orderNumber,
        p.PEDESDE AS source,
        p.PENUMELLOS AS customerOrder,
        l.PLSUC AS branch,
        i.IPEDPRV AS supplierOrder,
        p.PEPAR8 AS parameter8,
        i.IEAN AS barcode,
        l.PLCLASE AS productClass,
        CAST(NULLIF(l.PLASIGNPZAS, '') AS DECIMAL(18, 3)) AS assignedPieces,
        l.PLASIGNADO AS assignedQuantity
      FROM fplin l
      LEFT JOIN finv i ON i.ISEQ = l.ISEQ
      LEFT JOIN fpenc p ON p.PESEQ = l.PESEQ
      WHERE l.CLISEQ = ?
        AND p.PESPEDIDO = 1
        AND p.PEMULTICIA = 1
      ORDER BY l.PLSEQ
      LIMIT ? OFFSET ?
    `, `
      SELECT COUNT(*) AS total
      FROM fplin l
      LEFT JOIN fpenc p ON p.PESEQ = l.PESEQ
      WHERE l.CLISEQ = ?
        AND p.PESPEDIDO = 1
        AND p.PEMULTICIA = 1
    `, [criteria.clientId]);
  }

  findQuotedProducts(
    criteria: ClientConsultationCriteria,
  ): Promise<ClientConsultationResult<ClientQuotedProduct> | null> {
    return this.search(criteria, `
      SELECT
        l.PLSEQ AS id,
        i.ICOD AS productCode,
        i.IDESCR AS description,
        l.PLCANT AS quotedQuantity,
        l.PLSURT AS fulfilledQuantity,
        i.ISTKACT AS stock,
        i.IASIGNADO AS inventoryAssigned,
        l.PLASIGNADO AS assignedQuantity,
        p.PENUM AS quoteNumber,
        DATE(p.PEFECHA) AS quoteDate,
        p.PENUMELLOS AS customerQuote,
        l.PLPRECI AS unitPrice,
        CAST(NULLIF(l.PLASIGNPZAS, '') AS DECIMAL(18, 3)) AS assignedPieces
      FROM fplin l
      LEFT JOIN finv i ON i.ISEQ = l.ISEQ
      LEFT JOIN fpenc p ON p.PESEQ = l.PESEQ
      WHERE l.CLISEQ = ?
        AND p.PESPEDIDO = 4
        AND p.PEMULTICIA = 1
      ORDER BY l.PLSEQ
      LIMIT ? OFFSET ?
    `, `
      SELECT COUNT(*) AS total
      FROM fplin l
      LEFT JOIN fpenc p ON p.PESEQ = l.PESEQ
      WHERE l.CLISEQ = ?
        AND p.PESPEDIDO = 4
        AND p.PEMULTICIA = 1
    `, [criteria.clientId]);
  }

  findSoldProducts(
    criteria: ClientConsultationCriteria,
  ): Promise<ClientConsultationResult<ClientSoldProduct> | null> {
    return this.search(criteria, `
      SELECT
        a.AISEQ AS id,
        i.ICOD AS productCode,
        i.IDESCR AS description,
        a.AICANTF AS quantity,
        a.AIPRECIO AS unitPrice
      FROM faxinv a
      LEFT JOIN finv i ON i.ISEQ = a.ISEQ
      LEFT JOIN fdoc d ON d.DSEQ = a.DSEQ
      WHERE a.CLISEQ = ?
        AND a.CLISEQ <> 0
        AND d.DEST = 0
        AND d.DMULTICIA = 1
        AND a.AIMES = 1
        AND d.DESFACT = 1
        AND d.DOTROSTXT <> 'POS'
        AND d.DFECHA >= '1900-12-31'
        AND d.DCONTROLPOS = 0
      ORDER BY a.AISEQ
      LIMIT ? OFFSET ?
    `, `
      SELECT COUNT(*) AS total
      FROM faxinv a
      LEFT JOIN fdoc d ON d.DSEQ = a.DSEQ
      WHERE a.CLISEQ = ?
        AND a.CLISEQ <> 0
        AND d.DEST = 0
        AND d.DMULTICIA = 1
        AND a.AIMES = 1
        AND d.DESFACT = 1
        AND d.DOTROSTXT <> 'POS'
        AND d.DFECHA >= '1900-12-31'
        AND d.DCONTROLPOS = 0
    `, [criteria.clientId]);
  }

  findSoldProductDetails(
    criteria: ClientConsultationCriteria,
  ): Promise<ClientConsultationResult<ClientSoldProductDetail> | null> {
    return this.search(criteria, `
      SELECT
        a.AISEQ AS id,
        i.ICOD AS productCode,
        i.IDESCR AS description,
        a.AICANTF AS quantity,
        a.AIPRECIO AS unitPrice,
        d.DNUM AS documentNumber,
        DATE(d.DFECHA) AS date,
        d.DTIPOC2 AS secondaryExchangeRate,
        a.AIDESCTO AS discount,
        d.DREFERELLOS AS customerOrder,
        CAST(NULLIF(a.AIOTROS, '') AS DECIMAL(18, 4)) AS otherAmount,
        d.DMONEDA AS currencyId,
        a.AICOSTO AS cost,
        d.DPAR0 AS clientCodeSnapshot,
        d.DTALON AS deliveryReceipt,
        NULLIF(DATE(d.DFECHATALON), '1900-12-31') AS deliveryReceiptDate,
        CAST(NULLIF(a.AIPZAS, '') AS DECIMAL(18, 3)) AS pieces,
        a.AISUCURSAL AS branch
      FROM faxinv a
      LEFT JOIN finv i ON i.ISEQ = a.ISEQ
      LEFT JOIN fdoc d ON d.DSEQ = a.DSEQ
      WHERE a.CLISEQ = ?
        AND a.CLISEQ <> 0
        AND d.DEST = 0
        AND d.DMULTICIA = 1
        AND a.AIMES = 1
        AND d.DESFACT = 1
        AND d.DOTROSTXT <> 'POS'
        AND d.DFECHA >= '1900-12-31'
        AND d.DCONTROLPOS = 0
      ORDER BY a.AISEQ
      LIMIT ? OFFSET ?
    `, `
      SELECT COUNT(*) AS total
      FROM faxinv a
      LEFT JOIN fdoc d ON d.DSEQ = a.DSEQ
      WHERE a.CLISEQ = ?
        AND a.CLISEQ <> 0
        AND d.DEST = 0
        AND d.DMULTICIA = 1
        AND a.AIMES = 1
        AND d.DESFACT = 1
        AND d.DOTROSTXT <> 'POS'
        AND d.DFECHA >= '1900-12-31'
        AND d.DCONTROLPOS = 0
    `, [criteria.clientId]);
  }

  findAnnualSales(
    criteria: ClientConsultationCriteria,
  ): Promise<ClientConsultationResult<ClientAnnualSale> | null> {
    return this.search(criteria, `
      SELECT
        a.AISEQ AS id,
        DATE(d.DFECHA) AS date,
        i.ICOD AS productCode,
        i.IDESCR AS description,
        a.AICANTF AS quantity,
        a.AIPRECIO AS unitPrice,
        d.DPORCIVA AS vatPercentage
      FROM faxinv a
      LEFT JOIN fdoc d ON d.DSEQ = a.DSEQ
      LEFT JOIN finv i ON i.ISEQ = a.ISEQ
      WHERE a.CLISEQ = ?
        AND d.DFECHA >= '1900-12-31'
        AND a.AIMES = 1
        AND d.DEST = 0
        AND d.DOTROSTXT <> 'POS'
        AND d.DCONTROLPOS = 0
      ORDER BY a.AISEQ
      LIMIT ? OFFSET ?
    `, `
      SELECT COUNT(*) AS total
      FROM faxinv a
      LEFT JOIN fdoc d ON d.DSEQ = a.DSEQ
      WHERE a.CLISEQ = ?
        AND d.DFECHA >= '1900-12-31'
        AND a.AIMES = 1
        AND d.DEST = 0
        AND d.DOTROSTXT <> 'POS'
        AND d.DCONTROLPOS = 0
    `, [criteria.clientId]);
  }

  findAnnualSalesSummary(
    criteria: ClientConsultationCriteria,
  ): Promise<ClientConsultationResult<ClientAnnualSalesSummaryItem> | null> {
    return this.search(criteria, `
      SELECT
        d.DSEQ AS id,
        DATE(d.DFECHA) AS date,
        d.DBRUTO AS gross,
        d.DDESC AS discount
      FROM fdoc d
      WHERE d.CLISEQ = ?
        AND d.DESFACT = 1
        AND d.DEST = 0
        AND d.DCONTROLPOS = 0
      ORDER BY d.DSEQ
      LIMIT ? OFFSET ?
    `, `
      SELECT COUNT(*) AS total
      FROM fdoc d
      WHERE d.CLISEQ = ?
        AND d.DESFACT = 1
        AND d.DEST = 0
        AND d.DCONTROLPOS = 0
    `, [criteria.clientId]);
  }

  findSalesByBranch(
    criteria: ClientConsultationCriteria,
  ): Promise<ClientConsultationResult<ClientBranchSale> | null> {
    return this.search(criteria, `
      SELECT
        a.AISEQ AS id,
        i.ICOD AS productCode,
        i.IDESCR AS description,
        a.AICANTF AS quantity,
        a.AIPRECIO AS unitPrice,
        a.AISUCURSAL AS branch
      FROM faxinv a
      LEFT JOIN finv i ON i.ISEQ = a.ISEQ
      LEFT JOIN fdoc d ON d.DSEQ = a.DSEQ
      WHERE a.CLISEQ = ?
        AND a.CLISEQ <> 0
        AND d.DEST = 0
        AND d.DMULTICIA = 1
        AND a.AIMES = 1
        AND d.DFECHA >= '1900-12-31'
        AND d.DCONTROLPOS = 0
      ORDER BY a.AISEQ
      LIMIT ? OFFSET ?
    `, `
      SELECT COUNT(*) AS total
      FROM faxinv a
      LEFT JOIN fdoc d ON d.DSEQ = a.DSEQ
      WHERE a.CLISEQ = ?
        AND a.CLISEQ <> 0
        AND d.DEST = 0
        AND d.DMULTICIA = 1
        AND a.AIMES = 1
        AND d.DFECHA >= '1900-12-31'
        AND d.DCONTROLPOS = 0
    `, [criteria.clientId]);
  }

  findEdiSales(
    criteria: ClientConsultationCriteria,
  ): Promise<ClientConsultationResult<ClientEdiSale> | null> {
    return this.search(criteria, `
      SELECT
        v.VSSEQ AS id,
        i.ICOD AS productCode,
        i.IDESCR AS description,
        NULLIF(DATE(e.EDFECHADEL), '1900-12-31') AS deliveryDate,
        v.VSCANTQA AS requestedQuantity,
        v.VSCANTQS AS suppliedQuantity,
        v.VSSUCURSAL AS branch,
        v.VSTIPO AS type
      FROM fvsucursal v
      LEFT JOIN finv i ON i.ISEQ = v.ISEQ
      LEFT JOIN fedi e ON e.EDSEQ = v.EDSEQ
      WHERE v.CLISEQ = ?
      ORDER BY v.VSSEQ
      LIMIT ? OFFSET ?
    `, `
      SELECT COUNT(*) AS total
      FROM fvsucursal v
      WHERE v.CLISEQ = ?
    `, [criteria.clientId]);
  }

  async findWorkInProgress(
    criteria: ClientConsultationCriteria,
  ): Promise<ClientConsultationResult<ClientWorkInProgressItem> | null> {
    const client = await this.findClient(criteria.clientId);
    if (client === null) return null;

    return this.search(criteria, `
      SELECT
        t.TKTSEQ AS id,
        t.TKTNUMOP AS operationNumber,
        t.TKTART AS article,
        t.TKTCANT AS quantity,
        t.TKTSURT AS fulfilledQuantity,
        t.TKTPROD AS productCode,
        NULLIF(DATE(t.TKTINICIO), '1900-12-31') AS startDate,
        NULLIF(DATE(t.TKTDATEEND), '1900-12-31') AS endDate,
        t.TKTPAR0 AS parameter0,
        t.TKTCLI AS clientCode,
        t.TKTMAQUINA AS machine,
        t.TKTPEDIDO AS orderNumber
      FROM ftikets t
      WHERE t.TKTCLI = ?
      ORDER BY t.TKTSEQ
      LIMIT ? OFFSET ?
    `, `
      SELECT COUNT(*) AS total
      FROM ftikets t
      WHERE t.TKTCLI = ?
    `, [client.code]);
  }

  findCtOrderedProducts(
    criteria: ClientConsultationCriteria,
  ): Promise<ClientConsultationResult<ClientCtOrderedProduct> | null> {
    return this.search(criteria, `
      SELECT
        l.PLSEQ AS id,
        l.PLCANT AS orderedQuantity,
        l.PLSURT AS fulfilledQuantity,
        i.ICOD AS productCode,
        i.IDESCR AS description,
        p.PENUM AS orderNumber,
        p.PENUMELLOS AS customerOrder,
        p.PEDESDE AS source,
        DATE(p.PEVENCE) AS dueDate
      FROM fplin l
      LEFT JOIN finv i ON i.ISEQ = l.ISEQ
      LEFT JOIN fpenc p ON p.PESEQ = l.PESEQ
      WHERE l.CLISEQ = ?
        AND p.PEMULTICIA = 1
      ORDER BY l.PLSEQ
      LIMIT ? OFFSET ?
    `, `
      SELECT COUNT(*) AS total
      FROM fplin l
      LEFT JOIN fpenc p ON p.PESEQ = l.PESEQ
      WHERE l.CLISEQ = ?
        AND p.PEMULTICIA = 1
    `, [criteria.clientId]);
  }

  findCtSoldProducts(
    criteria: ClientConsultationCriteria,
  ): Promise<ClientConsultationResult<ClientCtSoldProduct> | null> {
    return this.findSoldProducts(criteria);
  }
}
