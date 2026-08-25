import type { RowDataPacket } from 'mysql2';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type {
  ClientActionIdentity,
  ClientBlockStatus,
  ClientClassificationOption,
  ClientClassificationValue,
  ClientContact,
  ClientDiscount,
  ClientEvent,
} from '../../domain/entities/client-action.js';
import type {
  ClientActionCriteria,
  ClientActionResult,
  ClientActionsRepository,
} from '../../domain/repositories/client-actions-repository.js';

interface ClientActionRow extends RowDataPacket, ClientActionIdentity {
  blockedAt: string | null;
  eventsMarker: string;
  classification1: string;
  classification2: string;
  classification3: string;
  classification4: string;
  classification5: string;
  classification6: string;
  classification7: string;
  classification8: string;
  classification9: string;
}

interface CountRow extends RowDataPacket {
  total: number;
}

interface ClassificationRow extends RowDataPacket {
  id: number;
  code: string;
  description: string;
  number: string;
  type: string;
  categoryType: number;
}

interface BlockEventRow extends RowDataPacket {
  id: number;
  date: string;
  title: string;
  description: string;
  key: string;
}

interface EventRow extends RowDataPacket, Omit<
  ClientEvent,
  'done' | 'morning' | 'secondaryDone' | 'extra'
> {
  done: number;
  morning: number;
  secondaryDone: number;
  extra: number;
}

interface ContactRow extends RowDataPacket, Omit<
  ClientContact,
  'phones' | 'receivesInvoices' | 'receivesAccountStatement' | 'responsibilities'
> {
  phone1: string;
  phone2: string;
  phone3: string;
  receivesInvoices: number;
  receivesAccountStatement: number;
  responsibility1: number;
  responsibility2: number;
  responsibility3: number;
  responsibility4: number;
  responsibility5: number;
  responsibility6: number;
}

const classificationFields = [
  { key: 'agent', label: 'AGENTE' },
  { key: 'sector', label: 'GIRO O SECTOR' },
  { key: 'branch', label: 'SUCURSAL' },
  { key: 'status', label: 'STATUS' },
  { key: 'source', label: 'CONDUCTO' },
  { key: 'reason', label: 'MOTIVO' },
  { key: 'freight', label: 'FLETE' },
  { key: 'origin', label: 'ORIGEN' },
  { key: 'project', label: 'PROYECTO' },
] as const;

const toIdentity = (row: ClientActionRow): ClientActionIdentity => ({
  id: row.id,
  code: row.code,
  name: row.name,
  currentBalance: row.currentBalance,
});

export class LegacyMysqlClientActionsRepository implements ClientActionsRepository {
  private async findClient(clientId: number): Promise<ClientActionRow | null> {
    const [rows] = await legacyMysqlPool.execute<ClientActionRow[]>(`
      SELECT
        CLISEQ AS id,
        CLICOD AS code,
        CLINOM AS name,
        CLISACT AS currentBalance,
        NULLIF(CLIBAJA, '1900-12-31') AS blockedAt,
        CLIEVENTOS AS eventsMarker,
        CLIPAR1 AS classification1,
        CLIPAR2 AS classification2,
        CLIPAR3 AS classification3,
        CLIPAR4 AS classification4,
        CLIPAR5 AS classification5,
        CLIPAR6 AS classification6,
        CLIPAR7 AS classification7,
        CLIPAR8 AS classification8,
        CLIPAR9 AS classification9
      FROM fcli
      WHERE CLISEQ = ?
      LIMIT 1
    `, [clientId]);

    return rows[0] ?? null;
  }

  async findClassifications(clientId: number): Promise<ClientActionResult<{
    classifications: ClientClassificationValue[];
    availableAgentOptions: ClientClassificationOption[];
  }> | null> {
    const client = await this.findClient(clientId);
    if (client === null) return null;

    const codes = classificationFields.map((_, index) =>
      client[`classification${index + 1}` as keyof ClientActionRow] as string);
    const [currentRows] = await legacyMysqlPool.execute<ClassificationRow[]>(`
      SELECT
        AGSEQ AS id,
        AGTNUM AS code,
        AGDESCR AS description,
        AGNUM AS number,
        AGT AS type,
        AGTIPO AS categoryType
      FROM fag
      WHERE AGTNUM IN (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ORDER BY AGSEQ
    `, codes);
    const [optionRows] = await legacyMysqlPool.execute<ClassificationRow[]>(`
      SELECT
        AGSEQ AS id,
        AGTNUM AS code,
        AGDESCR AS description,
        AGNUM AS number,
        AGT AS type,
        AGTIPO AS categoryType
      FROM fag
      WHERE AGT = '1'
        AND AGTIPO IN (0, 1)
      ORDER BY AGT, AGSEQ
    `);
    const currentByCode = new Map(currentRows.map((row) => [row.code, row]));

    return {
      client: toIdentity(client),
      payload: {
        classifications: classificationFields.map((field, index) => {
          const code = codes[index] ?? '';
          const current = currentByCode.get(code);

          return {
            id: current?.id ?? null,
            position: index + 1,
            key: field.key,
            label: field.label,
            code,
            description: current?.description ?? '',
            number: current?.number ?? '',
            type: current?.type ?? '',
            categoryType: current?.categoryType ?? null,
          };
        }),
        availableAgentOptions: optionRows.map((row) => ({
          id: row.id,
          code: row.code,
          description: row.description,
          number: row.number,
          type: row.type,
        })),
      },
    };
  }

