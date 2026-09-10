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
  configHash: string;
  jobs: BridgeJob[];
  audit?: BridgeAuditEntry[];
}
export const fetchBridgeState = () => bridgeRequest<BridgeState>("state");
export const saveBridgeConfig = (config: BridgeConfig, expectedConfigHash: string) => bridgeRequest<BridgeState>("configure", { config, expectedConfigHash });
export const fetchBridgeJobs = () => bridgeRequest<{ jobs: BridgeJob[] }>("jobs");
export const approveBridgeJob = (jobId: string, approved: boolean) => bridgeRequest<unknown>("approve", { jobId, approved });
export const cancelBridgeJob = (jobId: string) => bridgeRequest<unknown>("cancel", { jobId });

export const fetchBridgeAudit = () => bridgeRequest<{ audit: BridgeAuditEntry[] }>("audit");

export const fetchBridgePeerIdentity = (host: string) => bridgeRequest<{ identity: BridgeState["identity"] }>("peer-identity", { host });

export interface BridgeConnection {
  projects: { id: string; name: string }[];
  capabilities: BridgeCapability[];
  expiresAt: number;
}
export interface BridgeConnectionRequest {
  host: string;
  identityId: string;
  label: string;
  localLabel: string;
  project: { id: string; root: string };
  capabilities: BridgeCapability[];
  expiresAt: number;
}
export interface BridgeConnectionResult { state: BridgeState; connection: BridgeConnection }
export type BridgeConnectionOperation = { id: string; createdAt: number; updatedAt: number } & (
  | { status: "pending" }
  | { status: "completed"; result: BridgeConnectionResult }
  | { status: "failed"; error: string }
);
export class BridgeConnectionPendingError extends Error {
  readonly status = "pending";
  constructor(readonly operationId: string, readonly noLongerRetained = false) {
    super(`Pairing outcome is still pending confirmation. Check operation ${operationId} rather than starting another pairing. If the agent restarted or its one-hour result retention expired, review both devices' settings.`);
  }
}
const PENDING_CONNECTION_KEY = "pzza.bridge.pending-connection";
let pendingConnectionId: string | null = null;
export function getPendingBridgeConnectionId(): string | null {
  try { pendingConnectionId ??= sessionStorage.getItem(PENDING_CONNECTION_KEY); }
  catch { /* In-memory tracking still survives a settings panel remount. */ }
  return pendingConnectionId;
}
function retainPendingConnection(operationId: string | null) {
  pendingConnectionId = operationId;
  try {
    if (operationId) sessionStorage.setItem(PENDING_CONNECTION_KEY, operationId);
    else sessionStorage.removeItem(PENDING_CONNECTION_KEY);
  } catch { /* A pending error also carries the operation ID for recovery. */ }
}
export function dismissPendingBridgeConnection(operationId: string) {
  if (getPendingBridgeConnectionId() === operationId) retainPendingConnection(null);
}
export const fetchBridgeConnectionOperation = (operationId: string) => bridgeRequest<BridgeConnectionOperation>("connect-status", { operationId });
export async function resumeBridgeConnection(operationId: string): Promise<BridgeConnectionResult> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    let operation: BridgeConnectionOperation;
    try { operation = await fetchBridgeConnectionOperation(operationId); }
    catch (error) { throw new BridgeConnectionPendingError(operationId, error instanceof Error && "status" in error && error.status === 404); }
    if (operation.id !== operationId) throw new BridgeConnectionPendingError(operationId);
    if (operation.status === "completed" || operation.status === "failed") {
      if (getPendingBridgeConnectionId() === operationId) retainPendingConnection(null);
      if (operation.status === "failed") throw new Error(operation.error);
      return operation.result;
    }
    await new Promise<void>(resolve => setTimeout(resolve, 1000));
  }
  throw new BridgeConnectionPendingError(operationId);
}
export async function connectBridgeDevice(request: BridgeConnectionRequest): Promise<BridgeConnectionResult> {
  // Allocate before sending so a lost initiating response is recovered by ID,
  // never by repeating grant creation. Each HTTP call keeps its short timeout.
  const pending = getPendingBridgeConnectionId();
  if (pending) throw new BridgeConnectionPendingError(pending);
  const operationId = crypto.randomUUID();
  retainPendingConnection(operationId);
  try { await bridgeRequest<BridgeConnectionOperation>("connect", { ...request, operationId }); }
  catch (error) {
    if (error instanceof Error && "status" in error && typeof error.status === "number" && error.status < 500) {
      retainPendingConnection(null);
      throw error;
    }
  }
  return resumeBridgeConnection(operationId);
}
export const testBridgeConnection = (peerId: string) => bridgeRequest<BridgeConnection>("dispatch", { peerId, action: "bridge.describe", args: {} });
