import { bridgeRequest } from "./serverApi";

export const BRIDGE_CAPABILITIES = [
  ["terminal.read", "Read terminal output"], ["terminal.write", "Create, type in, and terminate terminals"],
  ["files.read", "Read project files"], ["files.write", "Edit project files"],
  ["app.open_editor", "Open project terminals and control the editor"], ["ios.build", "Run iOS builds"],
  ["simulator.control", "Control simulators"], ["maestro.run", "Run UI tests"], ["ios.submit", "Request app submission"],
] as const;
export type BridgeCapability = typeof BRIDGE_CAPABILITIES[number][0];
export interface BridgePeer {
  id: string;
  label: string;
  publicKey: string;
  host: string;
  port: number;
  enabled: boolean;
  expiresAt: number | null;
  projectIds: string[];
  capabilities: BridgeCapability[];
}
export interface BridgeConfig {
  enabled: boolean;
  peers: BridgePeer[];
  projects: { id: string; root: string }[];
}
export interface BridgeJob {
  id: string;
  action: string;
  status: string;
  projectId?: string;
  peerId?: string;
  error?: string;
  approval?: { artifact: string; sha256: string; destination: string; serviceProjectId: string };
  logs?: { cursor: number; at: number; message: string }[];
  nextCursor?: number;
}
export interface BridgeAuditEntry {
  peerId: string;
  action: string;
  projectId: string | null;
  time: number;
  outcome: string;
}
export interface BridgeState {
  identity: { id: string; publicKey: string };
  config: BridgeConfig;
  jobs: BridgeJob[];
  audit?: BridgeAuditEntry[];
}
export const fetchBridgeState = () => bridgeRequest<BridgeState>("state");
export const saveBridgeConfig = (config: BridgeConfig) => bridgeRequest<BridgeState>("config", config);
export const fetchBridgeJobs = () => bridgeRequest<{ jobs: BridgeJob[] }>("jobs");
export const approveBridgeJob = (jobId: string, approved: boolean) => bridgeRequest<unknown>("approve", { jobId, approved });
export const cancelBridgeJob = (jobId: string) => bridgeRequest<unknown>("cancel", { jobId });

export const fetchBridgeAudit = () => bridgeRequest<{ audit: BridgeAuditEntry[] }>("audit");

export const fetchBridgePeerIdentity = (host: string) => bridgeRequest<{ identity: BridgeState["identity"] }>("peer-identity", { host });
