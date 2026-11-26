export interface InvoiceTransferReceipt {
  id: number;
  number: string;
  date: string;
  from: string;
  to: string;
  amount: number;
}

export interface InvoiceTransferPreview {
  warehouses: { code: string; name: string }[];
  reason: string | null;
  from: string;
  to: string | null;
  date: string;
  amount: number;
  revision: string | null;
  receipt: InvoiceTransferReceipt | null;
  lines: { productCode: string; description: string; quantity: number; unit: string; price: number; cost: number }[];
}
