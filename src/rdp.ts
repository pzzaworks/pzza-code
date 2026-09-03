import { invoke } from "@tauri-apps/api/core";

export interface RdpOptions {
  host: string;
  tunnelPort: number;
  remotePort: number;
  user: string;
  certFingerprint: string;
  keychainService: string;
  freerdpBin: string;
}

// Generic defaults. Anything machine-specific (host, user, the RDP server's cert
// fingerprint, the Keychain entry name) is kept out of the repo: provide it from
// a git-ignored src/rdp.local.ts that exports `RDP_OVERRIDE`. import.meta.glob
// resolves to an empty set when that file is absent, so builds work without it.
const GENERIC: RdpOptions = {
  host: "",
  tunnelPort: 13389,
  remotePort: 3389,
  user: "",
  certFingerprint: "",
  keychainService: "pzzacode-rdp",
  freerdpBin: "/opt/homebrew/bin/sdl-freerdp",
};

const overrides = import.meta.glob("./rdp.local.ts", { eager: true }) as Record<
  string,
  { RDP_OVERRIDE?: Partial<RdpOptions> }
>;
const local = Object.values(overrides)[0]?.RDP_OVERRIDE ?? {};

export const RDP_DEFAULTS: RdpOptions = { ...GENERIC, ...local };

export function rdpStatus(tunnelPort: number): Promise<boolean> {
  return invoke<boolean>("rdp_status", { tunnelPort });
}

export function rdpLaunch(opts: RdpOptions): Promise<void> {
  return invoke("rdp_launch", { opts });
}
