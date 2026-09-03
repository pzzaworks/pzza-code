// A managed ssh device (used by RDP and port forwarding as server/client).
export interface Device {
  id: string;
  name: string;
  host: string; // ssh Host alias or IP
  user?: string;
}

export const DEFAULT_DEVICES: Device[] = [
  { id: "devbox", name: "Devbox", host: "devbox" },
  { id: "this-mac", name: "This Mac", host: "localhost" },
];
