export interface ClientConsultationIdentity {
  id: number;
  code: string;
  name: string;
  currentBalance: number;
}

export interface ClientInvoice {
  id: number;
  number: string;
  date: string;
  dueDate: string;
  amount: number;
  reference: string;
  paymentDate: string | null;
  affectsAccountsReceivable: boolean;
  deliveryReceipt: string;
  deliveryReceiptDate: string | null;
  route: number;
  exchangeRate: number;
  currencyId: number;
  branch: number;
  customerOrder: string;
  department: string;
  routeDate: string | null;
  parameter1: string;
  scheduledDate: string | null;
}

export interface ClientOrder {
  id: number;
  number: string;
  date: string;
  dueDate: string;
  source: string;
  fulfilled: number;
  customerOrder: string;
  parameter7: string;
  total: number;
  gross: number;
  discount: number;
  parameter9: string;
}

export interface ClientOrderedProduct {
  id: number;
  productCode: string;
  description: string;
  orderedQuantity: number;
  fulfilledQuantity: number;
  stock: number;
  inventoryAssigned: number;
  orderNumber: string;
  source: string;
  customerOrder: string;
  branch: number;
  supplierOrder: number;
  parameter8: string;
  barcode: string;
  productClass: string;
  assignedPieces: number | null;
  assignedQuantity: number;
}

export interface ClientQuotedProduct {
  id: number;
  productCode: string;
  description: string;
  quotedQuantity: number;
  fulfilledQuantity: number;
  stock: number;
  inventoryAssigned: number;
  assignedQuantity: number;
  quoteNumber: string;
  quoteDate: string;
  customerQuote: string;
  unitPrice: number;
  assignedPieces: number | null;
}

export interface ClientSoldProduct {
  id: number;
  productCode: string;
  description: string;
  quantity: number;
  unitPrice: number;
}

export interface ClientSoldProductDetail extends ClientSoldProduct {
  documentNumber: string;
  date: string;
  secondaryExchangeRate: number;
  discount: number;
  customerOrder: string;
  otherAmount: number | null;
  currencyId: number;
  cost: number;
  clientCodeSnapshot: string;
  deliveryReceipt: string;
  deliveryReceiptDate: string | null;
  pieces: number | null;
  branch: number;
}

export interface ClientAnnualSale {
  id: number;
  date: string;
  productCode: string;
  description: string;
  quantity: number;
  unitPrice: number;
  vatPercentage: number;
}

export interface ClientAnnualSalesSummaryItem {
  id: number;
  date: string;
  gross: number;
  discount: number;
}

export interface ClientBranchSale extends ClientSoldProduct {
  branch: number;
}

export interface ClientEdiSale {
  id: number;
  productCode: string;
  description: string;
  deliveryDate: string | null;
  requestedQuantity: number;
  suppliedQuantity: number;
  branch: number;
  type: string;
}

export interface ClientWorkInProgressItem {
  id: number;
  operationNumber: string;
  article: string;
  quantity: number;
  fulfilledQuantity: number;
  productCode: string;
  startDate: string | null;
  endDate: string | null;
  parameter0: string;
  clientCode: string;
  machine: string;
  orderNumber: string;
}

export interface ClientCtOrderedProduct {
  id: number;
  orderedQuantity: number;
  fulfilledQuantity: number;
  productCode: string;
  description: string;
  orderNumber: string;
  customerOrder: string;
  source: string;
  dueDate: string;
}

export type ClientCtSoldProduct = ClientSoldProduct;