  async findDestinations(clientId: number): Promise<ClientActionResult<{
    destinations: { available: false; source: null; reason: string };
  }> | null> {
    const client = await this.findClient(clientId);
    if (client === null) return null;

    return {
      client: toIdentity(client),
      payload: {
        destinations: {
          available: false,
          source: null,
          reason: 'OMNIS solo consulto configuracion de ventana; no se capturo un origen funcional.',
        },
      },
    };
  }

  async findBlockStatus(clientId: number): Promise<ClientActionResult<{
    blockStatus: ClientBlockStatus;
  }> | null> {
    const client = await this.findClient(clientId);
    if (client === null) return null;

    const [eventRows] = await legacyMysqlPool.execute<BlockEventRow[]>(`
      SELECT
        EVSEQ AS id,
        DATE(EVFECHA) AS date,
        EVTITULO AS title,
        EVDESCR AS description,
        EVKEY AS \`key\`
      FROM feventos
      WHERE EVKEY = CONCAT(?, 'BLOQUE')
      ORDER BY EVSEQ DESC
      LIMIT 1
    `, [client.code]);

    return {
      client: toIdentity(client),
      payload: {
        blockStatus: {
          blocked: client.blockedAt !== null,
          blockedAt: client.blockedAt,
          hasEvents: client.eventsMarker === '*',
          event: eventRows[0] ?? null,
        },
      },
    };
  }

  async findDiscounts(criteria: ClientActionCriteria): Promise<ClientActionResult<{
    discounts: ClientDiscount[];
  }> | null> {
    const client = await this.findClient(criteria.clientId);
    if (client === null) return null;
    const parameters = [`${client.code}+`, `${client.code}+z`];
    const [[rows], [countRows]] = await Promise.all([
      legacyMysqlPool.execute<(RowDataPacket & ClientDiscount)[]>(`
        SELECT
          DESSEQ AS id,
          DESKEY AS \`key\`,
          DES1 AS discount1,
          DES2 AS discount2,
          DES3 AS discount3,
          NULLIF(DATE(DESFECHA), '1900-12-31') AS startsAt,
          NULLIF(DATE(DESFECHAAL), '1900-12-31') AS endsAt,
          DESOBS AS notes,
          DESCANTINI AS quantityFrom,
          DESCANTFIN AS quantityTo,
          DESDEPTO AS department,
          DESKEY2 AS secondaryKey,
          NULLIF(DATE(DESFECHACAMBIO), '1900-12-31') AS changedAt,
          CAST(DESSTATUS AS SIGNED) AS status,
          DESANT AS previousDiscount,
          DESUNIDAD AS unit
        FROM fdesctos
        WHERE DESKEY >= ?
          AND DESKEY <= ?
        ORDER BY DESKEY, DESSEQ
        LIMIT ? OFFSET ?
      `, [...parameters, criteria.limit, criteria.offset]),
      legacyMysqlPool.execute<CountRow[]>(`
        SELECT COUNT(*) AS total
        FROM fdesctos
        WHERE DESKEY >= ?
          AND DESKEY <= ?
      `, parameters),
    ]);

    return {
      client: toIdentity(client),
      payload: { discounts: rows },
      total: countRows[0]?.total ?? 0,
    };
  }

  async findEvents(criteria: ClientActionCriteria): Promise<ClientActionResult<{
    events: ClientEvent[];
  }> | null> {
    const client = await this.findClient(criteria.clientId);
    if (client === null) return null;
    const [[rows], [countRows]] = await Promise.all([
      legacyMysqlPool.execute<EventRow[]>(`
        SELECT
          EVSEQ AS id,
          DATE(EVFECHA) AS date,
          EVTITULO AS title,
          EVDESCR AS description,
          NULLIF(DATE(EVFOLLOW), '1900-12-31') AS followUpAt,
          NULLIF(DATE(EVENCE), '1900-12-31') AS dueAt,
          EVTIPO AS type,
          EVRESPONSABLE AS responsible,
          EVSOLICITA AS requestedBy,
          EVRELEASE AS \`release\`,
          EVIMPORTANCIA AS importance,
          EVCOMPLEJIDAD AS complexity,
          EVDONE AS done,
          EVPROYECTO AS project,
          EVKEY AS \`key\`,
          EVNUM AS number,
          EVFACTURA AS invoice,
          EVCOSTO AS cost,
          EVAM AS morning,
          EVEJECUTA AS executedBy,
          EVDONE2 AS secondaryDone,
          NULLIF(DATE(EVFOLLOWINI), '1900-12-31') AS initialFollowUpAt,
          NULLIF(DATE(EVENCEINI), '1900-12-31') AS initialDueAt,
          EVSUC AS branch,
          EVEXTRA AS extra,
          EVDEPTO AS department
        FROM feventos
        WHERE CLISEQ = ?
          AND EVSOLICITA = ''
          AND EVDEPTO = 0
          AND EVSUC = ''
        ORDER BY EVSEQ
        LIMIT ? OFFSET ?
      `, [criteria.clientId, criteria.limit, criteria.offset]),
      legacyMysqlPool.execute<CountRow[]>(`
        SELECT COUNT(*) AS total
        FROM feventos
        WHERE CLISEQ = ?
          AND EVSOLICITA = ''
          AND EVDEPTO = 0
          AND EVSUC = ''
      `, [criteria.clientId]),
    ]);

    return {
      client: toIdentity(client),
      payload: {
        events: rows.map((row) => ({
          ...row,
          done: row.done === 1,
          morning: row.morning === 1,
          secondaryDone: row.secondaryDone === 1,
          extra: row.extra === 1,
        })),
      },
      total: countRows[0]?.total ?? 0,
    };
  }

