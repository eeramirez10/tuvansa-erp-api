import type { ResultSetHeader, RowDataPacket } from 'mysql2';
import { legacyMysqlPool } from '../../../../../shared/infrastructure/database/legacy-mysql-pool.js';
import type { ProductPanelsDataSource } from '../../domain/datasources/product-panels-data-source.js';
import type {
  ProductPanelCriteria,
  ProductBlockStatus,
  ProductPanelKey,
  ProductPanelResult,
  ProductPanelSection,
} from '../../domain/repositories/product-panels-repository.js';

interface ProductHeaderRow extends RowDataPacket {
  id: number;
  code: string;
  description: string;
}

type PanelRow = RowDataPacket & Record<string, unknown>;
type ParameterMode = 'id' | 'code' | 'code-range';

interface PanelDefinition {
  section: ProductPanelSection;
  button: string;
  sql?: string;
  parameterMode?: ParameterMode;
  source?: ProductPanelResult['source'];
  reason?: string;
}

const unavailable = (
  section: ProductPanelSection,
  button: string,
  reason: string,
): PanelDefinition => ({ section, button, source: 'not-available', reason });

const definitions: Record<ProductPanelKey, PanelDefinition> = {
  warehouses: {
    section: 'actions', button: 'Almacenes',
    sql: `SELECT FALM.ALMSEQ AS id, ALMNUM AS warehouseCode,
      FALMCAT.CATDESCR AS warehouseDescription, ALMCANT AS quantity,
      ALMASIGNADO AS assigned, ALMMINIMO AS minimum, ALMMAXIMO AS maximum,
      ALMVTA AS sales, ALMINVFIS AS physicalInventory,
      ALMFISICOINICIAL AS initialPhysicalInventory, ALMACTIVO AS count,
      ALMTRANSITO AS inTransit, ALMALTA AS createdAt, ALMULTIMAVTA AS lastSaleAt,
      ALMLOCALIZ AS location, ALMTOTVTA AS totalSales,
      ALMMINIMOENTDA AS storeMinimum, ALMPRECIO AS price
      FROM falm
      LEFT JOIN falmcat ON falm.ALMNUM = falmcat.CATALM
      WHERE falm.ISEQ = ? ORDER BY FALM.ALMSEQ`,
    parameterMode: 'id',
  },
  'color-size-registration': unavailable(
    'actions', 'Alta CT', 'Esta versión no contiene el módulo de COLOR Y TALLA',
  ),
  'block-status': {
    section: 'actions', button: 'Bloquear', source: 'product-cache',
    sql: `SELECT (IBAJA <> '1900-12-31') AS blocked,
      NULLIF(IBAJA, '1900-12-31') AS deactivatedAt
      FROM finv WHERE ISEQ = ?`, parameterMode: 'id',
  },
  classifications: {
    section: 'actions', button: 'Clasificar', source: 'product-cache',
    sql: `SELECT IFAM AS familyCode, IFAM1 AS level1, IFAM2 AS level2,
      IFAM3 AS level3, IFAM4 AS level4, IFAM5 AS level5, IFAM6 AS level6,
      IFAM7 AS level7, IFAM8 AS level8, IFAM9 AS level9
      FROM finv WHERE ISEQ = ?`, parameterMode: 'id',
  },
  'extended-description': {
    section: 'actions', button: 'Descr. ext.',
    sql: `SELECT I2SEQ AS id, I2DESCR AS description1, I2DESCR2 AS description2,
      I2DESCR3 AS description3, I2DESCR4 AS description4, I2COD AS code
      FROM finv2 WHERE I2KEY = ? ORDER BY I2SEQ`, parameterMode: 'id',
  },
  'customer-discounts': {
    section: 'actions', button: '% Descuentos clis',
    sql: `SELECT DESSEQ AS id, DESKEY AS customerKey, DES1 AS discount1,
      DES2 AS discount2, DES3 AS price, DESFECHA AS validFrom,
      DESFECHAAL AS validTo, DESCANTINI AS minimumQuantity,
      DESCANTFIN AS maximumQuantity, DESDEPTO AS department,
      DESOBS AS observations, DESSTATUS AS status, DESUNIDAD AS unit
      FROM fdesctos WHERE DESKEY2 >= ? AND DESKEY2 <= CONCAT(?, 'zzz')
      ORDER BY DESKEY2, DESSEQ`, parameterMode: 'code-range',
  },
  'supplier-discounts': {
    section: 'actions', button: '% Descuentos prv',
    sql: `SELECT DESSEQ AS id, DESKEY AS supplierKey, DES1 AS discount1,
      DES2 AS discount2, DES3 AS price, DESFECHA AS validFrom,
      DESFECHAAL AS validTo, DESCANTINI AS minimumQuantity,
      DESCANTFIN AS maximumQuantity, DESDEPTO AS department,
      DESOBS AS observations, DESSTATUS AS status, DESUNIDAD AS unit
      FROM fdesctos WHERE DESKEY2 >= ? AND DESKEY2 <= CONCAT(?, 'zzz')
      ORDER BY DESKEY2, DESSEQ`, parameterMode: 'code-range',
  },
  'other-data': {
    section: 'actions', button: 'Otros', source: 'product-cache',
    sql: `SELECT IVOLUMEN AS volume, IPESO AS weight, ICANTCAJA AS unitsPerBox,
      IEMPAQUE AS packaging, ILARGO AS length, IANCHO AS width, IALTO AS height,
      IEDIEMP AS ediPackaging, IEDIEMPC AS ediQuantity, IPESOMTRO AS weightPerMeter,
      ICOMPOS AS composition, IBODEGA AS warehouse, IINACTIVO AS inactiveForPurchases,
      ICONTROLPZAS AS controlsPieces, ITRANSITO AS inTransit,
      IFISICOINICIAL AS initialPhysical, IPESOSPARAPUNTO AS pointWeight,
      IRENGLON AS rowCode, IRAIZ AS rootCode, ICOLOREXT AS externalColor,
      IPEDIMENTO AS customsEntry, IFECHAIMPORT AS importDate, IADUANA AS customsOffice,
      IARANCEL AS tariff, IPORCARANC AS tariffPercentage, ILOTE AS lotControlled,
      ITIEMPO AS productionTime, ITIPOTIEMPO AS productionTimeType,
      IFECHAENSAMBLE AS assemblyDate
      FROM finv WHERE ISEQ = ?`, parameterMode: 'id',
  },
  specifications: {
    section: 'actions', button: 'Especificaciones',
    sql: `SELECT I2SEQ AS id, I2DESCR AS description1, I2DESCR2 AS description2,
      I2DESCR3 AS description3, I2DESCR4 AS description4, I2COD AS code
      FROM finv2 WHERE I2KEY = ? ORDER BY I2SEQ`, parameterMode: 'id',
  },
  photo: unavailable(
    'actions', 'Foto', 'OMNIS no emitio una consulta MySQL para el contenido de la foto',
  ),
  'ct-inventory': {
    section: 'actions', button: 'Inv. CT', source: 'product-cache',
    sql: `SELECT ALMNUM AS warehouseCode, ALMCANT AS stock,
      ALMASIGNADO AS assigned, (ALMCANT - ALMASIGNADO) AS available,
      ALMTRANSITO AS inTransit, ALMMINIMO AS minimum, ALMMAXIMO AS maximum
      FROM falm WHERE ISEQ = ? ORDER BY ALMSEQ`, parameterMode: 'id',
  },
  prices: {
    section: 'actions', button: 'Precios', source: 'product-cache',
    sql: `SELECT ILISTA4 AS cost, ILISTA1 AS list1, ILISTA2 AS list2,
      ILISTA3 AS list3, ILISTA6 AS list6, ILISTA7 AS list7, ILISTA8 AS list8,
      ILISTA9 AS list9, ILISTA10 AS list10, ILISTA11 AS list11,
      ILISTA12 AS list12, ILISTA13 AS list13, IMONEDA1 AS currency1,
      IMONEDA2 AS currency2, IMONEDA3 AS currency3, IMONEDA6 AS currency6,
      IMONEDA7 AS currency7, IMONEDA8 AS currency8, IMONEDA9 AS currency9,
      IMONEDA10 AS currency10, IMONEDA11 AS currency11,
      IMONEDA12 AS currency12, IMONEDA13 AS currency13,
      IPLANLISTA1 AS posPlan1, IPLANLISTA2 AS posPlan2,
      IPLANLISTA3 AS posPlan3, IPLANLISTA11 AS posPlan11
      FROM finv WHERE ISEQ = ?`, parameterMode: 'id',
  },
  skus: {
    section: 'actions', button: 'SKUs',
    sql: `SELECT SKUSEQ AS id, SKUSKU AS sku FROM fskus
      WHERE ISEQ = ? ORDER BY SKUSEQ`, parameterMode: 'id',
  },
  prepacks: {
    section: 'actions', button: 'Prepacks', source: 'product-cache',
    sql: `SELECT IPREPACK AS prepack FROM finv WHERE ISEQ = ?`, parameterMode: 'id',
  },
  alternates: {
    section: 'purchases-production', button: 'Alternos',
    sql: `SELECT ALTSEQ AS id, ALTPROD AS productCode, ALTART AS alternateCode,
      alternate.IDESCR AS alternateDescription, alternate.ISTKACT AS stock,
      alternate.ILISTA1 AS price1, ALTVTA AS salePrice,
      ALTIGUALES AS equivalent, ALTPORCENT AS percentage,
      ALTTIPO AS alternateType, ALTVALOR AS alternateValue, ALTGEN AS generation
      FROM falternos
      LEFT JOIN finv AS alternate ON alternate.ICOD = falternos.ALTART
      WHERE ALTPROD = ? ORDER BY ALTSEQ`, parameterMode: 'code',
  },
  components: {
    section: 'purchases-production', button: 'Componentes',
    sql: `SELECT ENSEQ AS id, EPRO AS productCode, EART AS componentCode,
      component.IDESCR AS componentDescription, component.ISTKACT AS stock,
      component.ILISTA1 AS price1, component.ILISTA4 AS cost,
      (ECANT * component.ILISTA4) AS amount, ECANT AS quantity,
      EORDEN AS sortOrder, EHERENCIA AS inheritance,
      EHERENCIA2 AS inheritance2, EUSO AS usageValue, EFACTOR AS factor,
      EUNIDAD AS unit FROM fens
      LEFT JOIN finv AS component ON component.ICOD = fens.EART
      WHERE EPRO = ? ORDER BY ENSEQ`, parameterMode: 'code',
  },
  'quality-specifications': {
    section: 'purchases-production', button: 'Especific. Cal',
    sql: `SELECT CONCAT(PRSEQ, '-', slots.n) AS id, PRSEQ AS specificationId,
      slots.n AS testNumber, PRUPRV AS providerCode, PRUKEY AS specificationKey,
      CASE slots.n
        WHEN 1 THEN PRNOMBRE1 WHEN 2 THEN PRNOMBRE2 WHEN 3 THEN PRNOMBRE3
        WHEN 4 THEN PRNOMBRE4 WHEN 5 THEN PRNOMBRE5 WHEN 6 THEN PRNOMBRE6
        WHEN 7 THEN PRNOMBRE7 WHEN 8 THEN PRNOMBRE8 WHEN 9 THEN PRNOMBRE9
        WHEN 10 THEN PRNOMBRE10 WHEN 11 THEN PRNOMBRE11 WHEN 12 THEN PRNOMBRE12
        WHEN 13 THEN PRNOMBRE13 WHEN 14 THEN PRNOMBRE14 ELSE PRNOMBRE15 END AS testName,
      CASE slots.n
        WHEN 1 THEN PRMIN1 WHEN 2 THEN PRMIN2 WHEN 3 THEN PRMIN3
        WHEN 4 THEN PRMIN4 WHEN 5 THEN PRMIN5 WHEN 6 THEN PRMIN6
        WHEN 7 THEN PRMIN7 WHEN 8 THEN PRMIN8 WHEN 9 THEN PRMIN9
        WHEN 10 THEN PRMIN10 WHEN 11 THEN PRMIN11 WHEN 12 THEN PRMIN12
        WHEN 13 THEN PRMIN13 WHEN 14 THEN PRMIN14 ELSE PRMIN15 END AS minimum,
      CASE slots.n
        WHEN 1 THEN PRMAX1 WHEN 2 THEN PRMAX2 WHEN 3 THEN PRMAX3
        WHEN 4 THEN PRMAX4 WHEN 5 THEN PRMAX5 WHEN 6 THEN PRMAX6
        WHEN 7 THEN PRMAX7 WHEN 8 THEN PRMAX8 WHEN 9 THEN PRMAX9
        WHEN 10 THEN PRMAX10 WHEN 11 THEN PRMAX11 WHEN 12 THEN PRMAX12
        WHEN 13 THEN PRMAX13 WHEN 14 THEN PRMAX14 ELSE PRMAX15 END AS maximum,
      CASE slots.n
        WHEN 1 THEN PRUM1 WHEN 2 THEN PRUM2 WHEN 3 THEN PRUM3
        WHEN 4 THEN PRUM4 WHEN 5 THEN PRUM5 WHEN 6 THEN PRUM6
        WHEN 7 THEN PRUM7 WHEN 8 THEN PRUM8 WHEN 9 THEN PRUM9
        WHEN 10 THEN PRUM10 WHEN 11 THEN PRUM11 WHEN 12 THEN PRUM12
        WHEN 13 THEN PRUM13 WHEN 14 THEN PRUM14 ELSE PRUM15 END AS unit,
      CASE slots.n
        WHEN 1 THEN PROBS1 WHEN 2 THEN PROBS2 WHEN 3 THEN PROBS3
        WHEN 4 THEN PROBS4 WHEN 5 THEN PROBS5 WHEN 6 THEN PROBS6
        WHEN 7 THEN PROBS7 WHEN 8 THEN PROBS8 WHEN 9 THEN PROBS9
        WHEN 10 THEN PROBS10 WHEN 11 THEN PROBS11 WHEN 12 THEN PROBS12
        WHEN 13 THEN PROBS13 WHEN 14 THEN PROBS14 ELSE PROBS15 END AS observations,
      CASE slots.n
        WHEN 1 THEN PRMETODO1 WHEN 2 THEN PRMETODO2 WHEN 3 THEN PRMETODO3
        WHEN 4 THEN PRMETODO4 WHEN 5 THEN PRMETODO5 WHEN 6 THEN PRMETODO6
        WHEN 7 THEN PRMETODO7 WHEN 8 THEN PRMETODO8 WHEN 9 THEN PRMETODO9
        WHEN 10 THEN PRMETODO10 WHEN 11 THEN PRMETODO11 WHEN 12 THEN PRMETODO12
        WHEN 13 THEN PRMETODO13 WHEN 14 THEN PRMETODO14 ELSE PRMETODO15 END AS method,
      CASE slots.n
        WHEN 1 THEN PRPRIORIDAD1 WHEN 2 THEN PRPRIORIDAD2 WHEN 3 THEN PRPRIORIDAD3
        WHEN 4 THEN PRPRIORIDAD4 WHEN 5 THEN PRPRIORIDAD5 WHEN 6 THEN PRPRIORIDAD6
        WHEN 7 THEN PRPRIORIDAD7 WHEN 8 THEN PRPRIORIDAD8 WHEN 9 THEN PRPRIORIDAD9
        WHEN 10 THEN PRPRIORIDAD10 WHEN 11 THEN PRPRIORIDAD11 WHEN 12 THEN PRPRIORIDAD12
        WHEN 13 THEN PRPRIORIDAD13 WHEN 14 THEN PRPRIORIDAD14 ELSE PRPRIORIDAD15 END AS priority
      FROM fpruebas
      CROSS JOIN (SELECT 1 AS n UNION ALL SELECT 2 UNION ALL SELECT 3
        UNION ALL SELECT 4 UNION ALL SELECT 5 UNION ALL SELECT 6
        UNION ALL SELECT 7 UNION ALL SELECT 8 UNION ALL SELECT 9
        UNION ALL SELECT 10 UNION ALL SELECT 11 UNION ALL SELECT 12
        UNION ALL SELECT 13 UNION ALL SELECT 14 UNION ALL SELECT 15) AS slots
      WHERE ISEQ = ? ORDER BY PRSEQ, slots.n`, parameterMode: 'id',
  },
  implosion: {
    section: 'purchases-production', button: 'Implosion',
    sql: `SELECT ENSEQ AS id, EPRO AS parentProductCode, EART AS componentCode,
      parent.IDESCR AS parentDescription, ECANT AS quantity,
      EORDEN AS sortOrder, EFACTOR AS costPercentage, EUNIDAD AS unit
      FROM fens LEFT JOIN finv AS parent ON parent.ICOD = fens.EPRO
      WHERE EART = ? ORDER BY ENSEQ`, parameterMode: 'code',
  },
  lots: {
    section: 'purchases-production', button: 'Lotes',
    sql: `SELECT LOSEQ AS id, LOPEDIM AS customsEntry, LOFECHA AS date,
      LOADUANA AS customsOffice, LOCANT AS availableQuantity, LONUM AS number,
      LOCADUCIDAD AS expiresAt, LOLOTE AS lot, LOALM AS warehouse,
      LOCOSTO AS cost, LOCOSTOADV AS adValoremCost, LOLOCALIZ AS location
      FROM flotes WHERE ISEQ = ? ORDER BY LOSEQ`, parameterMode: 'id',
  },
  'inventory-layers': {
    section: 'purchases-production', button: 'UEPS / PEPS',
    sql: `SELECT LOSEQ AS id, LOCANTINI AS initialQuantity, LOCANT AS quantity,
      LOCOSTO AS cost, LOCOSTOADV AS adValoremCost, LOFECHA AS date,
      LODOC AS document, LOLOTE AS lot, LOCADUCIDAD AS expiresAt,
      LOALM AS warehouse, LOPRV AS supplier, LOTIPOC2 AS layerType,
      LOKEY AS layerKey
      FROM flotes WHERE ISEQ = ? ORDER BY LOSEQ`, parameterMode: 'id',
  },
  ledger: {
    section: 'queries', button: 'Auxiliar',
    sql: `SELECT AISEQ AS id, DFECHA AS date, DNUM AS document,
      AICANT AS quantity, AICOSTO AS cost, AITIPMV AS movementType,
      AIALMACEN AS warehouse, faxinv.LOSEQ AS lotId, DRUTA AS route,
      AIUSEQ AS userId, AIREVAL AS revaluation,
      LOPEDIM AS customsEntry, DREFER AS reference,
      AIPZAS AS pieces, AISKU AS sku, AICANTF AS finalQuantity,
      DREFERELLOS AS ellosReference, AIPRECIO AS price
      FROM faxinv LEFT JOIN fdoc ON faxinv.DSEQ = fdoc.DSEQ
      LEFT JOIN flotes ON faxinv.LOSEQ = flotes.LOSEQ
      WHERE faxinv.ISEQ = ? AND AIMES = 1 AND DEST = 0 AND DMULTICIA = 1
      ORDER BY AISEQ`, parameterMode: 'id',
  },
  'customer-orders': {
    section: 'queries', button: 'Pedidos por cliente',
    sql: `SELECT PLSEQ AS id, CLICOD AS customerCode, CLINOM AS customerName,
      PLCANT AS quantity, PLSURT AS fulfilled, PLASIGNADO AS assigned,
      PEDESDE AS orderedAt, PENUM AS orderNumber, PENUMELLOS AS externalNumber,
      PEALMACEN AS warehouse, PLPRECI AS price, PLFACTOR AS factor
      FROM fplin LEFT JOIN fcli ON fplin.CLISEQ=fcli.CLISEQ
      LEFT JOIN fpenc ON fplin.PESEQ=fpenc.PESEQ
      WHERE fplin.ISEQ = ? AND fcli.CLISEQ <> 0 AND PESPEDIDO = 1
      ORDER BY PLSEQ`, parameterMode: 'id',
  },
  'customer-orders-star': {
    section: 'queries', button: 'Pedidos por cliente *', source: 'product-cache',
    sql: `SELECT IPEDCLI AS ordered, IASIGNADO AS assigned,
      ISTKACT AS stock, (IPEDCLI - IASIGNADO) AS pending
      FROM finv WHERE ISEQ = ?`, parameterMode: 'id',
  },
  'customer-orders-ct': {
    section: 'queries', button: 'Pedidos por cliente CT',
    sql: `SELECT PLSEQ AS id, ICOD AS productCode, CLICOD AS customerCode,
      CLINOM AS customerName, PLCANT AS quantity, PLSURT AS fulfilled,
      PENUM AS orderNumber, PLPRECI AS price, PEDESDE AS orderedAt,
      PEVENCE AS dueAt, PENUMELLOS AS externalNumber
      FROM fplin LEFT JOIN finv ON fplin.ISEQ=finv.ISEQ
      LEFT JOIN fcli ON fplin.CLISEQ=fcli.CLISEQ
      LEFT JOIN fpenc ON fplin.PESEQ=fpenc.PESEQ
      WHERE ICOD >= ? AND ICOD <= CONCAT(?, 'z') AND fcli.CLISEQ <> 0
      AND PESPEDIDO = 1 ORDER BY ICOD, PLSEQ`, parameterMode: 'code-range',
  },
  'customer-quotes': {
    section: 'queries', button: 'Cotizaciones por cliente',
    sql: `SELECT PLSEQ AS id, CLICOD AS customerCode, CLINOM AS customerName,
      PLCANT AS quantity, PLSURT AS fulfilled, PLASIGNADO AS assigned,
      PEDESDE AS quotedAt, PENUM AS quoteNumber, PENUMELLOS AS externalNumber,
      PEALMACEN AS warehouse FROM fplin
      LEFT JOIN fcli ON fplin.CLISEQ=fcli.CLISEQ
      LEFT JOIN fpenc ON fplin.PESEQ=fpenc.PESEQ
      WHERE fplin.ISEQ = ? AND fcli.CLISEQ <> 0 AND PESPEDIDO = 4
      ORDER BY PLSEQ`, parameterMode: 'id',
  },
  'customer-sales': {
    section: 'queries', button: 'Ventas por cliente',
    sql: `SELECT MIN(AISEQ) AS id, CLICOD AS customerCode, CLINOM AS customerName,
      SUM(AICANTF) AS quantity, SUM(AICANTF * AIPRECIO) AS amount FROM faxinv
      LEFT JOIN fcli ON faxinv.CLISEQ=fcli.CLISEQ
      LEFT JOIN fdoc ON faxinv.DSEQ=fdoc.DSEQ
      WHERE faxinv.ISEQ = ? AND fcli.CLISEQ <> 0 AND DEST=0 AND DMULTICIA=1
      AND AIMES=1 AND DESFACT=1 AND DOTROSTXT<>'POS' AND DCONTROLPOS=0
      GROUP BY fcli.CLISEQ, CLICOD, CLINOM ORDER BY CLICOD`, parameterMode: 'id',
  },
  'customer-sales-star': {
    section: 'queries', button: 'Ventas por cliente *',
    sql: `SELECT MIN(AISEQ) AS id, CLICOD AS customerCode, CLINOM AS customerName,
      SUM(AICANTF) AS quantity, SUM(AICANTF * AIPRECIO) AS amount FROM faxinv
      LEFT JOIN fcli ON faxinv.CLISEQ=fcli.CLISEQ
      LEFT JOIN fdoc ON faxinv.DSEQ=fdoc.DSEQ
      WHERE faxinv.ISEQ = ? AND fcli.CLISEQ <> 0 AND DEST=0 AND DMULTICIA=1
      AND AIMES=1 AND DESFACT=1 AND DOTROSTXT<>'POS' AND DCONTROLPOS=0
      GROUP BY fcli.CLISEQ, CLICOD, CLINOM ORDER BY CLICOD`, parameterMode: 'id',
  },
  'customer-sales-ct': {
    section: 'queries', button: 'Ventas por cliente CT',
    sql: `SELECT MIN(AISEQ) AS id, ICOD AS productCode,
      IDESCR AS productDescription, SUM(AICANTF) AS quantity,
      SUM(AICANTF * AIPRECIO) AS amount FROM faxinv
      LEFT JOIN finv ON faxinv.ISEQ=finv.ISEQ
      LEFT JOIN fcli ON faxinv.CLISEQ=fcli.CLISEQ
      LEFT JOIN fdoc ON faxinv.DSEQ=fdoc.DSEQ
      WHERE ICOD >= ? AND ICOD <= CONCAT(?, 'z') AND fcli.CLISEQ <> 0
      AND DEST=0 AND DMULTICIA=1 AND AIMES=1 AND DOTROSTXT<>'POS'
      AND DCONTROLPOS=0 GROUP BY finv.ISEQ, ICOD, IDESCR ORDER BY ICOD`,
    parameterMode: 'code-range',
  },
  'customer-sales-detail': {
    section: 'queries', button: 'Ventas desglosadas',
    sql: `SELECT AISEQ AS id, CLICOD AS customerCode, CLINOM AS customerName,
      AICANTF AS quantity, AIPRECIO AS price, DNUM AS document, DFECHA AS date,
      DTIPOC2 AS documentType, DREFERELLOS AS externalReference,
      AIDESCTO AS discount, AIOTROS AS otherAmount, DSUCURSAL AS branch
      FROM faxinv LEFT JOIN fcli ON faxinv.CLISEQ=fcli.CLISEQ
      LEFT JOIN fdoc ON faxinv.DSEQ=fdoc.DSEQ
      WHERE faxinv.ISEQ=? AND fcli.CLISEQ<>0 AND DEST=0 AND DMULTICIA=1
      AND AIMES=1 AND DESFACT=1 AND DOTROSTXT<>'POS' AND DCONTROLPOS=0
      ORDER BY AISEQ`, parameterMode: 'id',
  },
  'sales-by-branch': {
    section: 'queries', button: 'Ventas por sucursal',
    sql: `SELECT MIN(AISEQ) AS id, AISUCURSAL AS branch,
      CLICOD AS customerCode, CLINOM AS customerName,
      SUM(AICANTF) AS quantity, SUM(AICANTF * AIPRECIO) AS amount
      FROM faxinv LEFT JOIN fcli ON faxinv.CLISEQ=fcli.CLISEQ
      LEFT JOIN fdoc ON faxinv.DSEQ=fdoc.DSEQ
      WHERE faxinv.ISEQ=? AND fcli.CLISEQ<>0 AND DEST=0 AND DMULTICIA=1
      AND AIMES=1 GROUP BY AISUCURSAL, fcli.CLISEQ, CLICOD, CLINOM
      ORDER BY AISUCURSAL, CLICOD`, parameterMode: 'id',
  },
  'annual-sales': {
    section: 'queries', button: 'Ventas anuales',
    sql: `SELECT MIN(AISEQ) AS id, CLICOD AS customerCode,
      CLINOM AS customerName, YEAR(DFECHA) AS year,
      SUM(IF(MONTH(DFECHA)=1,AICANTF,0)) AS january,
      SUM(IF(MONTH(DFECHA)=2,AICANTF,0)) AS february,
      SUM(IF(MONTH(DFECHA)=3,AICANTF,0)) AS march,
      SUM(IF(MONTH(DFECHA)=4,AICANTF,0)) AS april,
      SUM(IF(MONTH(DFECHA)=5,AICANTF,0)) AS may,
      SUM(IF(MONTH(DFECHA)=6,AICANTF,0)) AS june,
      SUM(IF(MONTH(DFECHA)=7,AICANTF,0)) AS july,
      SUM(IF(MONTH(DFECHA)=8,AICANTF,0)) AS august,
      SUM(IF(MONTH(DFECHA)=9,AICANTF,0)) AS september,
      SUM(IF(MONTH(DFECHA)=10,AICANTF,0)) AS october,
      SUM(IF(MONTH(DFECHA)=11,AICANTF,0)) AS november,
      SUM(IF(MONTH(DFECHA)=12,AICANTF,0)) AS december,
      SUM(AICANTF) AS total FROM faxinv LEFT JOIN fdoc ON faxinv.DSEQ=fdoc.DSEQ
      LEFT JOIN fcli ON faxinv.CLISEQ=fcli.CLISEQ
      WHERE faxinv.ISEQ=? AND DESFACT=1 AND AIMES=1 AND DEST=0
      AND DOTROSTXT<>'POS' AND DCONTROLPOS=0
      GROUP BY fcli.CLISEQ, CLICOD, CLINOM, YEAR(DFECHA)
      ORDER BY CLICOD, year`, parameterMode: 'id',
  },
  'annual-sales-summary': {
    section: 'queries', button: 'Ventas anuales resumen',
    sql: `SELECT MIN(AISEQ) AS id, YEAR(DFECHA) AS year,
      SUM(IF(MONTH(DFECHA)=1,AICANTF,0)) AS january,
      SUM(IF(MONTH(DFECHA)=2,AICANTF,0)) AS february,
      SUM(IF(MONTH(DFECHA)=3,AICANTF,0)) AS march,
      SUM(IF(MONTH(DFECHA)=4,AICANTF,0)) AS april,
      SUM(IF(MONTH(DFECHA)=5,AICANTF,0)) AS may,
      SUM(IF(MONTH(DFECHA)=6,AICANTF,0)) AS june,
      SUM(IF(MONTH(DFECHA)=7,AICANTF,0)) AS july,
      SUM(IF(MONTH(DFECHA)=8,AICANTF,0)) AS august,
      SUM(IF(MONTH(DFECHA)=9,AICANTF,0)) AS september,
      SUM(IF(MONTH(DFECHA)=10,AICANTF,0)) AS october,
      SUM(IF(MONTH(DFECHA)=11,AICANTF,0)) AS november,
      SUM(IF(MONTH(DFECHA)=12,AICANTF,0)) AS december,
      SUM(AICANTF) AS total
      FROM faxinv LEFT JOIN fdoc ON faxinv.DSEQ=fdoc.DSEQ
      WHERE faxinv.ISEQ=? AND DESFACT=1 AND AIMES=1 AND DEST=0
      AND DOTROSTXT<>'POS' AND DCONTROLPOS=0
      GROUP BY YEAR(DFECHA) ORDER BY year`, parameterMode: 'id',
  },
  'supplier-orders': {
    section: 'queries', button: 'Ordenado a proveedor',
    sql: `SELECT PLSEQ AS id, PRVCOD AS supplierCode, PRVNOM AS supplierName,
      PLCANT AS quantity, PLSURT AS fulfilled, PENUM AS orderNumber,
      PEDESDE AS orderedAt, PEFECHA AS date, PEDATE2 AS secondDate,
      PLFACTOR AS factor, PLUNIDAD AS unit, PENUMELLOS AS externalNumber,
      PLASIGNADO AS assigned, PEALMACEN AS warehouse, PESPEDIDO AS orderType,
      PLPRECI AS price, PLSUC AS branch, PEOBS AS observations FROM fplin
      LEFT JOIN fprv ON fplin.PRVSEQ=fprv.PRVSEQ
      LEFT JOIN fpenc ON fplin.PESEQ=fpenc.PESEQ
      WHERE fplin.ISEQ=? AND fprv.PRVSEQ<>0 AND PESPEDIDO IN (2,3)
      ORDER BY PLSEQ`, parameterMode: 'id',
  },
  'supplier-orders-ct': {
    section: 'queries', button: 'Ordenado a proveedor CT',
    sql: `SELECT PLSEQ AS id, ICOD AS productCode, PRVCOD AS supplierCode,
      PRVNOM AS supplierName, PLCANT AS quantity, PLSURT AS fulfilled,
      PENUM AS orderNumber, PLPRECI AS price, PEDESDE AS orderedAt,
      PEVENCE AS dueAt, PENUMELLOS AS externalNumber, PEFECHA AS date
      FROM fplin LEFT JOIN finv ON fplin.ISEQ=finv.ISEQ
      LEFT JOIN fprv ON fplin.PRVSEQ=fprv.PRVSEQ
      LEFT JOIN fpenc ON fplin.PESEQ=fpenc.PESEQ
      WHERE ICOD>=? AND ICOD<=CONCAT(?, 'z') AND fprv.PRVSEQ<>0
      AND PESPEDIDO IN (2,3) ORDER BY ICOD, PLSEQ`, parameterMode: 'code-range',
  },
  'supplier-quotes': {
    section: 'queries', button: 'Cotizado a proveedores',
    sql: `SELECT PLSEQ AS id, PRVCOD AS supplierCode, PRVNOM AS supplierName,
      PLCANT AS quantity, PLSURT AS fulfilled, PENUM AS quoteNumber,
      PLPRECI AS price, PEDESDE AS quotedAt, PEFECHA AS date,
      PEDATE2 AS secondDate, PLFACTOR AS factor, PLUNIDAD AS unit
      FROM fplin LEFT JOIN fprv ON fplin.PRVSEQ=fprv.PRVSEQ
      LEFT JOIN fpenc ON fplin.PESEQ=fpenc.PESEQ
      WHERE fplin.ISEQ=? AND fprv.PRVSEQ<>0 AND PESPEDIDO=5
      ORDER BY PLSEQ`, parameterMode: 'id',
  },
  'supplier-purchases': {
    section: 'queries', button: 'Compras por proveedor',
    sql: `SELECT MIN(AISEQ) AS id, PRVCOD AS supplierCode,
      PRVNOM AS supplierName, SUM(AICANTF) AS quantity,
      SUM(AICANTF * AIPRECIO) AS amount FROM faxinv
      LEFT JOIN fprv ON faxinv.PRVSEQ=fprv.PRVSEQ
      LEFT JOIN fdoc ON faxinv.DSEQ=fdoc.DSEQ
      WHERE faxinv.ISEQ=? AND fprv.PRVSEQ<>0 AND DEST=0 AND DMULTICIA=1
      AND AIMES=1 AND DESFACT=2
      GROUP BY fprv.PRVSEQ, PRVCOD, PRVNOM ORDER BY PRVCOD`, parameterMode: 'id',
  },
  'supplier-purchases-dt': {
    section: 'queries', button: 'Compras por proveedor DT',
    sql: `SELECT PLSEQ AS id, ICOD AS productCode, PLCANT AS quantity,
      PLSURT AS fulfilled, PENUM AS orderNumber, PEFECHA AS date,
      PENUMELLOS AS externalNumber FROM fplin
      LEFT JOIN finv ON fplin.ISEQ=finv.ISEQ
      LEFT JOIN fpenc ON fplin.PESEQ=fpenc.PESEQ
      LEFT JOIN fprv ON fplin.PRVSEQ=fprv.PRVSEQ
      WHERE ICOD>=? AND ICOD<=CONCAT(?, 'z') AND fprv.PRVSEQ<>0
      AND PESPEDIDO IN (2,3) ORDER BY ICOD, PLSEQ`, parameterMode: 'code-range',
  },
  'supplier-purchases-detail': {
    section: 'queries', button: 'Compras desglosadas',
    sql: `SELECT AISEQ AS id, PRVCOD AS supplierCode, PRVNOM AS supplierName,
      AICANTF AS quantity, AIPRECIO AS price, DNUM AS document, DFECHA AS date,
      AIPZAS AS pieces, DMONEDA AS currency, DTIPOCINI AS documentType,
      (AICANTF * AIPRECIO) AS amount FROM faxinv
      LEFT JOIN fprv ON faxinv.PRVSEQ=fprv.PRVSEQ
      LEFT JOIN fdoc ON faxinv.DSEQ=fdoc.DSEQ
      WHERE faxinv.ISEQ=? AND fprv.PRVSEQ<>0 AND DEST=0 AND DMULTICIA=1
      AND AIMES=1 AND DESFACT=2 ORDER BY AISEQ`, parameterMode: 'id',
  },
  'annual-purchases': {
    section: 'queries', button: 'Compras anuales',
    sql: `SELECT MIN(AISEQ) AS id, PRVCOD AS supplierCode,
      PRVNOM AS supplierName, YEAR(DFECHA) AS year,
      SUM(IF(MONTH(DFECHA)=1,AICANTF,0)) AS january,
      SUM(IF(MONTH(DFECHA)=2,AICANTF,0)) AS february,
      SUM(IF(MONTH(DFECHA)=3,AICANTF,0)) AS march,
      SUM(IF(MONTH(DFECHA)=4,AICANTF,0)) AS april,
      SUM(IF(MONTH(DFECHA)=5,AICANTF,0)) AS may,
      SUM(IF(MONTH(DFECHA)=6,AICANTF,0)) AS june,
      SUM(IF(MONTH(DFECHA)=7,AICANTF,0)) AS july,
      SUM(IF(MONTH(DFECHA)=8,AICANTF,0)) AS august,
      SUM(IF(MONTH(DFECHA)=9,AICANTF,0)) AS september,
      SUM(IF(MONTH(DFECHA)=10,AICANTF,0)) AS october,
      SUM(IF(MONTH(DFECHA)=11,AICANTF,0)) AS november,
      SUM(IF(MONTH(DFECHA)=12,AICANTF,0)) AS december,
      SUM(AICANTF) AS total FROM faxinv LEFT JOIN fdoc ON faxinv.DSEQ=fdoc.DSEQ
      LEFT JOIN fprv ON faxinv.PRVSEQ=fprv.PRVSEQ
      WHERE faxinv.ISEQ=? AND DESFACT=2 AND AIMES=1 AND DEST=0
      GROUP BY fprv.PRVSEQ, PRVCOD, PRVNOM, YEAR(DFECHA)
      ORDER BY PRVCOD, year`, parameterMode: 'id',
  },
  'annual-purchases-summary': {
    section: 'queries', button: 'Compras anuales resumen',
    sql: `SELECT MIN(AISEQ) AS id, YEAR(DFECHA) AS year,
      SUM(IF(MONTH(DFECHA)=1,AICANTF,0)) AS january,
      SUM(IF(MONTH(DFECHA)=2,AICANTF,0)) AS february,
      SUM(IF(MONTH(DFECHA)=3,AICANTF,0)) AS march,
      SUM(IF(MONTH(DFECHA)=4,AICANTF,0)) AS april,
      SUM(IF(MONTH(DFECHA)=5,AICANTF,0)) AS may,
      SUM(IF(MONTH(DFECHA)=6,AICANTF,0)) AS june,
      SUM(IF(MONTH(DFECHA)=7,AICANTF,0)) AS july,
      SUM(IF(MONTH(DFECHA)=8,AICANTF,0)) AS august,
      SUM(IF(MONTH(DFECHA)=9,AICANTF,0)) AS september,
      SUM(IF(MONTH(DFECHA)=10,AICANTF,0)) AS october,
      SUM(IF(MONTH(DFECHA)=11,AICANTF,0)) AS november,
      SUM(IF(MONTH(DFECHA)=12,AICANTF,0)) AS december,
      SUM(AICANTF) AS total
      FROM faxinv LEFT JOIN fdoc ON faxinv.DSEQ=fdoc.DSEQ
      WHERE faxinv.ISEQ=? AND DESFACT=2 AND AIMES=1 AND DEST=0
      AND DOTROSTXT<>'POS' AND DCONTROLPOS=0
      GROUP BY YEAR(DFECHA) ORDER BY year`, parameterMode: 'id',
  },
  pieces: unavailable(
    'queries', 'Piezas', 'Esta version de OMNIS no contiene el modulo de PIEZAS',
  ),
  'fulfilled-pieces': {
    section: 'queries', button: 'Piezas surtidas',
    sql: `SELECT CAJSEQ AS id, CAJPZAS AS pieces, CAJCANT AS quantity,
      CAJSERIE AS serialNumber, CAJINV AS inventoryDocument,
      CAJPEDIDO AS orderNumber, CAJFACTURA AS invoiceNumber,
      CAJALM AS warehouse, CAJREFER AS reference, CAJFECHA AS date,
      CAJRECEPCION AS receivedAt, CAJMERMA AS waste, CAJLOTE AS lot
      FROM fcajas WHERE ISEQ=? AND CAJFACTURA<>'' ORDER BY CAJSEQ`, parameterMode: 'id',
  },
  'work-in-progress': {
    section: 'queries', button: 'W.I.P.',
    sql: `SELECT TKTSEQ AS id, TKTNUMOP AS productionOrder,
      TKTART AS operation, TKTCANT AS requested, TKTSURT AS fulfilled,
      (TKTCANT - TKTSURT) AS remaining, TKTMIN AS time,
      TKTINICIO AS startedAt, TKTMAQUINA AS machine,
      TKTORDEN AS sortOrder FROM ftikets WHERE TKTPROD=? ORDER BY TKTSEQ`,
    parameterMode: 'code',
  },
  'work-in-progress-ct': {
    section: 'queries', button: 'W.I.P. CT',
    sql: `SELECT TKTSEQ AS id, TKTPROD AS productCode,
      TKTNUMOP AS productionOrder, TKTART AS componentCode,
      TKTCANT AS requested, TKTSURT AS fulfilled,
      (TKTCANT - TKTSURT) AS remaining, TKTMIN AS time,
      TKTMAQUINA AS machine,
      TKTDATEEND AS endsAt, TKTINICIO AS startedAt, TKTDATE AS date,
      TKTPAR0 AS parameter0, TKTPAR1 AS parameter1 FROM ftikets
      WHERE TKTPROD>=? AND TKTPROD<=CONCAT(?, 'z') ORDER BY TKTPROD,TKTSEQ`,
    parameterMode: 'code-range',
  },
  edi: {
    section: 'queries', button: 'E.D.I.',
    sql: `SELECT VSSEQ AS id, CLICOD AS customerCode, CLINOM AS customerName,
      EDFECHADEL AS deliveryDate, VSCANTQA AS requested,
      VSCANTQS AS fulfilled, VSSUCURSAL AS branch, VSTIPO AS type
      FROM fvsucursal LEFT JOIN fcli ON fvsucursal.CLISEQ=fcli.CLISEQ
      LEFT JOIN fedi ON fvsucursal.EDSEQ=fedi.EDSEQ
      WHERE fvsucursal.ISEQ=? ORDER BY VSSEQ`, parameterMode: 'id',
  },
  'pending-enablements': {
    section: 'queries', button: 'Habilitaciones pendientes',
    sql: `SELECT AISEQ AS id, DFECHA AS date, DNUM AS document,
      AICANTF AS needed, AIPZAS AS fulfilled, AICANT AS remaining
      FROM faxinv LEFT JOIN fdoc ON faxinv.DSEQ=fdoc.DSEQ
      WHERE faxinv.ISEQ=? AND AIMES=1 AND DEST=0 AND DMULTICIA=1
      AND DPAR9 IN ('9NVO','9HAB') AND AICANTF>AICANT AND AICANTF>0
      ORDER BY AISEQ`, parameterMode: 'id',
  },
  documents: {
    section: 'queries', button: 'Documentos',
    sql: `SELECT AISEQ AS id, DNUM AS document, DREFER AS reference,
      CLICOD AS customerCode, CLINOM AS customerName, DFECHA AS date,
      ICOD AS productCode, IDESCR AS productDescription,
      IF(AICANTF > 0, AICANTF, 0) AS incoming,
      IF(AICANTF < 0, ABS(AICANTF), 0) AS outgoing,
      AIUNIDAD AS unit, AICOSTO AS cost, AIPZAS AS pieces,
      AIALMACEN AS warehouse, DTIPOC2 AS documentType
      FROM faxinv LEFT JOIN fdoc ON faxinv.DSEQ=fdoc.DSEQ
      LEFT JOIN fcli ON faxinv.CLISEQ=fcli.CLISEQ
      LEFT JOIN finv ON faxinv.ISEQ=finv.ISEQ
      WHERE faxinv.ISEQ=? AND AIMES=1 AND DEST=0 AND DMULTICIA=1
      ORDER BY DFECHA DESC, AISEQ DESC`, parameterMode: 'id',
  },
};

