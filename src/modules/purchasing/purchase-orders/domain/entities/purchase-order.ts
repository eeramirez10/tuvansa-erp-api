export type PurchaseOrderDocumentKind = 'order' | 'quote' | 'unknown';

export interface PurchaseOrderLine {
  id: number;
  productId: number;
  productCode: string;
  description: string;
  ordered: number;
  fulfilled: number;
  remaining: number;
  unit: string;
  classCode: string;
  branch: number;
  price: number;
  discount: number;
  currencyId: number;
  currencyName: string;
  confirmed: boolean;
  observations: string;
  assigned: number;
  piecesAssignment: string;
  factor: number;
  supplierProductCode: string;
}

export interface PurchaseOrderProps {
  id: number;
  number: string;
  supplierOrderNumber: string;
  supplier: { id: number; code: string; name: string };
  supplierParameter?: string;
  documentKind: PurchaseOrderDocumentKind;
  status: string;
  received: { quantity: number; pieces: number };
  branch: number;
  department: string;
  dates: { orderedAt: string | null; from: string | null; dueAt: string | null };
  warehouse: string;
  initial: boolean;
  taxPercentage: number;
  discountPercentages: [number, number, number];
  otherLabel: string;
  classifications: string[];
  totals: {
    assigned: number;
    ordered: number;
    fulfilled: number;
    remaining: number;
    subtotal: number;
    discount: number;
    exciseTax: number;
    freight: number;
    insurance: number;
    other: number;
    tax: number;
    total: number;
  };
  lines: PurchaseOrderLine[];
}

export class PurchaseOrder {
  private constructor(private readonly props: PurchaseOrderProps) {}

  static create(props: PurchaseOrderProps): PurchaseOrder {
    return new PurchaseOrder(props);
  }

  get identity(): { id: number; number: string } {
    return { id: this.props.id, number: this.props.number };
  }

  toPrimitives(): PurchaseOrderProps {
    return structuredClone(this.props);
  }

  withClassifications(classifications: string[]): PurchaseOrder {
    return PurchaseOrder.create({ ...this.props, classifications });
  }

  withSupplier(supplier: PurchaseOrderProps['supplier'], parameter: string | null): PurchaseOrder {
    return PurchaseOrder.create({ ...this.props, supplier, ...(parameter === null ? {} : { supplierParameter: parameter }) });
  }

  withEditedLines(edit: Pick<PurchaseOrderProps, 'lines' | 'totals'>, includeLines: boolean): PurchaseOrder {
    return PurchaseOrder.create({ ...this.props, totals: edit.totals, lines: includeLines ? edit.lines : [] });
  }
}
