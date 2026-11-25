import type { RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import { accessGroups, type LegacyUserDirectory, type NativePermission, type NativeUser } from '../domain/user-directory.js';

const nativeUsers = `SELECT USRSEQ AS legacyId, TRIM(USRCOD) AS identification, TRIM(USRNAME) AS name,
  USRGROUP AS \`group\`, USRMULTICIA=0 AS shared, USRBAJA='1900-12-31' AS active
  FROM FUSERS
  WHERE USRSEQ>0 AND USRMULTICIA IN (0,1)
    AND EXISTS (SELECT 1 FROM FCIA WHERE CIASEQ=1 AND CIAALIAS='TUVANSA')`;

export const legacyUserDirectory: LegacyUserDirectory = {
  async users() {
    const [rows] = await legacyMysqlPool.query<Array<RowDataPacket & NativeUser>>(nativeUsers);
    return rows.map(user => ({ ...user, active: Boolean(user.active), shared: Boolean(user.shared) }));
  },
  async user(id) {
    const [[user]] = await legacyMysqlPool.execute<Array<RowDataPacket & NativeUser>>(
      `${nativeUsers} AND USRSEQ=? LIMIT 1`, [id]);
    return user && { ...user, active: Boolean(user.active), shared: Boolean(user.shared) };
  },
  async permissions(group, keys) {
    if (!accessGroups.includes(group) || keys?.length === 0) return [];
    const filter = keys ? `AND HKEY IN (${keys.map(() => '?').join(',')})` : '';
    const [rows] = await legacyMysqlPool.execute<Array<RowDataPacket & NativePermission>>(
      `SELECT TRIM(HKEY) AS \`key\`, COALESCE(NULLIF(TRIM(HWIZARDDESCR),''),NULLIF(TRIM(HHELP2),''),TRIM(HKEY)) AS label,
        COALESCE(TRIM(HMODULO),'') AS module, HUSER${group}<>0 AS allowed,
        COALESCE(TRIM(HVALIDACLAVE),'')<>'' AS requiresSupervisor
       FROM FHELP WHERE TRIM(HKEY)<>''
         AND EXISTS (SELECT 1 FROM FCIA WHERE CIASEQ=1 AND CIAALIAS='TUVANSA' AND SUBSTRING(CIACOMPORTA,39,1)='1')
         ${filter} ORDER BY HSEQ`, keys ?? []);
    const permissions = new Map<string, NativePermission>();
    for (const row of rows) {
      if (!permissions.has(row.key)) permissions.set(row.key, {
        key: row.key, label: row.label, module: row.module,
        allowed: Boolean(row.allowed), requiresSupervisor: Boolean(row.requiresSupervisor),
      });
    }
    return [...permissions.values()];
  },
};
