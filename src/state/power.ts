import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { HAS_TAURI } from "../tauriEnv";

// Settings > General > Power: keep the Mac awake for running agents while
// PzzaCode is open (src-tauri/src/power.rs). The preference lives here and is
// sent to Rust on every launch; Rust holds nothing until it arrives, and
// macOS lets go of everything when the app exits.

export const POWER_SUPPORTED = HAS_TAURI && /mac/i.test(navigator.platform || navigator.userAgent);
const KEY = "pzza.keepAwake";

export interface KeepAwake {
  enabled: boolean;
  /** Keep holding on battery too (down to 20%), not only on the power adapter. */
  onBattery: boolean;
}

export type PowerHelper = "unsupported" | "unavailable" | "notInstalled" | "needsApproval" | "ready";

export interface PowerStatus {
  helper: PowerHelper;
  /** Idle sleep is held off. */
  awake: boolean;
  /** Sleep on lid close is held off. */
  lid: boolean;
  /** Why holding is paused right now, e.g. "On battery". */
  paused: string | null;
  error: string | null;
}

interface PowerState extends KeepAwake {
  status: PowerStatus | null;
  /** A failed request from Settings (installing the helper, opening Login Items). */
  actionError: string | null;
  installing: boolean;
  setKeepAwake: (patch: Partial<KeepAwake>) => Promise<void>;
  /** Re-sends the preference, which also picks up a helper approved meanwhile. */
  apply: () => Promise<void>;
  installHelper: () => Promise<void>;
  openLoginItems: () => Promise<void>;
}

const DEFAULTS: KeepAwake = { enabled: false, onBattery: false };

function load(): KeepAwake {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (value && typeof value === "object") {
      const saved = value as Partial<Record<keyof KeepAwake, unknown>>;
      return { enabled: saved.enabled === true, onBattery: saved.onBattery === true };
    }
  } catch {
    /* unreadable: defaults */
  }
  return DEFAULTS;
}

function save(value: KeepAwake) {
  try {
    localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    /* storage unavailable: applies for this session only */
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export const usePower = create<PowerState>()((set, get) => {
  // Calls are serialized so a quick on/off/on lands in order.
  let queue: Promise<void> = Promise.resolve();
  const send = () => {
    queue = queue.then(async () => {
      if (!POWER_SUPPORTED) return;
      const { enabled, onBattery } = get();
      try {
        const status = await invoke<PowerStatus>("power_keep_awake", { enabled, onBattery });
        set({ status });
      } catch (error) {
        set({ actionError: message(error) });
      }
    });
    return queue;
  };
  return {
    ...load(),
    status: null,
    actionError: null,
    installing: false,
    setKeepAwake: (patch) => {
      const next = { enabled: get().enabled, onBattery: get().onBattery, ...patch };
      save(next);
      set({ ...next, actionError: null });
      return send();
    },
    apply: send,
    installHelper: async () => {
      if (!POWER_SUPPORTED || get().installing) return;
      set({ installing: true, actionError: null });
      try {
        const status = await invoke<PowerStatus>("power_install_helper");
        set({ status });
      } catch (error) {
        set({ actionError: message(error) });
      } finally {
        set({ installing: false });
      }
    },
    openLoginItems: async () => {
      set({ actionError: null });
      try {
        await invoke("power_open_login_items");
      } catch (error) {
        set({ actionError: message(error) });
      }
    },
  };
});

/** Sends the saved preference at launch and again whenever the window comes
 *  back to the front (the user may have just approved the helper). */
export function initializePower(): () => void {
  if (!POWER_SUPPORTED) return () => {};
  const apply = () => { void usePower.getState().apply(); };
  apply();
  window.addEventListener("focus", apply);
  return () => window.removeEventListener("focus", apply);
}
