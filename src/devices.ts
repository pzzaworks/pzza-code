// A managed ssh device (used by RDP and port forwarding as server/client).
export interface Device {
  id: string;
  name: string;
  host: string; // ssh Host alias or IP
  user?: string;
}

// The only device that always exists is the local machine running the app - it
// is both the current device and where the built-in agent runs. Extra devices
// (a devbox, a remote box) are added by the user through the setup wizard.
export const THIS_MAC: Device = { id: "this-mac", name: "This Device", host: "localhost" };

export const DEFAULT_DEVICES: Device[] = [THIS_MAC];

// Name of the device a session runs on: no host = this device, otherwise the
// matching device (or the raw host when it is not in the list).
export function deviceNameFor(devices: Device[], host?: string): string {
  if (host) return deviceForHost(devices, host)?.name ?? host;
  return devices.find((d) => d.id === THIS_MAC.id)?.name ?? THIS_MAC.name;
}

export type DeviceOs = "macos" | "linux" | "windows" | "freebsd" | "unknown";

export function deviceHost(device: Device): string {
  return device.id === THIS_MAC.id ? "" : device.user ? `${device.user}@${device.host}` : device.host;
}

export function deviceForHost(devices: Device[], host?: string): Device | undefined {
  return devices.find((device) => host ? deviceHost(device) === host || device.host === host : device.id === THIS_MAC.id);
}
