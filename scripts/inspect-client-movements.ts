import type { RowDataPacket } from 'mysql2';
import { createLegacyDbConnection } from './legacy-db-connection.js';

interface TableRow extends RowDataPacket {
  TABLE_NAME: string;
  TABLE_ROWS: number;
}

interface ColumnRow extends RowDataPacket {
  TABLE_NAME: string;
  ORDINAL_POSITION: number;
  COLUMN_NAME: string;
  COLUMN_TYPE: string;
  COLUMN_KEY: string;
}

interface ReferenceRow extends RowDataPacket {
  TABLE_NAME: string;
  TABLE_ROWS: number;
  RELEVANT_COLUMNS: string;
}

interface ClientMovementCountRow extends RowDataPacket {
  clientId: number;
  code: string;
  name: string;
  currentBalance: number;
  movementCount: number;
  movementsTotal: number;
}

interface MovementTypeRow extends RowDataPacket {
  movementType: string;
  movements: number;
  total: number;
  minimum: number;
  maximum: number;
}

interface MovementRow extends RowDataPacket {
  movementId: number;
  movementType: string;
  movementDate: string;
  amount: number;
  paymentReference: string;
  documentId: number;
  documentNumber: string | null;
  documentDate: string | null;
  documentAmount: number | null;
  documentReference: string | null;
}

const connection = await createLegacyDbConnection();

try {
  const [tables] = await connection.execute<TableRow[]>(`
    SELECT TABLE_NAME, TABLE_ROWS
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND (
        LOWER(TABLE_NAME) LIKE '%aux%'
        OR LOWER(TABLE_NAME) = 'fax'
        OR LOWER(TABLE_NAME) LIKE '%cxc%'
        OR LOWER(TABLE_NAME) LIKE '%doc%'
        OR LOWER(TABLE_NAME) LIKE '%car%'
      )
    ORDER BY TABLE_NAME
  `);

  const [columns] = await connection.execute<ColumnRow[]>(`
    SELECT TABLE_NAME, ORDINAL_POSITION, COLUMN_NAME, COLUMN_TYPE, COLUMN_KEY
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME IN (
        SELECT TABLE_NAME
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE()
          AND (
            LOWER(TABLE_NAME) LIKE '%aux%'
            OR LOWER(TABLE_NAME) = 'fax'
            OR LOWER(TABLE_NAME) LIKE '%cxc%'
            OR LOWER(TABLE_NAME) LIKE '%doc%'
            OR LOWER(TABLE_NAME) LIKE '%car%'
          )
      )
    ORDER BY TABLE_NAME, ORDINAL_POSITION
  `);

  const [references] = await connection.execute<ReferenceRow[]>(`
    SELECT
      c.TABLE_NAME,
      t.TABLE_ROWS,
      GROUP_CONCAT(c.COLUMN_NAME ORDER BY c.ORDINAL_POSITION SEPARATOR ', ') AS RELEVANT_COLUMNS
    FROM information_schema.COLUMNS c
    JOIN information_schema.TABLES t
      ON t.TABLE_SCHEMA = c.TABLE_SCHEMA
      AND t.TABLE_NAME = c.TABLE_NAME
    WHERE c.TABLE_SCHEMA = DATABASE()
      AND (
        c.COLUMN_NAME IN ('CLISEQ', 'DSEQ', 'CLICOD', 'DNUM')
        OR c.COLUMN_NAME LIKE '%CLISEQ%'
        OR c.COLUMN_NAME LIKE '%DSEQ%'
      )
    GROUP BY c.TABLE_NAME, t.TABLE_ROWS
    ORDER BY c.TABLE_NAME
  `);

  const [movementCatalogCandidates] = await connection.execute<TableRow[]>(`
    SELECT TABLE_NAME, TABLE_ROWS
    FROM information_schema.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
      AND (
        LOWER(TABLE_NAME) LIKE '%tip%'
        OR LOWER(TABLE_NAME) LIKE '%mov%'
      )
    ORDER BY TABLE_NAME
  `);

  const [movementTypeColumns] = await connection.execute<ColumnRow[]>(`
    SELECT TABLE_NAME, ORDINAL_POSITION, COLUMN_NAME, COLUMN_TYPE, COLUMN_KEY
    FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'ftipmv'
    ORDER BY ORDINAL_POSITION
  `);

  const [movementTypeCatalog] = await connection.execute<RowDataPacket[]>(`
    SELECT * FROM ftipmv ORDER BY 1 LIMIT 30
  `);

  const [movementTypeCatalogInUse] = await connection.execute<RowDataPacket[]>(`
    SELECT DISTINCT ti.TICLA, ti.TIDESCR, ti.TIAFCXC
    FROM ftipmv ti
    JOIN (SELECT DISTINCT ATIPMV FROM fax WHERE CLISEQ <> 0) a
      ON a.ATIPMV = ti.TICLA
    ORDER BY ti.TICLA
  `);

  const [clients] = await connection.execute<ClientMovementCountRow[]>(`
    SELECT
      c.CLISEQ AS clientId,
      c.CLICOD AS code,
      c.CLINOM AS name,
      c.CLISACT AS currentBalance,
      COUNT(a.ASEQ) AS movementCount,
      COALESCE(SUM(a.ACANT), 0) AS movementsTotal
    FROM fcli c
    JOIN fax a ON a.CLISEQ = c.CLISEQ
    GROUP BY c.CLISEQ, c.CLICOD, c.CLINOM, c.CLISACT
    ORDER BY movementCount DESC
    LIMIT 5
  `);

  const [movementTypes] = await connection.execute<MovementTypeRow[]>(`
    SELECT
      ATIPMV AS movementType,
      COUNT(*) AS movements,
      SUM(ACANT) AS total,
      MIN(ACANT) AS minimum,
      MAX(ACANT) AS maximum
    FROM fax
    WHERE CLISEQ <> 0
    GROUP BY ATIPMV
    ORDER BY ATIPMV
  `);

  const firstClient = clients[0];
  const movements = firstClient === undefined
    ? []
    : (await connection.execute<MovementRow[]>(`
        SELECT
          a.ASEQ AS movementId,
          a.ATIPMV AS movementType,
          a.AFECHA AS movementDate,
          a.ACANT AS amount,
          a.AREFPAG AS paymentReference,
          a.DSEQ AS documentId,
          d.DNUM AS documentNumber,
          d.DFECHA AS documentDate,
          d.DCANT AS documentAmount,
          d.DREFER AS documentReference
        FROM fax a
        LEFT JOIN fdoc d ON d.DSEQ = a.DSEQ
        WHERE a.CLISEQ = ?
        ORDER BY a.AFECHA DESC, a.ASEQ DESC
        LIMIT 20
      `, [firstClient.clientId]))[0];

  console.log('Tablas candidatas para movimientos de clientes:');
  console.table(tables);
  console.log('Columnas candidatas:');
  console.table(columns);
  console.log('Tablas que referencian clientes o documentos:');
  console.table(references);
  console.log('Posibles catalogos de tipos de movimiento:');
  console.table(movementCatalogCandidates);
  console.log('Columnas de ftipmv:');
  console.table(movementTypeColumns);
  console.log('Muestra de ftipmv:');
  console.table(movementTypeCatalog);
  console.log('Tipos usados en movimientos de clientes:');
  console.table(movementTypeCatalogInUse);
  console.log('Clientes con mas movimientos:');
  console.table(clients);
  console.log('Tipos de movimiento:');
  console.table(movementTypes);
  console.log('Muestra de movimientos del primer cliente:');
  console.table(movements);
} finally {
  await connection.end();
}
