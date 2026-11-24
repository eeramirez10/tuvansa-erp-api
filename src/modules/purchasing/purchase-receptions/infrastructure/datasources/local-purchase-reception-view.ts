import type { PostgresClient } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import type { PurchaseReceptionProps } from '../../domain/entities/purchase-reception.js';
import {
  expenseCancellationSql, purchaseDocumentTables, readPurchaseDocuments, receiptCancellationSql, receiptDocumentationSql, type PurchaseDocumentTables,
} from './postgres-purchase-payables.js';

export interface LocalReceptionViewRecord {
  reception: PurchaseReceptionProps;
  principal: number | null;
  movementType: string;
  policyNumber: string | null;
  policyId: number | null;
}

function receiptView(withCancellations: boolean, withDocumentations: boolean) {
  const cancellation = receiptCancellationSql(withCancellations);
  const documentation = receiptDocumentationSql(withDocumentations);
  return `SELECT r.id,r.company_id,r.number,r.order_number,
    CASE WHEN ${cancellation.cancelled} THEN (r.result->'reception') ||
      jsonb_build_object('status','C','cancelled',true,'cancellation',${cancellation.reference})
      WHEN ${documentation.present} THEN jsonb_set(r.result->'reception','{totals,balance}','0'::jsonb)
      ELSE r.result->'reception' END AS reception,
    (r.payable->>'amount')::numeric AS principal,r.movement #>> '{header,type}' AS movement_type,
    r.accounting->>'number' AS policy_number,CASE WHEN r.accounting IS NOT NULL THEN r.id END AS policy_id
    FROM tuvansa.purchase_receptions r ${cancellation.join} ${documentation.join}`;
}

const expenseLines = `(
    SELECT coalesce(jsonb_agg(jsonb_build_object(
      'id',line.position,'productId',line.item->'productId','productCode',line.item->'productCode',
      'description',line.item->'productName','quantity',1,'invoicedQuantity',1,'unit','',
      'price',line.item->'base','grossPrice',line.item->'base','discount',0,'amount',line.item->'base',
      'pieces','','costCenter',line.item->'costCenter','branch',0,'lotId',0,'inventoryCreatedAt',null,
      'expenseTaxes',jsonb_build_object('vat',line.item->'vat','vatWithholding',line.item->'vatWithholding',
        'incomeWithholding',line.item->'incomeWithholding')
    ) ORDER BY line.position),'[]'::jsonb)
    FROM jsonb_array_elements(d.lines) WITH ORDINALITY AS line(item,position)
  )`;

function expenseView(includeLines: boolean, withCancellations: boolean) {
  const cancellation = expenseCancellationSql(withCancellations);
  return `SELECT d.id,d.company_id,d.number,''::text AS order_number,
    jsonb_build_object(
      'id',d.id,'number',d.number,'orderNumber','','supplierReference',d.reference,
      'supplier',jsonb_build_object('id',d.supplier_id,'code',d.supplier_code,'name',d.supplier_name),
      'department','','warehouse','','branch',0,'status',CASE WHEN ${cancellation.cancelled} THEN 'C' ELSE '2' END,
      'cancelled',${cancellation.cancelled},'cancellation',${cancellation.reference},'delayDays',0,
      'dates',jsonb_build_object('receivedAt',d.date,'dueAt',d.due_date,'orderedAt',null),
      'classifications',jsonb_build_array('','','','','','','','',''),'discountPercentages',jsonb_build_array(0,0,0),
      'totals',jsonb_build_object(
        'units',jsonb_array_length(d.lines),'pieces',0,'subtotal',d.base,'discount',0,
        'freight',0,'insurance',0,'other',0,'otherLabel','','exciseTax',0,
        'taxPercentage',CASE WHEN d.base<>0 THEN round(d.vat/d.base*100,2) ELSE 0 END,
        'tax',d.vat,'withholdingTax',d.vat_withholding+d.income_withholding,
        'expenseTaxes',jsonb_build_object('vatWithholding',d.vat_withholding,'incomeWithholding',d.income_withholding),
        'total',d.amount,'balance',CASE WHEN ${cancellation.cancelled} THEN 0 ELSE d.amount END
      ),'lines',${includeLines ? expenseLines : "'[]'::jsonb"}
    ) AS reception,d.amount AS principal,'GA'::text AS movement_type,b.policy_number,b.id AS policy_id
    FROM tuvansa.purchase_expense_documents d
    JOIN tuvansa.purchase_expense_batches b ON b.id=d.batch_id AND b.company_id=d.company_id
    ${cancellation.join}`;
}

export function readLocalReceptionView<T>(
  fallback: T, includeLines: boolean, read: (client: PostgresClient, view: string) => Promise<T>,
) {
  return readPurchaseDocuments(fallback, (client, tables) => read(client, localReceptionView(tables, includeLines)));
}

function localReceptionView(tables: PurchaseDocumentTables, includeLines: boolean) {
  const sources = [];
  if (tables.receipts) sources.push(receiptView(tables.receiptCancellations, tables.documentations));
  if (tables.expenses) sources.push(expenseView(includeLines, tables.expenseCancellations));
  return sources.join(' UNION ALL ');
}

export async function readLocalReceptionOn(client: PostgresClient, companyId: number, id: number) {
  const view = localReceptionView(await purchaseDocumentTables(client), false);
  if (!view) return null;
  const { rows: [row] } = await client.query<Pick<LocalReceptionViewRecord, 'reception'>>(
    `SELECT reception FROM (${view}) documents WHERE company_id=$1 AND id=$2`, [companyId, id],
  );
  return row?.reception ?? null;
}
