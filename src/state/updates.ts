import { confirmUnsavedWork } from "./unsavedWork";
import { create } from "zustand";
import { checkForUpdate, relaunchApp, type AvailableUpdate } from "../updater";
import { HAS_TAURI } from "../tauriEnv";
import { notify } from "./notifications";
import { localSessionWorkRunning, whenLocalSessionWorkSettled } from "./localSessionWork";

// In-app update state shared by the banner and Settings. Checks run on launch,
// hourly, and when the window regains focus; with automatic updates on (the
// default) a new release is downloaded and installed in the background and
// only the restart is left to the user.

const AUTO_KEY = "pzza.autoUpdate";
// The version whose background install failed, or that cannot be installed in
// the background (see bundleWritable). When PzzaCode's folder is not
// writable for this user, installing asks macOS for an administrator password;
// a background install must never ask again and again, so after one failure
// that version is only installed when the user chooses Update.
const SKIPPED_KEY = "pzza.autoUpdate.skipped";
const RECHECK_MS = 60 * 60 * 1000;
const FOCUS_RECHECK_MS = 15 * 60 * 1000;

export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "latest" }
  | { kind: "available"; update: AvailableUpdate }
  | { kind: "installing"; update: AvailableUpdate; pct: number }
  | { kind: "ready"; update: AvailableUpdate; restarting?: boolean; error?: string }
  | { kind: "error"; msg: string };

interface UpdateState {
  status: UpdateStatus;
  autoUpdate: boolean;
  dismissed: string | null; // version whose banner was closed this session
  setAutoUpdate: (v: boolean) => void;
  // manual = surfaced to the user (Settings); background failures stay quiet.
  check: (manual?: boolean, installAutomatically?: boolean) => Promise<void>;
  // Installs the available update because the user asked for it.
  install: () => Promise<void>;
  relaunch: () => Promise<void>;
  dismiss: () => void;
}

function loadAuto(): boolean {
  try {
    const raw = localStorage.getItem(AUTO_KEY);
    return raw === null ? true : raw === "true";
  } catch {
    return true;
  }
}

function skippedVersion(): string | null {
  try {
    return localStorage.getItem(SKIPPED_KEY);
  } catch {
    return null;
  }
}

function setSkippedVersion(version: string | null): void {
  try {
    if (version === null) localStorage.removeItem(SKIPPED_KEY);
    else localStorage.setItem(SKIPPED_KEY, version);
  } catch {
    /* Without storage the skip lasts for this window only (see autoInstallFailed). */
  }
}

// Background installs that failed in this window, for when storage is unavailable.
const autoInstallFailed = new Set<string>();
const mayInstallInBackground = (version: string) => !autoInstallFailed.has(version) && skippedVersion() !== version;

const errMsg = (e: unknown) => String((e as Error)?.message || e);

// Whether this user can replace PzzaCode's app bundle. When they cannot,
// installing asks macOS for an administrator password, which a background
// install must never do. null: unknown (the check failed or is not available),
// and background installs go on as before.
async function bundleWritable(): Promise<boolean | null> {
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    const writable: unknown = await invoke("app_bundle_writable");
    return typeof writable === "boolean" ? writable : null;
  } catch {
    return null;
  }
}

