import type { RowDataPacket } from 'mysql2/promise';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { ProductOtherDataCatalogSource } from '../../domain/datasources/product-other-data-source.js';
import { productOtherDataFields, type ProductOtherDataValue } from '../../domain/entities/product-other-data.js';
import type { ProductOtherDataCatalog } from '../../domain/repositories/product-other-data-repository.js';

const fields = {
  volume: 'IVOLUMEN', weight: 'IPESO', unitsPerBox: 'ICANTCAJA', packaging: 'IEMPAQUE',
  length: 'ILARGO', width: 'IANCHO', height: 'IALTO', location: 'ILOCALIZ',
  ediPackaging: 'IEDIEMP', ediQuantity: 'IEDIEMPC', density: 'IDENSIDAD', weightPerMeter: 'IPESOMTRO',
  composition: 'ICOMPOS', warehouse: 'IBODEGA', changedAt: 'IFECHACAMBIO', salePricesChangedAt: 'IFECHACAMBIOPR',
  virtualStore: 'ITVP', nextReception: 'IPROXRECEP', inactiveForPurchases: 'IINACTIVO', controlsPieces: 'ICONTROLPZAS',
  inTransit: 'ITRANSITO', initialPhysical: 'IFISICOINICIAL', notShipped: 'IPERDIDAVTA', firstPosSaleAt: 'IPRIMERVTAPOS',
  physicalCount: 'INVFIS', changedBy: 'IUSEQ', pointWeight: 'IPESOSPARAPUNTO', rowCode: 'IRENGLON',
  rootCode: 'IRAIZ', colorCode: 'ICOLOR', externalColor: 'ICOLOREXT',
  discountGroup: 'IDESCGRUPO',
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`list${i + 4}`, `ILISTA${i + 4}`])),
  ...Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`currency${i + 4}`, `IMONEDA${i + 4}`])),
  percentage4: 'IPORC1', percentage5: 'IPORC2', percentage6: 'IPORC3',
  commissionPercentage: 'IPORCOMISION', iepsPercentage: 'IPORCIEPES', fixedIeps: 'IFIJOIEPS',
  offerFrom: 'IOFERDESDE', offerUntil: 'IOFERHASTA', offerDiscount: 'IDESCTOPOS', minimumUntil: 'IMINIMOHASTA',
  walletPercentage: 'IDESCTOMON', taxRateType: 'IPORCIVA', vatWithholdingType: 'IRETIVA',
  noInventoryLayer: 'INOCAPAS', customsEntry: 'IPEDIMENTO', importDate: 'IFECHAIMPORT', customsOffice: 'IADUANA',
  tariff: 'IARANCEL', tariffPercentage: 'IPORCARANC', lotPointer: 'IPOINTERLOTE',
  lotSize: 'ILOTE', productionTime: 'ITIEMPO', productionTimeType: 'ITIPOTIEMPO', productionCapacity: 'INUMMAQ',
  assemblyDate: 'IFECHAENSAMBLE', assemblyEnabled: 'IENSABLES', secondCode: 'ISEGUNDAS', thirdCode: 'ITERCERAS',
  decreaseMinimumWithOrders: 'IREBAJAMINIMO', nonproductiveTime: 'INOPRODUCTIVO',
  baseCurrency: 'IMONEDA', purchaseVolume: 'IVOLUMEN2', purchaseUnitsPerBox: 'ICANTCAJA2', purchaseLocation: 'ILUGAR',
  supplierCode: 'IPRV', royalty: 'IROYALTY', supplierProductCode: 'ICODPRV', alternateUnit: 'IUM2',
  alternateUnitFactor: 'IUM2FACTOR', alternateUnitPrice: 'IUM2PRECIO', unit: 'IUM',
  seasonEndsAt: 'IFINTEMPORADA', minimumPurchase: 'ICOMPRAMINIMA', temporaryCurve: 'ICURVATMP',
  deliveryWeeksFactor: 'IFACTORSEMTDAS', warehouseWeeksFactor: 'IFACTORSEMBODEGA', prepack: 'IPREPACK',
  purchaseStatus: 'ISTATUSOTB', distributeOwnDc: 'ISOLOCD',
  planPrice1: 'IPLANLISTA1', planPrice2: 'IPLANLISTA2', planPrice3: 'IPLANLISTA3', planPrice11: 'IPLANLISTA11',
  ...Object.fromEntries(Array.from({ length: 18 }, (_, i) => [`misc${i + 1}`, `IVARIOS${i + 1}`])),
  temp: 'ITEMP',
} satisfies Record<string, string>;

// Aliases and identifiers above are fixed, so only product IDs come from a request.
const productOtherDataProjection = Object.entries(fields).map(([key, column]) => `${column} AS ${key}`).join(', ');
const miscLabelColumns = Array.from({ length: 17 }, (_, i) => `CIAVAR${i + 1}`);

type ProductRow = RowDataPacket & { id: number; code: string; description: string } & Record<string, ProductOtherDataValue>;
interface TariffRow extends RowDataPacket { code: string; description: string }

const tariffPercentage = (description: string) => {
  const amount = /\*\s*([+-]?\d+(?:[.,]\d+)?)\s*%/.exec(description)?.[1];
  return amount === undefined ? null : Number(amount.replace(',', '.'));
};

// Derivada de los campos de EINV2#1. OMNIS abre la ventana con FINV en memoria.
export class LegacyMysqlProductOtherDataSource implements ProductOtherDataCatalogSource {
  async get(productId: number): Promise<ProductOtherDataCatalog | null> {
    const [products] = await legacyMysqlPool.execute<ProductRow[]>(
      `SELECT ISEQ AS id, ICOD AS code, IDESCR AS description, ${productOtherDataProjection}
       FROM finv WHERE ISEQ = ? LIMIT 1`, [productId],
    );
    const row = products[0];
    if (!row) return null;

    const [[companies], [tariffs]] = await Promise.all([
      legacyMysqlPool.execute<RowDataPacket[]>(
        `SELECT SUBSTRING(CIACOMPORTA,56,1) AS derivesList6, ${miscLabelColumns.join(', ')}
         FROM fcia WHERE CIASEQ = 1 LIMIT 1`,
      ),
      legacyMysqlPool.execute<TariffRow[]>(
        `SELECT CATCOD AS code, CATDESCR AS description FROM falmcat WHERE CATTIPO = 'ARA' ORDER BY CATSEQ`,
      ),
    ]);
    const company = companies[0];
    return {
      product: { id: row.id, code: row.code.trim(), description: row.description.trim() },
      values: Object.fromEntries(Object.keys(fields).map((key) => {
        const value = row[key] ?? null;
        return [key, productOtherDataFields[key]?.kind === 'boolean' ? Boolean(value) : value];
      })),
      tariffs: tariffs.map(({ code, description }) => ({
        code: code.trim(), description: description.trim(), percentage: tariffPercentage(description),
      })),
      miscLabels: miscLabelColumns.map((column) => String(company?.[column] ?? '').trim()),
      derivesList6: company?.derivesList6 === '1',
    };
  }
}
