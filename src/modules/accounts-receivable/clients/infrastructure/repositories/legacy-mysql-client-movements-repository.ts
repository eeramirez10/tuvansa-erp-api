import type { RowDataPacket } from 'mysql2';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import {
  ClientMovement,
  type ClientMovementDocument,
} from '../../domain/entities/client-movement.js';
import type {
  ClientMovementsRepository,
  ClientMovementsResult,
  ClientMovementSearchCriteria,
} from '../../domain/repositories/client-movements-repository.js';

interface ClientRow extends RowDataPacket {
  id: number;
  code: string;
  name: string;
  currentBalance: number;
}

interface MovementSummaryRow extends RowDataPacket {
  movementCount: number;
  charges: number;
  credits: number;
  netMovement: number;
}

interface BalanceRow extends RowDataPacket {
  balance: number;
}

interface MovementRow extends RowDataPacket {
  id: number;
  movementDate: string;
  movementTypeCode: string;
  movementTypeDescription: string | null;
  amount: number;
  runningBalance: number;
  paymentReference: string;
  exchangeRate: number;
  policy: string;
  receiptNumber: number;
  userId: number;
  documentId: number | null;
  documentNumber: string | null;
  documentDate: string | null;
  documentDueDate: string | null;
  documentReference: string | null;
  documentAmount: number | null;
  documentCurrencyId: number | null;
  documentCanceled: number | null;
}

const money = (value: number): number => Math.round(value * 100) / 100;

const toDocument = (row: MovementRow): ClientMovementDocument | null => {
  if (row.documentId === null) return null;

  return {
    id: row.documentId,
    number: row.documentNumber,
    date: row.documentDate,
    dueDate: row.documentDueDate,
    reference: row.documentReference,
    amount: row.documentAmount,
    currencyId: row.documentCurrencyId,
    isCanceled: row.documentCanceled === null ? null : row.documentCanceled === 1,
  };
};

const toMovement = (row: MovementRow): ClientMovement =>
  ClientMovement.create({
    id: row.id,
    date: row.movementDate,
    movementType: {
      code: row.movementTypeCode,
      description: row.movementTypeDescription ?? '',
    },
    amount: money(row.amount),
    runningBalance: money(row.runningBalance),
    paymentReference: row.paymentReference,
    exchangeRate: row.exchangeRate,
    policy: row.policy,
    receiptNumber: row.receiptNumber,
    userId: row.userId,
    document: toDocument(row),
  });

