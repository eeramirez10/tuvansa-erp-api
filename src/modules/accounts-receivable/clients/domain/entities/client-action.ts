import type { ClientConsultationIdentity } from './client-consultation.js';

export type ClientActionIdentity = ClientConsultationIdentity;

export interface ClientClassificationValue {
  id: number | null;
  position: number;
  key: string;
  label: string;
  code: string;
  description: string;
  number: string;
  type: string;
  categoryType: number | null;
}

export interface ClientClassificationOption {
  id: number;
  code: string;
  description: string;
  number: string;
  type: string;
}

export interface ClientDiscount {
  id: number;
  key: string;
  discount1: number;
  discount2: number;
  discount3: number;
  startsAt: string | null;
  endsAt: string | null;
  notes: string;
  quantityFrom: number;
  quantityTo: number;
  department: string;
  secondaryKey: string;
  changedAt: string | null;
  status: number;
  previousDiscount: number;
  unit: string;
}

export interface ClientEvent {
  id: number;
  date: string;
  title: string;
  description: string;
  followUpAt: string | null;
  dueAt: string | null;
  type: string;
  responsible: string;
  requestedBy: string;
  release: number;
  importance: number;
  complexity: number;
  done: boolean;
  project: string;
  key: string;
  number: string;
  invoice: string;
  cost: number;
  morning: boolean;
  executedBy: string;
  secondaryDone: boolean;
  initialFollowUpAt: string | null;
  initialDueAt: string | null;
  branch: string;
  extra: boolean;
  department: number;
}

export interface ClientBranch {
  id: number;
  code: string;
  name: string;
}

export interface ClientContact {
  id: number;
  name: string;
  position: string;
  phones: string[];
  email: string;
  notes: string;
  birthday: string | null;
  interests: string;
  extension: string;
  mobile: string;
  title: string;
  receivesInvoices: boolean;
  receivesAccountStatement: boolean;
  responsibilities: boolean[];
  changedAt: string | null;
}

export interface ClientBlockStatus {
  blocked: boolean;
  blockedAt: string | null;
  hasEvents: boolean;
  event: {
    id: number;
    date: string;
    title: string;
    description: string;
    key: string;
  } | null;
}

export interface UnresolvedClientAction {
  available: false;
  source: null;
  reason: string;
}
