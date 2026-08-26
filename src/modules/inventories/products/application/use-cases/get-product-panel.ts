import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type {
  ProductPanelKey,
  ProductPanelResult,
  ProductPanelsRepository,
} from '../../domain/repositories/product-panels-repository.js';

export class GetProductPanel {
  constructor(private readonly repository: ProductPanelsRepository) {}

  async execute(
    productId: number,
    panel: ProductPanelKey,
    page: number,
    pageSize: number,
  ): Promise<{ data: ProductPanelResult; pagination: { page: number; pageSize: number; returned: number } }> {
    const result = await this.repository.getPanel(productId, panel, {
      limit: pageSize,
      offset: (page - 1) * pageSize,
    });
    if (result === null) throw new NotFoundError('Producto');
    return {
      data: result,
      pagination: { page, pageSize, returned: result.items.length },
    };
  }
}
