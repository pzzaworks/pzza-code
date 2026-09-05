import { invoke } from "@tauri-apps/api/core";

// Open a device's desktop. The native side does everything in one go: reads or
// creates the RDP password in the Keychain, configures GNOME Remote Desktop on
// the device with it over ssh, opens a private tunnel and launches the viewer.
export interface RdpOptions {
  host: string; // ssh target: alias or user@host
  port?: number;
  identity?: string;
  user: string; // RDP account on the device
  keychainService: string;
}

// What the launch found on the device: daemon mode (headless/session) and port.
export interface Launched {
  port: number;
  mode: string;
}

export function rdpLaunch(opts: RdpOptions): Promise<Launched> {
  return invoke<Launched>("rdp_launch", { opts });
}
