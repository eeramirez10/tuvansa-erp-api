import { createHash } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import { readLegacySaleStock } from '../../../../sales/orders/infrastructure/datasources/sales-order-inventory-stock.js';
import { supplierCatalogRecord } from '../../../../accounts-payable/suppliers/infrastructure/datasources/postgres-supplier-catalog-data-source.js';
import {
  catalogOtherData, catalogProductsById, isNewCatalogProduct,
} from '../../../../inventories/products/infrastructure/datasources/product-catalog-references.js';
import { loadPurchaseOrderWriteContext } from '../../../purchase-orders/application/use-cases/load-purchase-order-write-context.js';
import { PurchaseOrder } from '../../../purchase-orders/domain/entities/purchase-order.js';
import type { LegacyMysqlPurchaseOrderEditDataSource } from '../../../purchase-orders/infrastructure/datasources/legacy-mysql-purchase-order-edit-data-source.js';
import type { PostgresPurchaseOrderEdits } from '../../../purchase-orders/infrastructure/datasources/postgres-purchase-order-edits.js';
import type {
  PurchaseReceptionCreateInput, PurchaseReceptionPosting, PurchaseReceptionWriteContext, PurchaseReceptionWriteReferences,
} from '../../domain/datasources/purchase-reception-write-data-source.js';
import type { ReceiptCancellationReferences } from '../../domain/datasources/purchase-reception-cancellation-data-source.js';
import { purchaseOrderReceiptLines, type PurchaseOrderReceiptEffect } from '../../domain/entities/purchase-reception-order-effect.js';
import { pedimentoTariff } from '../../domain/entities/purchase-pedimento.js';

interface ReceiptRules extends RowDataPacket {
  fiscalStart: string | null; fiscalEnd: string | null;
  flags: string; plugs: string; defaultWarehouse: string; movement: string; noCosts: number;
  stockSign: number; payableSign: number; invoiceSign: number; policyType: string;
  accountMode: number; movementAccount: string; vatRate: number; vatAccount: string; alternateVatAccount: string;
  tolerance: number; terms: number; supplierAccount: string; betweenCompanies: number; withheldVat: number; withheldIsr: number;
}

interface ProductRules extends RowDataPacket {
  id: number; unit: string; receivedAt: string | null; noLayers: number;
  vatCode: number; withheldVat: number; exciseRate: number; exciseUnit: number; tariff: number;
  account: string; returnAccount: string;
  layerProduct: boolean; controlsPieces: number;
  openingStock: number; average: number; last: number; adValorem: number;
  customsEntry: string; customsOffice: string; importDate: string | null;
}

const date = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeZone: 'America/Mexico_City' });
const money = (value: number) => Number(value.toFixed(2));
const amount = (value: number, decimals: number) => Number(value.toFixed(decimals));
const unsupported = (message: string) => new ApplicationError(message, 'PURCHASE_RECEPTION_POSTING_UNSUPPORTED', 422);
const flag = (rules: ReceiptRules, position: number) => rules.flags.charAt(position - 1) === '1';
const validAccount = (account: string | undefined) => Boolean(account?.trim());
const supportsPeps = (rules: ReceiptRules) => rules.noCosts === 0
  && [22, 24, 37, 45, 51].every((position) => flag(rules, position))
  && [4, 8, 46, 50, 67, 75, 94].every((position) => !flag(rules, position));
const hasPhysicalPieces = (value: string) => !/^(?:0+(?:\.0+)?)?$/.test(value.trim());

export class MysqlPurchaseReceptionWriteReferences implements PurchaseReceptionWriteReferences, ReceiptCancellationReferences {
  constructor(
    private readonly capture: LegacyMysqlPurchaseOrderEditDataSource,
    private readonly edits: PostgresPurchaseOrderEdits,
  ) {}