  async findBranches(criteria: ClientActionCriteria): Promise<ClientActionResult<{
    branches: Array<{ id: number; code: string; name: string }>;
  }> | null> {
    const client = await this.findClient(criteria.clientId);
    if (client === null) return null;
    const [[rows], [countRows]] = await Promise.all([
      legacyMysqlPool.execute<Array<RowDataPacket & { id: number; code: string; name: string }>>(`
        SELECT SUCSEQ AS id, SUCCOD AS code, SUCNOM AS name
        FROM fsucursales
        WHERE CLISEQ = ?
        ORDER BY SUCSEQ
        LIMIT ? OFFSET ?
      `, [criteria.clientId, criteria.limit, criteria.offset]),
      legacyMysqlPool.execute<CountRow[]>(`
        SELECT COUNT(*) AS total FROM fsucursales WHERE CLISEQ = ?
      `, [criteria.clientId]),
    ]);

    return {
      client: toIdentity(client),
      payload: { branches: rows },
      total: countRows[0]?.total ?? 0,
    };
  }

  async findPhoto(clientId: number): Promise<ClientActionResult<{
    photo: { available: false; source: null; reason: string };
  }> | null> {
    const client = await this.findClient(clientId);
    if (client === null) return null;

    return {
      client: toIdentity(client),
      payload: {
        photo: {
          available: false,
          source: null,
          reason: 'No se capturo una consulta MySQL ni se encontro un archivo de foto del cliente.',
        },
      },
    };
  }

  async findContacts(criteria: ClientActionCriteria): Promise<ClientActionResult<{
    contacts: ClientContact[];
  }> | null> {
    const client = await this.findClient(criteria.clientId);
    if (client === null) return null;
    const [[rows], [countRows]] = await Promise.all([
      legacyMysqlPool.execute<ContactRow[]>(`
        SELECT
          CONTSEQ AS id,
          CONTNOMBRE AS name,
          CONTPUESTO AS position,
          CONTTEL1 AS phone1,
          CONTTEL2 AS phone2,
          CONTTEL3 AS phone3,
          CONTMAIL AS email,
          CONTOBS AS notes,
          NULLIF(DATE(CONTCUMPLE), '1900-12-31') AS birthday,
          CONTINTERES AS interests,
          CONTEXT AS extension,
          CONTCEL AS mobile,
          CONTIT AS title,
          CONTENVFACT AS receivesInvoices,
          CONTENVECTA AS receivesAccountStatement,
          CONTRESP1 AS responsibility1,
          CONTRESP2 AS responsibility2,
          CONTRESP3 AS responsibility3,
          CONTRESP4 AS responsibility4,
          CONTRESP5 AS responsibility5,
          CONTRESP6 AS responsibility6,
          NULLIF(DATE(CONTFCAMBIO), '1900-12-31') AS changedAt
        FROM fcontactos
        WHERE CONTKEY = ?
          AND CONTES = 0
        ORDER BY CONTSEQ
        LIMIT ? OFFSET ?
      `, [client.code, criteria.limit, criteria.offset]),
      legacyMysqlPool.execute<CountRow[]>(`
        SELECT COUNT(*) AS total
        FROM fcontactos
        WHERE CONTKEY = ?
          AND CONTES = 0
      `, [client.code]),
    ]);

    return {
      client: toIdentity(client),
      payload: {
        contacts: rows.map((row) => ({
          id: row.id,
          name: row.name,
          position: row.position,
          phones: [row.phone1, row.phone2, row.phone3].filter(Boolean),
          email: row.email,
          notes: row.notes,
          birthday: row.birthday,
          interests: row.interests,
          extension: row.extension,
          mobile: row.mobile,
          title: row.title,
          receivesInvoices: row.receivesInvoices === 1,
          receivesAccountStatement: row.receivesAccountStatement === 1,
          responsibilities: [
            row.responsibility1,
            row.responsibility2,
            row.responsibility3,
            row.responsibility4,
            row.responsibility5,
            row.responsibility6,
          ].map((value) => value === 1),
          changedAt: row.changedAt,
        })),
      },
      total: countRows[0]?.total ?? 0,
    };
  }
}
