import { createHash, timingSafeEqual } from 'node:crypto';
import type { RowDataPacket } from 'mysql2/promise';
import { env } from '../../../../../config/env.js';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { OrderAuthorizationAccess } from '../../domain/datasources/order-authorization-access.js';

const keyRequired = () => new ApplicationError('Ingresa una clave de autorización de pedidos válida.', 'ORDER_APPROVER_REQUIRED', 401);
const denied = () => new ApplicationError('El usuario no tiene permiso para autorizar pedidos.', 'ORDER_APPROVER_FORBIDDEN', 403);

export class MysqlOrderAuthorizationAccess implements OrderAuthorizationAccess {
  constructor(private readonly keys = env.SALES_ORDER_APPROVER_KEYS) {}

  async verify(credential: string | undefined): Promise<number> {
    if (!this.keys.length) {
      throw new ApplicationError('La autorización de pedidos requiere claves personales configuradas.', 'ORDER_APPROVER_NOT_CONFIGURED', 503);
    }
    if (!credential || !/^[a-f0-9]{64}$/i.test(credential)) throw keyRequired();
    const digest = createHash('sha256').update(credential).digest();
    const approver = this.keys.find(({ sha256 }) => timingSafeEqual(digest, Buffer.from(sha256, 'hex')));
    if (!approver) throw keyRequired();

    // Derivada de la comprobación por grupo de INICIO/30 en el alcance México.
    const [[user]] = await legacyMysqlPool.execute<Array<RowDataPacket & { groupId: number }>>(
      `SELECT USRGROUP AS groupId FROM FUSERS JOIN FCIA ON CIASEQ=1
       WHERE USRSEQ=? AND USRBAJA='1900-12-31' AND USRMULTICIA IN (0,1)
         AND CIAALIAS='TUVANSA' AND SUBSTRING(CIACOMPORTA,39,1)='1' LIMIT 1`, [approver.userId],
    );
    const group = user?.groupId;
    if (group === undefined || !Number.isInteger(group) || group < 0 || group > 41) throw denied();
    const [[access]] = await legacyMysqlPool.execute<Array<RowDataPacket & { allowed: number; requiresSupervisor: number }>>(
      `SELECT HUSER${group}<>0 AS allowed, TRIM(HVALIDACLAVE)<>'' AS requiresSupervisor
       FROM FHELP WHERE HKEY=? ORDER BY HSEQ LIMIT 1`, ['MPED5'],
    );
    if (!access?.allowed) throw denied();
    if (access.requiresSupervisor) {
      throw new ApplicationError('Esta acción requiere validación adicional de un supervisor en Omnis.', 'ORDER_SUPERVISOR_REQUIRED', 403);
    }
    return approver.userId;
  }
}
