import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import type { PostgresClient, PostgresConnectionFactory } from '../../../../../shared/infrastructure/database/postgres-pool.js';
import type { ProductsDataSource } from '../../domain/datasources/products-data-source.js';
import type { ProductBlockStatus } from '../../domain/repositories/product-panels-repository.js';
import { Product, type ProductProps } from '../../domain/entities/product.js';
import type {
  DeleteProductResult,
  ProductCreateValues,
  ProductNavigationDirection,
  ProductRemovalConfirmation,
  ProductRemovalPreview,
  ProductSearchCriteria,
  ProductSearchResult,
  ProductWriteValues,
} from '../../domain/repositories/products-repository.js';
import { applyProductWriteValues, blankProduct, normalizeProductDate, normalizeProductDates, type ProductUnit } from './product-catalog-record.js';
import { assertProductSnapshot, productCatalogAvailable, productCatalogTransaction } from './postgres-product-catalog-snapshot.js';
import type { LegacyMysqlProductsDataSource } from './legacy-mysql-products-data-source.js';
import { isNewCatalogProduct } from './product-catalog-references.js';

interface DocumentRow {
  document: ProductProps;
  deletionRelation: string | null;
  revision: number;
  deleted: boolean;
}

const activeCatalogEntry = 'deleted_at IS NULL';
const selectProduct = (client: PostgresClient, productId: number, options: { includeDeleted?: boolean; lock?: boolean } = {}) =>
  client.query<DocumentRow>(
    `SELECT document,deletion_relation AS "deletionRelation",revision,deleted_at IS NOT NULL AS deleted
     FROM tuvansa.inventory_products WHERE id = $1 ${options.includeDeleted ? '' : 'AND deleted_at IS NULL'}
     ${options.lock ? 'FOR UPDATE' : ''}`,
    [productId],
  );

const codeExists = async (client: PostgresClient, code: string, excludingId?: number) =>
  (await client.query(
    `SELECT 1 FROM tuvansa.inventory_products
     WHERE lower(code) = lower($1) AND ($2::bigint IS NULL OR id <> $2)
       LIMIT 1`,
    [code, excludingId ?? null],
  )).rows.length > 0;

const findUnit = async (client: PostgresClient, unitId: number) =>
  (await client.query<ProductUnit>(
    `SELECT id, code, description, uses_color_and_size AS "usesColorAndSize"
     FROM tuvansa.inventory_product_units WHERE id = $1`,
    [unitId],
  )).rows[0];

const accountingAccountExists = async (client: PostgresClient, account: string) =>
  (await client.query(
    'SELECT 1 FROM tuvansa.inventory_product_accounts WHERE code = lower($1)',
    [account],
  )).rows.length > 0;

const catalogRevision = (revision: number) => `${revision}:0:0`;
const catalogFields: readonly (keyof ProductWriteValues)[] = [
  'description','type','unitId','familyCode','usesColorAndSize',
  'salePrice1','salePrice2','salePrice3','saleCurrency1','saleCurrency2','saleCurrency3',
  'averageCost','lastCost','previousCost','costCurrency','adValorem',
  'minimum','maximum','location','ean','upc','primaryAccount','secondaryAccount','costOfSalesAccount',
  'salesLastSixWeeks','inventoryDays',
];
const costFields = ['averageCost','lastCost','previousCost','costCurrency','adValorem'];
const stale = () => new ConflictError('La ficha cambió. Vuelve a abrirla antes de guardar.', 'PRODUCT_EDIT_STALE');

const validateAccounts = async (client: PostgresClient, values: ProductWriteValues): Promise<void> => {
  for (const account of [values.primaryAccount, values.secondaryAccount, values.costOfSalesAccount]) {
    if (account && !(await accountingAccountExists(client, account))) {
      throw new ConflictError(`La cuenta contable ${account} no existe`, 'ACCOUNTING_ACCOUNT_NOT_FOUND');
    }
  }
};

