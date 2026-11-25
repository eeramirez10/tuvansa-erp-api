export interface PolicyClassificationIdentity {
  id: number;
  number: string;
}

export interface PolicyClassificationUpdate {
  compositeCode: string;
  revision: number;
  requestKey: string;
}

export interface SavedPolicyClassification extends PolicyClassificationIdentity {
  compositeCode: string;
  revision: number;
}

export interface PolicyClassificationsStorage {
  writable(): boolean;
  find(policies: PolicyClassificationIdentity[]): Promise<SavedPolicyClassification[]>;
  save(policy: PolicyClassificationIdentity, input: PolicyClassificationUpdate): Promise<SavedPolicyClassification>;
}
