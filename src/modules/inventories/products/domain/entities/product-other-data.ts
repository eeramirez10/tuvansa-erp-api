export type ProductOtherDataValue = string | number | boolean | null;
export type ProductOtherDataValues = Record<string, ProductOtherDataValue>;

type ProductOtherDataField = {
  kind: 'number' | 'text' | 'date' | 'boolean';
  editable: boolean;
  decimals?: number;
  minimum?: number;
  exclusiveMinimum?: number;
  maximum?: number;
  maxLength?: number;
  minLength?: number;
  uppercase?: boolean;
};

const number = (rules: Omit<ProductOtherDataField, 'kind' | 'editable'> = {}): ProductOtherDataField =>
  ({ kind: 'number', editable: true, ...rules });
const decimal = (decimals: number, minimum = 0): ProductOtherDataField => number({ decimals, minimum });
const signed = (decimals: number): ProductOtherDataField => number({ decimals });
const integer = (maximum?: number): ProductOtherDataField =>
  number({ decimals: 0, minimum: 0, ...(maximum === undefined ? {} : { maximum }) });
const text = (maxLength: number, uppercase = false, minLength = 0): ProductOtherDataField =>
  ({ kind: 'text', editable: true, maxLength, uppercase, minLength });
const date: ProductOtherDataField = { kind: 'date', editable: true };
const checkbox: ProductOtherDataField = { kind: 'boolean', editable: true };
const readonly = (field: ProductOtherDataField): ProductOtherDataField => ({ ...field, editable: false });

export const productOtherDataFields: Record<string, ProductOtherDataField> = {
  volume: decimal(6), weight: number({ minimum: 0 }), unitsPerBox: number({ decimals: 2, exclusiveMinimum: 0 }),
  packaging: signed(2), length: signed(2), width: signed(2), height: signed(2), location: text(30, true),
  ediPackaging: text(4, true, 2), ediQuantity: readonly(integer()), density: decimal(4), weightPerMeter: number({ minimum: 0 }),
  composition: text(120), warehouse: signed(0), changedAt: readonly(date), salePricesChangedAt: date,
  virtualStore: checkbox, nextReception: date, inactiveForPurchases: checkbox, controlsPieces: checkbox,
  inTransit: readonly(signed(2)), initialPhysical: readonly(signed(4)), notShipped: signed(2), firstPosSaleAt: date,
  physicalCount: readonly(signed(4)), changedBy: readonly(integer()), pointWeight: signed(2), rowCode: text(1),
  rootCode: text(13), colorCode: readonly(text(6)), externalColor: text(20, true),
  discountGroup: integer(7),
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`list${i + 4}`, i === 2 ? decimal(4) : signed(4)])),
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`currency${i + 4}`, integer(i >= 7 ? 255 : 2_147_483_647)])),
  percentage4: signed(2), percentage5: signed(2), percentage6: signed(2),
  commissionPercentage: signed(2), iepsPercentage: signed(6), fixedIeps: readonly(signed(2)),
  offerFrom: date, offerUntil: date, offerDiscount: signed(2), minimumUntil: date, walletPercentage: signed(2),
  taxRateType: integer(2), vatWithholdingType: integer(3),
  noInventoryLayer: checkbox, customsEntry: text(15, true), importDate: date, customsOffice: text(25),
  tariff: text(16), tariffPercentage: signed(2), lotPointer: readonly(integer()),
  lotSize: number({ decimals: 4, exclusiveMinimum: 0 }), productionTime: decimal(6),
  productionTimeType: integer(1), productionCapacity: integer(), assemblyDate: readonly(date),
  assemblyEnabled: readonly(integer()), secondCode: text(13, true), thirdCode: text(13, true),
  decreaseMinimumWithOrders: checkbox, nonproductiveTime: checkbox,
  baseCurrency: integer(9), purchaseVolume: decimal(3), purchaseUnitsPerBox: integer(2_147_483_647),
  purchaseLocation: text(4), supplierCode: text(6, true), royalty: signed(2), supplierProductCode: text(16, true),
  alternateUnit: text(3, true), alternateUnitFactor: number(), alternateUnitPrice: signed(4), unit: readonly(text(3)),
  seasonEndsAt: date, minimumPurchase: integer(2_147_483_647), temporaryCurve: integer(255),
  deliveryWeeksFactor: signed(2), warehouseWeeksFactor: signed(2), prepack: integer(2_147_483_647),
  purchaseStatus: integer(3), distributeOwnDc: checkbox,
  planPrice1: decimal(4), planPrice2: decimal(4), planPrice3: decimal(4), planPrice11: decimal(4),
  ...Object.fromEntries([4, 4, 4, 2, 4, 2, 4, 2, 2, 2, 2, 4, 4, 2, 4, 2, 2, 4].map((scale, i) => [`misc${i + 1}`, decimal(scale)])),
  temp: integer(2_147_483_647),
};

export const editableProductOtherDataFields = Object.keys(productOtherDataFields).filter(
  (key) => productOtherDataFields[key]?.editable,
);
