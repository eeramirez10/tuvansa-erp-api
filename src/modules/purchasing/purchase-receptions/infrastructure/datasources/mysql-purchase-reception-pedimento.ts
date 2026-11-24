import type { RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';

const expenseSlots = ['FLETE1', 'FLETE2', 'AGENTE1', 'AGENTE2', 'DTA', 'OTROS'] as const;
type ExpenseSlot = typeof expenseSlots[number];
type PedimentoField = `PMT${'' | 'PRV' | 'IVA'}${ExpenseSlot}`;

interface PedimentoRow extends RowDataPacket, Record<PedimentoField, string | number | null> {
  number: string;
  date: string | null;
  customsOffice: string;
  incrementables: number;
  PMTPASIVOS: number;
}

export const customsReception = `receipt.DSEQ = ? AND receipt.DMULTICIA = 1 AND receipt.DEST = 0 AND receipt.DESFACT = 2
  AND receipt.DITIPMV = 'RA' AND receipt.DOTROSTXT <> 'IMPORT'`;

export function uniqueCustomsReceiptNumber(companyOnly: boolean) {
  return `NOT EXISTS (
    SELECT 1 FROM FDOC other WHERE other.DNUM = receipt.DNUM AND other.DSEQ <> receipt.DSEQ
      AND other.DEST = 0 AND other.DESFACT = 2 AND other.DITIPMV = 'RA' AND other.DOTROSTXT <> 'IMPORT'
      ${companyOnly ? 'AND other.DMULTICIA = receipt.DMULTICIA' : ''}
  )`;
}

export function pedimentoExpenses(row?: PedimentoRow) {
  return [
    ...expenseSlots.map((slot) => ({
      slot,
      supplierCode: String(row?.[`PMTPRV${slot}`] ?? '').trim(),
      amount: Number(row?.[`PMT${slot}`] ?? 0),
      vat: Number(row?.[`PMTIVA${slot}`] ?? 0),
    })),
    { slot: 'PASIVOS' as const, supplierCode: '', amount: Number(row?.PMTPASIVOS ?? 0), vat: null },
  ];
}

export async function readPurchaseReceptionPedimento(id: number) {
  const [[row]] = await legacyMysqlPool.execute<PedimentoRow[]>(
    `SELECT p.PMTNUM AS number, p.PMTFECHA AS date, p.PMTADUANA AS customsOffice, p.PMTINCREMENTABLES AS incrementables,
       p.PMTPASIVOS, ${expenseSlots.flatMap((slot) => ['', 'PRV', 'IVA'].map((prefix) => `p.PMT${prefix}${slot}`)).join(', ')}
     FROM FDOC receipt JOIN FPEDIMENTO p ON p.PMTODOC = receipt.DNUM
     WHERE ${customsReception} AND ${uniqueCustomsReceiptNumber(false)}
     ORDER BY p.PMTOSEQ DESC LIMIT 1`, [id],
  );
  const pedimento = row ? {
    number: String(row.number ?? '').trim(),
    date: row.date === '1900-12-31' ? null : row.date,
    customsOffice: String(row.customsOffice ?? '').trim(),
    incrementables: Number(row.incrementables ?? 0),
  } : null;
  return {
    pedimento: pedimento && (pedimento.number || pedimento.date || pedimento.customsOffice || pedimento.incrementables) ? pedimento : null,
    expenses: pedimentoExpenses(row),
  };
}
