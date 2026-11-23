export interface BankPanelSettingKey {
  accountId: number;
  action: 'classifiers' | 'budget' | 'review';
  scope: string;
}

export interface BankPanelSetting<T> {
  revision: number;
  values: T;
}

export interface BankPanelSettingsDataSource {
  writable(): boolean;
  read<T>(key: BankPanelSettingKey): Promise<BankPanelSetting<T> | null>;
  save<T>(key: BankPanelSettingKey, revision: number, values: T): Promise<BankPanelSetting<T>>;
}
