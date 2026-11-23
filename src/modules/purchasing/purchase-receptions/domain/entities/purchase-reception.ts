export interface PurchaseReceptionLine {
  id: number;
  productId: number;
  productCode: string;
  description: string;
  quantity: number;
  invoicedQuantity: number;
  unit: string;
  price: number;
  grossPrice: number;
  discount: number;
  amount: number;
  pieces: string;
  costCenter: number | string;
  branch: number;
  lotId: number;
  inventoryCreatedAt: string | null;
  expenseTaxes?: { vat: number; vatWithholding: number; incomeWithholding: number };
}

export interface PurchaseReceptionProps {
  id: number;
  number: string;
  orderNumber: string;
  supplierReference: string;
  supplier: { id: number; code: string; name: string };
  department: string;
  warehouse: string;
  branch: number;
  status: string;
  cancelled: boolean;
  cancellation?: { id: number; policyNumber: string; date: string; reason: string } | null;
  dates: { receivedAt: string | null; dueAt: string | null; orderedAt: string | null };
  delayDays: number;
  classifications: string[];
  discountPercentages: number[];
  totals: {
    units: number;
    pieces: number;
    subtotal: number;
    discount: number;
    freight: number;
    insurance: number;
    other: number;
    otherLabel: string;
    exciseTax: number;
    taxPercentage: number;
    tax: number;
    withholdingTax: number;
    expenseTaxes?: { vatWithholding: number; incomeWithholding: number };
    total: number;
    balance: number;
  };
  lines: PurchaseReceptionLine[];
}

export class PurchaseReception {
  private constructor(private readonly props: PurchaseReceptionProps) {}

  static create(props: PurchaseReceptionProps): PurchaseReception {
    return new PurchaseReception(props);
  }

  toPrimitives(): PurchaseReceptionProps {
    return structuredClone(this.props);
  }
}
