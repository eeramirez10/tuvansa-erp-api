export const purchaseOrderAuthorizationLevels = ['A', 'B', 'C', 'D', 'E', 'F'] as const;
export type PurchaseOrderAuthorizationLevel = typeof purchaseOrderAuthorizationLevels[number];
export type PurchaseOrderAuthorizationDirection = 'approve' | 'revoke';

export const isPurchaseOrderAuthorizationStatus = (code: string) => /^9[A-F]?$/.test(code);

export function purchaseOrderAuthorizationTransition(
  current: string, level: PurchaseOrderAuthorizationLevel, direction: PurchaseOrderAuthorizationDirection,
): string | null {
  const target = `9${level}`;
  const previous = `9${purchaseOrderAuthorizationLevels[purchaseOrderAuthorizationLevels.indexOf(level) - 1] ?? ''}`;
  if (direction === 'revoke') {
    return current === target || (level === 'F' && current > target) ? previous : null;
  }
  const allowed = level === 'A' || level === 'F' ? current < target : current === previous;
  return allowed ? target : null;
}
