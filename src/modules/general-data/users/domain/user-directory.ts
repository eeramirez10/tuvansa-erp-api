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
  user(id: number): Promise<NativeUser | undefined>;
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

export interface PermissionChange {
  key: string;
  allowed: boolean | null;
}
