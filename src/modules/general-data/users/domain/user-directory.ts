export const generalDataPermission = 'INICIO13';
export const userCatalogPermission = 'MCATALOGOS8';
export const salesOrderPermission = 'MPED5';
export const accessGroups = Array.from({ length: 42 }, (_, group) => group);
export const webIdentificationPattern = /^[\p{L}\p{N}_.@-]+$/u;

export interface NativeUser {
  legacyId: number;
  identification: string;
  name: string;
  group: number;
  shared: boolean;
  active: boolean;
  details?: NativeUserDetails;
}

export interface NativeUserDetails {
  company: number | null;
  department: number | null;
  multiCompany: number | null;
  notes: string | null;
  hideCosts: boolean | null;
  hideBalances: boolean | null;
  ownCustomersOnly: boolean | null;
  parameter: string | null;
  printer: string | null;
  labelPrinter: number | null;
  supplierClassifiers: string | null;
  captureFrom: string | null;
  captureUntil: string | null;
  store: string | null;
  payrollNumber: string | null;
  position: string | null;
}

export interface NativePermission {
  key: string;
  label: string;
  module: string;
  allowed: boolean;
  requiresSupervisor: boolean;
}

export interface LegacyUserDirectory {
  users(): Promise<NativeUser[]>;
  user(id: number, includeDetails?: boolean): Promise<NativeUser | undefined>;
  permissions(group: number, keys?: string[]): Promise<NativePermission[]>;
}

export interface WebIdentity {
  id: string;
  identification: string;
  name: string;
  legacyId: number | null;
  group: number;
  administrator: boolean;
}

export interface UserProfile {
  identification: string;
  name: string;
  group: number;
  active: boolean;
  administrator: boolean;
}

export interface DirectoryUser extends UserProfile {
  id: string;
  legacyId: number | null;
  legacyIdentification: string | null;
  shared: boolean;
  legacyActive: boolean | null;
  revision: number;
  configured: boolean;
  effectiveActive: boolean;
}

export interface DirectoryUserDetail extends DirectoryUser {
  legacyDetails: NativeUserDetails | null;
  activationExpiresAt: string | null;
}

export interface PermissionChange {
  key: string;
  allowed: boolean | null;
}
