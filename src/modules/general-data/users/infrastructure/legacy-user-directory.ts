import type { RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import { accessGroups, duplicatePolicyLiabilityPermission, type LegacyUserDirectory, type NativePermission, type NativeUser, type NativeUserDetails } from '../domain/user-directory.js';

const userColumns = `USRSEQ AS legacyId, TRIM(USRCOD) AS identification, TRIM(USRNAME) AS name,
  USRGROUP AS \`group\`, USRMULTICIA=0 AS shared, USRBAJA='1900-12-31' AS active`;
const userDetails = `USRCIA AS company, USRDEPTO AS department, USRMULTICIA AS multiCompany, NULLIF(TRIM(USROBS),'') AS notes,
  USRNOCOSTOS AS hideCosts, USRNOSALDOS AS hideBalances, USRSOLOEL AS ownCustomersOnly,
  NULLIF(TRIM(USRPAR),'') AS parameter, NULLIF(USRES,0) AS classifier,
  NULLIF(TRIM(USRPRINTERNAME),'') AS printer, NULLIF(USRSIPETIQ,0) AS labelPrinter,
  NULLIF(TRIM(USRPROVS),'') AS supplierClassifiers, NULLIF(USRFI,'1900-12-31') AS captureFrom,
  NULLIF(USRFF,'1900-12-31') AS captureUntil, NULLIF(TRIM(USRTDA),'') AS store,
  NULLIF(TRIM(USRNOMINA),'') AS payrollNumber, NULLIF(TRIM(USRPUESTO),'') AS position`;
const nativeUsers = `FROM FUSERS
  WHERE USRSEQ>0 AND USRMULTICIA IN (0,1)
    AND EXISTS (SELECT 1 FROM FCIA WHERE CIASEQ=1 AND CIAALIAS='TUVANSA')`;

function nativeUser(row: NativeUser): NativeUser {
  return { legacyId: row.legacyId, identification: row.identification, name: row.name,
    group: row.group, active: Boolean(row.active), shared: Boolean(row.shared) };
}

type DetailRow = Omit<NativeUserDetails, 'hideCosts' | 'hideBalances' | 'ownCustomersOnly'> & {
  hideCosts: number | null; hideBalances: number | null; ownCustomersOnly: number | null;
};

const flag = (value: number | null) => value === null ? null : value !== 0;

export const legacyUserDirectory: LegacyUserDirectory = {
  async users() {
    const [rows] = await legacyMysqlPool.query<Array<RowDataPacket & NativeUser>>(`SELECT ${userColumns} ${nativeUsers}`);
    return rows.map(nativeUser);
  },
  async user(id, includeDetails = false) {
    const [[row]] = await legacyMysqlPool.execute<Array<RowDataPacket & NativeUser & DetailRow>>(
      `SELECT ${userColumns}${includeDetails ? `, ${userDetails}` : ''} ${nativeUsers} AND USRSEQ=? LIMIT 1`, [id]);
    if (!row) return undefined;
    const user = nativeUser(row);
    if (!includeDetails) return user;
    return {
      ...user,
      details: {
        company: row.company, department: row.department, multiCompany: row.multiCompany, notes: row.notes,
        hideCosts: flag(row.hideCosts), hideBalances: flag(row.hideBalances), ownCustomersOnly: flag(row.ownCustomersOnly),
        parameter: row.parameter, classifier: row.classifier ?? null, printer: row.printer,
        labelPrinter: row.labelPrinter, supplierClassifiers: row.supplierClassifiers,
        captureFrom: row.captureFrom, captureUntil: row.captureUntil, store: row.store, payrollNumber: row.payrollNumber, position: row.position,
      },
    };
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
    if ((!keys || keys.includes(duplicatePolicyLiabilityPermission)) && !permissions.has(duplicatePolicyLiabilityPermission)) {
      permissions.set(duplicatePolicyLiabilityPermission, {
        key: duplicatePolicyLiabilityPermission, label: 'Duplicar pasivo', module: 'Contabilidad',
        allowed: false, requiresSupervisor: false,
      });
    }
    return [...permissions.values()];
  },
};
