import type { InvoicePieceStore } from '../../application/use-cases/edit-invoice-pieces.js';
import type { InvoicesDataSource } from '../../domain/datasources/invoices-data-source.js';
import { Invoice } from '../../domain/entities/invoice.js';
import type {
  InvoiceNavigationDirection,
  InvoiceSearchCriteria,
  InvoiceSearchResult,
  InvoicesRepository,
} from '../../domain/repositories/invoices-repository.js';

export class InvoicesRepositoryImpl implements InvoicesRepository {
  constructor(private readonly dataSource: InvoicesDataSource, private readonly pieces?: InvoicePieceStore) {}

  private async withPieces(invoice: Invoice | null) {
    if (!invoice || !this.pieces) return invoice;
    const detail = invoice.toPrimitives();
    if (!detail.lines.length) return invoice;
    const pieces = await this.pieces.latest(detail);
    if (!pieces.length) return invoice;
    const byLine = new Map(pieces.map(({ lineId, value }) => [lineId, value]));
    return Invoice.create({ ...detail, lines: detail.lines.map((line) => ({ ...line, pieces: byLine.get(line.id) ?? line.pieces })) });
  }

  async findById(invoiceId: number) { return this.withPieces(await this.dataSource.findById(invoiceId)); }
  async findByNumber(invoiceNumber: string) { return this.withPieces(await this.dataSource.findByNumber(invoiceNumber)); }
  async findFirst() { return this.withPieces(await this.dataSource.findFirst()); }
  async findAdjacent(invoiceId: number, direction: InvoiceNavigationDirection) {
    return this.withPieces(await this.dataSource.findAdjacent(invoiceId, direction));
  }
  search(criteria: InvoiceSearchCriteria): Promise<InvoiceSearchResult> {
    return this.dataSource.search(criteria);
  }
}
