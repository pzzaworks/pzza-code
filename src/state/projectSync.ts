import { create } from "zustand";
import { DEFAULT_SYNC_OPTIONS, type EnvSyncResult, type ProjectSync, type ProjectSyncResult, type SyncOptions } from "../serverApi";
import { deviceExclusions, projectSettings } from "../projectSettings";

function stored(key: string): unknown {
  try { return JSON.parse(localStorage.getItem(key) ?? "null"); } catch { return null; }
}
export const DEFAULT_PROJECT_ROOT = "~/Projects";
function rootValue(): string {
  try { return localStorage.getItem("pzza.projectsRoot") || DEFAULT_PROJECT_ROOT; } catch { return DEFAULT_PROJECT_ROOT; }
}
interface Preferences { root: string; options: SyncOptions; devicesOff: string[] }
export const useProjectSyncPreferences = create<Preferences>(() => ({ root: rootValue(), options: projectSettings(stored("pzza.sync.options"), DEFAULT_SYNC_OPTIONS), devicesOff: deviceExclusions(stored("pzza.sync.devicesOff")) }));
export function updateProjectSyncPreferences(patch: Partial<Preferences>): void {
  const next = { ...useProjectSyncPreferences.getState(), ...patch };
  localStorage.setItem("pzza.projectsRoot", next.root);
  localStorage.setItem("pzza.sync.options", JSON.stringify(next.options));
  localStorage.setItem("pzza.sync.devicesOff", JSON.stringify(next.devicesOff));
  useProjectSyncPreferences.setState(next);
}
export function summarizeProjectSync(result: ProjectSync) {
  const counts = { updated: 0, current: 0, skipped: 0, dirty: 0, stashed: 0, errors: 0 };
  for (const device of result.devices) {
    if (device.error) counts.errors++;
    counts.errors += device.envs.filter(item => item.status === "failed").length;
    for (const item of device.results) {
      if (item.status === "failed") counts.errors++;
      else if (item.status === "cloned" || item.status === "updated") counts.updated++;
      else counts[item.status]++;
    }
  }
  // A verified stash or recovery ref means Sync preserved the work and finished
  // safely. Only disabled preservation, failures, or cancelled enabled work are
  // actionable. The row detail contains the exact Git restore command.
  const needsAttention = Boolean(result.cancelled) || counts.errors > 0 || counts.dirty > 0;
  const details = [
    counts.updated && `${counts.updated} updated or cloned`, counts.current && `${counts.current} already current`,
    counts.skipped && `${counts.skipped} skipped`, counts.dirty && `${counts.dirty} left dirty and unsynced`,
    counts.stashed && `${counts.stashed} local changes preserved`, counts.errors && `${counts.errors} errors`,
  ].filter(Boolean).join(", ");
  return {
    complete: !result.cancelled && counts.errors === 0 && counts.dirty === 0,
    needsAttention,
    title: result.cancelled ? "Sync cancelled" : needsAttention ? "Sync needs attention" : "Sync completed",
    body: `${result.cancelled ? "Remaining enabled work was cancelled. " : ""}${details || "No repositories changed"}.${needsAttention ? " Open Sync to review." : ""}`,
  };
}

// The repository list owns filtering. Keep its per-device outcome rule here so
// summary notifications and the Attention filter cannot disagree about dirty
// work deliberately left in place when stash preservation is disabled.
export function hasUnresolvedProjectSync(result: ProjectSyncResult | undefined, envs: EnvSyncResult[]): boolean {
  return result?.status === "failed" || result?.status === "dirty" || envs.some((item) => item.status === "failed");
}

interface ProjectOperations {
  scan: () => Promise<boolean>;
  sync: () => Promise<boolean>;
  cancel: () => Promise<void>;
  snapshot: () => { scanning: boolean; syncing: boolean; error: string | null; scan: unknown; sync: unknown };
}
let operations: ProjectOperations | null = null;
let operation: { id: string; action: "scan" | "sync"; status: "running" | "complete" | "failed"; error?: string } | null = null;
const waiting = new Set<(value: ProjectOperations) => void>();
export function bindProjectOperations(value: ProjectOperations): () => void {
  operations = value;
  for (const resolve of waiting) resolve(value);
  waiting.clear();
  return () => { if (operations === value) operations = null; };
}
export function projectSyncSnapshot() { return { operation, ...(operations?.snapshot() ?? { scanning: false, syncing: false, error: null, scan: null, sync: null }) }; }
async function ready(): Promise<ProjectOperations> {
  if (operations) return operations;
  return new Promise((resolve, reject) => {
    const completed = (value: ProjectOperations) => { clearTimeout(timer); waiting.delete(completed); resolve(value); };
    const timer = setTimeout(() => { waiting.delete(completed); reject(new Error("The Sync settings panel could not be opened.")); }, 5000);
    waiting.add(completed);
    window.dispatchEvent(new CustomEvent("pzza-notification-section", { detail: "sync" }));
  });
}
export async function startProjectOperation(action: "scan" | "sync") {
  const surface = await ready();
  if (operation?.status === "running" || surface.snapshot().syncing) throw new Error("A project operation is already running.");
  if (action === "sync" && (surface.snapshot().scanning || !surface.snapshot().scan)) throw new Error("Wait for the project scan before syncing.");
  const current = { id: crypto.randomUUID(), action, status: "running" as "running" | "complete" | "failed" };
  operation = current;
  void surface[action]().then(ok => { operation = { ...current, status: ok ? "complete" : "failed" }; }).catch((error: unknown) => { operation = { ...current, status: "failed", error: error instanceof Error ? error.message : "Project operation failed." }; });
  return { accepted: true, operation: current };
}
export async function cancelProjectOperation() { const surface = await ready(); await surface.cancel(); return projectSyncSnapshot(); }
