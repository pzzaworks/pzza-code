import { agentsHubRequest } from "./serverApi";
import { createReadCache, readIncrementally } from "./state/hubReads";

export interface HubFramework { id: string; label: string; instructionFile: string; skillsDirectory: string | null; launchSupported: boolean }
export interface HubDocument { id: string; name: string; framework: string; content: string }
export interface HubAssetMetadata { path: string; executable: boolean; bytes: number }
export interface HubSkill { id: string; name: string; content: string; sourceUrl?: string; subpath?: string; license?: string; commit?: string; files?: HubAssetMetadata[] }
export interface HubProfile { id: string; name: string; framework: string; systemPrompt: string; instructionIds: string[]; skillIds: string[] }
export interface HubDeployment { id: string; profileId: string; host: string; cwd: string; mode: string; status: string; session?: string; backupPath?: string; error?: string; createdAt: number; revision: number }
export interface HubSummary { revision: number; documents: (Omit<HubDocument, "content"> & { contentBytes: number })[]; skills: (Omit<HubSkill, "content"> & { contentBytes: number })[]; profiles: (Omit<HubProfile, "systemPrompt"> & { systemPromptBytes: number })[]; deployments: HubDeployment[]; frameworks: HubFramework[] }
export interface HubItems { document: HubDocument; skill: HubSkill; profile: HubProfile }
export type HubKind = keyof HubItems;
export type HubItemResponse<K extends HubKind = HubKind> = { revision: number; item: HubItems[K] };
// Asset metadata is deliberately not assignable to the write contract.
export type HubChange = { [K in HubKind]: { op: "update"; kind: K; item: Partial<Omit<HubItems[K], "files">> & { id: string }; detachReferences?: boolean } | { op: "remove"; kind: K; id: string; detachReferences?: boolean } }[HubKind];
export interface HubAssetPage { revision: number; id: string; path: string; bytes: number; executable: boolean; sha256: string; encoding: "utf8" | "binary"; content: string | null; offset: number; nextOffset: number; hasMore: boolean }
export interface HubPreview { previewId: string; revision: number; profileId: string; host: string; cwd: string; files: { path: string; content: string | null; encoding?: "utf8" | "base64"; operation?: "write" | "delete"; previousContent?: string; previousEncoding?: "utf8" | "base64"; baselineSha256: string | null; contentBase64?: string }[]; launch: { supported: boolean; command: string | null }; conflicts: string[] }
export interface HubImportResult extends HubSummary { imported: { id: string; status: "imported" | "existing" | "updated" } }
const summaries = createReadCache<HubSummary>(1, 30000);
const details = createReadCache<HubItemResponse>(16, 30000);
export const peekHub = () => summaries.peek("local");
export const fetchHub = (fresh = false) => summaries.read("local", () => agentsHubRequest<HubSummary>("summary"), fresh);
export async function fetchHubItem<K extends HubKind>(kind: K, id: string, revision: number, fresh = false): Promise<HubItemResponse<K>> {
  const result = await details.read(`${revision}:${kind}:${id}`, () => agentsHubRequest<HubItemResponse<K>>("item", { kind, id }), fresh);
  return result as HubItemResponse<K>;
}
export function invalidateHub() { summaries.clear(); details.clear(); }
export async function updateHub(revision: number, changes: HubChange[]) {
  const result = await agentsHubRequest<HubSummary>("update", { revision, changes });
  invalidateHub();
  return result;
}
export const fetchHubAsset = (revision: number, id: string, path: string, offset = 0) => agentsHubRequest<HubAssetPage>("asset", { revision, id, path, offset, length: 16384 });
export const previewHub = (profileId: string, host: string, cwd: string, adoptExisting = false) => agentsHubRequest<HubPreview>("preview", { profileId, host, cwd, adoptExisting });
export const applyHub = (previewId: string, mode: "sync" | "deploy") => agentsHubRequest<HubDeployment>(mode, { previewId });
export async function importHubSkill(revision: number, sourceUrl: string, subpath: string, updateId?: string, signal?: AbortSignal) {
  const result = await agentsHubRequest<HubImportResult>("import-skill", { revision, sourceUrl, subpath, ...(updateId ? { updateId } : {}) }, signal);
  invalidateHub();
  return result;
}

export interface GlobalInstructionFile { path: string; framework: string; content: string; modifiedAt: number; sha256: string; bytes: number }
export interface GlobalInstructionDevice { host: string; name: string; files: GlobalInstructionFile[]; error?: string }
export interface GlobalInstructionDiscovery { devices: GlobalInstructionDevice[] }
export interface GlobalInstructionSource { host: string; path: string; sha256: string }
export interface GlobalInstructionTarget { host: string; path: string }
export interface GlobalInstructionPreview {
  previewId: string;
  source: GlobalInstructionSource & { framework: string; content: string; modifiedAt: number };
  targets: (GlobalInstructionTarget & { previousContent: string | null; baselineSha256: string | null; status: "ready" | "unchanged" | "failed"; error?: string })[];
}
export interface GlobalInstructionResult extends GlobalInstructionTarget { status: "synced" | "unchanged" | "failed"; backupPath?: string; error?: string }
const globals = createReadCache<GlobalInstructionDevice>(20, 30000);
export const cachedGlobalInstructions = (devices: { host: string; name: string }[]) => devices.flatMap(device => {
  const cached = globals.peek(device.host);
  return cached ? [{ ...cached, name: device.name }] : [];
});
export async function discoverGlobalInstructions(devices: { host: string; name: string }[], publish: (device: GlobalInstructionDevice) => void, fresh = false) {
  const unique = [...new Map(devices.map(device => [device.host, device])).values()].sort((a, b) => Number(Boolean(a.host)) - Number(Boolean(b.host)));
  await readIncrementally(unique, async device => {
    try {
      const result = await globals.read(device.host, async () => {
        const found = await agentsHubRequest<GlobalInstructionDiscovery>("global-discover", { devices: [device] });
        if (!found.devices[0]) throw new Error("This device did not return an instruction snapshot.");
        return found.devices[0];
      }, fresh);
      return { ...result, name: device.name };
    } catch (cause) { return { ...device, files: [], error: cause instanceof Error ? cause.message : "Could not load this device. Check its connection and refresh." }; }
  }, publish);
}
export const previewGlobalInstructions = (source: GlobalInstructionSource, targets: GlobalInstructionTarget[]) => agentsHubRequest<GlobalInstructionPreview>("global-preview", { source, targets });
export async function syncGlobalInstructions(previewId: string) {
  const result = await agentsHubRequest<{ results: GlobalInstructionResult[] }>("global-sync", { previewId });
  globals.clear();
  return result;
}
