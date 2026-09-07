import { HAS_TAURI } from "./tauriEnv";
import { fetchDeviceOs } from "./serverApi";

export interface NativeTransparencyResult {
  blur: boolean;
  reason?: string;
}

let pending: Promise<void> = Promise.resolve();

async function applyTransparency(enabled: boolean): Promise<NativeTransparencyResult> {
  if (!HAS_TAURI) {
    return { blur: false, ...(enabled ? { reason: "Desktop blur is available in the desktop app on macOS and Windows." } : {}) };
  }
  try {
    const { Effect, EffectState, getCurrentWindow } = await import("@tauri-apps/api/window");
    const window = getCurrentWindow();
    if (!enabled) {
      await window.clearEffects();
      return { blur: false };
    }
    const os = await fetchDeviceOs("");
    if (os !== "macos" && os !== "windows") {
      return { blur: false, reason: "Desktop blur is unavailable on this operating system; translucent app surfaces remain available." };
    }
    await window.setEffects(os === "macos"
      ? { effects: [Effect.Sidebar], state: EffectState.Active }
      : { effects: [Effect.Acrylic] });
    return { blur: true };
  } catch (error) {
    return { blur: false, reason: `Could not apply desktop blur: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function setNativeTransparency(enabled: boolean): Promise<NativeTransparencyResult> {
  const result = pending.then(() => applyTransparency(enabled));
  pending = result.then(() => undefined);
  return result;
}
