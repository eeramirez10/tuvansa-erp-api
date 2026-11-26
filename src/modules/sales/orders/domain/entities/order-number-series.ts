import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';

export interface OrderNumberSeries {
  code: string;
  description: string;
  taxPercentage: number;
  digits: number;
  lastNumber: number;
}

export const orderNumberPattern = (code: string, digits: number) => `^${code}[0-9]{${digits}}$`;

export function nextOrderNumber(series: OrderNumberSeries, lastLocalNumber: number): string {
  const next = String(Math.max(series.lastNumber, lastLocalNumber) + 1);
  if (next.length > series.digits) {
    throw new ConflictError('Se agotó el consecutivo del tipo de movimiento de pedidos.', 'ORDER_NUMBER_EXHAUSTED');
  }
  return series.code + next.padStart(series.digits, '0');
}
