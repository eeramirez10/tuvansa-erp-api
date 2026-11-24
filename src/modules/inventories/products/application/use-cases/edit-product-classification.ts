import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import {
  productClassificationKeys,
  type ProductClassificationAssignments,
  type ProductClassificationCatalog,
  type ProductClassificationRepository,
  type StoredProductClassification,
} from '../../domain/repositories/product-classification-repository.js';

const selectedOption = (catalog: ProductClassificationCatalog, key: string, code: string) =>
  catalog.options.find((option) => option.key === key && option.code === code);

const previousNumber = (catalog: ProductClassificationCatalog, key: string, assignments: ProductClassificationAssignments) => {
  const previous = productClassificationKeys[productClassificationKeys.indexOf(key) - 1];
  return previous === undefined ? '' : selectedOption(catalog, previous, assignments[previous] ?? '')?.number ?? '';
};

const panel = (catalog: ProductClassificationCatalog, stored: StoredProductClassification | null, writable: boolean) => {
  const assignments = { ...catalog.assignments, ...stored?.changes };
  const familyCode = stored?.familyCode ?? catalog.familyCode;
  const groups = productClassificationKeys.map((key) => {
    const selectedCode = assignments[key] ?? '';
    const selected = selectedOption(catalog, key, selectedCode);
    return {
      key,
      label: catalog.labels[key] ?? '',
      selectedCode,
      selectedNumber: selected?.number ?? '',
      selectedDescription: selected?.description ?? '',
      selectedFlag: selected?.key ?? '',
      options: catalog.options.filter((option) => option.key === key).map(({ id, code, number, description, parent }) => ({
        id, code, number, description, parentCode: parent,
      })),
    };
  });
  const item = {
    familyCode,
    ...Object.fromEntries(productClassificationKeys.slice(0, 9).map((key) => [`level${key}`, assignments[key] ?? ''])),
  };
  return {
    product: catalog.product, key: 'classifications' as const, section: 'actions' as const,
    button: 'Clasificar', available: true, source: 'product-cache' as const, items: [item],
    classification: { revision: stored?.revision ?? 0, writable, familyCode, groups },
  };
};

export class EditProductClassification {
  constructor(private readonly repository: ProductClassificationRepository) {}

  private async catalog(productId: number) {
    const found = await this.repository.catalog(productId);
    if (!found) throw new NotFoundError('Producto');
    return found;
  }

  async get(productId: number, page: number, pageSize: number) {
    const [catalog, stored] = await Promise.all([this.catalog(productId), this.repository.get(productId)]);
    const data = panel(catalog, stored, await this.repository.writable(productId));
    if (page > 1) data.items = [];
    return { data, pagination: { page, pageSize, returned: data.items.length } };
  }

  async save(productId: number, requested: {
    revision: number;
    changes: ProductClassificationAssignments;
    rebuildFamily?: boolean | undefined;
  }) {
    if (!await this.repository.writable(productId)) {
      throw new ApplicationError('Este producto no está disponible para clasificar en PostgreSQL.', 'CLASSIFICATION_READ_ONLY', 403);
    }
    const [catalog, stored] = await Promise.all([this.catalog(productId), this.repository.get(productId)]);
    if ((stored?.revision ?? 0) !== requested.revision) {
      throw new ConflictError('La clasificación cambió en otra sesión. Vuelve a abrir la ventana.', 'CLASSIFICATION_STALE');
    }
    const current = { ...catalog.assignments, ...stored?.changes };
    const assignments = { ...current, ...requested.changes };
    const changes = { ...stored?.changes };
    let changed = false;
    for (const [key, code] of Object.entries(requested.changes)) {
      if (!productClassificationKeys.includes(key)) {
        throw new ApplicationError('El parámetro de clasificación no es válido.', 'CLASSIFICATION_GROUP_INVALID', 422);
      }
      if (current[key] === code) continue;
      const option = selectedOption(catalog, key, code);
      if (!option || (key !== '1' && option.parent !== '' && option.parent !== previousNumber(catalog, key, assignments))) {
        throw new ApplicationError('La opción no corresponde a la familia o al parámetro anterior.', 'CLASSIFICATION_OPTION_INVALID', 422);
      }
      changes[key] = code;
      changed = true;
    }
    const lastFamily = stored?.familyCode ?? catalog.familyCode;
    const recalculateFamily = catalog.recalculateFamily || requested.rebuildFamily === true;
    const familyCode = recalculateFamily
      ? productClassificationKeys.slice(0, 9).map((key) => (assignments[key] ?? '').slice(1)).join('').slice(0, 16)
      : lastFamily;
    const saved = changed || familyCode !== lastFamily
      ? await this.repository.save(productId, {
        revision: requested.revision, changes,
        familyCode: recalculateFamily ? familyCode : (stored?.familyCode ?? null),
      })
      : stored;
    return { data: panel(catalog, saved, true), pagination: { page: 1, pageSize: 100, returned: 1 } };
  }
}
