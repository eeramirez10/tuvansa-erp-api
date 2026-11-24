export interface PurchasePedimento {
  number: string;
  date: string | null;
  customsOffice: string;
  incrementables: number;
}

export interface PedimentoTariffBasis {
  unitPrice: number;
  quantity: number;
  lineAfterDiscount: number;
  netGoods: number;
  incrementables: number;
  tariffPercent: number;
}

export function pedimentoTariff({
  unitPrice, quantity, lineAfterDiscount, netGoods, incrementables, tariffPercent,
}: PedimentoTariffBasis) {
  // MRECEP/32. #4 ya incluye el descuento de partida. DBRUTO-DDESC incluye los descuentos de la recepción.
  const perUnit = incrementables === 0 ? 0
    : Number((lineAfterDiscount / netGoods * incrementables / quantity).toFixed(2));
  return Number(((unitPrice + perUnit) * tariffPercent / 100).toFixed(4));
}
