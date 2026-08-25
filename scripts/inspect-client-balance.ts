import type { RowDataPacket } from 'mysql2';
import { createLegacyDbConnection } from './legacy-db-connection.js';

interface ClientRow extends RowDataPacket {
  clientId: number;
  code: string;
  name: string;
  currentBalance: number;
}

interface DocumentRow extends RowDataPacket {
  clientId: number;
  clientCode: string;
  clientName: string;
  clientCurrentBalance: number;
  documentId: number;
  documentNumber: string;
  documentDate: string;
  dueDate: string;
  documentAmount: number;
  amountInBaseCurrency: number;
  exchangeRate: number;
  currencyId: number;
  reference: string;
  theirReference: string;
  scheduledDate: string;
  branch: number;
  deliveryReceipt: string;
  deliveryReceiptDate: string;
  affectsReceivables: number;
  auxiliaryBalance: number;
  auxiliaryMovements: number;
}

const connection = await createLegacyDbConnection();

try {
  const [clients] = await connection.execute<ClientRow[]>(`
    SELECT
      CLISEQ AS clientId,
      CLICOD AS code,
      CLINOM AS name,
      CLISACT AS currentBalance
    FROM fcli
    WHERE CLICOD = '000001'
    ORDER BY CLISEQ
  `);

  const [documents] = await connection.execute<DocumentRow[]>(`
    SELECT
      d.CLISEQ AS clientId,
      c.CLICOD AS clientCode,
      c.CLINOM AS clientName,
      c.CLISACT AS clientCurrentBalance,
      d.DSEQ AS documentId,
      d.DNUM AS documentNumber,
      d.DFECHA AS documentDate,
      d.DVENCE AS dueDate,
      d.DCANT AS documentAmount,
      d.DCANTF AS amountInBaseCurrency,
      d.DTIPOC AS exchangeRate,
      d.DMONEDA AS currencyId,
      d.DREFER AS reference,
      d.DREFERELLOS AS theirReference,
      d.DFECHAPROGR AS scheduledDate,
      d.DSUCURSAL AS branch,
      d.DTALON AS deliveryReceipt,
      d.DFECHATALON AS deliveryReceiptDate,
      d.DESCXC AS affectsReceivables,
      COALESCE(SUM(a.ACANT), 0) AS auxiliaryBalance,
      COUNT(a.ASEQ) AS auxiliaryMovements
    FROM fdoc d
    LEFT JOIN fcli c ON c.CLISEQ = d.CLISEQ
    LEFT JOIN fax a ON a.DSEQ = d.DSEQ
    WHERE d.DNUM IN ('FE0061786', 'FE0061787', 'FE0061788', 'FE0061789', 'FE0061905', 'FE0061906')
    GROUP BY
      d.CLISEQ, c.CLICOD, c.CLINOM, c.CLISACT,
      d.DSEQ, d.DNUM, d.DFECHA, d.DVENCE, d.DCANT, d.DCANTF, d.DTIPOC,
      d.DMONEDA, d.DREFER, d.DREFERELLOS, d.DFECHAPROGR, d.DSUCURSAL,
      d.DTALON, d.DFECHATALON, d.DESCXC
    ORDER BY d.DNUM
  `);

  const [currencyTables] = await connection.execute<RowDataPacket[]>(`
    SELECT TABLE_NAME, TABLE_ROWS
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND LOWER(TABLE_NAME) LIKE '%mon%'
    ORDER BY TABLE_NAME
  `);

  const selectedClientId = documents[0]?.clientId;
  const balanceComparison = selectedClientId === undefined
    ? []
    : (await connection.execute<RowDataPacket[]>(`
        SELECT
          COUNT(*) AS documents,
          SUM(DCANT <> 0) AS documentsWithAmount,
          SUM(DCANTF <> 0) AS documentsWithBaseAmount,
          SUM(DCANT) AS documentAmountTotal,
          SUM(DCANTF) AS baseAmountTotal
        FROM fdoc
        WHERE CLISEQ = ?
      `, [selectedClientId]))[0];

  const openDocuments = selectedClientId === undefined
    ? []
    : (await connection.execute<RowDataPacket[]>(`
        SELECT
          DSEQ, DNUM, DFECHA, DVENCE, DCANT, DCANTF, DTIPOC, DMONEDA,
          DREFER, DREFERELLOS, DESCXC, DSTATUS, DCANCELADA
        FROM fdoc
        WHERE CLISEQ = ?
          AND (DCANT <> 0 OR DCANTF <> 0)
        ORDER BY DFECHA DESC, DSEQ DESC
        LIMIT 30
      `, [selectedClientId]))[0];

  const [foreignCurrencySamples] = await connection.execute<RowDataPacket[]>(`
    SELECT
      DSEQ, DNUM, DCANT, DCANTF, DTIPOC, DMONEDA,
      ROUND(DCANT * DTIPOC, 2) AS amountTimesExchangeRate
    FROM fdoc
    WHERE DCANT <> 0
      AND DMONEDA <> 1
    ORDER BY DFECHA DESC, DSEQ DESC
    LIMIT 20
  `);

  const [currencyValues] = await connection.execute<RowDataPacket[]>(`
    SELECT DMONEDA AS currencyId, COUNT(*) AS documents
    FROM fdoc
    GROUP BY DMONEDA
    ORDER BY DMONEDA
  `);

  const [foreignBalanceComparisons] = await connection.execute<RowDataPacket[]>(`
    SELECT
      c.CLISEQ AS clientId,
      c.CLICOD AS code,
      c.CLISACT AS clientBalance,
      COUNT(*) AS openDocuments,
      SUM(d.DCANT) AS amountTotal,
      ROUND(SUM(d.DCANT * d.DTIPOC), 2) AS convertedAmountTotal
    FROM fcli c
    JOIN fdoc d ON d.CLISEQ = c.CLISEQ
    WHERE d.DCANT <> 0
    GROUP BY c.CLISEQ, c.CLICOD, c.CLISACT
    HAVING SUM(d.DMONEDA = 2) = COUNT(*)
      AND COUNT(*) <= 5
    ORDER BY COUNT(*) DESC, c.CLISEQ
    LIMIT 20
  `);

  console.log('Cliente visible en OMNIS:');
  console.table(clients);
  console.log('Documentos visibles y saldo calculado desde fax:');
  console.table(documents);
  console.log('Posibles catalogos de moneda:');
  console.table(currencyTables);
  console.log('Comparacion de campos de saldo en fdoc:');
  console.table(balanceComparison);
  console.log('Documentos con importe distinto de cero:');
  console.table(openDocuments);
  console.log('Muestra de saldos en moneda extranjera:');
  console.table(foreignCurrencySamples);
  console.log('Valores de moneda usados en fdoc:');
  console.table(currencyValues);
  console.log('Comparacion de saldos para clientes con documentos en moneda 2:');
  console.table(foreignBalanceComparisons);
} finally {
  await connection.end();
}
