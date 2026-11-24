import type { RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type {
  ReceiptSupplierChangeSource, ReceiptSupplierReplacement, ReceiptSupplierSearch,
} from '../../domain/datasources/purchase-reception-supplier-change-data-source.js';

interface Header extends RowDataPacket {
  id: number;
  number: string;
  supplierId: number;
  supplierCode: string;
  supplierName: string;
  type: string;
  paidStatus: number;
  invoiceFlag: number;
  inventoryFlag: number;
  currency: number;
  exchangeRate: number;
  amount: number;
  total: number;
  cancelled: number;
  date: string;
  dueAt: string | null;
  supplierReference: string;
  orderNumber: string;
}

interface Ledger extends RowDataPacket {
  id: number;
  type: string;
  supplierId: number;
  amount: number;
  exchangeRate: number;
  date: string;
  policyNumber: string;
  bankId: number;
  userId: number;
}

const escapePrefix = (value: string) => value.replace(/[!_%]/g, '!$&') + '%';
const cents = (value: number) => Math.round(value * 100);

export class MysqlPurchaseReceptionSupplierChangeSource {
  async enabled() {
    const [[row]] = await legacyMysqlPool.execute<(RowDataPacket & { enabled: number })[]>(
      `SELECT CIACLAVES=0 AND EXISTS (
         SELECT 1 FROM FHELP WHERE HKEY='ERECEPC#13/44' AND HUSER0=1
       ) AS enabled FROM FCIA WHERE CIASEQ=1 AND CIAALIAS='TUVANSA'`,
    );
    return row?.enabled === 1;
  }

  async receipt(receiptId: number): Promise<ReceiptSupplierChangeSource | null> {
    const [[header]] = await legacyMysqlPool.execute<Header[]>(
      `SELECT d.DSEQ AS id,d.DNUM AS number,d.PRVSEQ AS supplierId,TRIM(p.PRVCOD) AS supplierCode,p.PRVNOM AS supplierName,
         d.DITIPMV AS type,d.DESCXC AS paidStatus,d.DESFACT AS invoiceFlag,d.DESINV AS inventoryFlag,d.DMONEDA AS currency,
         d.DTIPOC AS exchangeRate,d.DCANT AS amount,d.DCANTF AS total,d.DCANCELADA AS cancelled,
         DATE_FORMAT(d.DFECHA,'%Y-%m-%d') AS date,NULLIF(DATE_FORMAT(d.DVENCE,'%Y-%m-%d'),'1900-12-31') AS dueAt,
         d.DREFERELLOS AS supplierReference,d.DREFER AS orderNumber
       FROM FDOC d JOIN FPRV p ON p.PRVSEQ=d.PRVSEQ
       WHERE d.DSEQ=? AND d.DMULTICIA=1 AND d.DEST=0 AND (d.DESFACT IN (2,3) OR d.DESCXC=2)`, [receiptId],
    );
    if (!header) return null;
    const [ledger] = await legacyMysqlPool.execute<Ledger[]>(
      `SELECT ASEQ AS id,ATIPMV AS type,PRVSEQ AS supplierId,ACANT AS amount,ATIPOC AS exchangeRate,
         DATE_FORMAT(AFECHA,'%Y-%m-%d') AS date,TRIM(APOLIZA) AS policyNumber,BASEQ AS bankId,AUSEQ AS userId
       FROM FAX WHERE DSEQ=? ORDER BY ASEQ`, [receiptId],
    );
    const [original] = ledger;
    let reason: string | null = null;
    if (header.cancelled || ledger.some(({ type }) => type === 'K')) reason = 'La recepción está cancelada.';
    else if (ledger.some(({ type }) => type === 'PP' || type === 'RP')) reason = 'La recepción tiene pagos registrados.';
    else if (ledger.some(({ type }) => type === 'DO')) reason = 'La recepción ya está documentada.';
    else if (!/^RA\d/.test(header.number) || header.type !== 'RA' || header.currency !== 1 || header.exchangeRate !== 1
      || header.inventoryFlag !== 1 || header.invoiceFlag !== 2 || header.paidStatus !== 2) {
      reason = 'El cambio requiere una recepción ordinaria vigente en pesos.';
    } else if (ledger.length !== 1 || original?.type !== 'RA' || original.supplierId !== header.supplierId
      || original.exchangeRate !== 1 || original.bankId || original.date !== header.date || !original.policyNumber
      || header.amount <= 0 || cents(header.amount) !== cents(header.total) || cents(original.amount) !== cents(header.amount)) {
      reason = 'Se requiere un cargo original íntegro con póliza y auxiliar verificables.';
    }

    let supplierAccount = '';
    if (!reason && original) {
      const [posted] = await legacyMysqlPool.execute<Array<RowDataPacket & { account: string }>>(
        `SELECT TRIM(b.BCOD) AS account FROM FPOLIZA p
         JOIN FBANMOV m ON m.POSEQ=p.POSEQ JOIN FBENC b ON b.BSEQ=m.BSEQ
         WHERE p.PONUM=? AND p.POCIA=1 AND p.POAPLICADA=1 AND p.POEST=0 AND p.POFAMILIA='COMPRAS'
           AND m.PRVSEQ=? AND m.BADNUM=? AND m.BAIMPOR=0 AND m.BAIMPORNEG=?
           AND b.BMOVS=1 AND b.BCIA IN (0,1) AND b.BMULTICIA IN (0,1)
           AND NOT EXISTS (SELECT 1 FROM FAX a JOIN FDOC d ON d.DSEQ=a.DSEQ
             WHERE a.APOLIZA=p.PONUM AND a.DSEQ<>? AND d.DMULTICIA=1)`,
        [original.policyNumber, header.supplierId, header.number, header.amount, receiptId],
      );
      supplierAccount = posted.length === 1 ? posted[0]!.account : '';
      if (!supplierAccount) reason = 'No se pudo verificar la cuenta del pasivo en la póliza original.';
    }

    const { id, number, supplierId, supplierCode, supplierName, amount, date, dueAt, supplierReference, orderNumber } = header;
    return {
      reception: { id, number }, originalSupplier: { id: supplierId, code: supplierCode, name: supplierName },
      amount, supplierAccount, reason, version: JSON.stringify([header, ledger, supplierAccount]),
      historicalCharge: original?.type === 'RA' ? {
        id: original.id, date, dueAt, supplierReference, orderNumber, policyNumber: original.policyNumber, userId: original.userId,
      } : null,
    };
  }

  async suppliers({ code, name }: ReceiptSupplierSearch, exact = false): Promise<ReceiptSupplierReplacement[]> {
    if (!code && !name) return [];
    const fields: string[] = [];
    const params: string[] = [];
    if (code) {
      fields.push(exact ? 'PRVCOD=?' : "PRVCOD LIKE ? ESCAPE '!'");
      params.push(exact ? code : escapePrefix(code));
    }
    if (name) {
      fields.push(name.startsWith('*') ? 'LOCATE(UPPER(?),UPPER(PRVNOM))>0' : "PRVNOM LIKE ? ESCAPE '!'");
      params.push(name.startsWith('*') ? name.slice(1) : escapePrefix(name));
    }
    const [rows] = await legacyMysqlPool.execute<Array<RowDataPacket & Omit<ReceiptSupplierReplacement, 'eligible'> & { eligible: number }>>(
      `SELECT PRVSEQ AS id,TRIM(PRVCOD) AS code,PRVNOM AS name,TRIM(PRVCTA) AS account,
         (PRVBAJA='1900-12-31' AND PRVMONEDA=1 AND PRVINTERCIA=0 AND PRVRETIVA=0 AND PRVRETISR=0) AS eligible
       FROM FPRV WHERE PRVSEQ>0 AND PRVMULTICIA IN (0,1) AND ${fields.join(' AND ')}
       ORDER BY PRVCOD,PRVSEQ LIMIT 35`, params,
    );
    return rows.map((row) => ({ ...row, eligible: row.eligible === 1 }));
  }
}
