import type { RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import { clientCatalogRecord } from '../../../../accounts-receivable/clients/infrastructure/datasources/postgres-client-catalog.js';
import { mexicoGlobalPepsCondition } from '../../../../inventories/movements/infrastructure/datasources/mysql-inventory-adjustment-references.js';
import {
  catalogOtherData, catalogProductsById, isNewCatalogProduct,
} from '../../../../inventories/products/infrastructure/datasources/product-catalog-references.js';
import { normalizeOrderWarehouse } from '../../../orders/domain/entities/order-warehouse.js';
import type { OrderProps } from '../../../orders/domain/entities/order.js';
import type {
  InvoiceFromOrderContext, InvoiceFromOrderProduct, InvoiceFromOrderReferences,
} from '../../domain/datasources/invoice-from-order-data-source.js';

interface ReferencesRow extends RowDataPacket {
  fiscalStart: string;
  fiscalEnd: string;
  customerCode: string;
  customerCurrency: number;
  blocked: number;
  posRestricted: number;
  alternateCustomer: string;
  intercompany: number;
  withheldVat: number;
  customerTermsDays: number;
  creditLimit: number;
  creditBalance: number;
  vat: number;
  automaticPeps: number;
}

interface ProductRow extends RowDataPacket {
  id: number;
  code: string;
  unit: string;
  package: string;
  family: string;
  cost: number;
  legacyOnHand: number;
  legacyAssigned: number;
  supported: number;
  peps: number;
  average: number;
  last: number;
  adValorem: number;
}

const noReferences = 'La configuración de Remisión México (FA) no está disponible para este pedido.';

export class MysqlInvoiceFromOrderReferences implements InvoiceFromOrderReferences {
  async context(companyId: number, order: OrderProps): Promise<InvoiceFromOrderContext> {
    const warehouse = normalizeOrderWarehouse(order.warehouse);
    const ids = [...new Set(order.lines.filter(({ assigned }) => assigned > 0).map(({ productId }) => productId))];
    const client = await clientCatalogRecord(order.customer.id);
    const [rows] = await legacyMysqlPool.execute<ReferencesRow[]>(
      `SELECT c.CIAFI AS fiscalStart, c.CIAFF AS fiscalEnd, TRIM(cl.CLICOD) AS customerCode,
         COALESCE(cl.CLIMONEDA,1) AS customerCurrency,
         NULLIF(cl.CLIBAJA,'1900-12-31') IS NOT NULL AS blocked, COALESCE(cl.CLISOLOPOS,0)=2 AS posRestricted,
         TRIM(cl.CLIAPLICAR) AS alternateCustomer, COALESCE(cl.CLIINTERCIA,0) AS intercompany,
         COALESCE(cl.CLIRETIVA,0) AS withheldVat, COALESCE(cl.CLIPLAZO0,0) AS customerTermsDays,
         COALESCE(cl.CLICREDIT,0) AS creditLimit, COALESCE(cl.CLISACT + cl.CLITSACT,0) AS creditBalance,
         CASE COALESCE(cl.CLITIPOIVA,0) WHEN 0 THEN m.TIIVA0 WHEN 1 THEN m.TIIVA1 WHEN 2 THEN m.TIIVA2 END AS vat,
         (${mexicoGlobalPepsCondition}) AS automaticPeps
       FROM FCIA c
       JOIN FTIPMV m ON m.TICLA=c.CIATMFACT AND m.TIMULTICIA=c.CIASEQ AND m.TIMODULO=4
       LEFT JOIN FCLI cl ON cl.CLISEQ=?
       WHERE c.CIASEQ=? AND c.CIAALIAS='TUVANSA' AND c.CIATMFACT='FA'
         AND m.TIFISCAL=0 AND m.TIAFINV=-1 AND m.TIAFCXC=1 AND m.TIAFVTS=1 AND m.TICONVERTIR='FE'
         AND SUBSTRING(c.CIACOMPORTA,2,1)='1' AND SUBSTRING(c.CIACOMPORTA,10,1)='1'
         AND SUBSTRING(c.CIACOMPORTA,12,1)='1' AND SUBSTRING(c.CIACOMPORTA,37,1)='1'
         AND SUBSTRING(c.CIACOMPORTA,45,1)='1' AND SUBSTRING(c.CIACOMPORTA,108,1)='1'
         AND EXISTS (SELECT 1 FROM FALMCAT WHERE CATALM=?)
       LIMIT 2`,
      [order.customer.id, companyId, warehouse],
    );
    const base = rows[0];
    if (rows.length !== 1 || !base || (!base.customerCode && (!client || client.legacy))) {
      return { reason: noReferences, fiscalStart: '', fiscalEnd: '', customerTermsDays: 0, creditLimit: 0, creditBalance: 0, vat: 0, products: new Map() };
    }
    const changes = client?.changes;
    const rules = {
      ...base, customerCode: client?.document.code ?? base.customerCode,
      blocked: Boolean(base.posRestricted || (client?.blocked ?? base.blocked) || client?.deleted),
      customerTermsDays: changes?.paymentTermDays ?? base.customerTermsDays,
      creditLimit: changes?.creditLimit ?? base.creditLimit,
      alternateCustomer: changes?.applyToClientCode ?? base.alternateCustomer,
    };
    if (rules.customerCode !== order.customer.code) {
      return { reason: noReferences, fiscalStart: '', fiscalEnd: '', customerTermsDays: 0, creditLimit: 0, creditBalance: 0, vat: 0, products: new Map() };
    }
    let reason: string | null = null;
    if (rules.blocked) reason = 'El cliente está bloqueado para facturación.';
    else if (
      rules.customerCurrency > 1 || rules.intercompany || rules.withheldVat
      || (rules.alternateCustomer && rules.alternateCustomer !== rules.customerCode)
      || rules.vat !== 16 || !rules.fiscalStart || !rules.fiscalEnd || rules.fiscalStart > rules.fiscalEnd
      || !Number.isInteger(rules.customerTermsDays) || rules.customerTermsDays < 0
      || !Number.isInteger(order.termsDays) || order.termsDays < 0
    ) reason = 'El cliente requiere una moneda, cuenta, plazo o impuesto fuera de la remisión estándar.';

    const products = new Map<number, InvoiceFromOrderProduct>();
    if (!reason && ids.length > 0) {
      const [items] = await legacyMysqlPool.execute<ProductRow[]>(
        `SELECT i.ISEQ AS id, TRIM(i.ICOD) AS code, TRIM(i.IUM) AS unit, TRIM(i.IEMPAQUE) AS package, TRIM(i.IFAM6) AS family,
          (i.ILISTA4 + i.IADVALOREM) AS cost, COALESCE(a.ALMCANT,0) AS legacyOnHand,
          COALESCE(a.ALMASIGNADO,0) AS legacyAssigned, i.ILISTA4 AS average, i.ILISTA5 AS last, i.IADVALOREM AS adValorem,
          (
            i.ITIPO IN (0,1) AND i.INOCAPAS=1 AND i.IBAJA='1900-12-31' AND i.IPORCIVA=0
            AND i.IPORCIEPES=0 AND i.IFIJOIEPS=0 AND i.IRETIVA=0 AND i.IPORCRETIVA=0
            AND NOT EXISTS (SELECT 1 FROM FLOTES l WHERE l.ISEQ=i.ISEQ AND l.LOALM=? AND l.LOCANT>0)
          ) AS supported,
          (i.ITIPO IN (0,1) AND i.INOCAPAS<>1 AND i.IBAJA='1900-12-31' AND i.IINACTIVO=0
            AND i.IPORCIVA=0 AND i.IPORCIEPES=0 AND i.IFIJOIEPS=0 AND i.IRETIVA=0 AND i.IPORCRETIVA=0
            AND i.ICT=0 AND i.ICONTROLPZAS=0 AND i.IPORCARANC=0) AS peps
         FROM FINV i LEFT JOIN FALM a ON a.ALMKEY=CONCAT(RPAD(TRIM(i.ICOD),13,' '),?)
         WHERE i.ISEQ IN (${ids.map(() => '?').join(',')})`,
        [warehouse, warehouse, ...ids],
      );
      for (const item of items) {
        const { peps, average, last, adValorem, supported, ...product } = item;
        const pepsCostBasis = rules.automaticPeps && peps ? { average, last, adValorem } : undefined;
        products.set(item.id, { ...product, supported: Boolean(supported || pepsCostBasis), ...(pepsCostBasis && { pepsCostBasis }) });
      }
      const [references, otherData] = await Promise.all([catalogProductsById(ids), catalogOtherData(ids)]);
      for (const [id, { document, deleted, revision }] of references) {
        if (deleted || !document.isActive) {
          products.delete(id);
          continue;
        }
        const legacy = products.get(id);
        const options = otherData.get(id);
        if (!revision && legacy) continue;
        const supported = legacy?.supported ?? (
          isNewCatalogProduct(id) && options?.noInventoryLayer === true
          && Number(options.taxRateType ?? 0) === 0 && Number(options.iepsPercentage ?? 0) === 0
          && Number(options.vatWithholdingType ?? 0) === 0 && Number(options.tariffPercentage ?? 0) === 0
        );
        const peps = legacy?.pepsCostBasis;
        const pepsCostBasis = peps && !document.classification.usesColorAndSize
          && options?.noInventoryLayer !== true && !options?.controlsPieces && !options?.tariff && !options?.tariffPercentage
          && !options?.taxRateType && !options?.iepsPercentage && !options?.vatWithholdingType
          ? {
            average: typeof options?.list4 === 'number' ? options.list4 : document.prices.costs.average,
            last: typeof options?.list5 === 'number' ? options.list5 : document.prices.costs.last,
            adValorem: document.prices.costs.adValorem,
          }
          : undefined;
        products.set(id, {
          id, code: document.code, unit: document.classification.unit.code,
          cost: document.prices.costs.average + document.prices.costs.adValorem,
          package: legacy?.package ?? '', family: legacy?.family ?? '',
          legacyOnHand: legacy?.legacyOnHand ?? 0, legacyAssigned: legacy?.legacyAssigned ?? 0,
          supported: supported && (!peps || pepsCostBasis !== undefined)
            && ['rawMaterial', 'finishedProduct'].includes(document.classification.type),
          ...(pepsCostBasis && { pepsCostBasis }),
        });
      }
    }
    return {
      reason, fiscalStart: rules.fiscalStart, fiscalEnd: rules.fiscalEnd, customerTermsDays: rules.customerTermsDays,
      creditLimit: rules.creditLimit, creditBalance: rules.creditBalance, vat: rules.vat, products,
    };
  }
}
