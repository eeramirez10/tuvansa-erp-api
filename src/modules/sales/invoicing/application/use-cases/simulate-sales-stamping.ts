import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { StampingSimulationDataSource } from '../../domain/datasources/stamping-simulation-data-source.js';
import type { InvoiceProps } from '../../domain/entities/invoice.js';

export class SimulateSalesStamping {
  constructor(
    private readonly simulations: StampingSimulationDataSource,
    private readonly findRemission: (id: number) => Promise<InvoiceProps | null>,
    private readonly enabled: () => boolean,
  ) {}

  private eligible(invoice: InvoiceProps) {
    return invoice.movementType === 'FA' && !invoice.canceled && invoice.totals.total > 0;
  }

  async inspect(invoice: InvoiceProps) {
    if (!this.enabled() || !this.eligible(invoice)) return undefined;
    return { result: await this.simulations.find(invoice.id) };
  }

  async run(id: number) {
    if (!this.enabled()) {
      throw new ApplicationError('La simulación de timbrado sólo está disponible en el entorno de pruebas.', 'STAMPING_SIMULATION_DISABLED', 403);
    }

    const invoice = await this.findRemission(id);
    if (!invoice) throw new NotFoundError('Remisión web');
    if (!this.eligible(invoice)) {
      throw new ApplicationError('Se requiere una remisión FA activa con importe positivo.', 'STAMPING_SIMULATION_INELIGIBLE', 422);
    }

    const previous = await this.simulations.find(invoice.id);
    return previous ?? this.simulations.record(invoice.id, `SIM-FE-${invoice.number}`);
  }
}
