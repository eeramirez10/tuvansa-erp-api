import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import { editableProductOtherDataFields, type ProductOtherDataValues } from '../../domain/entities/product-other-data.js';
import type {
  ProductOtherDataCatalog,
  ProductOtherDataRepository,
  StoredProductOtherData,
} from '../../domain/repositories/product-other-data-repository.js';

const panel = (catalog: ProductOtherDataCatalog, saved: StoredProductOtherData | null, writable: boolean, page: number, pageSize: number) => {
  const values: ProductOtherDataValues = {
    ...catalog.values,
    ...saved?.changes,
    ...(saved?.changedAt === undefined ? {} : { changedAt: saved.changedAt }),
  };
  const legacyItem = {
    ...values,
    inactiveForPurchases: Number(values.inactiveForPurchases),
    controlsPieces: Number(values.controlsPieces),
    lotControlled: values.lotSize,
  };
  return {
    data: {
      product: catalog.product, key: 'other-data' as const, section: 'actions' as const,
      button: 'Otros', available: true, source: 'product-cache' as const, items: page === 1 ? [legacyItem] : [],
      otherData: {
        values, revision: saved?.revision ?? 0, writable, editableFields: editableProductOtherDataFields,
        tariffs: catalog.tariffs, miscLabels: catalog.miscLabels,
      },
    },
    pagination: { page, pageSize, returned: page === 1 ? 1 : 0 },
  };
};

const derivedList6 = (catalog: ProductOtherDataCatalog, current: ProductOtherDataValues, requested: ProductOtherDataValues) => {
  const factor = requested.alternateUnitFactor ?? current.alternateUnitFactor;
  if (!catalog.derivesList6 || typeof factor !== 'number' || factor === 0) return requested;
  const price = Number(requested.alternateUnitPrice ?? current.alternateUnitPrice ?? 0);
  const amount = price / factor;
  if (!Number.isFinite(amount) || Math.abs(amount) > Number.MAX_SAFE_INTEGER / 10_000) {
    throw new ApplicationError('El precio y el factor de la unidad alterna generan un importe fuera de rango.', 'OTHER_DATA_LIST_6_RANGE', 422);
  }
  return { ...requested, list6: Number(amount.toFixed(4)) };
};

export class EditProductOtherData {
  constructor(private readonly repository: ProductOtherDataRepository) {}

  private async catalog(productId: number) {
    const found = await this.repository.catalog(productId);
    if (!found) throw new NotFoundError('Producto');
    return found;
  }

  async get(productId: number, page: number, pageSize: number) {
    const [catalog, saved] = await Promise.all([this.catalog(productId), this.repository.get(productId)]);
    return panel(catalog, saved, await this.repository.writable(productId), page, pageSize);
  }

  async save(productId: number, revision: number, requested: ProductOtherDataValues) {
    if (!await this.repository.writable(productId)) {
      throw new ApplicationError('Este producto no está disponible para editar Otros en PostgreSQL.', 'OTHER_DATA_READ_ONLY', 403);
    }
    const [catalog, saved] = await Promise.all([this.catalog(productId), this.repository.get(productId)]);
    if ((saved?.revision ?? 0) !== revision) {
      throw new ConflictError('Los datos de Otros cambiaron en otra sesión. Vuelve a cargar la ventana.', 'OTHER_DATA_STALE');
    }
    const current = { ...catalog.values, ...saved?.changes };
    const updates = Object.entries(derivedList6(catalog, current, requested)).filter(([key, value]) => current[key] !== value);
    if (!updates.length) return panel(catalog, saved, true, 1, 100);

    const changes = { ...saved?.changes };
    for (const [key, value] of updates) {
      if (catalog.values[key] === value) delete changes[key];
      else changes[key] = value;
    }
    const result = await this.repository.save(productId, { revision, changes });
    return panel(catalog, result, true, 1, 100);
  }
}
