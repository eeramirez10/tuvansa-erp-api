import { createHash } from 'node:crypto';
import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import type {
  SalesTicketConversionDataSource, SalesTicketConversionInput, SalesTicketConversionPreview,
  SalesTicketConversionSettings, SalesTicketConversionSource,
} from '../../domain/datasources/sales-ticket-conversion-data-source.js';

const mexicoDate = new Intl.DateTimeFormat('sv-SE', { dateStyle: 'short', timeZone: 'America/Mexico_City' });
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const disabled = 'La configuración de México debe permitir la conversión de FA a FE.';

function fiscalDateReason({ fiscalStart, fiscalEnd }: SalesTicketConversionSettings, date: string) {
  if (!fiscalStart || fiscalStart < '1901-01-01' || !fiscalEnd || fiscalEnd < fiscalStart) {
    return 'No está configurado el ejercicio contable de México.';
  }
  return date < fiscalStart || date > fiscalEnd
    ? `La fecha de emisión debe estar dentro del ejercicio contable de México (${fiscalStart} a ${fiscalEnd}).`
    : null;
}

function reasonFor({ invoice, charge, paymentRevision, canceled, result }: SalesTicketConversionSource) {
  if (result) return 'La remisión ya se convirtió a factura.';
  if (canceled || invoice.canceled) return 'La remisión está cancelada.';
  if (invoice.folio || invoice.cfdStatus !== '0') return 'La remisión tiene un estado fiscal que impide convertirla.';
  if (paymentRevision !== 1) return 'La conversión requiere una remisión cuyo cargo aún no tenga movimientos de cobranza.';
  if (invoice.movementType !== 'FA' || invoice.currency.id !== 1 || invoice.currency.exchangeRate !== 1
    || !invoice.dates.issuedAt || charge <= 0 || charge !== invoice.totals.total) {
    return 'Se requiere una remisión web FA en pesos con su cargo original.';
  }
  if (!invoice.lines.some((line) => line.fulfilledQuantity > 0)
    || invoice.lines.some((line) => line.fulfilledQuantity < 0)
    || invoice.totals.freight || invoice.totals.insurance || invoice.totals.other) {
    return 'La conversión requiere partidas positivas y una remisión sin flete, seguro u otros cargos.';
  }
  return null;
}

function versionOf({ invoice, charge, paid, paymentRevision }: SalesTicketConversionSource, date: string) {
  return hash([invoice, charge, paid, paymentRevision, date]);
}

export class ConvertSalesTicket {
  constructor(
    private readonly storage: SalesTicketConversionDataSource,
    private readonly settings: () => Promise<SalesTicketConversionSettings | null>,
    private readonly today = () => mexicoDate.format(),
  ) {}

  async preview(invoiceId: number): Promise<{ preview: SalesTicketConversionPreview; reason: string | null } | null> {
    const source = await this.storage.source(invoiceId);
    if (!source) return null;
    const { invoice, charge, paid, result } = source;
    const issuedAt = result?.issuedAt ?? this.today();
    let reason = reasonFor(source);
    if (!reason) {
      const settings = await this.settings();
      reason = settings ? fiscalDateReason(settings, issuedAt) : disabled;
    }
    return {
      preview: {
        sourceNumber: invoice.number, targetType: 'FE', issuedAt, total: invoice.totals.total,
        balance: Math.max(0, Number((charge - paid).toFixed(2))), currency: invoice.currency.name,
        version: reason ? null : versionOf(source, issuedAt), result,
      },
      reason,
    };
  }

  execute(invoiceId: number, { requestKey, expectedVersion }: SalesTicketConversionInput) {
    return this.storage.convert(invoiceId, requestKey, hash([invoiceId, expectedVersion]), async (source) => {
      if (source.result) throw new ConflictError('La remisión ya se convirtió a factura.', 'SALES_TICKET_ALREADY_CONVERTED');
      const date = this.today();
      const settings = await this.settings();
      const dateReason = settings && fiscalDateReason(settings, date);
      if (dateReason) throw new ApplicationError(dateReason, 'SALES_TICKET_CONVERSION_DATE_INVALID', 422);
      if (versionOf(source, date) !== expectedVersion) {
        throw new ConflictError('La remisión cambió. Vuelve a consultar la vista previa.', 'SALES_TICKET_CONVERSION_STALE');
      }
      const reason = reasonFor(source);
      if (reason) throw new ConflictError(reason, 'SALES_TICKET_CONVERSION_INELIGIBLE');
      if (!settings) throw new ApplicationError(disabled, 'SALES_TICKET_CONVERSION_CONFIGURATION', 422);
      return date;
    });
  }
}