const productLines = "jsonb_build_array(jsonb_build_object('productId',$1::bigint))";
const catalogReferences = [
  { table: 'orders', caption: 'Pedidos', where: `document->'lines' @> ${productLines} OR base_document->'lines' @> ${productLines}` },
  { table: 'purchase_order_edits', caption: 'Órdenes de compra', where: `document->'lines' @> ${productLines}` },
  { table: 'purchase_reception_inventory', caption: 'Recepciones', where: 'product_id=$1' },
  { table: 'purchase_expense_documents', caption: 'Gastos múltiples', where: `lines @> ${productLines}` },
  { table: 'sales_remission_inventory', caption: 'Facturación', where: 'product_id=$1' },
  { table: 'inventory_movement_documents', caption: 'Movimientos de inventario', where: `original_document->'lines' @> ${productLines}` },
  { table: 'inventory_adjustment_stock', caption: 'Movimientos de inventario', where: 'product_id=$1' },
] as const;

async function localReference(client: PostgresClient, productId: number): Promise<string | null> {
  const { rows } = await client.query<{ table: string }>(
    "SELECT name AS \"table\" FROM unnest($1::text[]) AS name WHERE to_regclass('tuvansa.'||name) IS NOT NULL",
    [catalogReferences.map(({ table }) => table)],
  );
  const names = new Set(rows.map(({ table }) => table));
  for (const { table, caption, where } of catalogReferences) {
    if (names.has(table) && (await client.query(`SELECT 1 FROM tuvansa.${table} WHERE ${where} LIMIT 1`, [productId])).rows.length) {
      return caption;
    }
  }
  return null;
}

export class PostgresProductsDataSource implements ProductsDataSource {
  constructor(
    private readonly connect: PostgresConnectionFactory,
    private readonly configured: () => boolean = () => true,
    private readonly native?: Pick<LegacyMysqlProductsDataSource, 'getEditRules' | 'catalogRemovalRelation' | 'catalogRenameRelation'>,
  ) {}

  async catalogWritable(): Promise<boolean> {
    if (!this.configured()) return false;
    const client = await this.connect();
    try { return await productCatalogAvailable(client); } finally { client.release(); }
  }

  private async writableProduct(client: PostgresClient, row?: DocumentRow): Promise<Product | null> {
    if (!row) return null;
    const { id, code, classification } = row.document;
    const rules = await this.native?.getEditRules(code, classification.unit.id);
    const editableFields = catalogFields.filter((field) => !rules?.hideCosts || !costFields.includes(field));
    const nativeLinks = !isNewCatalogProduct(id) && (this.native
      ? Boolean(await this.native.catalogRenameRelation(id))
      : ['fens', 'fplin'].includes(row.deletionRelation ?? ''));
    if (!nativeLinks && !await localReference(client, id)) editableFields.unshift('code');
    return Product.create({
      ...normalizeProductDates(row.document),
      editing: { writable: true, revision: catalogRevision(row.revision), editableFields },
    });
  }

  async listUnits() {
    return this.read(async (client) => (await client.query<ProductUnit>(
      'SELECT id,code,description FROM tuvansa.inventory_product_units ORDER BY id',
    )).rows);
  }

  private async read<T>(operation: (client: PostgresClient) => Promise<T>): Promise<T> {
    const client = await this.connect();
    try {
      await assertProductSnapshot(client);
      return await operation(client);
    } finally {
      client.release();
    }
  }

  private write<T>(operation: (client: PostgresClient) => Promise<T>): Promise<T> {
    return productCatalogTransaction(this.connect, async (client) => {
      await assertProductSnapshot(client);
      return operation(client);
    });
  }

  findById(productId: number): Promise<Product | null> {
    return this.read(async (client) => this.writableProduct(client, (await selectProduct(client, productId)).rows[0]));
  }

  findFirstActive(): Promise<Product | null> {
    return this.read(async (client) => {
      const result = await client.query<DocumentRow>(
        `SELECT document,deletion_relation AS "deletionRelation",revision,false AS deleted
         FROM tuvansa.inventory_products WHERE active AND ${activeCatalogEntry}
         ORDER BY lower(code), id LIMIT 1`,
      );
      return this.writableProduct(client, result.rows[0]);
    });
  }

