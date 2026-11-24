import type { RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { ReceiptCancellationSource } from '../../domain/datasources/purchase-reception-cancellation-data-source.js';
import type { PurchaseReceptionProps } from '../../domain/entities/purchase-reception.js';

interface PayableRow extends RowDataPacket {
  type: string | null;
  supplierId: number | null;
  amount: number | null;
  ledgerDate: string | null;
  orderReference: string | null;
  exchangeRate: number | null;
  policyNumber: string | null;
  bankEntry: number | null;
  bankAccount: string | null;
  receiptNumber: string;
  receiptDate: string;
  dueAt: string;
  balance: number;
  total: number;
  currencyId: number;
  receiptExchangeRate: number;
  receiptSupplierId: number;
  supplierAccount: string | null;
  vat: number;
  vatRate: number;
  vatWithholding: number;
  incomeWithholding: number;
  policyType: string;
  accountingEnabled: string;
  cancellationPolicies: string;
  accountingStandardCost: string;
  vatAccount: string;
  alternateVatAccount: string;
  standardVatRate: number;
  inventoryAccountMode: number | null;
  movementAccount: string | null;
}

interface JournalRow extends RowDataPacket {
  policyId: number;
  policyDate: string;
  applied: number;
  status: number;
  family: string;
  sharedPolicy: number;
  movementType: string | null;
  supplierId: number | null;
  reference: string | null;
  exchangeRate: number | null;
  debit: number | null;
  credit: number | null;
  department: number | null;
  reconciliation: string | null;
  transit: string | null;
  account: string | null;
  accountType: number | null;
  accountMovements: number | null;
  accountCurrency: number | null;
  accountCompany: number | null;
  accountMultiCompany: number | null;
  accountBlocksPolicy: number | null;
}

interface ProductRow extends RowDataPacket {
  lineId: number;
  invoiceQuantity: number;
  price: number;
  discount: number;
  inventoryAccount: string | null;
  returnAccount: string | null;
  tariff: number | null;
}

interface HistoricalReceptionAccounting {
  payable: ReceiptCancellationSource['payable'];
  accounting: ReceiptCancellationSource['accounting'];
  reason: string | null;
}

const code = (value: string | null) => value?.trim() ?? '';
const cents = (value: number) => Math.round((value + Number.EPSILON) * 100);
const blocked = (reason: string): HistoricalReceptionAccounting => ({ payable: null, accounting: null, reason });

export async function readHistoricalReceptionAccounting(receipt: PurchaseReceptionProps): Promise<HistoricalReceptionAccounting> {
  const [ledger] = await legacyMysqlPool.execute<PayableRow[]>(
    `SELECT A.ATIPMV AS type,A.PRVSEQ AS supplierId,A.ACANT AS amount,A.AFECHA AS ledgerDate,
       A.AREFPAG AS orderReference,A.ATIPOC AS exchangeRate,A.APOLIZA AS policyNumber,A.BASEQ AS bankEntry,A.ABCOD AS bankAccount,
       D.DNUM AS receiptNumber,D.DFECHA AS receiptDate,D.DVENCE AS dueAt,D.DCANT AS balance,D.DCANTF AS total,
       D.DMONEDA AS currencyId,D.DTIPOC AS receiptExchangeRate,D.PRVSEQ AS receiptSupplierId,P.PRVCTA AS supplierAccount,
       D.DIVA AS vat,D.DPORCIVA AS vatRate,D.DIVARET AS vatWithholding,D.DISRRET AS incomeWithholding,
       C.CIAPOLIZACONT AS policyType,SUBSTRING(C.CIAPLUGS,4,1) AS accountingEnabled,
       SUBSTRING(C.CIACOMPORTA,78,1) AS cancellationPolicies,SUBSTRING(C.CIACOMPORTA,75,1) AS accountingStandardCost,
       C.CIACTAIVAC AS vatAccount,C.CIACTAIVAC2 AS alternateVatAccount,C.CIATASAIVA AS standardVatRate,
       M.TICONTA AS inventoryAccountMode,M.TICUENTA AS movementAccount
     FROM FDOC D
     JOIN FCIA C ON C.CIASEQ=D.DMULTICIA AND C.CIASEQ=1 AND C.CIAALIAS='TUVANSA'
     LEFT JOIN FTIPMV M ON M.TICLA='RA' AND M.TIMULTICIA=D.DMULTICIA
     LEFT JOIN FPRV P ON P.PRVSEQ=D.PRVSEQ
     LEFT JOIN FAX A ON A.DSEQ=D.DSEQ
     WHERE D.DSEQ=? AND D.DITIPMV='RA'
     ORDER BY A.ASEQ`,
    [receipt.id],
  );
  if (ledger.some(({ type }) => code(type) === 'K')) return blocked('La recepción ya tiene una cancelación en Omnis.');
  if (ledger.some(({ type }) => code(type) === 'PP')) return blocked('La recepción tiene pagos PP registrados en Omnis.');

  const [original] = ledger;
  const total = cents(receipt.totals.total);
  if (ledger.length !== 1 || !original || code(original.type) !== 'RA' || original.amount === null || total <= 0
    || cents(original.amount) !== total || cents(original.total) !== total || cents(original.balance) !== total
    || cents(receipt.totals.balance) !== total || original.receiptNumber !== receipt.number
    || original.supplierId !== receipt.supplier.id || original.receiptSupplierId !== receipt.supplier.id
    || original.ledgerDate !== receipt.dates.receivedAt || original.receiptDate !== receipt.dates.receivedAt
    || code(original.orderReference) !== receipt.orderNumber || original.currencyId !== 1
    || original.exchangeRate !== 1 || original.receiptExchangeRate !== 1
    || original.bankEntry !== 0 || code(original.bankAccount)
    || !original.dueAt || original.dueAt === '1900-12-31' || original.dueAt !== receipt.dates.dueAt) {
    return blocked('La recepción requiere un único cargo RA original, íntegro y pendiente en pesos.');
  }
  const policyNumber = code(original.policyNumber);
  const supplierAccount = code(original.supplierAccount);
  const accountMode = original.inventoryAccountMode;
  if (!policyNumber.startsWith('3') || !supplierAccount || original.policyType !== '3'
    || original.accountingEnabled !== 'X' || original.cancellationPolicies !== '1'
    || original.accountingStandardCost !== '0' || (accountMode !== 0 && accountMode !== 1 && accountMode !== 2)) {
    return blocked('No se pudo identificar la configuración de la póliza original y su cancelación.');
  }
  const vat = cents(original.vat);
  if (vat < 0 || vat !== cents(receipt.totals.tax) || original.vatWithholding !== 0 || original.incomeWithholding !== 0
    || receipt.totals.exciseTax !== 0 || receipt.totals.freight !== 0 || receipt.totals.insurance !== 0 || receipt.totals.other !== 0) {
    return blocked('La recepción tiene cargos o impuestos que requieren su propia cancelación contable.');
  }

  const [[journal], [products]] = await Promise.all([
    legacyMysqlPool.execute<JournalRow[]>(
      `SELECT P.POSEQ AS policyId,P.POFECHA AS policyDate,P.POAPLICADA AS applied,P.POEST AS status,P.POFAMILIA AS family,
         EXISTS(SELECT 1 FROM FAX A JOIN FDOC D ON D.DSEQ=A.DSEQ
           WHERE D.DMULTICIA=1 AND A.APOLIZA=P.PONUM AND A.DSEQ<>?) AS sharedPolicy,
         M.BATIP AS movementType,M.PRVSEQ AS supplierId,M.BADNUM AS reference,M.BATIPOC AS exchangeRate,
         M.BAIMPOR AS debit,M.BAIMPORNEG AS credit,M.BACENCOS AS department,M.BAOK AS reconciliation,M.BAOKTRANSITO AS transit,
         B.BCOD AS account,B.BTIPO AS accountType,B.BMOVS AS accountMovements,B.BMONEDA AS accountCurrency,B.BCIA AS accountCompany,
         B.BMULTICIA AS accountMultiCompany,B.BNOPOLIZA AS accountBlocksPolicy
       FROM FPOLIZA P
       LEFT JOIN FBANMOV M ON M.POSEQ=P.POSEQ
       LEFT JOIN FBENC B ON B.BSEQ=M.BSEQ
       WHERE P.PONUM=? AND P.POCIA=1
       ORDER BY P.POSEQ,M.BASEQ`,
      [receipt.id, policyNumber],
    ),
    legacyMysqlPool.execute<ProductRow[]>(
      `SELECT A.AISEQ AS lineId,A.AICANTF AS invoiceQuantity,A.AIPRECIO AS price,A.AIDESCTO AS discount,
         I.ICTA AS inventoryAccount,I.ICTADEV AS returnAccount,I.IPORCARANC AS tariff
       FROM FAXINV A LEFT JOIN FINV I ON I.ISEQ=A.ISEQ
       WHERE A.DSEQ=? AND A.AITIPMV='RA'
       ORDER BY A.AISEQ`,
      [receipt.id],
    ),
  ]);
  const [policy] = journal;
  if (!policy || journal.some((row) => row.policyId !== policy.policyId) || policy.sharedPolicy
    || policy.status !== 0 || policy.applied !== 1 || code(policy.family) !== 'COMPRAS'
    || policy.policyDate !== receipt.dates.receivedAt) {
    return blocked('No se encontró una póliza COMPRAS aplicada y exclusiva de la recepción.');
  }

  const comparator = new Map<string, number>();
  const vatAccount = code(original.vatRate === original.standardVatRate ? original.vatAccount : original.alternateVatAccount);
  if (vat > 0) {
    if (!vatAccount || vatAccount === supplierAccount) return blocked('La recepción no tiene una cuenta histórica de IVA verificable.');
    comparator.set(vatAccount, vat);
  }
  const lineIds = new Set(receipt.lines.map(({ id }) => id));
  const inventory = new Map<string, number>();
  const documentDiscount = receipt.discountPercentages.reduce((factor, rate) => factor * (1 - rate / 100), 1);
  if (!products.length || products.length !== lineIds.size || products.some(({ lineId }) => !lineIds.has(lineId))) {
    return blocked('No se pudieron verificar todas las cuentas de inventario de la recepción.');
  }
  for (const product of products) {
    // MRECEP/136 and /138 select the movement's configured account and round each discounted amount to four decimals.
    const account = code([product.inventoryAccount, product.returnAccount, original.movementAccount][accountMode] ?? null);
    const units = product.price * product.invoiceQuantity * documentDiscount * (1 - product.discount / 100);
    if (!account || account === supplierAccount || account === vatAccount || product.tariff !== 0 || !(units > 0)) {
      return blocked('La recepción contiene partidas con una cuenta o un costo de inventario no verificable.');
    }
    inventory.set(account, (inventory.get(account) ?? 0) + Math.round(units * 10_000));
  }
  for (const [account, units] of inventory) comparator.set(account, Math.round(units / 100));
  if ([...comparator.values()].reduce((sum, amount) => sum + amount, 0) !== total) {
    return blocked('Los importes de inventario e IVA no coinciden con el cargo original.');
  }

  const debits = new Map<string, number>();
  const lines: NonNullable<ReceiptCancellationSource['accounting']>['lines'] = [];
  let validSupplierCredits = 0;
  for (const row of journal) {
    const account = code(row.account);
    const reference = code(row.reference);
    const debit = cents(row.debit ?? 0);
    const credit = cents(row.credit ?? 0);
    if (!account || row.movementType !== 'RA' || row.supplierId !== receipt.supplier.id || row.exchangeRate !== 1
      || row.accountType !== 2 || row.accountMovements !== 1 || row.accountBlocksPolicy !== 0
      || (row.accountCurrency !== 0 && row.accountCurrency !== 1)
      || (![0, 1].includes(row.accountCompany ?? -1) && row.accountMultiCompany !== 1)
      || code(row.reconciliation) || code(row.transit) || row.department === null
      || !Number.isInteger(row.department) || row.department < 0 || debit < 0 || credit < 0) {
      return blocked('La póliza incluye una cuenta o un movimiento incompatible con la cancelación.');
    }
    if (account === supplierAccount && reference === receipt.number && credit === total && debit === 0) {
      validSupplierCredits += 1;
    } else if (!reference && debit > 0 && credit === 0 && comparator.has(account)) {
      debits.set(account, (debits.get(account) ?? 0) + debit);
    } else {
      return blocked('La póliza original contiene movimientos ajenos al cargo, el inventario o el IVA de la recepción.');
    }
    lines.push({ account, department: row.department === 0 ? '' : String(row.department), debit: debit / 100, credit: credit / 100 });
  }
  if (validSupplierCredits !== 1 || [...comparator].some(([account, amount]) => debits.get(account) !== amount)) {
    return blocked('Los movimientos de la póliza original no coinciden con el cargo y los importes verificables de la recepción.');
  }
  return {
    payable: { amount: total / 100, currencyId: original.currencyId, exchangeRate: original.exchangeRate, dueAt: original.dueAt },
    accounting: { type: original.policyType, number: policyNumber, lines },
    reason: null,
  };
}
