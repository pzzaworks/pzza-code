import { HAS_TAURI } from "./tauriEnv";

// In-app updates. The Tauri updater plugin fetches latest.json from the GitHub
// release, verifies the artifact's minisign signature against the public key
// baked into the app, downloads and installs it, then we relaunch. Everything
// is a no-op in the browser build.

export interface AvailableUpdate {
  version: string;
  currentVersion: string;
  body?: string;
  date?: string;
  // Download + install, reporting progress in [0, 1]; resolves when installed.
  install: (onProgress?: (fraction: number) => void) => Promise<void>;
}

export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  if (!HAS_TAURI) return null;
  const { check } = await import("@tauri-apps/plugin-updater");
  const update = await check();
  if (!update) return null;
  return {
    version: update.version,
    currentVersion: update.currentVersion,
    body: update.body ?? undefined,
    date: update.date ?? undefined,
    install: async (onProgress) => {
      let total = 0;
      let got = 0;
      await update.downloadAndInstall((ev) => {
        if (ev.event === "Started") total = ev.data.contentLength ?? 0;
        else if (ev.event === "Progress") {
          got += ev.data.chunkLength;
          if (total > 0) onProgress?.(Math.min(1, got / total));
        } else if (ev.event === "Finished") onProgress?.(1);
      });
    },
  };
}

export async function relaunchApp(): Promise<void> {
  if (!HAS_TAURI) return;
  const { relaunch } = await import("@tauri-apps/plugin-process");
  await relaunch();
}