  private async rules(supplierId: number): Promise<ReceiptRules | undefined> {
    const supplier = await supplierCatalogRecord(supplierId);
    if (supplier?.deleted) return undefined;
    const source = supplier ? '' : 'JOIN FPRV S ON S.PRVSEQ=?';
    const supplierFields = supplier ? '' : `,S.PRVTOLERANCIA AS tolerance,S.PRVPLAZO AS terms,S.PRVCTA AS supplierAccount,
      S.PRVINTERCIA AS betweenCompanies,S.PRVRETIVA AS withheldVat,S.PRVRETISR AS withheldIsr`;
    const [rows] = await legacyMysqlPool.execute<ReceiptRules[]>(
      `SELECT C.CIACOMPORTA AS flags,C.CIAPLUGS AS plugs,C.CIANOCOSTOS AS noCosts,ROOT.CATMCIAALM AS defaultWarehouse,
         NULLIF(C.CIAFI,'1900-12-31') AS fiscalStart,NULLIF(C.CIAFF,'1900-12-31') AS fiscalEnd,
         M.TICLA AS movement, M.TIAFINV AS stockSign, M.TIAFCXC AS payableSign, M.TIAFVTS AS invoiceSign,
         C.CIAPOLIZACONT AS policyType, M.TICONTA AS accountMode, M.TICUENTA AS movementAccount,
         C.CIATASAIVA AS vatRate,C.CIACTAIVAC AS vatAccount,C.CIACTAIVAC2 AS alternateVatAccount
         ${supplierFields}
       FROM FCIA C JOIN FALMCAT ROOT ON ROOT.CATKEY='CIA1' AND ROOT.CATCOD='1'
       JOIN FTIPMV M ON M.TICLA=ROOT.CATMCIATMR AND M.TIMULTICIA=1 AND M.TIMODULO=7
       ${source}
       WHERE C.CIASEQ=1 AND C.CIAALIAS='TUVANSA' ORDER BY ROOT.CATSEQ,M.TISEQ LIMIT 1`,
      supplier ? [] : [supplierId],
    );
    const rules = rows[0];
    return rules && supplier ? {
      ...rules, tolerance: supplier.tolerancePercent, terms: supplier.supplier.terms.paymentTermDays,
      supplierAccount: supplier.supplier.fiscal.accountingAccount, betweenCompanies: supplier.intercompany,
      withheldVat: supplier.withheldVat, withheldIsr: supplier.withheldIncomeTax,
    } : rules;
  }

