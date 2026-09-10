import { useEffect, useRef, useState } from "react";
import { initTerminalAppControlHandlers } from "./appControlTerminal";
import { initIntegrationAppControlHandlers } from "./appControlIntegrations";
import { initCoreAppControlHandlers } from "./appControlCore";
import { initDeviceAppControlHandlers } from "./appControlDevice";
import { initEditorAppControlHandlers } from "./appControlEditor";
import { useStore } from "./state/store";
import { executeAppControlRuntime, readAppControlRuntime, runAppControlExecution, finishAppControlReport, discardAppControlReport } from "./appControlRuntime";
import { hasIcon } from "./workspaceIcons";
import { HAS_TAURI } from "./tauriEnv";
import { hasUnsavedEditors } from "./editorChanges";
import { ALL_WORKSPACE_ID, DEFAULT_WORKSPACE_ID } from "./workspaces";
import { executeAppControl, type AppControlContext } from "./appControlCommands";
import { pollAppControl, registerAppControl, reportAppControl, unregisterAppControl, type AppControlOutcome } from "./serverApi";

function storedEnabled(): boolean {
  try { return localStorage.getItem("pzza.mcp.enabled") !== "0"; } catch { return false; }
}
const context: AppControlContext = {
  getState: useStore.getState,
  hasUnsavedEditor: (id) => hasUnsavedEditors([id]),
  defaultWorkspaceId: DEFAULT_WORKSPACE_ID,
  allWorkspaceId: ALL_WORKSPACE_ID,
  isWorkspaceIcon: hasIcon,
  executeRuntime: executeAppControlRuntime,
  readRuntime: readAppControlRuntime,
};

function pause(delay: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, delay);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });
}

export function useAppControl(): void {
  useEffect(() => {
    const cleanups = [initCoreAppControlHandlers(), initTerminalAppControlHandlers(), initDeviceAppControlHandlers(), initEditorAppControlHandlers(), initIntegrationAppControlHandlers()];
    return () => cleanups.forEach(cleanup => cleanup());
  }, []);
  const [enabled, setEnabled] = useState(storedEnabled);
  const [pageSession, setPageSession] = useState(0);
  const enabledRef = useRef(enabled);
  useEffect(() => {
    const update = (next: boolean) => { enabledRef.current = next; setEnabled(next); };
    const localChange = (event: Event) => {
      const detail: unknown = event instanceof CustomEvent ? event.detail : undefined;
      if (detail && typeof detail === "object" && "enabled" in detail && typeof detail.enabled === "boolean") update(detail.enabled);
      else update(storedEnabled());
    };
    const storageChange = (event: StorageEvent) => {
      if (event.key === "pzza.mcp.enabled" || event.key === null) update(storedEnabled());
    };
    const restored = (event: PageTransitionEvent) => { if (event.persisted) setPageSession((value) => value + 1); };
    window.addEventListener("pzza:mcp-enabled-changed", localChange);
    window.addEventListener("storage", storageChange);
    window.addEventListener("pageshow", restored);
    return () => {
      window.removeEventListener("pzza:mcp-enabled-changed", localChange);
      window.removeEventListener("storage", storageChange);
      window.removeEventListener("pageshow", restored);
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const clientId = crypto.randomUUID();
    const controller = new AbortController();
    const { signal } = controller;
    const completed = new Map<string, { outcome: AppControlOutcome; bytes: number }>();
    let completedBytes = 0;
    let registering: Promise<unknown> | undefined;
    const run = async () => {
      let registered = false;
      let retry = 250;
      while (!signal.aborted && enabledRef.current) {
        try {
          if (!registered) {
            registering = registerAppControl(clientId, HAS_TAURI ? "Desktop app" : `Browser (${location.hostname || "local"})`, signal);
            await registering;
            registering = undefined;
            registered = true;
          }
          if (signal.aborted || !enabledRef.current) break;
          const command = await pollAppControl(clientId, signal);
          if (signal.aborted || !enabledRef.current) break;
          retry = 250;
          if (!command) continue;
          let outcome = completed.get(command.id)?.outcome;
          if (!outcome) {
            try {
              if (Date.now() >= command.expiresAt) throw new Error("App control command expired before execution.");
              outcome = { result: await runAppControlExecution(command.id, () => executeAppControl(command.action, command.args, context)) };
            }
            catch (error) { outcome = { error: error instanceof Error ? error.message : "App control command failed." }; }
            const bytes = JSON.stringify(outcome).length * 2;
            completed.set(command.id, { outcome, bytes });
            completedBytes += bytes;
            // Bound retained result data as well as entry count so repeated
            // state snapshots cannot grow the UI's replay cache without limit.
            while (completed.size > 128 || completedBytes > 4 * 1024 * 1024) {
              const oldest = completed.entries().next().value;
              if (!oldest) break;
              completedBytes -= oldest[1].bytes;
              completed.delete(oldest[0]);
              discardAppControlReport(oldest[0]);
            }
          }
          await reportAppControl(clientId, command.id, outcome, signal);
          await finishAppControlReport(command.id);
        } catch {
          if (signal.aborted || !enabledRef.current) break;
          // A restarted agent has forgotten this client. Registration is
          // idempotent, and completed command IDs prevent accidental replay.
          registered = false;
          await pause(retry, signal);
          retry = Math.min(retry * 2, 10000);
        }
      }
    };
    void run();
    const stop = () => {
      controller.abort();
      for (const id of completed.keys()) discardAppControlReport(id);
      // Wait for an in-flight registration to settle before unregistering, so
      // teardown cannot leave a just-registered ghost client behind.
      void Promise.resolve(registering).catch(() => {}).then(() => unregisterAppControl(clientId)).catch(() => {});
    };
    window.addEventListener("pagehide", stop, { once: true });
    return () => { window.removeEventListener("pagehide", stop); stop(); };
  }, [enabled, pageSession]);
}
