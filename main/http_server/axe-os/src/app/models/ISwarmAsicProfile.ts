export interface ISwarmAsicProfile {
  name: string;
  ips: string[];
  frequency: number | null;
  coreVoltage: number | null;
  deviceSettings?: {
    [ip: string]: {
      frequency: number;
      coreVoltage: number;
    }
  };
}