export const useUpdates = create<UpdateState>((set, get) => {
  // automatic: started by a check or the switch, not by the user's Update.
  const installUpdate = async (automatic: boolean) => {
    const st = get().status;
    if (st.kind !== "available") return;
    const { update } = st;
    if (automatic) {
      if (await bundleWritable() === false) {
        // Not tried in the background again for this version; said once.
        autoInstallFailed.add(update.version);
        setSkippedVersion(update.version);
        notify({
          category: "app",
          title: `PzzaCode ${update.version} needs to be installed by hand`,
          body: "PzzaCode is in a folder this user cannot change, so updates are not installed in the background. Choose Update in the top bar and enter an administrator password when macOS asks, or install the new version from the release page.",
          target: { section: "general" },
          dedupeKey: `update-manual-install:${update.version}`,
        });
        return;
      }
      // The status may have moved on while the check ran (a manual Update started).
      if (get().status !== st) return;
    }
    set({ status: { kind: "installing", update, pct: 0 } });
    try {
      await update.install((pct) => set({ status: { kind: "installing", update, pct } }));
      setSkippedVersion(null);
      autoInstallFailed.delete(update.version);
      set({ status: { kind: "ready", update }, dismissed: null });
    } catch (e) {
      if (!automatic) {
        set({ status: { kind: "error", msg: errMsg(e) } });
        return;
      }
      // Leave the update available for the user's own Update, and say so once.
      autoInstallFailed.add(update.version);
      setSkippedVersion(update.version);
      set({ status: { kind: "available", update } });
      notify({
        category: "app",
        title: `PzzaCode ${update.version} was not installed`,
        body: `The background install did not finish (${errMsg(e)}). It is not tried in the background again. Choose Update in the top bar to install it yourself; if PzzaCode is in a folder you cannot change, install the new version from the release page instead.`,
        target: { section: "general" },
        dedupeKey: `update-auto-install:${update.version}`,
      });
    }
  };
  return {
    status: { kind: "idle" },
    autoUpdate: loadAuto(),
    dismissed: null,
    setAutoUpdate: (v) => {
      try {
        localStorage.setItem(AUTO_KEY, String(v));
      } catch {
        /* ignore */
      }
      set({ autoUpdate: v });
      // Turning it on with an update already waiting installs it right away.
      const status = get().status;
      if (v && status.kind === "available" && mayInstallInBackground(status.update.version)) void installUpdate(true);
    },
    check: async (manual = false, installAutomatically = true) => {
      if (!HAS_TAURI) return;
      const { kind } = get().status;
      if (kind === "checking" || kind === "installing" || kind === "ready") return;
      set({ status: { kind: "checking" } });
      try {
        const update = await checkForUpdate();
        if (!update) {
          set({ status: { kind: "latest" } });
          return;
        }
        set({ status: { kind: "available", update } });
        if (installAutomatically && get().autoUpdate && mayInstallInBackground(update.version)) await installUpdate(true);
      } catch (e) {
        set({ status: manual ? { kind: "error", msg: errMsg(e) } : { kind: "idle" } });
      }
    },
    install: () => installUpdate(false),
    relaunch: async () => {
      const status = get().status;
      if (status.kind !== "ready" || status.restarting) return;
      set({ status: { ...status, restarting: true, error: undefined } });
      try {
        // A running local session refresh or restore finishes first.
        if (localSessionWorkRunning()) await whenLocalSessionWorkSettled();
        if (!await confirmUnsavedWork()) {
          set({ status: { ...status, restarting: false, error: undefined } });
          return;
        }
        window.dispatchEvent(new Event("pzza:quick-chat-cancel"));
        await relaunchApp();
      } catch (error) {
        set({ status: { ...status, restarting: false, error: errMsg(error) } });
      }
    },
    dismiss: () => {
      const st = get().status;
      if (st.kind === "available" || st.kind === "ready") set({ dismissed: st.update.version });
    },
  };
});

let started = false;
// Start the background schedule (idempotent; called once from the app shell).
export function startUpdateChecks(): void {
  if (started || !HAS_TAURI) return;
  started = true;
  let last = Date.now();
  const run = () => {
    last = Date.now();
    void useUpdates.getState().check();
  };
  run();
  setInterval(run, RECHECK_MS);
  window.addEventListener("focus", () => {
    if (Date.now() - last >= FOCUS_RECHECK_MS) run();
  });
  watchAgentRestartRequired();
}

// After a background update replaced the app on disk, the device agent is not
// started again from the newer files if it stops: until a restart, sessions,
// ports and the other panels that need it stay unreachable. Say so once.
let restartRequiredNoticed = false;
function noticeAgentRestartRequired(): void {
  if (restartRequiredNoticed) return;
  restartRequiredNoticed = true;
  notify({
    category: "app",
    title: "Restart PzzaCode to finish the update",
    body: "The device agent stopped after PzzaCode was updated, and it starts again with the new version only after a restart. Choose Restart to update in the top bar. Your terminal sessions keep running.",
    dedupeKey: "agent-restart-required",
  });
}

function watchAgentRestartRequired(): void {
  void import("@tauri-apps/api/core")
    .then(({ invoke }) => invoke<boolean>("agent_restart_required"))
    .then(required => { if (required === true) noticeAgentRestartRequired(); })
    .catch(() => { /* Older native side without the command: nothing to show. */ });
  void import("@tauri-apps/api/event")
    .then(({ listen }) => listen<boolean>("agent-restart-required", event => { if (event.payload === true) noticeAgentRestartRequired(); }))
    .catch(() => { /* Events unavailable outside the desktop app. */ });
}
