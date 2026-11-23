export interface Company {
  id: number;
  alias: string;
  description: string;
  enabled: boolean;
}

export interface CompanyContext {
  company: Company;
  databaseAlias: string;
  warehouseCode: string;
  locationId: number;
}