  private async products(ids: number[]): Promise<Map<number, ProductRules>> {
    if (ids.length === 0) return new Map();
    const [rows] = await legacyMysqlPool.execute<ProductRules[]>(
      `SELECT ISEQ AS id, IUM AS unit, NULLIF(IALTA,'1900-12-31') AS receivedAt, INOCAPAS AS noLayers,
        IPORCIVA AS vatCode, IRETIVA AS withheldVat, IPORCIEPES AS exciseRate, IFIJOIEPS AS exciseUnit,
        IPORCARANC AS tariff, ICTA AS account, ICTADEV AS returnAccount,
        (INOCAPAS<>1 AND ITIPO IN (0,1,3)) AS layerProduct, ICONTROLPZAS AS controlsPieces,
        ISTKACT AS openingStock, ILISTA4 AS average, ILISTA5 AS last, IADVALOREM AS adValorem,
        TRIM(IPEDIMENTO) AS customsEntry, TRIM(IADUANA) AS customsOffice,
        CASE WHEN IFECHAIMPORT>='1901-01-01' THEN DATE_FORMAT(IFECHAIMPORT,'%Y-%m-%d') END AS importDate
       FROM FINV WHERE ISEQ IN (${ids.map(() => '?').join(',')})`, ids,
    );
    const result = new Map(rows.map((item) => [item.id, item]));
    const [references, otherData] = await Promise.all([catalogProductsById(ids), catalogOtherData(ids)]);
    for (const [id, { document, deleted, revision }] of references) {
      if (deleted || !document.isActive) {
        result.delete(id);
        continue;
      }
      const legacy = result.get(id);
      const other = otherData.get(id);
      if (!revision && !isNewCatalogProduct(id) && !other) continue;
      result.set(id, {
        id, unit: document.classification.unit.code, receivedAt: document.createdAt,
        account: document.warehouse.accounts.primary, returnAccount: document.warehouse.accounts.secondary,
        noLayers: typeof other?.noInventoryLayer === 'boolean' ? Number(other.noInventoryLayer) : legacy?.noLayers ?? 0,
        vatCode: Number(other?.taxRateType ?? legacy?.vatCode ?? 0),
        withheldVat: Number(other?.vatWithholdingType ?? legacy?.withheldVat ?? 0),
        exciseRate: Number(other?.iepsPercentage ?? legacy?.exciseRate ?? 0),
        exciseUnit: legacy?.exciseUnit ?? 0, tariff: Number(other?.tariffPercentage ?? legacy?.tariff ?? 0),
        layerProduct: Boolean(legacy?.layerProduct && !document.classification.usesColorAndSize),
        controlsPieces: Number(Boolean(other?.controlsPieces || legacy?.controlsPieces)),
        openingStock: Number(legacy?.openingStock ?? 0),
        average: Number(other?.list4 ?? document.prices.costs.average),
        last: Number(other?.list5 ?? document.prices.costs.last),
        adValorem: Number(document.prices.costs.adValorem),
        customsEntry: String(other?.customsEntry ?? legacy?.customsEntry ?? ''),
        customsOffice: String(other?.customsOffice ?? legacy?.customsOffice ?? ''),
        importDate: typeof other?.importDate === 'string' || other?.importDate === null ? other.importDate : legacy?.importDate ?? null,
      } as ProductRules);
    }
    return result;
  }

  private inventoryAccount(rules: ReceiptRules, product: ProductRules) {
    if (rules.accountMode === 0) return product.account;
    if (rules.accountMode === 1) return product.returnAccount;
    return rules.movementAccount;
  }

  async cancellationOrder(orderId: number) {
    const state = await loadPurchaseOrderWriteContext(orderId, this.capture, this.edits, this.edits).catch((error: unknown) => {
      if (error instanceof NotFoundError) return null;
      throw error;
    });
    if (!state) return null;
    const { base, stored, version } = state;
    const source = PurchaseOrder.create(base);
    const order = (stored ? source.withEditedLines(stored, true) : source).toPrimitives();
    const change = (await this.edits.findSupplierChanges([orderId])).find(({ number }) => number === base.number);
    return {
      order, revision: stored?.revision ?? 0, legacyVersion: version, supplierRevision: change?.revision ?? 0,
      amountInWords: stored?.amountInWords ?? null, stale: Boolean(stored && stored.legacyVersion !== version),
    };
  }

  inventory(warehouse: string, productIds: number[]): ReturnType<ReceiptCancellationReferences['inventory']> {
    return readLegacySaleStock(warehouse, productIds);
  }

