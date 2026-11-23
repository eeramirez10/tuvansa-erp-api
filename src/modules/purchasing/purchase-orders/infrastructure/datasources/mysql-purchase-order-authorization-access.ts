import { createHash, timingSafeEqual } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import { env } from '../../../../../config/env.js';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { PurchaseOrderAuthorizationAccess } from '../../domain/datasources/purchase-order-authorization-data-source.js';
import type { PurchaseOrderSupplierChangeMode } from '../../domain/datasources/purchase-order-supplier-change-data-source.js';
import { purchaseOrderAuthorizationLevels, type PurchaseOrderAuthorizationLevel } from '../../domain/entities/purchase-order-authorization.js';

const groupColumns = Array.from({ length: 40 }, (_, index) => `HUSER${index}`).join(', ');
const denied = (supplierChange: boolean) => new ApplicationError(supplierChange
  ? 'El usuario no tiene permiso para cambiar proveedor.' : 'El usuario no tiene permiso para este nivel de autorización.',
'PURCHASE_ORDER_APPROVER_FORBIDDEN', 403);

export class MysqlPurchaseOrderAuthorizationAccess implements PurchaseOrderAuthorizationAccess {
  enabled() { return env.PURCHASE_ORDER_APPROVER_KEYS.some(({ levels }) => levels.length > 0); }

  levels() {
    return purchaseOrderAuthorizationLevels.filter((level) => env.PURCHASE_ORDER_APPROVER_KEYS.some((approver) => approver.levels.includes(level)));
  }

  supplierChangeEnabled(mode: PurchaseOrderSupplierChangeMode) {
    return env.PURCHASE_ORDER_APPROVER_KEYS.some((approver) =>
      mode === 'action' ? approver.supplierChangeAction : approver.supplierChange);
  }

  async verify(key: string | undefined, action: PurchaseOrderAuthorizationLevel | 'supplier-change' | 'supplier-change-action'): Promise<number> {
    const direct = action === 'supplier-change-action';
    const supplierChange = action === 'supplier-change' || direct;
    const permission = direct ? 'EOC#35/40' : action === 'supplier-change' ? 'EOC#16/7'
      : `EOC#16/${purchaseOrderAuthorizationLevels.indexOf(action) + 1}`;
    const requiredPermissions = direct ? [permission] : ['MRECEP63-A', permission];
    if (!key) throw new ApplicationError('Ingresa una clave de autorización válida.', 'PURCHASE_ORDER_APPROVER_REQUIRED', 401);
    const digest = createHash('sha256').update(key).digest();
    const approver = env.PURCHASE_ORDER_APPROVER_KEYS.find(({ sha256 }) => timingSafeEqual(digest, Buffer.from(sha256, 'hex')));
    if (!approver) throw new ApplicationError('Ingresa una clave de autorización válida.', 'PURCHASE_ORDER_APPROVER_REQUIRED', 401);
    if (!(direct ? approver.supplierChangeAction
      : action === 'supplier-change' ? approver.supplierChange : approver.levels.includes(action))) throw denied(supplierChange);

    const [[users], [permissions]] = await Promise.all([
      legacyMysqlPool.execute<Array<RowDataPacket & { groupId: number; permissionByGroup: number }>>(
        `SELECT USRGROUP AS groupId, SUBSTRING(CIACOMPORTA,39,1)='1' AS permissionByGroup
         FROM FUSERS JOIN FCIA ON FCIA.CIASEQ=1
         WHERE USRSEQ=? AND USRBAJA='1900-12-31' AND USRMULTICIA IN (0,?)`,
        [approver.userId, env.PURCHASE_ORDER_EDIT_COMPANY_ID],
      ),
      legacyMysqlPool.execute<RowDataPacket[]>(
        `SELECT HKEY AS permission, HVALIDACLAVE<>'' AS requiresSupervisor, ${groupColumns}
         FROM FHELP WHERE HKEY IN (${requiredPermissions.map(() => '?').join(',')}) ORDER BY HSEQ`,
        requiredPermissions,
      ),
    ]);
    const user = users[0];
    if (!user || !user.permissionByGroup) throw denied(supplierChange);
    const groupId = user.groupId;
    const access = new Map<string, RowDataPacket>();
    for (const row of permissions) {
      if (!access.has(row.permission)) access.set(row.permission, row);
    }
    const relevant = requiredPermissions.map((item) => access.get(item));
    if (groupId !== 0 && relevant.some((row) => !Number(row?.[`HUSER${groupId}`]))) throw denied(supplierChange);
    if (relevant.some((row) => Number(row?.requiresSupervisor))) {
      throw new ApplicationError('Esta acción requiere validación adicional de un supervisor en Omnis.', 'PURCHASE_ORDER_SUPERVISOR_REQUIRED', 403);
    }
    return approver.userId;
  }
}
