import type { RowDataPacket } from 'mysql2';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { BankAccountsDataSource } from '../../domain/datasources/bank-accounts-data-source.js';
import type { BankPanelsDataSource } from '../../domain/datasources/bank-panels-data-source.js';
import { bankCanReconcile } from '../../domain/entities/bank-reconciliation.js';
import type {
  BankPanelKey,
  BankPanelOptions,
  BankPanelResponse,
} from '../../domain/repositories/bank-panels-repository.js';

type PanelRow = RowDataPacket & Record<string, unknown>;

export const sumBankPanelColumn = (items: Array<Record<string, unknown>>, key: string): number =>
  items.reduce((total, item) => total + Number(item[key] ?? 0), 0);

const sum = sumBankPanelColumn;
const pendingBankPolicy = "BATIPOC <> 0 AND POEST = 0";
const emptyReconciliationDetail = 'La partida no tiene documentos vinculados disponibles.';

export const isLegacyBankMovementId = (id: number) => id > 0 && id <= 4_294_967_295;

export async function readLegacyBankPostdateAccounts(companyId: number, accountId: number, movementId: number, policyId: number) {
  if (![movementId, policyId].every(isLegacyBankMovementId)) return [];
  const [rows] = await legacyMysqlPool.execute<(RowDataPacket & { accountId: number })[]>(
    `SELECT DISTINCT related.BSEQ AS accountId
       FROM FBANMOV picked JOIN FPOLIZA p ON p.POSEQ=picked.POSEQ
       JOIN FBANMOV related ON related.POSEQ=p.POSEQ
       WHERE picked.BASEQ=? AND picked.BSEQ=? AND p.POSEQ=? AND p.POCIA=? AND p.POEST=0
         AND picked.BAOK<>'X' AND picked.BATIPOC<>0 AND related.BSEQ>0
       ORDER BY related.BSEQ`,
    [movementId, accountId, policyId, companyId],
  );
  return rows.map((row) => Number(row.accountId));
}

export async function readLegacyBankReconciliationMovements(companyId: number, accountId: number, ids: number[]) {
  if (!ids.length) return [];
  const [rows] = await legacyMysqlPool.execute<(RowDataPacket & { id: number; date: string; amount: number; inTransit: string; applied: number })[]>(
    `SELECT m.BASEQ AS id,p.POFECHA AS date,(m.BAIMPOR-m.BAIMPORNEG) AS amount,m.BAOKTRANSITO AS inTransit,p.POAPLICADA AS applied
       FROM FBANMOV m JOIN FPOLIZA p ON p.POSEQ=m.POSEQ
       WHERE m.BSEQ=? AND m.BASEQ IN (${ids.map(() => '?').join(',')}) AND p.POCIA=? AND p.POEST=0
         AND m.BAOK='' AND m.BATIPOC=1 AND m.BAIMPOR<>m.BAIMPORNEG AND p.POFECHA>'1900-12-31'`,
    [accountId, ...ids, companyId],
  );
  return rows.map(({ id, date, amount, inTransit, applied }) =>
    ({ id, date, amount: Number(Number(amount).toFixed(2)), inTransit: inTransit === '*', applied: Number(applied) === 1 }));
}

export async function readLegacyBankStatementDate(companyId: number, accountId: number) {
  if (!isLegacyBankMovementId(accountId)) return null;
  const [[row]] = await legacyMysqlPool.execute<(RowDataPacket & { date: string | null })[]>(
    `SELECT CAST(MAX(m.BAFECHARECIBO) AS DATE) AS date
       FROM FBANMOV m STRAIGHT_JOIN FPOLIZA p ON p.POSEQ=m.POSEQ
       WHERE m.BSEQ=? AND m.BAOK='X' AND m.BAFECHARECIBO>'1900-12-31' AND p.POCIA=? AND p.POEST=0`,
    [accountId, companyId],
  );
  return row?.date ?? null;
}

