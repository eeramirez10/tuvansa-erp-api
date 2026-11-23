import type { PostgresClient } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import type { PurchaseReceptionProps } from '../../domain/entities/purchase-reception.js';
import { readPurchaseDocuments, type PurchaseDocumentTables } from './postgres-purchase-payables.js';

export interface LocalReceptionViewRecord {
  reception: PurchaseReceptionProps;
  principal: number | null;
  movementType: string;
  policyNumber: string | null;
  policyId: number | null;
}

const receiptView = `SELECT id,company_id,number,order_number,result->'reception' AS reception,
    (payable->>'amount')::numeric AS principal,movement #>> '{header,type}' AS movement_type,
    accounting->>'number' AS policy_number,CASE WHEN accounting IS NOT NULL THEN id END AS policy_id
  FROM tuvansa.purchase_receptions`;

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

function expenseView(includeLines: boolean) {
  return `SELECT d.id,d.company_id,d.number,''::text AS order_number,
    jsonb_build_object(
      'id',d.id,'number',d.number,'orderNumber','','supplierReference',d.reference,
      'supplier',jsonb_build_object('id',d.supplier_id,'code',d.supplier_code,'name',d.supplier_name),
      'department','','warehouse','','branch',0,'status','2','cancelled',false,'delayDays',0,
      'dates',jsonb_build_object('receivedAt',d.date,'dueAt',d.due_date,'orderedAt',null),
      'classifications',jsonb_build_array('','','','','','','','',''),'discountPercentages',jsonb_build_array(0,0,0),
      'totals',jsonb_build_object(
        'units',jsonb_array_length(d.lines),'pieces',0,'subtotal',d.base,'discount',0,
        'freight',0,'insurance',0,'other',0,'otherLabel','','exciseTax',0,
        'taxPercentage',CASE WHEN d.base<>0 THEN round(d.vat/d.base*100,2) ELSE 0 END,
        'tax',d.vat,'withholdingTax',d.vat_withholding+d.income_withholding,
        'expenseTaxes',jsonb_build_object('vatWithholding',d.vat_withholding,'incomeWithholding',d.income_withholding),
        'total',d.amount,'balance',d.amount
      ),'lines',${includeLines ? expenseLines : "'[]'::jsonb"}
    ) AS reception,d.amount AS principal,'GA'::text AS movement_type,b.policy_number,b.id AS policy_id
    FROM tuvansa.purchase_expense_documents d
    JOIN tuvansa.purchase_expense_batches b ON b.id=d.batch_id AND b.company_id=d.company_id`;
}

export function readLocalReceptionView<T>(
  fallback: T, includeLines: boolean, read: (client: PostgresClient, view: string) => Promise<T>,
) {
  return readPurchaseDocuments(fallback, (client, tables: PurchaseDocumentTables) => {
    const sources = [];
    if (tables.receipts) sources.push(receiptView);
    if (tables.expenses) sources.push(expenseView(includeLines));
    return read(client, sources.join(' UNION ALL '));
  });
}