const parametersFor = (
  mode: ParameterMode | undefined,
  product: ProductHeaderRow,
): Array<string | number> => {
  if (mode === 'code') return [product.code];
  if (mode === 'code-range') return [product.code, product.code];
  return [product.id];
};

export class LegacyMysqlProductPanelsDataSource implements ProductPanelsDataSource {
  async getPanel(
    productId: number,
    panel: ProductPanelKey,
    criteria: ProductPanelCriteria,
  ): Promise<ProductPanelResult | null> {
    const [productRows] = await legacyMysqlPool.execute<ProductHeaderRow[]>(
      `SELECT ISEQ AS id, ICOD AS code, IDESCR AS description
       FROM finv WHERE ISEQ = ? LIMIT 1`,
      [productId],
    );
    const product = productRows[0];
    if (product === undefined) return null;

    const definition = definitions[panel];
    if (definition.sql === undefined) {
      return {
        product,
        key: panel,
        section: definition.section,
        button: definition.button,
        available: false,
        source: 'not-available',
        items: [],
        ...(definition.reason === undefined ? {} : { reason: definition.reason }),
      };
    }

    const [rows] = await legacyMysqlPool.execute<PanelRow[]>(
      `${definition.sql} LIMIT ? OFFSET ?`,
      [
        ...parametersFor(definition.parameterMode, product),
        criteria.limit,
        criteria.offset,
      ],
    );
    return {
      product,
      key: panel,
      section: definition.section,
      button: definition.button,
      available: true,
      source: definition.source ?? 'mysql',
      items: rows.map((row) => ({ ...row })),
    };
  }

  async setBlocked(productId: number, blocked: boolean): Promise<ProductBlockStatus | null> {
    const [result] = await legacyMysqlPool.execute<ResultSetHeader>(
      `UPDATE finv
       SET IBAJA = IF(? = 1, CURDATE(), '1900-12-31'),
           IUSEQ = 0, IFECHACAMBIO = CURDATE()
       WHERE ISEQ = ?`,
      [blocked ? 1 : 0, productId],
    );
    if (result.affectedRows === 0) return null;
    const [rows] = await legacyMysqlPool.execute<Array<ProductHeaderRow & {
      deactivatedAt: string | null;
    }>>(
      `SELECT ISEQ AS id, ICOD AS code, IDESCR AS description,
       NULLIF(IBAJA, '1900-12-31') AS deactivatedAt
       FROM finv WHERE ISEQ = ? LIMIT 1`,
      [productId],
    );
    const product = rows[0];
    if (product === undefined) return null;
    return {
      product: { id: product.id, code: product.code, description: product.description },
      blocked: product.deactivatedAt !== null,
      deactivatedAt: product.deactivatedAt,
    };
  }
}
