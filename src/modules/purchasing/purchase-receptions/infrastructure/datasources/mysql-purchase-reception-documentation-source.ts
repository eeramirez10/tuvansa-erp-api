import type { RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type {
  ReceptionDocumentationPreview, ReceptionDocumentationSource,
} from '../../domain/datasources/purchase-reception-documentation-data-source.js';

interface NativeReception extends RowDataPacket {
  id: number;
  number: string;
  date: string | null;
  dueAt: string | null;
  supplierId: number;
  supplierCode: string;
  supplierName: string;
  type: string;
  paidStatus: number;
  status: number;
  cancelled: number;
  currency: number;
  exchangeRate: number;
  amount: number;
  principal: number;
}
interface NativeAuxiliaryRow extends RowDataPacket {
  id: number;
  amount: number;
  type: string;
  paidReference: string;
  date: string;
}

export class MysqlPurchaseReceptionDocumentationSource {
  async enabled(): Promise<boolean> {
    const [rows] = await legacyMysqlPool.execute<(RowDataPacket & { enabled: number })[]>(
      `SELECT (c.CIACLAVES=0
         AND EXISTS(SELECT 1 FROM FTIPMV m WHERE m.TICLA='DO' AND m.TIMULTICIA=0
           AND m.TIMODULO=0 AND m.TIAFCXC=1 AND m.TIAFINV=0 AND m.TIAFVTS=0 AND m.TIAFBCS=0)) AS enabled
       FROM FCIA c WHERE c.CIASEQ=1 AND c.CIAALIAS='TUVANSA'`,
    );
    return rows[0]?.enabled === 1;
  }

  async reception(id: number): Promise<Omit<ReceptionDocumentationSource, 'recorded'> & { nativeRecord: ReceptionDocumentationPreview | null } | null> {
    const [rows] = await legacyMysqlPool.execute<NativeReception[]>(
      `SELECT d.DSEQ AS id,d.DNUM AS number,DATE_FORMAT(d.DFECHA,'%Y-%m-%d') AS date,
         DATE_FORMAT(d.DVENCE,'%Y-%m-%d') AS dueAt,p.PRVSEQ AS supplierId,p.PRVCOD AS supplierCode,p.PRVNOM AS supplierName,
         d.DITIPMV AS type,d.DESCXC AS paidStatus,d.DESFACT AS status,d.DCANCELADA AS cancelled,
         d.DMONEDA AS currency,d.DTIPOC AS exchangeRate,
         d.DCANT AS amount,d.DCANTF AS principal
       FROM FDOC d JOIN FPRV p ON p.PRVSEQ=d.PRVSEQ
       WHERE d.DSEQ=? AND d.DMULTICIA=1 AND d.DEST=0`, [id],
    );
    const header = rows[0];
    if (!header) return null;
    const [auxiliary] = await legacyMysqlPool.execute<NativeAuxiliaryRow[]>(
      `SELECT ASEQ AS id,ACANT AS amount,ATIPMV AS type,AREFPAG AS paidReference,DATE_FORMAT(AFECHA,'%Y-%m-%d') AS date
       FROM FAX WHERE DSEQ=? AND PRVSEQ=? ORDER BY ASEQ`, [id, header.supplierId],
    );
    const original = auxiliary.find(({ type, amount }) => type === 'RA' && amount > 0);
    const negativeDO = auxiliary.filter(({ type, amount, paidReference }) => type === 'DO' && amount < 0 && !paidReference);
    const [settled] = negativeDO;
    let nativeRecord: ReceptionDocumentationPreview | null = null;
    if (negativeDO.length === 1 && settled?.date === header.date && header.type === 'RA') {
      const [documents] = await legacyMysqlPool.execute<(RowDataPacket & { id: number; number: string; amount: number })[]>(
        `SELECT d.DSEQ AS id,d.DNUM AS number,a.ACANT AS amount FROM FDOC d
         JOIN FAX a ON a.DSEQ=d.DSEQ AND a.PRVSEQ=d.PRVSEQ
         WHERE d.DMULTICIA=1 AND d.DEST=0 AND d.PRVSEQ=? AND d.DREFERELLOS=? AND d.DFECHA=? AND d.DVENCE <=> ?
           AND d.DMONEDA=1 AND d.DTIPOC=1 AND a.AFECHA=d.DFECHA AND a.ATIPMV='DO' AND a.ACANT>0 AND a.AREFPAG=?
         ORDER BY a.ASEQ`, [header.supplierId, header.number, header.date, header.dueAt, header.number],
      );
      if (documents.length > 0 && documents.length <= 4 && new Set(documents.map(({ id }) => id)).size === documents.length
        && documents.reduce((total, item) => total + Math.round(item.amount * 100), 0) === Math.round(-settled.amount * 100)) {
        nativeRecord = {
          reception: { id, number: header.number }, amount: -settled.amount, revision: '0'.repeat(64),
          canWrite: false, reason: 'La recepción ya está documentada en PROSCAI.',
          documents: documents.map(({ id, number, amount }) => ({ id, number, amount })),
        };
      }
    }
    let reason: string | null = null;
    if (header.cancelled) {
      reason = 'La recepción ya fue cancelada en PROSCAI.';
    } else if (!/^RA\d/.test(header.number) || header.type !== 'RA' || header.status !== 2 || header.currency !== 1
      || header.exchangeRate !== 1 || !header.date || header.date === '0000-00-00') {
      reason = 'Documenta requiere una recepción ordinaria RA en pesos.';
    } else if (auxiliary.some(({ type }) => type === 'DO')) {
      reason = 'El auxiliar de la recepción ya contiene un movimiento DO en PROSCAI.';
    } else if (!original || auxiliary.length !== 1 || header.paidStatus !== 2 || header.amount <= 0
      || original.amount !== header.amount || header.amount !== header.principal) {
      reason = 'El saldo debe coincidir con el cargo original de la recepción, sin pagos ni ajustes.';
    }
    return {
      id, number: header.number, supplier: { id: header.supplierId, code: header.supplierCode, name: header.supplierName },
      date: header.date, dueAt: header.dueAt === '0000-00-00' ? null : header.dueAt,
      amount: header.amount, reason, version: JSON.stringify([header, auxiliary]), nativeRecord,
    };
  }

  async numberExists(companyId: number, numbers: string[]) {
    const placeholders = numbers.map(() => '?').join(',');
    const [rows] = await legacyMysqlPool.execute<RowDataPacket[]>(
      `SELECT DSEQ FROM FDOC WHERE DMULTICIA=? AND DNUM IN (${placeholders}) LIMIT 1`, [companyId, ...numbers],
    );
    return rows.length > 0;
  }
}
