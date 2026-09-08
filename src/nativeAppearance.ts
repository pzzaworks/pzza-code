import { HAS_TAURI } from "./tauriEnv";

export interface NativeTransparencyResult {
  blur: boolean;
  reason?: string;
}

let pending: Promise<void> = Promise.resolve();

async function applyTransparency(enabled: boolean, radius: number, rounded: boolean): Promise<NativeTransparencyResult> {
  if (!HAS_TAURI) {
    return { blur: false, ...(enabled ? { reason: "Desktop blur is available in the desktop app on macOS and Windows." } : {}) };
  }
  try {
    const { Effect, getCurrentWindow } = await import("@tauri-apps/api/window");
    const window = getCurrentWindow();
    // Window effects belong to this client, never to the selected remote agent.
    const platform = navigator.platform || navigator.userAgent;
    const os = /mac/i.test(platform) ? "macos" : /win/i.test(platform) ? "windows" : "linux";
    if (os === "macos") {
      await window.setBackgroundColor("#00000000");
      await window.clearEffects();
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("set_desktop_blur", { radius: enabled ? radius : 0, rounded });
      return { blur: enabled && radius > 0 };
    } else {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      await getCurrentWebview().setBackgroundColor(enabled ? "#00000000" : null);
    }
    if (!enabled || radius === 0) {
      await window.clearEffects();
      return { blur: false };
    }
    if (os !== "windows") {
      return { blur: false, reason: "Desktop blur is unavailable on this operating system; translucent app surfaces remain available." };
    }
    await window.setEffects({ effects: [Effect.Acrylic] });
    return { blur: true };
  } catch (error) {
    return { blur: false, reason: `Could not apply desktop blur: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function setNativeTransparency(enabled: boolean, radius: number, rounded: boolean): Promise<NativeTransparencyResult> {
  const result = pending.then(() => applyTransparency(enabled, radius, rounded));
  pending = result.then(() => undefined);
  return result;
}
