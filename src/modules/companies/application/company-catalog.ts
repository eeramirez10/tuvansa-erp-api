import { ApplicationError } from '../../../shared/domain/errors/application-error.js';
import type { Company, CompanyContext } from '../domain/company.js';

const description = 'TUBERIA Y VALVULAS DEL NORTE, S.A. DE C.V.';
const mexico: Company = { id: 1, alias: 'MEXICO', description, enabled: true };

// Order and labels from Selección de multicía in PROSCAI German de pruebas.
const companies: readonly Company[] = [
  mexico,
  { id: 2, alias: 'MONTERREY', description, enabled: false },
  { id: 3, alias: 'VERACRUZ', description, enabled: false },
  { id: 4, alias: 'MEXICALI', description, enabled: false },
  { id: 5, alias: 'QUERETARO', description, enabled: false },
  { id: 6, alias: 'CANCUN', description, enabled: false },
];

export function listCompanies(): readonly Company[] {
  return companies;
}

export function getCompanyContext(id: number): CompanyContext {
  const company = companies.find((entry) => entry.id === id);
  if (!company) {
    throw new ApplicationError('La compañía solicitada no existe.', 'COMPANY_NOT_FOUND', 404);
  }
  if (!company.enabled) {
    throw new ApplicationError('La compañía solicitada aún no está habilitada.', 'COMPANY_DISABLED', 403);
  }

  return {
    company,
    databaseAlias: 'TUVANSA',
    warehouseCode: '01',
    locationId: 0,
  };
}