  search(criteria: ProductSearchCriteria): Promise<ProductSearchResult> {
    return this.read(async (client) => {
      const active = criteria.status === 'all' ? null : criteria.status === 'active';
      const search = criteria.query === undefined ? null : `%${criteria.query}%`;
      const result = await client.query<{ total: string; items: ProductProps[] }>(
        `WITH matching AS (
           SELECT id, code, document FROM tuvansa.inventory_products
           WHERE ${activeCatalogEntry} AND ($1::boolean IS NULL OR active = $1)
             AND ($2::text IS NULL OR code ILIKE $2 OR document->>'description' ILIKE $2
               OR document #>> '{warehouse,ean}' ILIKE $2 OR document #>> '{warehouse,upc}' ILIKE $2)
         )
         SELECT (SELECT count(*)::text FROM matching) AS total,
           ARRAY(SELECT document FROM matching ORDER BY lower(code), id LIMIT $3 OFFSET $4) AS items`,
        [active, search, criteria.limit, criteria.offset],
      );
      const page = result.rows[0];
      const items = (page?.items ?? []).map((document) => Product.create(normalizeProductDates(document)));
      return { total: Number(page?.total ?? 0), items };
    });
  }

  findAdjacent(productId: number, direction: ProductNavigationDirection): Promise<Product | null> {
    return this.read(async (client) => {
      const operator = direction === 'previous' ? '<' : '>';
      const order = direction === 'previous' ? 'DESC' : 'ASC';
      const result = await client.query<DocumentRow>(
        `SELECT adjacent.document,adjacent.deletion_relation AS "deletionRelation",adjacent.revision,false AS deleted
         FROM tuvansa.inventory_products current_product
         JOIN tuvansa.inventory_products adjacent
           ON lower(adjacent.code) ${operator} lower(current_product.code)
         WHERE current_product.id = $1 AND adjacent.deleted_at IS NULL
         ORDER BY lower(adjacent.code) ${order}, adjacent.id ${order} LIMIT 1`,
        [productId],
      );
      return this.writableProduct(client, result.rows[0]);
    });
  }

  codeExists(code: string, excludingProductId?: number): Promise<boolean> {
    return this.read((client) => codeExists(client, code, excludingProductId));
  }

  unitExists(unitId: number): Promise<boolean> {
    return this.read(async (client) => (await findUnit(client, unitId)) !== undefined);
  }

  accountingAccountExists(account: string): Promise<boolean> {
    return this.read((client) => accountingAccountExists(client, account));
  }

  create(values: ProductCreateValues): Promise<Product> {
    return this.write(async (client) => {
      if (await codeExists(client, values.code)) {
        throw new ConflictError('Ya existe un producto con ese código', 'PRODUCT_CODE_EXISTS');
      }
      const fallbackUnit = values.unitId === undefined ? (await client.query<{ id: number }>(
        "SELECT id FROM tuvansa.inventory_product_units WHERE code='1' ORDER BY id LIMIT 1",
      )).rows[0]?.id ?? 1 : values.unitId;
      const unit = await findUnit(client, fallbackUnit);
      if (!unit) throw new ConflictError('La unidad no existe', 'PRODUCT_UNIT_NOT_FOUND');
      await validateAccounts(client, values);
      const created = await client.query<{ id: string; date: string }>(
        `SELECT nextval('tuvansa.inventory_product_ids')::text AS id, CURRENT_DATE::text AS date`,
      );
      const { id, date } = created.rows[0]!;
      const document = applyProductWriteValues(blankProduct(Number(id), date), values, unit);
      await client.query(
        'INSERT INTO tuvansa.inventory_products (id, document, revision) VALUES ($1, $2, 1)',
        [id, document],
      );
      return (await this.writableProduct(client, { document, revision: 1, deletionRelation: null, deleted: false }))!;
    });
  }

