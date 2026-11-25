import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type {
  InventoryMovementPrintReferences,
  MovementPrintCustoms,
} from '../../domain/repositories/inventory-movement-print-references.js';
import type { MovementsRepository } from '../../domain/repositories/movements-repository.js';

const unavailable = (message: string) =>
  new ApplicationError(message, 'INVENTORY_MOVEMENT_PRINT_UNAVAILABLE', 422);

export class ReadInventoryMovementPrint {
  constructor(
    private readonly movements: Pick<MovementsRepository, 'findById'>,
    private readonly references: InventoryMovementPrintReferences,
  ) {}

  async execute(id: number) {
    const movement = await this.movements.findById(id);
    if (!movement) throw new NotFoundError('Documento de inventario');
    const { header, lines, comment } = movement;
    const { type, inventoryFlag, billingFlag, company, status, document } = header;
    const transfer = type === 'TR';
    if ((type !== 'EI' && type !== 'SI' && !transfer) || !document.startsWith(type)
      || inventoryFlag !== 1 || billingFlag !== 0 || company !== 1 || status !== 0) {
      throw unavailable('La impresión está disponible para entradas, salidas y traspasos de inventario de México.');
    }
    if (!lines.some((line) => line.type !== 'K' && line.quantity !== 0)) {
      throw unavailable('El documento no tiene partidas vigentes para imprimir.');
    }

    const settings = await this.references.settings(header);
    const expectedFormat = type === 'SI' ? 'QTUVANSA002' : 'QTUVANSA007';
    if (!settings || settings.adHoc || settings.format !== expectedFormat) {
      throw unavailable('El formato de impresión configurado para este movimiento no está disponible.');
    }

    const lotIds = [...new Set(lines.map(({ lotId }) => lotId).filter((lotId) => lotId > 0))];
    const customsByLot = lotIds.length ? await this.references.customsByLot(lotIds) : new Map<number, MovementPrintCustoms>();
    // Documentos imprime por DSEQ. En TR eso incluye ambos lados del traspaso.
    const printableLines = lines.map((line) => {
      const lot = customsByLot.get(line.lotId);
      return {
        id: line.id,
        productCode: line.productCode,
        description: line.description,
        ...(transfer ? { warehouse: line.warehouse } : {}),
        quantity: line.quantity,
        cost: line.cost,
        amount: line.quantity * line.cost,
        customs: lot ?? (line.customsEntry ? { entry: line.customsEntry, date: null, office: '' } : null),
      };
    });

    return { data: {
      format: expectedFormat,
      type,
      document,
      date: header.date,
      reference: header.reference,
      warehouse: header.warehouse,
      ...(transfer ? { sourceWarehouse: header.reference2 } : {}),
      warehouseName: settings.warehouseName,
      companyName: settings.companyName,
      place: settings.place,
      comment: comment ?? '',
      lines: printableLines,
      total: printableLines.reduce((sum, line) => sum + line.amount, 0),
    } };
  }
}
