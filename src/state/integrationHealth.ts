import { create } from "zustand";
import { repairMcp, type McpRepairResult } from "../serverApi";

export interface DeviceIntegrationHealth { host: string; name: string; results: McpRepairResult[]; error?: string; checking: boolean; checkedAt?: number }
interface IntegrationBatch { id: string; status: "running" | "complete"; hosts: string[] }
interface IntegrationHealth {
  devices: Record<string, DeviceIntegrationHealth>;
  batch: IntegrationBatch | null;
  check(host: string, name: string, fresh?: boolean): Promise<void>;
  checkAll(devices: { host: string; name: string }[], fresh?: boolean): IntegrationBatch;
}
const pending = new Map<string, Promise<void>>();
export const useIntegrationHealth = create<IntegrationHealth>((set, get) => ({
  devices: {}, batch: null,
  check(host, name, fresh = false) {
    const active = pending.get(host);
    if (active) return active;
    set(state => ({ devices: { ...state.devices, [host]: { ...state.devices[host], host, name, results: state.devices[host]?.results ?? [], checking: true, error: undefined } } }));
    const operation = repairMcp(host, fresh).then(({ results }) => {
      set(state => ({ devices: { ...state.devices, [host]: { host, name, results, checking: false, checkedAt: Date.now() } } }));
    }).catch((error: unknown) => {
      set(state => ({ devices: { ...state.devices, [host]: { host, name, results: state.devices[host]?.results ?? [], checking: false, checkedAt: Date.now(), error: error instanceof Error ? error.message : "Integration check failed" } } }));
    }).finally(() => { pending.delete(host); });
    pending.set(host, operation);
    return operation;
  },
  checkAll(devices, fresh = true) {
    if (get().batch?.status === "running") throw new Error("An integration check is already running.");
    const targets = [...new Map(devices.map(device => [device.host, device])).values()];
    const batch: IntegrationBatch = { id: crypto.randomUUID(), status: "running", hosts: targets.map(device => device.host) };
    set({ batch });
    let index = 0;
    void Promise.all(Array.from({ length: Math.min(3, targets.length) }, async () => {
      while (index < targets.length) {
        const target = targets[index++];
        await get().check(target.host, target.name, fresh);
      }
    })).finally(() => { if (get().batch?.id === batch.id) set({ batch: { ...batch, status: "complete" } }); });
    return batch;
  },
}));