  update(productId: number, values: ProductWriteValues, revision?: string): Promise<Product | null> {
    return this.write(async (client) => {
      const product = (await selectProduct(client, productId, { lock: true })).rows[0];
      if (!product) return null;
      if (revision !== undefined && revision !== catalogRevision(product.revision)) throw stale();
      const capabilities = (await this.writableProduct(client, product))!.toPrimitives().editing!;
      const unsupported = Object.keys(values).find((field) => !capabilities.editableFields.includes(field));
      if (unsupported) throw new ConflictError(`El campo ${unsupported} requiere resolver sus referencias.`, 'PRODUCT_FIELD_READ_ONLY');
      if (values.code && values.code !== product.document.code && await codeExists(client, values.code, productId)) {
        throw new ConflictError('Ya existe un producto con ese código', 'PRODUCT_CODE_EXISTS');
      }
      const unit = values.unitId === undefined ? undefined : await findUnit(client, values.unitId);
      if (values.unitId !== undefined && !unit) {
        throw new ConflictError('La unidad no existe', 'PRODUCT_UNIT_NOT_FOUND');
      }
      await validateAccounts(client, values);
      const rules = await this.native?.getEditRules(product.document.code, unit?.id ?? product.document.classification.unit.id);
      const document = applyProductWriteValues(product.document, {
        ...values, ...(rules?.hasComponents && rules.assemblyTypeOverride ? { type: 'set' } : {}),
      }, unit);
      await client.query(
        'UPDATE tuvansa.inventory_products SET document = $2, revision = revision + 1 WHERE id = $1',
        [productId, document],
      );
      return this.writableProduct(client, { ...product, document, revision: product.revision + 1 });
    });
  }

  async removal(productId: number): Promise<ProductRemovalPreview | null> {
    return this.read(async (client) => {
      const product = (await selectProduct(client, productId)).rows[0];
      if (!product) return null;
      const relation = await this.removalRelation(client, product);
      return {
        id: productId, code: product.document.code, revision: catalogRevision(product.revision),
        canDelete: relation === null,
        reason: relation ? `El producto tiene registros relacionados en ${relation}.` : null,
      };
    });
  }

  private async removalRelation(client: PostgresClient, product: DocumentRow) {
    return product.deletionRelation
      ?? (product.document.accumulated.currentStock === 0 ? null : 'Existencias')
      ?? (isNewCatalogProduct(product.document.id) ? null : await this.native?.catalogRemovalRelation(product.document.id))
      ?? await localReference(client, product.document.id);
  }

  setBlocked(productId: number, blocked: boolean): Promise<ProductBlockStatus | null> {
    return this.write(async (client) => {
      const row = (await selectProduct(client, productId, { lock: true })).rows[0];
      if (!row) return null;
      const { id, code, description } = row.document;
      let deactivatedAt = normalizeProductDate(row.document.deactivatedAt);
      if (blocked === row.document.isActive) {
        const { rows: [clock] } = await client.query<{ today: string }>(
          "SELECT (now() AT TIME ZONE 'America/Mexico_City')::date::text AS today",
        );
        deactivatedAt = blocked ? clock!.today : null;
        const document = { ...row.document, isActive: !blocked, deactivatedAt };
        await client.query('UPDATE tuvansa.inventory_products SET document=$2,revision=revision+1 WHERE id=$1', [productId, document]);
      }
      return { product: { id, description, code }, blocked, deactivatedAt };
    });
  }

  delete(productId: number, confirmation?: ProductRemovalConfirmation): Promise<DeleteProductResult> {
    return this.write(async (client) => {
      const product = (await selectProduct(client, productId, { includeDeleted: Boolean(confirmation), lock: true })).rows[0];
      if (!product) return { status: 'not-found' };
      if (confirmation) {
        if (confirmation.code !== product.document.code) throw stale();
        if (product.deleted && confirmation.revision === catalogRevision(product.revision - 1)) return { status: 'deleted' };
        if (confirmation.revision !== catalogRevision(product.revision) || product.deleted) throw stale();
      }
      const relation = await this.removalRelation(client, product);
      if (relation) return { status: 'in-use', relation };
      await client.query(
        'UPDATE tuvansa.inventory_products SET deleted_at = now(), revision = revision + 1 WHERE id = $1',
        [productId],
      );
      return { status: 'deleted' };
    });
  }
}