  async context(companyId: number, orderId: number): Promise<PurchaseReceptionWriteContext | null> {
    const state = await loadPurchaseOrderWriteContext(orderId, this.capture, this.edits, this.edits).catch((error: unknown) => {
      if (error instanceof NotFoundError) return null;
      throw error;
    });
    if (!state) return null;
    const { base, rules: orderRules, version, stored } = state;
    const change = (await this.edits.findSupplierChanges([orderId])).find(({ number }) => number === base.number);
    const source = PurchaseOrder.create(base);
    const updated = stored ? source.withEditedLines(stored, true) : source;
    const order = (change ? updated.withSupplier(change.supplier, change.supplierParameter) : updated).toPrimitives();
    const [rules, warehouses] = await Promise.all([this.rules(order.supplier.id), this.capture.creationWarehouses()]);
    const policy = {
      receiveAssigned: rules ? flag(rules, 68) : true,
      supplierTolerancePercent: rules?.tolerance ?? 0,
      canRetireCompletedOrder: false,
    };
    const defaultWarehouse = [order.warehouse, rules?.defaultWarehouse].find((code) => warehouses.some((item) => item.code === code));
    const today = date.format();
    const receivedAt = rules?.fiscalEnd && today > rules.fiscalEnd ? rules.fiscalEnd
      : rules?.fiscalStart && today < rules.fiscalStart ? rules.fiscalStart : today;
    const defaults = { receivedAt, warehouse: defaultWarehouse ?? warehouses[0]?.code ?? '' };
    let reason: string | null = null;
    let pedimentoAvailable = false;
    if (companyId !== 1 || orderRules.companyId !== companyId) reason = 'La orden pertenece a otra compañía.';
    else if (stored && stored.legacyVersion !== version) reason = 'La orden cambió en PROSCAI.';
    else if (!rules || rules.movement !== 'RA' || rules.stockSign !== 1 || rules.payableSign !== 1 || rules.invoiceSign !== 1) {
      reason = 'El tipo de movimiento de recepción de TUVANSA no está disponible.';
    } else if (!defaults.warehouse) reason = 'No hay un almacén disponible para la recepción.';
    else if ((stored?.comments?.fields.currencyId ?? orderRules.currencyId) > 1 || rules.betweenCompanies || rules.withheldVat || rules.withheldIsr) {
      reason = 'La orden requiere una recepción en moneda extranjera, intercompañía o con retenciones.';
    }
    if (!reason && rules) {
      const eligible = new Set(purchaseOrderReceiptLines(order, policy).map(({ orderLineId }) => orderLineId));
      const eligibleLines = order.lines.filter((line) => eligible.has(line.id));
      if (eligibleLines.some(({ currencyId }) => currencyId > 1)) reason = 'Hay partidas de la orden en moneda extranjera.';
      const productIds = [...new Set(eligibleLines.map(({ productId }) => productId))];
      const products = await this.products(productIds);
      pedimentoAvailable = supportsPeps(rules) && [...products.values()].some((product) => product.noLayers !== 1 && product.layerProduct);
      for (const id of productIds) {
        try { this.checkProduct(rules, products.get(id)); }
        catch (error) {
          if (!(error instanceof ApplicationError)) throw error;
          reason = error.message;
          break;
        }
      }
      if (!reason && eligibleLines.some((line) => products.get(line.productId)?.noLayers !== 1
        && hasPhysicalPieces(line.piecesAssignment))) reason = 'La recepción PEPS contiene partidas con piezas físicas.';
      if (this.postsAccounting(rules) && !validAccount(rules.supplierAccount)) reason = 'El proveedor no tiene cuenta contable.';
    }
    return {
      order, defaults, policy, reason, revision: stored?.revision ?? 0, sourceVersion: version,
      legacyVersion: change ? createHash('sha256').update(`${version}/supplier/${change.revision}`).digest('hex') : version,
      supplierRevision: change?.revision ?? 0, amountInWords: stored?.amountInWords ?? null,
      warehouses: warehouses.map(({ code, description }) => ({ code, name: description })),
      pedimentoAvailable: !reason && pedimentoAvailable,
    };
  }

  private postsAccounting(rules: ReceiptRules) {
    return flag(rules, 78) && rules.plugs.charAt(3) === 'X';
  }

