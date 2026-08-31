import type { RowDataPacket } from 'mysql2';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { BankAccountsDataSource } from '../../domain/datasources/bank-accounts-data-source.js';
import type { BankPanelsDataSource } from '../../domain/datasources/bank-panels-data-source.js';
import type {
  BankPanelKey,
  BankPanelOptions,
  BankPanelResponse,
} from '../../domain/repositories/bank-panels-repository.js';

type PanelRow = RowDataPacket & Record<string, unknown>;

const sum = (items: Array<Record<string, unknown>>, key: string): number =>
  items.reduce((total, item) => total + Number(item[key] ?? 0), 0);

const toItems = (rows: PanelRow[]): Array<Record<string, unknown>> =>
  rows.map((row) => ({ ...row }));

export class LegacyMysqlBankPanelsDataSource implements BankPanelsDataSource {
  constructor(private readonly accountsDataSource: BankAccountsDataSource) {}

  async getPanel(bankAccountId: number, key: BankPanelKey, options: BankPanelOptions): Promise<BankPanelResponse> {
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
      case 'auxiliary': return this.getAuxiliary(bankAccountId, options.fiscalYear);
      case 'reconciliation': return this.getReconciliation(accountData.code, accountData.balances.bank, accountData.balances.inTransit);
      case 'automatic-reconciliation': return this.getAutomaticReconciliation(bankAccountId, options.asOfDate, accountData.balances.bank);
      case 'cost-center-ledger': return this.getCostCenterLedger(accountData.code, options.costCenter);
      case 'authorization-review': return this.getAuthorizationReview(accountData.code);
      case 'classifiers': return this.getClassifiers();
      case 'supplier-expenses':
        return {
          button: 'Gastos por prv.', section: 'actions', source: ['FBENC'], available: true, readOnly: true, items: [],
          summary: { balance: accountData.balances.current, currency: accountData.currency },
        };
      case 'transfer': return this.getTransferConfiguration();
      case 'unapplied-auxiliary': return this.getUnappliedAuxiliary(bankAccountId, options.fiscalYear);
    }
  }

  private async getAuxiliary(bankAccountId: number, fiscalYear: number): Promise<BankPanelResponse> {
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
        WHERE FBENC.BSEQ = ? AND BAMES = 1 AND POAPLICADA = 1
          AND YEAR(POFECHA) >= ? AND POEST = 0 AND POCIA = 1
        ORDER BY FBENC.BSEQ, FBANMOV.BASEQ LIMIT 32767`,
      [bankAccountId, fiscalYear],
    );
    const items = toItems(rows);
    return {
      button: 'Auxiliar', section: 'actions', source: ['FBANMOV', 'FBENC', 'FPOLIZA'], available: true, readOnly: true, items,
      summary: { charges: sum(items, 'charge'), credits: sum(items, 'credit'), balance: sum(items, 'charge') - sum(items, 'credit') },
    };
  }

  private async getReconciliation(code: string, bankBalance: number, inTransitBalance: number): Promise<BankPanelResponse> {
    const [rows] = await legacyMysqlPool.execute<PanelRow[]>(
      `SELECT BATIP AS movementType, BAIMPOR AS charge, BAIMPORNEG AS credit,
              BAOK AS reconciled, FBANMOV.BASEQ AS movementId,
              POBENEF AS beneficiary, BANUM AS bankNumber, PONUM AS policyNumber,
              POFECHA AS policyDate, BAOKTRANSITO AS inTransit,
              POCHEQUE AS checkNumber, POUSR AS user, BATIPOC AS accountingType,
              FBANMOV.POSEQ AS policyId, POPOSTFECHA AS postdatedAt,
              POAPLICADA AS applied, BACENCOS AS costCenter
         FROM FBANMOV
         LEFT JOIN FBENC ON FBANMOV.BSEQ = FBENC.BSEQ
         LEFT JOIN FPOLIZA ON FBANMOV.POSEQ = FPOLIZA.POSEQ
        WHERE BCOD = ? AND BAOK <> 'X' AND BATIPOC <> 0
          AND POEST = 0 AND POCIA = 1
        ORDER BY BCOD, FBANMOV.BASEQ LIMIT 32767`,
      [code],
    );
    const items = toItems(rows);
    return {
      button: 'Conciliar', section: 'actions', source: ['FBANMOV', 'FBENC', 'FPOLIZA'], available: true, readOnly: true, items,
      summary: { bankBalance, inTransitBalance, charges: sum(items, 'charge'), credits: sum(items, 'credit') },
    };
  }

  private async getAutomaticReconciliation(bankAccountId: number, asOfDate: string, bankBalance: number): Promise<BankPanelResponse> {
    const [rows] = await legacyMysqlPool.execute<PanelRow[]>(
      `SELECT BATIP AS movementType, BAIMPOR AS charge, BAIMPORNEG AS credit,
              BAOK AS reconciled, FBANMOV.BASEQ AS movementId,
              POFECHA AS policyDate, POCHEQUE AS checkNumber,
              '0' AS linked, POBENEF AS beneficiary, PONUM AS policyNumber
         FROM FBANMOV
         LEFT JOIN FPOLIZA ON FBANMOV.POSEQ = FPOLIZA.POSEQ
         LEFT JOIN FBENC ON FBANMOV.BSEQ = FBENC.BSEQ
        WHERE BAOK = '' AND FBENC.BSEQ = ? AND BATIPOC <> 0
          AND POEST = 0 AND POCIA = 1 AND BAOKTRANSITO = ''
          AND POFECHA <= ?
        ORDER BY BAOK, FBANMOV.BASEQ LIMIT 32767`,
      [bankAccountId, asOfDate],
    );
    const items = toItems(rows);
    return {
      button: 'Concilia Automático', section: 'actions', source: ['FBANMOV', 'FPOLIZA', 'FBENC'], available: true, readOnly: true, items,
      summary: { asOfDate, bankBalance, pending: sum(items, 'charge') - sum(items, 'credit') },
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

  private async getAuthorizationReview(code: string): Promise<BankPanelResponse> {
    const [rows] = await legacyMysqlPool.execute<PanelRow[]>(
      `SELECT BATIP AS movementType, BAIMPOR AS charge, BAIMPORNEG AS credit,
              BAAUTORIZADO AS authorized, FBANMOV.BASEQ AS movementId,
              POBENEF AS beneficiary, BANUM AS bankNumber, PONUM AS policyNumber,
              POFECHA AS policyDate, POEST AS policyStatus,
              POCHEQUE AS checkNumber, BAOKTRANSITO AS inTransit
         FROM FBANMOV
         LEFT JOIN FBENC ON FBANMOV.BSEQ = FBENC.BSEQ
         LEFT JOIN FPOLIZA ON FBANMOV.POSEQ = FPOLIZA.POSEQ
        WHERE BCOD = ? AND POEST = 0 AND POCIA = 1 AND BAAUTORIZADO <> '*'
        ORDER BY BCOD, FBANMOV.BASEQ LIMIT 32767`,
      [code],
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
              POPOSTFECHA AS postdatedAt, BACENCOS AS costCenter
         FROM FBANMOV
         LEFT JOIN FBENC ON FBANMOV.BSEQ = FBENC.BSEQ
         LEFT JOIN FPOLIZA ON FBANMOV.POSEQ = FPOLIZA.POSEQ
        WHERE FBENC.BSEQ = ? AND BAMES = 1 AND POAPLICADA = 0
          AND YEAR(POFECHA) >= ? AND POEST = 0 AND POCIA = 1
        ORDER BY FBENC.BSEQ, FBANMOV.BASEQ LIMIT 32767`,
      [bankAccountId, fiscalYear],
    );
    const items = toItems(rows);
    return {
      button: 'Aux. no aplicados', section: 'actions', source: ['FBANMOV', 'FBENC', 'FPOLIZA'], available: true, readOnly: true, items,
      summary: { charges: sum(items, 'charge'), credits: sum(items, 'credit') },
    };
  }
}