export async function readLegacyTransitMovement(companyId: number, accountId: number, movementId: number) {
  if (!isLegacyBankMovementId(movementId)) return null;
  const [rows] = await legacyMysqlPool.execute<(RowDataPacket & { amount: number; inTransit: string })[]>(
    `SELECT (BAIMPOR - BAIMPORNEG) AS amount, BAOKTRANSITO AS inTransit
     FROM FBANMOV JOIN FPOLIZA ON FBANMOV.POSEQ=FPOLIZA.POSEQ
     WHERE FBANMOV.BSEQ=? AND FBANMOV.BASEQ=? AND POCIA=? AND BAOK <> 'X' AND ${pendingBankPolicy}`,
    [accountId, movementId, companyId],
  );
  const row = rows[0];
  return row ? { amount: Number(Number(row.amount).toFixed(2)), inTransit: row.inTransit === '*' } : null;
}

const toItems = (rows: PanelRow[]): Array<Record<string, unknown>> =>
  rows.map((row) => ({ ...row }));

export class LegacyMysqlBankPanelsDataSource implements BankPanelsDataSource {
  constructor(private readonly accountsDataSource: BankAccountsDataSource) {}

  async getPanel(bankAccountId: number, key: BankPanelKey, options: BankPanelOptions, appliedHere: number[] = []): Promise<BankPanelResponse> {
    const account = await this.accountsDataSource.findById(bankAccountId);
    if (account === null) {
      return {
        button: key,
        section: 'actions',
        source: ['FBENC'],
        available: false,
        readOnly: true,
        items: [],
        reason: 'Cuenta bancaria no encontrada',
      };
    }

    const accountData = account.toPrimitives();
    switch (key) {
      case 'movements':
        return {
          button: 'Movimientos', section: 'actions', source: ['FBENC'], available: false, readOnly: true, items: [],
          reason: 'No se pueden generar movimientos a una cuenta con el sistema de contabilidad activado.',
        };
      case 'deposits':
        return {
          button: 'Depósitos', section: 'actions', source: ['FBENC'], available: false, readOnly: true, items: [],
          reason: 'Para generar un movimiento a bancos haga una póliza.',
        };
      case 'payments':
        return {
          button: 'Pagos', section: 'actions', source: ['FBENC'], available: false, readOnly: true, items: [],
          reason: 'La cuenta seleccionada no abrió una ventana ni ejecutó SQL en OMNIS.',
        };
      case 'general-ledger':
        return {
          button: 'Mayor', section: 'actions', source: ['FBENC'], available: true, readOnly: true,
          items: [...accountData.ledger.firstPeriod, ...accountData.ledger.secondPeriod],
          summary: { balances: accountData.balances, currency: accountData.currency },
        };
      case 'auxiliary': return this.getAuxiliary(bankAccountId, await this.fiscalYear(options.fiscalYear), appliedHere);
      case 'reconciliation': return this.getReconciliation(bankAccountId, accountData.balances.bank, accountData.balances.inTransit,
        bankCanReconcile(accountData, 1));
      case 'reconciliation-detail': return this.getReconciliationDetail(bankAccountId, options.movementId);
      case 'automatic-reconciliation': return this.getAutomaticReconciliation(bankAccountId, options.asOfDate, accountData.balances.bank,
        bankCanReconcile(accountData, 1));
      case 'cost-center-ledger': return this.getCostCenterLedger(accountData.code, options.costCenter);
      case 'authorization-review': return this.getAuthorizationReview(bankAccountId);
      case 'classifiers': return this.getClassifiers();
      case 'supplier-expenses': return this.getSupplierExpenses(bankAccountId);
      case 'transfer': return this.getTransferConfiguration();
      case 'unapplied-auxiliary': return this.getUnappliedAuxiliary(bankAccountId, await this.fiscalYear(options.fiscalYear));
    }
  }

