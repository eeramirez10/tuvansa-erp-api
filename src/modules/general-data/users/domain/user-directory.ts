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
  classifier?: number | null;
  printer: string | null;
  labelPrinter: number | null;
  supplierClassifiers: string | null;
  captureFrom: string | null;
  captureUntil: string | null;
  store: string | null;
  payrollNumber: string | null;
  position: string | null;
}

export type UserSettings = Omit<NativeUserDetails, 'hideCosts' | 'hideBalances' | 'ownCustomersOnly' | 'classifier'> & {
  hideCosts: boolean;
  hideBalances: boolean;
  ownCustomersOnly: boolean;
  classifier: number | null;
};

export type UserAccess = Pick<UserSettings, 'hideCosts' | 'hideBalances' | 'ownCustomersOnly' | 'classifier' |
  'parameter' | 'company' | 'supplierClassifiers' | 'captureFrom' | 'captureUntil'>;

export function effectiveUserSettings(legacy?: NativeUserDetails | null, saved?: Partial<UserSettings>): UserSettings {
  return {
    company: legacy?.company ?? null, department: legacy?.department ?? null, multiCompany: legacy?.multiCompany ?? null,
    notes: legacy?.notes ?? null, hideCosts: legacy?.hideCosts ?? false, hideBalances: legacy?.hideBalances ?? false,
    ownCustomersOnly: legacy?.ownCustomersOnly ?? false, parameter: legacy?.parameter ?? null, classifier: legacy?.classifier ?? null,
    printer: legacy?.printer ?? null, labelPrinter: legacy?.labelPrinter ?? null, supplierClassifiers: legacy?.supplierClassifiers ?? null,
    captureFrom: legacy?.captureFrom ?? null, captureUntil: legacy?.captureUntil ?? null, store: legacy?.store ?? null,
    payrollNumber: legacy?.payrollNumber ?? null, position: legacy?.position ?? null, ...saved,
  };
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
  access: UserAccess;
}

export interface UserProfile {
  identification: string;
  name: string;
  group: number;
  active: boolean;
  administrator: boolean;
  settings?: { [K in keyof UserSettings]?: UserSettings[K] | undefined } | undefined;
}

export interface DirectoryUser extends Omit<UserProfile, 'settings'> {
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
  settings: UserSettings;
  activationExpiresAt: string | null;
}

export interface PermissionChange {
  key: string;
  allowed: boolean | null;
}
