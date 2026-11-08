import { useCallback, useEffect, useState } from "react";
import { relaunchApp } from "../updater";
import { hasUnsavedWork } from "../state/unsavedWork";
import {
  PERMISSIONS,
  openPermissionSettings,
  permissionStatuses,
  requestPermission,
  type PermissionId,
  type PermissionStatus,
} from "../state/permissions";

export interface PermissionControls {
  statuses: Partial<Record<PermissionId, PermissionStatus>>;
  busy: PermissionId | null;
  error: string;
  /** Asks macOS for the permission: the system prompt, or the right Settings page. */
  allow: (id: PermissionId) => void;
  openSettings: (id: PermissionId) => void;
  /** Grants made here that reach PzzaCode only after a relaunch. */
  restartNeeded: readonly PermissionId[];
  restarting: boolean;
  restart: () => void;
}

// Permission statuses and actions, shared by Settings and onboarding. Statuses
// refresh whenever the window regains focus, which is how the user comes back
// from System Settings.
export function usePermissionControls(): PermissionControls {
  const [statuses, setStatuses] = useState<Partial<Record<PermissionId, PermissionStatus>>>({});
  const [busy, setBusy] = useState<PermissionId | null>(null);
  const [error, setError] = useState("");
  const [restartFor, setRestartFor] = useState<readonly PermissionId[]>([]);
  const [restarting, setRestarting] = useState(false);

  const refresh = useCallback(() => permissionStatuses()
    .then(next => { setStatuses(next); setError(""); })
    .catch(() => setError("Permission status could not be read. Reopen this page to try again.")), []);
  useEffect(() => {
    void refresh();
    const onReturn = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [refresh]);

  const run = (id: PermissionId, action: () => Promise<unknown>) => {
    setBusy(id);
    setError("");
    if (PERMISSIONS.find(item => item.id === id)?.needsRestart) setRestartFor(current => current.includes(id) ? current : [...current, id]);
    void action()
      .catch(() => setError("System Settings could not be opened. Open it from the Apple menu > System Settings > Privacy & Security."))
      .finally(() => { setBusy(null); void refresh(); });
  };
  const restart = () => {
    if (hasUnsavedWork()) {
      setError("Save or discard your editor and settings drafts, then restart.");
      return;
    }
    setRestarting(true);
    relaunchApp().catch(() => { setRestarting(false); setError("PzzaCode could not restart. Quit and reopen it to apply the change."); });
  };
  return {
    statuses, busy, error, restarting, restart,
    allow: id => run(id, () => requestPermission(id)),
    openSettings: id => run(id, () => openPermissionSettings(id)),
    restartNeeded: restartFor.filter(id => statuses[id] === "granted"),
  };
}

export function restartMessage(ids: readonly PermissionId[]): string {
  return `Restart PzzaCode so ${ids.map(id => PERMISSIONS.find(item => item.id === id)?.label).join(" and ")} applies. Terminals opened before the grant may need to be reopened.`;
}

