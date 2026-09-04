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
export const THIS_MAC: Device = { id: "this-mac", name: "This Mac", host: "localhost" };

export const DEFAULT_DEVICES: Device[] = [THIS_MAC];
