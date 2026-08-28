import type { RowDataPacket } from 'mysql2';

import { createLegacyDbConnection } from './legacy-db-connection.js';

interface InvoiceRow extends RowDataPacket {
  DSEQ: number;
  DNUM: string;
  DFECHA: Date | string;
  DREFER: string;
  DREFERELLOS: string;
  DITIPMV: string;
}

interface InvoiceMovementRow extends RowDataPacket {
  ASEQ: number;
  AFECHA: Date | string;
  ATIPMV: string;
  ACANT: number;
  AREFPAG: string;
  DSEQ: number;
}

const documentNumber = process.argv[2] ?? '0007069';
const orderNumber = process.argv[3] ?? 'P015471';
const connection = await createLegacyDbConnection();

try {
  const [rows] = await connection.execute<InvoiceRow[]>(
    `SELECT DSEQ, DNUM, DFECHA, DREFER, DREFERELLOS, DITIPMV
       FROM fdoc
      WHERE DNUM IN (?, CONCAT('F', ?))
         OR DREFER = ?
      ORDER BY DSEQ DESC
      LIMIT 20`,
    [documentNumber, documentNumber, orderNumber],
  );

  const ids = rows.map((row) => row.DSEQ);
  const [movements] = ids.length === 0
    ? [[] as InvoiceMovementRow[]]
    : await connection.query<InvoiceMovementRow[]>(
      `SELECT ASEQ, AFECHA, ATIPMV, ACANT, AREFPAG, DSEQ
         FROM fax
        WHERE DSEQ IN (?)
        ORDER BY AFECHA, ASEQ`,
      [ids],
    );

  console.log(JSON.stringify({ invoices: rows, movements }, null, 2));
} finally {
  await connection.end();
}
