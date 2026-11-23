import { describe, expect, it } from 'vitest';
import { isPurchaseOrderAuthorizationStatus, purchaseOrderAuthorizationTransition as transition } from '../src/modules/purchasing/purchase-orders/domain/entities/purchase-order-authorization.js';

describe('autorización de órdenes de compra', () => {
  it('avanza A–E según EOC#16 y revierte sólo el nivel vigente', () => {
    expect(transition('', 'A', 'approve')).toBe('9A');
    expect(transition('9003', 'A', 'approve')).toBe('9A');
    expect(transition('9A', 'B', 'approve')).toBe('9B');
    expect(transition('9A', 'C', 'approve')).toBeNull();
    expect(transition('9B', 'C', 'approve')).toBe('9C');
    expect(transition('9C', 'D', 'approve')).toBe('9D');
    expect(transition('9D', 'E', 'approve')).toBe('9E');
    expect(transition('9E', 'D', 'revoke')).toBeNull();
    expect(transition('9D', 'D', 'revoke')).toBe('9C');
    expect(transition('9A', 'A', 'revoke')).toBe('9');
  });

  it('conserva las comparaciones de F y reserva los códigos de autorización', () => {
    expect(transition('', 'F', 'approve')).toBe('9F');
    expect(transition('9F', 'F', 'approve')).toBeNull();
    expect(transition('9G', 'F', 'revoke')).toBe('9E');
    expect(transition('9E', 'F', 'revoke')).toBeNull();
    expect(isPurchaseOrderAuthorizationStatus('9')).toBe(true);
    expect(isPurchaseOrderAuthorizationStatus('9D')).toBe(true);
    expect(isPurchaseOrderAuthorizationStatus('9003')).toBe(false);
  });
});
