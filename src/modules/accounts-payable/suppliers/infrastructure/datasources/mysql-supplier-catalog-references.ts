import type { RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { SupplierCatalogReferences, SupplierCatalogSettings } from '../../domain/datasources/supplier-catalog-data-source.js';
import type { SupplierCatalogParameters } from '../../domain/entities/supplier-catalog.js';
import type { SupplierClassificationOption } from '../../domain/repositories/supplier-panels-repository.js';
import type { SupplierActivityKind } from '../../domain/entities/supplier-activity.js';
import { LegacyMysqlSuppliersDataSource } from './legacy-mysql-suppliers-data-source.js';

const nativeDependencies = [
  ['FDOC', 'El proveedor tiene documentos o movimientos del mes.'],
  ['FAX', 'El proveedor tiene movimientos en cuentas por pagar.'],
  ['FAXINV', 'El proveedor tiene movimientos de inventario.'],
  ['FPENC', 'El proveedor tiene órdenes o cotizaciones de compra.'],
  ['FPLIN', 'El proveedor tiene partidas de órdenes de compra.'],
  ['FCANU2', 'El proveedor tiene compras anuales.'],
] as const;

export async function readSupplierClassifications(id: number): Promise<string[] | null> {
  const fields = Array.from({ length: 9 }, (_, index) => `PRVPAR${index + 1}`);
  const [rows] = await legacyMysqlPool.execute<RowDataPacket[]>(
    `SELECT ${fields.join(',')} FROM FPRV WHERE PRVSEQ=? LIMIT 1`, [id],
  );
  return rows[0] ? fields.map((field) => String(rows[0]?.[field] ?? '').trimEnd()) : null;
}

// Adaptada a los nueve grupos que EPRV#9C/240 consulta por separado.
export async function readSupplierClassifiers(): Promise<SupplierClassificationOption[]> {
  const [rows] = await legacyMysqlPool.execute<Array<RowDataPacket & SupplierClassificationOption>>(
    `SELECT AGSEQ AS id, AGTNUM AS code, AGDESCR AS description, AGNUM AS number, AGT AS type
     FROM FAG WHERE AGT IN ('1','2','3','4','5','6','7','8','9') AND AGTIPO IN (0,2)
     ORDER BY AGTNUM,AGSEQ`,
  );
  return rows.map(({ id, code, description, number, type }) => ({ id, code: code.trimEnd(), description, number, type }));
}

export async function readSupplierActivity(id: number, code: string, kind: SupplierActivityKind) {
  // Adaptada de EPRV#20/240 para la sesión sin identificación de usuario de German.
  if (kind === 'events') {
    const [events] = await legacyMysqlPool.execute<RowDataPacket[]>(
      `SELECT EVSEQ AS id, CAST(EVFECHA AS CHAR) AS date, EVTITULO AS title, EVDESCR AS description,
              CAST(NULLIF(EVFOLLOW,'1900-12-31') AS CHAR) AS followUpAt,
              CAST(NULLIF(EVENCE,'1900-12-31') AS CHAR) AS dueAt,
              EVTIPO AS type, EVRESPONSABLE AS responsible, EVSOLICITA AS requestedBy,
              EVIMPORTANCIA AS importance, EVCOMPLEJIDAD AS complexity, EVDONE AS done, EVPROYECTO AS project,
              EVNUM AS number, EVFACTURA AS invoice, EVCOSTO AS cost, EVEJECUTA AS executedBy, EVSUC AS branch, EVDEPTO AS department
       FROM FEVENTOS WHERE PRVSEQ=? AND EVSOLICITA='' ORDER BY EVSEQ`, [id],
    );
    return events.map((row) => ({ ...row }));
  }
  // Adaptada de EPRV#44/240. CONTES=1 identifica los contactos del proveedor.
  const [contacts] = await legacyMysqlPool.execute<RowDataPacket[]>(
    `SELECT CONTSEQ AS id, CONTKEY AS ownerCode, CONTNOMBRE AS name, CONTPUESTO AS position,
            CONTTEL1 AS phone1, CONTTEL2 AS phone2, CONTTEL3 AS fax, CONTMAIL AS email, CONTOBS AS notes,
            CAST(NULLIF(CONTCUMPLE,'1900-12-31') AS CHAR) AS birthday,
            CONTINTERES AS interests, CONTEXT AS extension, CONTCEL AS mobile
     FROM FCONTACTOS WHERE CONTKEY=? AND CONTES=1 ORDER BY CONTSEQ`, [code],
  );
  return contacts.map((row) => ({ ...row }));
}

export class MysqlSupplierCatalogReferences implements SupplierCatalogReferences {
  constructor(private readonly legacy = new LegacyMysqlSuppliersDataSource()) {}

  async settings(): Promise<SupplierCatalogSettings | null> {
    const [rows] = await legacyMysqlPool.execute<Array<RowDataPacket & SupplierCatalogSettings>>(
      `SELECT CIACTAPRV AS defaultAccount, SUBSTRING(CIAPLUGS,4,1)='X' AS accountingEnabled,
         SUBSTRING(CIAPLUGS,4,1)='X' AND SUBSTRING(CIACOMPORTA,84,1)<>'1' AS accountingAccountRequired
       FROM FCIA WHERE CIASEQ=1 AND CIAALIAS='TUVANSA' LIMIT 1`,
    );
    const row = rows[0];
    return row ? {
      defaultAccount: row.defaultAccount, accountingEnabled: Boolean(row.accountingEnabled),
      accountingAccountRequired: Boolean(row.accountingAccountRequired),
    } : null;
  }

  findById(id: number) { return this.legacy.findById(id); }

  classifications = readSupplierClassifications;
  classifiers = readSupplierClassifiers;
  activity = readSupplierActivity;

  async parameters(id: number): Promise<SupplierCatalogParameters | null> {
    const [rows] = await legacyMysqlPool.execute<Array<RowDataPacket & SupplierCatalogParameters>>(
      `SELECT PRVTOLERANCIA AS tolerancePercent, PRVTIPOIVA AS vatCode,
       PRVRETIVA AS withheldVat, PRVRETISR AS withheldIncomeTax, PRVINTERCIA AS intercompany
       FROM FPRV WHERE PRVSEQ=? LIMIT 1`, [id],
    );
    const row = rows[0];
    return row ? {
      tolerancePercent: Number(row.tolerancePercent), vatCode: Number(row.vatCode),
      withheldVat: Number(row.withheldVat), withheldIncomeTax: Number(row.withheldIncomeTax), intercompany: Number(row.intercompany),
    } : null;
  }

  async codeExists(code: string, excludeId = 0): Promise<boolean> {
    const [rows] = await legacyMysqlPool.execute<RowDataPacket[]>(
      'SELECT PRVSEQ FROM FPRV WHERE PRVCOD=? AND PRVSEQ<>? LIMIT 1', [code, excludeId],
    );
    return rows.length > 0;
  }

  async leafAccount(code: string): Promise<boolean> {
    const [rows] = await legacyMysqlPool.execute<RowDataPacket[]>(
      'SELECT BSEQ FROM FBENC WHERE BCOD=? AND BSUBCTAS=0 LIMIT 1', [code],
    );
    return rows.length > 0;
  }

  async dependency(id: number, code: string): Promise<string | null> {
    // Derivada de MPRV/22. Las seis relaciones conservan el orden de los avisos de Omnis.
    const [rows] = await legacyMysqlPool.execute<Array<RowDataPacket & { relation: number }>>(
      `SELECT ${nativeDependencies.map(([table], index) => `EXISTS(SELECT 1 FROM ${table} WHERE PRVSEQ=? LIMIT 1) AS relation${index}`).join(',')},
         EXISTS(SELECT 1 FROM FPRV WHERE PRVAPLICAR=? AND PRVAPLICAR<>'' AND PRVSEQ<>? LIMIT 1) AS applications`,
      [...nativeDependencies.map(() => id), code, id],
    );
    const row = rows[0];
    const relation = nativeDependencies.findIndex((_, index) => Boolean(row?.[`relation${index}`]));
    return nativeDependencies[relation]?.[1] ?? (row?.applications ? 'Otro proveedor aplica movimientos a este código.' : null);
  }
}
