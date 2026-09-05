import { create } from "zustand";
import { checkForUpdate, relaunchApp, type AvailableUpdate } from "../updater";
import { HAS_TAURI } from "../tauriEnv";

// In-app update state shared by the banner and Settings. Checks run on launch,
// hourly, and when the window regains focus; with automatic updates on (the
// default) a new release is downloaded and installed in the background and
// only the restart is left to the user.

const AUTO_KEY = "pzza.autoUpdate";
const RECHECK_MS = 60 * 60 * 1000;
const FOCUS_RECHECK_MS = 15 * 60 * 1000;

export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "latest" }
  | { kind: "available"; update: AvailableUpdate }
  | { kind: "installing"; update: AvailableUpdate; pct: number }
  | { kind: "ready"; update: AvailableUpdate }
  | { kind: "error"; msg: string };

interface UpdateState {
  status: UpdateStatus;
  autoUpdate: boolean;
  dismissed: string | null; // version whose banner was closed this session
  setAutoUpdate: (v: boolean) => void;
  // manual = surfaced to the user (Settings); background failures stay quiet.
  check: (manual?: boolean) => Promise<void>;
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

const errMsg = (e: unknown) => String((e as Error)?.message || e);

export const useUpdates = create<UpdateState>((set, get) => ({
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
    if (v && get().status.kind === "available") void get().install();
  },
  check: async (manual = false) => {
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
      if (get().autoUpdate) await get().install();
    } catch (e) {
      set({ status: manual ? { kind: "error", msg: errMsg(e) } : { kind: "idle" } });
    }
  },
  install: async () => {
    const st = get().status;
    if (st.kind !== "available") return;
    const { update } = st;
    set({ status: { kind: "installing", update, pct: 0 } });
    try {
      await update.install((pct) => set({ status: { kind: "installing", update, pct } }));
      set({ status: { kind: "ready", update }, dismissed: null });
    } catch (e) {
      set({ status: { kind: "error", msg: errMsg(e) } });
    }
  },
  relaunch: () => relaunchApp(),
  dismiss: () => {
    const st = get().status;
    if (st.kind === "available" || st.kind === "ready") set({ dismissed: st.update.version });
  },
}));

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
}
