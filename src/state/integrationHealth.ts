import { create } from "zustand";
import { repairMcp, type McpRepairResult } from "../serverApi";

export interface DeviceIntegrationHealth { host: string; name: string; results: McpRepairResult[]; error?: string; checking: boolean }
interface IntegrationHealth {
  devices: Record<string, DeviceIntegrationHealth>;
  check(host: string, name: string, fresh?: boolean): Promise<void>;
}
export const useIntegrationHealth = create<IntegrationHealth>((set, get) => ({
  devices: {},
  async check(host, name, fresh = false) {
    if (get().devices[host]?.checking) return;
    set(state => ({ devices: { ...state.devices, [host]: { ...state.devices[host], host, name, results: state.devices[host]?.results ?? [], checking: true, error: undefined } } }));
    try {
      const { results } = await repairMcp(host, fresh);
      set(state => ({ devices: { ...state.devices, [host]: { host, name, results, checking: false } } }));
    } catch (error) {
      set(state => ({ devices: { ...state.devices, [host]: { host, name, results: state.devices[host]?.results ?? [], checking: false, error: error instanceof Error ? error.message : "Integration check failed" } } }));
    }
  },
}));
