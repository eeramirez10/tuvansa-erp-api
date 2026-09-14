import { ApplicationError } from '../../../../../shared/domain/errors/application-error.js';
import { ConflictError } from '../../../../../shared/domain/errors/conflict-error.js';
import { NotFoundError } from '../../../../../shared/domain/errors/not-found-error.js';
import type { SaveClientFiscal } from '../../domain/entities/client-fiscal.js';
import type { ClientFiscalRepository } from '../../domain/repositories/client-fiscal-repository.js';
import type { ClientFiscalVerificationProvider } from '../../domain/services/client-fiscal-verification-provider.js';

export class ClientFiscalUseCases {
  constructor(
    private readonly repository: ClientFiscalRepository,
    private readonly provider: ClientFiscalVerificationProvider,
  ) {}

  async get(clientId: number) {
    const data = await this.repository.find(clientId);
    if (data === null) throw new NotFoundError('Cliente');
    return { data: { ...data, verificationAvailable: this.provider.configured } };
  }

  async save(clientId: number, input: SaveClientFiscal) {
    const result = await this.repository.save(clientId, input);
    if (result.status === 'not-found') throw new NotFoundError('Cliente');
    if (result.status === 'conflict') {
      throw new ConflictError('Los datos fiscales cambiaron. Cierre y vuelva a abrir la ventana.', 'FISCAL_DATA_CHANGED');
    }
    if (result.status !== 'saved') throw new Error('Unexpected fiscal save result');
    return {
      data: { ...result.data, verificationAvailable: this.provider.configured },
      message: 'Datos guardados. Verificación pendiente en PROSCAI.',
    };
  }

  async verify(clientId: number) {
    const { data: original } = await this.get(clientId);
    let result;
    try {
      result = await this.provider.verify({ ...original.values });
    } catch {
      // Do not expose provider responses, URLs, credentials or transport errors.
      throw new ApplicationError('El servicio de verificación fiscal no está disponible. Intente más tarde.',
        'FISCAL_PROVIDER_UNAVAILABLE', 503);
    }
    if (result.status === 'unavailable') {
      if (result.reason === 'not-configured') {
        throw new ApplicationError(
          'La integración con el proveedor fiscal está pendiente. Por ahora, verifique en PROSCAI. Puede editar los datos con Ctrl + clic.',
          'FISCAL_VERIFICATION_UNAVAILABLE', 501,
        );
      }
      throw new ApplicationError('El servicio de verificación fiscal no está disponible. Intente más tarde.',
        'FISCAL_PROVIDER_UNAVAILABLE', 503);
    }
    // A response for an old version must not describe the currently edited client.
    const { data: current } = await this.get(clientId);
    if (current.version !== original.version) {
      throw new ConflictError('Los datos fiscales cambiaron durante la consulta. Vuelva a verificar.', 'FISCAL_DATA_CHANGED');
    }
    if (result.status === 'rejected') {
      throw new ApplicationError('El proveedor no validó los datos fiscales. Revise los datos del cliente.',
        'FISCAL_DATA_REJECTED', 422);
    }
    if (result.status !== 'validated') {
      throw new ApplicationError('El servicio fiscal devolvió una respuesta no válida.', 'FISCAL_PROVIDER_INVALID_RESPONSE', 502);
    }
    // A provider response is not an OMNIS checksum. Do not write CLICFDI4CS.
    return {
      data: { clientId, version: original.version, status: 'provider-validated' as const, legacySync: 'pending' as const },
      message: 'Datos validados por el proveedor. La verificación en PROSCAI sigue pendiente.',
    };
  }
}