export class LegacyMysqlClientMovementsRepository implements ClientMovementsRepository {
  async searchByClient(
    criteria: ClientMovementSearchCriteria,
  ): Promise<ClientMovementsResult | null> {
    const [clientRows] = await legacyMysqlPool.execute<ClientRow[]>(`
      SELECT
        CLISEQ AS id,
        CLICOD AS code,
        CLINOM AS name,
        CLISACT AS currentBalance
      FROM fcli
      WHERE CLISEQ = ?
      LIMIT 1
    `, [criteria.clientId]);

    const client = clientRows[0];
    if (client === undefined) return null;

    const periodConditions = [
      'a.CLISEQ = ?',
      'a.AMES = 1',
      'IF(d.DEST IS NULL, 0, d.DEST) = 0',
      'd.DMULTICIA = 1',
    ];
    const periodParameters: Array<number | string> = [criteria.clientId];

    if (criteria.dateFrom !== undefined) {
      periodConditions.push('a.AFECHA >= ?');
      periodParameters.push(criteria.dateFrom);
    }

    if (criteria.dateTo !== undefined) {
      periodConditions.push('a.AFECHA <= ?');
      periodParameters.push(criteria.dateTo);
    }

    const [summaryRows] = await legacyMysqlPool.execute<MovementSummaryRow[]>(`
      SELECT
        COUNT(*) AS movementCount,
        COALESCE(SUM(CASE WHEN ACANT > 0 THEN ACANT ELSE 0 END), 0) AS charges,
        COALESCE(SUM(CASE WHEN ACANT < 0 THEN ABS(ACANT) ELSE 0 END), 0) AS credits,
        COALESCE(SUM(ACANT), 0) AS netMovement
      FROM fax a
      LEFT JOIN fdoc d ON d.DSEQ = a.DSEQ
      WHERE ${periodConditions.join(' AND ')}
    `, periodParameters);

    let openingBalance = 0;
    if (criteria.dateFrom !== undefined) {
      const [openingRows] = await legacyMysqlPool.execute<BalanceRow[]>(`
        SELECT COALESCE(SUM(ACANT), 0) AS balance
        FROM fax a
        LEFT JOIN fdoc d ON d.DSEQ = a.DSEQ
        WHERE a.CLISEQ = ?
          AND a.AMES = 1
          AND IF(d.DEST IS NULL, 0, d.DEST) = 0
          AND d.DMULTICIA = 1
          AND a.AFECHA < ?
      `, [criteria.clientId, criteria.dateFrom]);
      openingBalance = openingRows[0]?.balance ?? 0;
    }

    const movementConditions: string[] = [];
    const movementParameters: Array<number | string> = [criteria.clientId];

    if (criteria.dateFrom !== undefined) {
      movementConditions.push('ledger.movementDate >= ?');
      movementParameters.push(criteria.dateFrom);
    }

    if (criteria.dateTo !== undefined) {
      movementConditions.push('ledger.movementDate <= ?');
      movementParameters.push(criteria.dateTo);
    }

    const outerWhere = movementConditions.length === 0
      ? ''
      : `WHERE ${movementConditions.join(' AND ')}`;

    const [movementRows] = await legacyMysqlPool.execute<MovementRow[]>(`
      WITH ledger AS (
        SELECT
          a.ASEQ AS id,
          a.AFECHA AS movementDate,
          a.ATIPMV AS movementTypeCode,
          a.ACANT AS amount,
          a.AREFPAG AS paymentReference,
          a.ATIPOC AS exchangeRate,
          a.APOLIZA AS policy,
          a.ARECIBO AS receiptNumber,
          a.AUSEQ AS userId,
          NULLIF(a.DSEQ, 0) AS documentId,
          SUM(a.ACANT) OVER (
            ORDER BY a.AFECHA, a.ASEQ
            ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
          ) AS runningBalance
        FROM fax a
        LEFT JOIN fdoc d ON d.DSEQ = a.DSEQ
        WHERE a.CLISEQ = ?
          AND a.AMES = 1
          AND IF(d.DEST IS NULL, 0, d.DEST) = 0
          AND d.DMULTICIA = 1
      ),
      movement_types AS (
        SELECT TICLA AS code, MAX(NULLIF(TIDESCR, '')) AS description
        FROM ftipmv
        GROUP BY TICLA
      )
      SELECT
        ledger.id,
        ledger.movementDate,
        ledger.movementTypeCode,
        movement_types.description AS movementTypeDescription,
        ledger.amount,
        ledger.runningBalance,
        ledger.paymentReference,
        ledger.exchangeRate,
        ledger.policy,
        ledger.receiptNumber,
        ledger.userId,
        ledger.documentId,
        d.DNUM AS documentNumber,
        d.DFECHA AS documentDate,
        d.DVENCE AS documentDueDate,
        d.DREFER AS documentReference,
        d.DCANT AS documentAmount,
        d.DMONEDA AS documentCurrencyId,
        d.DCANCELADA AS documentCanceled
      FROM ledger
      LEFT JOIN fdoc d ON d.DSEQ = ledger.documentId
      LEFT JOIN movement_types ON movement_types.code = ledger.movementTypeCode
      ${outerWhere}
      ORDER BY ledger.id
      LIMIT ? OFFSET ?
    `, [...movementParameters, criteria.limit, criteria.offset]);

    const summary = summaryRows[0] ?? {
      movementCount: 0,
      charges: 0,
      credits: 0,
      netMovement: 0,
    };
    const roundedOpeningBalance = money(openingBalance);
    const netMovement = money(summary.netMovement);

    return {
      client: {
        id: client.id,
        code: client.code,
        name: client.name,
        currentBalance: money(client.currentBalance),
      },
      summary: {
        openingBalance: roundedOpeningBalance,
        charges: money(summary.charges),
        credits: money(summary.credits),
        netMovement,
        closingBalance: money(roundedOpeningBalance + netMovement),
        movementCount: summary.movementCount,
      },
      items: movementRows.map(toMovement),
    };
  }
}
