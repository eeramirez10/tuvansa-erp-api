import { describe, expect, it } from 'vitest';
import { collectionCustomerBonus } from '../src/modules/sales/commissions/domain/entities/collection-customer-bonus.js';
describe('Bono de clientes marcado en FCLI', () => {
  it.each(['Nuevo', 'Viejo_Reactivado'])('aplica uno por ciento para %s, conservando precisión y sentido del PA antes del subtotal', status => {
    expect(collectionCustomerBonus(status, -123456)).toMatchObject({ customerBonusEligible: true, customerBonusBase: 1234.56, customerBonusRate: 1, customerBonus: 12.3456 });
    expect(collectionCustomerBonus(status, -50).customerBonus).toBe(0.005);
    expect(collectionCustomerBonus(status, -49).customerBonus).toBe(0.0049);
    expect(collectionCustomerBonus(status, 50).customerBonus).toBe(-0.005);
    expect(collectionCustomerBonus(status, 0).customerBonus).toBe(0);
  });
  it.each(['Recurrente', 'Inactivo'])('no aplica el incentivo a %s', status => {
    expect(collectionCustomerBonus(status, -123456)).toMatchObject({ customerBonusEligible: false, customerBonusBase: 0, customerBonusRate: 0, customerBonus: 0 });
  });
  it('respeta la marca guardada, normaliza espacios/caso y no reclasifica por fechas', () => {
    expect(collectionCustomerBonus(' viejo_reactivado ', -10000).customerStatus).toBe('Viejo_Reactivado');
    expect(collectionCustomerBonus(' recurrente ', -10000).customerBonus).toBe(0);
  });
  it('no convierte una clasificación desconocida o pago faltante en una comisión cero', () => {
    expect(collectionCustomerBonus('', -10000)).toMatchObject({ customerStatus: 'Sin clasificar', customerBonus: null, customerBonusRate: null });
    expect(collectionCustomerBonus('N/D', -10000).customerBonus).toBeNull();
    expect(collectionCustomerBonus('Nuevo', null)).toMatchObject({ customerBonusBase: null, customerBonus: null });
  });
});
