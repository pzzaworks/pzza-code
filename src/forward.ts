import { invoke } from "@tauri-apps/api/core";

// Matches devbox-autoforward's defaults: never mirror ssh, the stub resolver,
// printing, or the remote desktop listener; ports below 1024 need root locally.
export const DEFAULT_SKIP = [22, 53, 631, 3389];
export const DEFAULT_MIN_PORT = 1024;

export interface ForwardStatus {
  masterUp: boolean;
  remote: number[];
  wanted: number[];
  forwarded: number[];
}

export function forwardScan(
  host: string,
  skip: number[],
  minPort: number,
): Promise<ForwardStatus> {
  return invoke<ForwardStatus>("forward_scan", { host, skip, minPort });
}

export function forwardReconcile(
  host: string,
  skip: number[],
  minPort: number,
): Promise<ForwardStatus> {
  return invoke<ForwardStatus>("forward_reconcile", { host, skip, minPort });
}

export function forwardSet(
  host: string,
  port: number,
  enable: boolean,
): Promise<void> {
  return invoke("forward_set", { host, port, enable });
}

export function openUrl(url: string): Promise<void> {
  return invoke("open_url", { url });
}
