import type { RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { MovementHeader } from '../../domain/entities/inventory-movement.js';
import type {
  InventoryMovementPrintReferences,
  MovementPrintCustoms,
  MovementPrintSettings,
} from '../../domain/repositories/inventory-movement-print-references.js';
import { isLocalInventoryLayerId, readLocalInventoryAdjustments } from './inventory-adjustment-layers.js';

interface SettingsRow extends RowDataPacket {
  format: string | null;
  adHoc: number;
  companyName: string | null;
  city: string | null;
  state: string | null;
  warehouseName: string | null;
}

interface CustomsRow extends MovementPrintCustoms { id: number | string }

export class InventoryMovementPrintDataSource implements InventoryMovementPrintReferences {
  async settings({ type, company, warehouse }: MovementHeader): Promise<MovementPrintSettings | null> {
    // Derivada de MFACT/21: toma el formato efectivo del tipo de movimiento, dando prioridad a la compañía.
    const [rows] = await legacyMysqlPool.execute<SettingsRow[]>(
      `SELECT TRIM(t.TIREPNAME) AS format, t.TIADHOC AS adHoc, c.CIANAME AS companyName,
         c.CIACD AS city, c.CIAEDO AS state,
         (SELECT a.CATDESCR FROM FALMCAT a WHERE a.CATALM=? AND a.CATTIPO=''
          AND a.CATMULTICIA IN (0,c.CIASEQ) ORDER BY a.CATMULTICIA DESC,a.CATSEQ LIMIT 1) AS warehouseName
       FROM FCIA c JOIN FTIPMV t ON t.TICLA=? AND t.TIMULTICIA IN (0,c.CIASEQ) AND t.TIMODULO=2
       WHERE c.CIASEQ=? AND c.CIAALIAS='TUVANSA' ORDER BY t.TIMULTICIA DESC,t.TISEQ LIMIT 1`,
      [warehouse, type, company],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      format: row.format ?? '',
      adHoc: Boolean(row.adHoc),
      companyName: row.companyName?.trim() ?? '',
      place: [row.city?.trim(), row.state?.trim()].filter(Boolean).join(', '),
      warehouseName: row.warehouseName?.trim() ?? '',
    };
  }

  async customsByLot(ids: number[]): Promise<Map<number, MovementPrintCustoms>> {
    const historical = ids.filter((id) => !isLocalInventoryLayerId(id));
    const local = ids.filter(isLocalInventoryLayerId);
    // Derivada. El desglose de pedimento se vincula a la capa conservada en la partida.
    const [rows] = historical.length ? await legacyMysqlPool.execute<(RowDataPacket & CustomsRow)[]>(
      `SELECT LOSEQ AS id, TRIM(LOPEDIM) AS entry, NULLIF(DATE_FORMAT(LOFECHA,'%Y-%m-%d'),'1900-12-31') AS date,
         TRIM(LOADUANA) AS office FROM FLOTES WHERE LOSEQ IN (${historical.map(() => '?').join(',')})`,
      historical,
    ) : [[]];
    const localRows = local.length ? await readLocalInventoryAdjustments<CustomsRow[]>([], async (client) => {
      const result = await client.query<CustomsRow>(
        `SELECT id, customs_entry AS entry, to_char(lot_date,'YYYY-MM-DD') AS date,
           customs_office AS office FROM tuvansa.inventory_adjustment_layers WHERE id=ANY($1::bigint[])`,
        [local],
      );
      return result.rows;
    }) : [];
    return new Map([...rows, ...localRows].map(({ id, entry, date, office }) => [Number(id), { entry, date, office }]));
  }
}
