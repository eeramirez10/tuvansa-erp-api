export interface StampingSimulation {
  mode: 'simulation';
  reference: string;
  simulatedAt: string;
}

export interface StampingSimulationDataSource {
  find(remissionId: number): Promise<StampingSimulation | null>;
  record(remissionId: number, reference: string): Promise<StampingSimulation>;
}