  private checkProduct(rules: ReceiptRules, product?: ProductRules) {
    if (!product || product.exciseRate || product.exciseUnit || product.withheldVat) {
      throw unsupported('La recepción contiene un producto con IEPS, retenciones o sin datos de inventario.');
    }
    if (product.noLayers !== 1 && (!supportsPeps(rules) || !product.layerProduct || product.controlsPieces)) {
      throw unsupported('La recepción contiene un producto que requiere otro manejo de capas o piezas.');
    }
    if (product.tariff && (product.noLayers === 1 || product.tariff < 0)) {
      throw unsupported('El arancel de un producto requiere una capa PEPS compatible.');
    }
    const account = this.inventoryAccount(rules, product);
    if (this.postsAccounting(rules) && !validAccount(account)) throw unsupported('Un producto no tiene cuenta contable de inventario.');
    return product;
  }

  async posting(context: PurchaseReceptionWriteContext, input: PurchaseReceptionCreateInput, effect: PurchaseOrderReceiptEffect): Promise<PurchaseReceptionPosting> {
    const { order } = context;
    const rules = await this.rules(order.supplier.id);
    if (!rules) throw unsupported('No está disponible la configuración de recepción de TUVANSA.');
    const { receivedAt, warehouse, supplierReference, pedimento } = input;
    if (pedimento && !supportsPeps(rules)) throw unsupported('La compañía no tiene habilitada la recepción con pedimento y PEPS.');
    if (!rules.fiscalStart || !rules.fiscalEnd || receivedAt < rules.fiscalStart || receivedAt > rules.fiscalEnd) {
      throw unsupported('La fecha de recepción debe estar en el periodo contable abierto.');
    }
    const products = await this.products([...new Set(effect.lines.map(({ productId }) => productId))]);
    const orderLines = new Map(order.lines.map((line) => [line.id, line]));
    const gl = new Map<string, number>();
    const discountFactor = order.discountPercentages.reduce((factor, discount) => factor * (1 - discount / 100), 1);
    const priced = effect.lines.map((line) => {
      const source = orderLines.get(line.orderLineId)!;
      const product = this.checkProduct(rules, products.get(line.productId));
      const account = this.inventoryAccount(rules, product);
      const gross = line.baseQuantity * source.price * (1 - source.discount / 100);
      const netLine = amount(gross * discountFactor, 4);
      const price = amount(source.price * (1 - source.discount / 100) * discountFactor, 5);
      const peps = product.noLayers !== 1;
      if (peps && hasPhysicalPieces(source.piecesAssignment)) throw unsupported('La recepción PEPS contiene partidas con piezas físicas.');
      if (pedimento && !peps) throw unsupported('La recepción con pedimento requiere partidas con capas PEPS.');
      if (product.tariff && !pedimento) throw unsupported(`Captura el pedimento de ${source.productCode} para aplicar su arancel.`);
      gl.set(account, (gl.get(account) ?? 0) + netLine);
      return { line, source, product, gross, netLine, price, peps };
    });
    const subtotal = priced.reduce((total, { gross }) => total + gross, 0);
    const net = priced.reduce((total, { netLine }) => total + netLine, 0);
    const baseVat = priced.reduce((total, { product, netLine }) => total + (product.vatCode === 0 ? netLine : 0), 0);
    const units = priced.reduce((total, { line }) => total + line.baseQuantity, 0);
    const netGoods = money(money(subtotal) - money(subtotal - net));
    const lines = priced.map(({ line, source, product, gross, netLine, price, peps }) => {
      let tariff = 0;
      if (pedimento && product.tariff) {
        if (netGoods <= 0 && pedimento.incrementables > 0) throw unsupported('Se requiere un importe neto para prorratear los incrementables.');
        tariff = pedimentoTariff({
          unitPrice: price, quantity: line.baseQuantity, lineAfterDiscount: gross, netGoods,
          incrementables: pedimento.incrementables, tariffPercent: product.tariff,
        });
        if (!Number.isFinite(tariff) || tariff < 0 || tariff > 999999999.9999) {
          throw unsupported(`El arancel de ${source.productCode} excede el rango de costeo.`);
        }
      }
      return {
        orderLineId: line.orderLineId,
        ...(peps ? { pepsLayer: {
          date: product.importDate, customsEntry: product.customsEntry, customsOffice: product.customsOffice,
          costBasis: { openingStock: Number(product.openingStock), average: Number(product.average), last: Number(product.last), adValorem: Number(product.adValorem) },
          ...(pedimento ? { tariff: { goodsCost: price, amount: tariff } } : {}),
        } } : {}),
        reception: {
          productId: line.productId, productCode: source.productCode, description: source.description,
          quantity: line.baseQuantity, invoicedQuantity: line.baseQuantity, unit: product.unit,
          price, grossPrice: source.price, discount: source.discount, amount: money(netLine),
          pieces: source.piecesAssignment, costCenter: 0, branch: source.branch, lotId: 0,
          inventoryCreatedAt: product.receivedAt ?? null,
        },
        movement: {
          productId: line.productId, productCode: source.productCode, description: source.description,
          quantity: line.baseQuantity, unit: product.unit, cost: amount(price + tariff, 5), pieces: 0, piecesText: '',
          warehouse, type: rules.movement, lotId: 0,
          ...(pedimento ? { customsEntry: pedimento.number } : {}),
        },
      };
    });
    const discount = money(subtotal - net);
    const tax = money(baseVat * order.taxPercentage / 100);
    const total = money(money(subtotal) - discount + tax);
    if (total < 0 || !Number.isFinite(total)) throw unsupported('El importe de la recepción no es válido.');
    const due = new Date(receivedAt + 'T00:00:00Z');
    due.setUTCDate(due.getUTCDate() + rules.terms);
    const dueAt = due.toISOString().slice(0, 10);
    const payable = total > 0 ? { amount: total, currencyId: 1, exchangeRate: 1, dueAt } : null;
    let accounting: PurchaseReceptionPosting['accounting'] = null;
    if (payable && this.postsAccounting(rules)) {
      const vatAccount = order.taxPercentage === rules.vatRate ? rules.vatAccount : rules.alternateVatAccount;
      if (!validAccount(rules.supplierAccount) || (tax > 0 && !validAccount(vatAccount)) || !rules.policyType.trim()) {
        throw unsupported('Falta una cuenta contable de proveedor, IVA o tipo de póliza.');
      }
      const debits = [...gl.entries()].filter(([, value]) => value !== 0).map(([account, debit]) =>
        ({ account, department: order.department, debit: money(debit), credit: 0 }));
      const lastDebit = debits.at(-1);
      const roundoff = money(total - tax - debits.reduce((sum, line) => sum + line.debit, 0));
      if (lastDebit) lastDebit.debit = money(lastDebit.debit + roundoff);
      if (tax > 0) debits.push({ account: vatAccount, department: order.department, debit: tax, credit: 0 });
      accounting = {
        type: rules.policyType,
        lines: [{ account: rules.supplierAccount, department: order.department, debit: 0, credit: total }, ...debits],
      };
    }
    return {
      lines, payable, accounting,
      document: {
        orderNumber: order.number, supplierReference, supplier: order.supplier, department: order.department, warehouse,
        branch: order.branch, status: '', cancelled: false, dates: { receivedAt, dueAt, orderedAt: order.dates.orderedAt },
        ...(pedimento ? { pedimento } : {}),
        delayDays: 0, classifications: order.classifications, discountPercentages: order.discountPercentages,
        totals: {
          units: amount(units, 3), pieces: 0, subtotal: money(subtotal), discount, freight: 0, insurance: 0,
          other: 0, otherLabel: '', exciseTax: 0, taxPercentage: order.taxPercentage, tax, withholdingTax: 0, total,
          balance: payable?.amount ?? 0,
        },
      },
      movement: {
        date: receivedAt, reference: order.number, reference2: supplierReference,
        warehouse, supplierCode: order.supplier.code, customerCode: '', customerName: '',
        type: rules.movement, status: 0, company: 1, inventoryFlag: 1, billingFlag: 2,
      },
    };
  }
}