  private async getSupplierExpenses(bankAccountId: number): Promise<BankPanelResponse> {
    const source = ['FBANMOV', 'FPRV', 'FDOC', 'FCIA'];
    const base = { button: 'Gastos por prv.', section: 'actions', source, available: true, readOnly: true } as const;
    const [documentLink] = await legacyMysqlPool.execute<PanelRow[]>(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='FBANMOV' AND COLUMN_NAME='DSEQ'`,
    );
    if (documentLink.length === 0) {
      return {
        ...base, items: [], summary: { charges: 0, credits: 0 },
        reason: 'Esta copia de Proscai no incluye el vínculo de los movimientos con el documento de compra.',
      };
    }

    // Adaptación de EBANCO#9/240 y la relación por secuencia de MSQL/276.
    const [rows] = await legacyMysqlPool.execute<PanelRow[]>(
      `SELECT m.BASEQ AS movementId, TRIM(p.PRVCOD) AS supplierCode, TRIM(p.PRVNOM) AS supplierName,
              m.BAIMPOR AS charge, m.BAIMPORNEG AS credit
       FROM FBANMOV m
       LEFT JOIN FPRV p ON p.PRVSEQ=m.PRVSEQ
       JOIN FDOC d ON d.DSEQ=m.DSEQ
       JOIN FCIA c ON c.CIASEQ=1 AND d.DEST=c.CIAKYT AND d.DMULTICIA=c.CIASEQ
       WHERE m.BSEQ=? AND m.PRVSEQ<>0 AND m.BAMES=1
       ORDER BY m.BASEQ LIMIT 32767`, [bankAccountId],
    );
    const items = toItems(rows);
    return {
      ...base, items,
      summary: { charges: Number(sum(items, 'charge').toFixed(2)), credits: Number(sum(items, 'credit').toFixed(2)) },
    };
  }

  private async fiscalYear(requestedYear?: number): Promise<number> {
    if (requestedYear !== undefined) return requestedYear;
    const [[period]] = await legacyMysqlPool.execute<(RowDataPacket & { fiscalYear: number | null })[]>(
      'SELECT YEAR(CIAFI) AS fiscalYear FROM FCIA WHERE CIASEQ=1 LIMIT 1',
    );
    return period?.fiscalYear || new Date().getFullYear();
  }

  private async getAuxiliary(bankAccountId: number, fiscalYear: number, appliedHere: number[]): Promise<BankPanelResponse> {
    const applied = appliedHere.length ? `(POAPLICADA=1 OR FPOLIZA.POSEQ IN (${appliedHere.map(() => '?').join(',')}))` : 'POAPLICADA = 1';
    const [rows] = await legacyMysqlPool.execute<PanelRow[]>(
      `SELECT BATIP AS movementType, BAIMPOR AS charge, BAIMPORNEG AS credit,
              BAOK AS reconciled, FBANMOV.BASEQ AS movementId,
              POBENEF AS beneficiary, PONUM AS policyNumber, POFECHA AS policyDate,
              FBANMOV.POSEQ AS policyId, BANUM AS bankNumber, PODESCR AS description,
              BABENEF AS movementBeneficiary, POCHEQUE AS checkNumber,
              POUSR AS user, BATIPOC AS accountingType, POPOSTFECHA AS postdatedAt,
              BACENCOS AS costCenter
         FROM FBANMOV
         LEFT JOIN FBENC ON FBANMOV.BSEQ = FBENC.BSEQ
         LEFT JOIN FPOLIZA ON FBANMOV.POSEQ = FPOLIZA.POSEQ
        WHERE FBENC.BSEQ = ? AND BAMES = 1 AND ${applied}
          AND YEAR(POFECHA) >= ? AND POEST = 0 AND POCIA = 1
        ORDER BY FBENC.BSEQ, FBANMOV.BASEQ LIMIT 32767`,
      [bankAccountId, ...appliedHere, fiscalYear],
    );
    const items = toItems(rows);
    return {
      button: 'Auxiliar', section: 'actions', source: ['FBANMOV', 'FBENC', 'FPOLIZA'], available: true, readOnly: true, items,
      summary: { fiscalYear, charges: sum(items, 'charge'), credits: sum(items, 'credit'), balance: sum(items, 'charge') - sum(items, 'credit') },
    };
  }

  private async getReconciliation(bankAccountId: number, bankBalance: number, inTransitBalance: number, transitEligible: boolean): Promise<BankPanelResponse> {
    const [rows] = await legacyMysqlPool.execute<PanelRow[]>(
      `SELECT BATIP AS movementType, BAIMPOR AS charge, BAIMPORNEG AS credit,
              BAOK AS reconciled, FBANMOV.BASEQ AS movementId,
              POBENEF AS beneficiary, BANUM AS bankNumber, PONUM AS policyNumber,
              POFECHA AS policyDate, BAOKTRANSITO AS inTransit,
              POCHEQUE AS checkNumber, POUSR AS user, BATIPOC AS accountingType,
              FBANMOV.POSEQ AS policyId, POPOSTFECHA AS postdatedAt,
              POAPLICADA AS applied, BACENCOS AS costCenter,
              EXISTS (SELECT 1 FROM FAX a WHERE a.BASEQ=FBANMOV.BASEQ) AS documentLinks
         FROM FBANMOV
         LEFT JOIN FBENC ON FBANMOV.BSEQ = FBENC.BSEQ
         LEFT JOIN FPOLIZA ON FBANMOV.POSEQ = FPOLIZA.POSEQ
        WHERE FBENC.BSEQ = ? AND BAOK <> 'X' AND ${pendingBankPolicy} AND POCIA = 1
        ORDER BY BCOD, FBANMOV.BASEQ LIMIT 32767`,
      [bankAccountId],
    );
    const items = toItems(rows).map(({ documentLinks, ...row }) => ({ ...row, canViewDetail: Number(documentLinks) === 1 }));
    return {
      button: 'Conciliar', section: 'actions', source: ['FBANMOV', 'FBENC', 'FPOLIZA', 'FAX'], available: true, readOnly: true, items,
      summary: { bankBalance, inTransitBalance, transitEligible, charges: sum(items, 'charge'), credits: sum(items, 'credit') },
    };
  }

  private async getReconciliationDetail(bankAccountId: number, movementId: number | undefined): Promise<BankPanelResponse> {
    const [rows] = movementId && isLegacyBankMovementId(movementId) ? await legacyMysqlPool.execute<PanelRow[]>(
      `SELECT a.ASEQ AS id,a.AFECHA AS date,a.DSEQ AS documentId,COALESCE(d.DNUM,'') AS document,
              a.ATIPMV AS movementType,a.AREFPAG AS reference,a.ACANT AS amount,a.ADIFCAMBIAR AS exchangeDifference
         FROM FBANMOV m JOIN FPOLIZA p ON p.POSEQ=m.POSEQ JOIN FAX a ON a.BASEQ=m.BASEQ
         LEFT JOIN FDOC d ON d.DSEQ=a.DSEQ
        WHERE m.BASEQ=? AND m.BSEQ=? AND m.BAOK<>'X' AND m.BATIPOC<>0 AND p.POCIA=1 AND p.POEST=0
        ORDER BY a.ASEQ`,
      [movementId, bankAccountId],
    ) : [[]];
    const items = toItems(rows);
    return {
      button: 'Detalle', section: 'actions', source: ['FBANMOV', 'FPOLIZA', 'FAX', 'FDOC'],
      available: items.length > 0, readOnly: true, items,
      ...(items.length ? {} : { reason: emptyReconciliationDetail }),
    };
  }

  private async getAutomaticReconciliation(bankAccountId: number, asOfDate: string, bankBalance: number, transitEligible: boolean): Promise<BankPanelResponse> {
    const [rows] = await legacyMysqlPool.execute<PanelRow[]>(
      `SELECT BATIP AS movementType, BAIMPOR AS charge, BAIMPORNEG AS credit,
              BAOK AS reconciled, FBANMOV.BASEQ AS movementId,
              POFECHA AS policyDate, POCHEQUE AS checkNumber,
              '0' AS linked, POBENEF AS beneficiary, PONUM AS policyNumber, BAOKTRANSITO AS inTransit,
              POAPLICADA AS applied, BATIPOC AS accountingType, FBANMOV.POSEQ AS policyId
         FROM FBANMOV
         LEFT JOIN FPOLIZA ON FBANMOV.POSEQ = FPOLIZA.POSEQ
         LEFT JOIN FBENC ON FBANMOV.BSEQ = FBENC.BSEQ
        WHERE BAOK = '' AND FBENC.BSEQ = ? AND ${pendingBankPolicy} AND POCIA = 1
          AND POFECHA <= ?
        ORDER BY BAOK, FBANMOV.BASEQ LIMIT 32767`,
      [bankAccountId, asOfDate],
    );
    const items = toItems(rows);
    return {
      button: 'Concilia Automático', section: 'actions', source: ['FBANMOV', 'FPOLIZA', 'FBENC'], available: true, readOnly: true, items,
      summary: { asOfDate, bankBalance, transitEligible, pending: sum(items, 'charge') - sum(items, 'credit') },
    };
  }

  private async getCostCenterLedger(code: string, costCenter: string): Promise<BankPanelResponse> {
    const [centers] = await legacyMysqlPool.execute<PanelRow[]>(
      `SELECT CATCOD AS code, CATDESCR AS description, '0' AS selected
         FROM FALMCAT
        WHERE CATTIPO = 'CEN'
        ORDER BY CATTIPO, FALMCAT.CATSEQ LIMIT 32767`,
    );
    const compositeKey = `01${costCenter.padEnd(3, ' ')}${code}`;
    const [ledgerRows] = await legacyMysqlPool.execute<PanelRow[]>(
      'SELECT * FROM FCCBENC WHERE BCCKEY = ? LIMIT 1', [compositeKey],
    );
    const ledger = ledgerRows[0];
    const items = Array.from({ length: 24 }, (_, index) => {
      const period = index < 12 ? 1 : 2;
      const month = (index % 12) + 1;
      const suffix = `${period}${String(month).padStart(2, '0')}`;
      return {
        period, month,
        balance: Number(ledger?.[`BCCS${suffix}`] ?? 0),
        charges: Number(ledger?.[`BCCSC${suffix}`] ?? 0),
        credits: Number(ledger?.[`BCCSA${suffix}`] ?? 0),
        prorationExpenses: Number(ledger?.[`BCCPG${suffix}`] ?? 0),
        budget: Number(ledger?.[`BCCSP${String(index + 1).padStart(2, '0')}`] ?? 0),
      };
    });
    return {
      button: 'Mayor C.C.', section: 'actions', source: ['FALMCAT', 'FCCBENC'], available: true, readOnly: true, items,
      summary: { costCenter, centers: toItems(centers), found: ledger !== undefined },
    };
  }

  private async getAuthorizationReview(bankAccountId: number): Promise<BankPanelResponse> {
    const [rows] = await legacyMysqlPool.execute<PanelRow[]>(
      `SELECT BATIP AS movementType, BAIMPOR AS charge, BAIMPORNEG AS credit,
              BAAUTORIZADO AS authorized, FBANMOV.BASEQ AS movementId,
              POBENEF AS beneficiary, BANUM AS bankNumber, PONUM AS policyNumber,
              POFECHA AS policyDate, POEST AS policyStatus,
              POCHEQUE AS checkNumber, BAOKTRANSITO AS inTransit, FBANMOV.POSEQ AS policyId,
              BACENCOS AS costCenter
         FROM FBANMOV
         LEFT JOIN FBENC ON FBANMOV.BSEQ = FBENC.BSEQ
         LEFT JOIN FPOLIZA ON FBANMOV.POSEQ = FPOLIZA.POSEQ
        WHERE FBENC.BSEQ = ? AND POEST = 0 AND POCIA = 1 AND BAAUTORIZADO <> '*'
        ORDER BY BCOD, FBANMOV.BASEQ LIMIT 32767`,
      [bankAccountId],
    );
    return { button: 'Revisar', section: 'actions', source: ['FBANMOV', 'FBENC', 'FPOLIZA'], available: true, readOnly: true, items: toItems(rows) };
  }

  private async getClassifiers(): Promise<BankPanelResponse> {
    const groups = await Promise.all(Array.from({ length: 9 }, async (_, index) => {
      const type = String(index + 1);
      const [rows] = await legacyMysqlPool.execute<PanelRow[]>(
        `SELECT AGNUM AS code, AGDESCR AS description, AGTNUM AS parent
           FROM FAG
          WHERE AGT = ? AND AGTIPO = 3
          ORDER BY AGT, FAG.AGSEQ LIMIT 32767`,
        [type],
      );
      return { type, items: toItems(rows) };
    }));
    return { button: 'Clasificar', section: 'actions', source: ['FAG'], available: true, readOnly: true, items: groups };
  }

  private async getTransferConfiguration(): Promise<BankPanelResponse> {
    const [rows] = await legacyMysqlPool.execute<PanelRow[]>("SELECT * FROM FTIPMV WHERE TICLA = '3' LIMIT 1");
    return { button: 'Traspasos entre Cuentas', section: 'actions', source: ['FTIPMV', 'FBENC'], available: true, readOnly: true, items: toItems(rows) };
  }

  private async getUnappliedAuxiliary(bankAccountId: number, fiscalYear: number): Promise<BankPanelResponse> {
    const [rows] = await legacyMysqlPool.execute<PanelRow[]>(
      `SELECT BAIMPOR AS charge, BAIMPORNEG AS credit,
              FBANMOV.BASEQ AS movementId, POBENEF AS beneficiary,
              PONUM AS policyNumber, POFECHA AS policyDate,
              '0' AS accumulated, FBANMOV.POSEQ AS policyId,
              BANUM AS bankNumber, PODESCR AS description,
              BABENEF AS movementBeneficiary, POCHEQUE AS checkNumber,
              POUSR AS user, BATIPOC AS accountingType,
              POPOSTFECHA AS postdatedAt, BACENCOS AS costCenter,
              (FBENC.BTIPO=0 AND FBENC.BMONEDA=1 AND PONUM LIKE '3%'
               AND BATIP='3' AND BATIPOC=1 AND BAOK='' AND BAIMPOR<>BAIMPORNEG
               AND POFECHA BETWEEN c.CIAFI AND c.CIAFF AND YEAR(POFECHA) IN (c.CIAPERIODO,c.CIAPERIODO+1)) AS applyCandidate
         FROM FBANMOV
         LEFT JOIN FBENC ON FBANMOV.BSEQ = FBENC.BSEQ
         LEFT JOIN FPOLIZA ON FBANMOV.POSEQ = FPOLIZA.POSEQ
         LEFT JOIN FCIA c ON c.CIASEQ=FPOLIZA.POCIA
        WHERE FBENC.BSEQ = ? AND BAMES = 1 AND POAPLICADA = 0
          AND YEAR(POFECHA) >= ? AND POEST = 0 AND POCIA = 1
        ORDER BY FBENC.BSEQ, FBANMOV.BASEQ LIMIT 32767`,
      [bankAccountId, fiscalYear],
    );
    const items = toItems(rows);
    return {
      button: 'Aux. no aplicados', section: 'actions', source: ['FBANMOV', 'FBENC', 'FPOLIZA'], available: true, readOnly: true, items,
      summary: { fiscalYear, charges: sum(items, 'charge'), credits: sum(items, 'credit') },
    };
  }
}
