import { useCallback, useEffect, useRef, useState } from "react";
import { relaunchApp } from "../updater";
import { hasUnsavedWork } from "../state/unsavedWork";
import { observePermissionStatuses } from "../state/sessionRefresh";
import {
  PERMISSIONS,
  openPermissionSettings,
  permissionStatuses,
  requestPermission,
  type PermissionId,
  type PermissionInfo,
  type PermissionStatus,
} from "../state/permissions";
import { refreshSetup, useSetup } from "../state/setup";
import { visibleInterval } from "../visibility";

// While a permissions view is open, statuses are read again this often, and
// faster while Allow all waits for a grant in System Settings.
const POLL_MS = 4000;
const GUIDE_POLL_MS = 1500;

export interface PermissionGuide {
  /** The permission being granted now. */
  current: PermissionId;
  /** Position of `current` (1-based) and how many the guide covers. */
  step: number;
  total: number;
}

export interface PermissionControls {
  statuses: Partial<Record<PermissionId, PermissionStatus>>;
  /** tmux is not installed yet, so macOS has nothing to grant its permissions to. */
  tmuxMissing: boolean;
  /** Whether Allow can act on this permission now: not granted yet, and its subject exists. */
  actionable: (item: PermissionInfo) => boolean;
  busy: PermissionId | null;
  error: string;
  /** Asks macOS for the permission: the system prompt, or the right Settings page. */
  allow: (id: PermissionId) => void;
  openSettings: (id: PermissionId) => void;
  /** Grants made here that reach PzzaCode only after a relaunch. */
  restartNeeded: readonly PermissionId[];
  restarting: boolean;
  restart: () => void;
  /** Allow all: one permission at a time, moving on as soon as it is granted. */
  guide: PermissionGuide | null;
  startGuide: (subject?: "app" | "tmux") => void;
  skipGuide: () => void;
  stopGuide: () => void;
  /** Opens the current guide step's System Settings pane (and Finder for tmux) again. */
  repeatGuide: () => void;
}

// Permission statuses and actions, shared by Settings and onboarding. Statuses
// refresh whenever the window regains focus, which is how the user comes back
// from System Settings, and periodically while the view is open.
export function usePermissionControls(): PermissionControls {
  const [statuses, setStatuses] = useState<Partial<Record<PermissionId, PermissionStatus>>>({});
  const [busy, setBusy] = useState<PermissionId | null>(null);
  const [error, setError] = useState("");
  const [restartFor, setRestartFor] = useState<readonly PermissionId[]>([]);
  const [restarting, setRestarting] = useState(false);
  const [queue, setQueue] = useState<{ ids: readonly PermissionId[]; index: number } | null>(null);
  // Known only once setup has read this Mac; until then tmux rows act as before.
  const tmuxMissing = useSetup(state => !!state.status && !state.status.tmux);

  const refresh = useCallback(() => {
    // While tmux is missing (or not looked for yet), look again with every
    // status read, so its permissions open as soon as it is installed.
    if (!useSetup.getState().status?.tmux) void refreshSetup();
    return permissionStatuses()
      .then(next => { setStatuses(next); setError(""); observePermissionStatuses(next); })
      .catch(() => setError("Permission status could not be read. Reopen this page to try again."));
  }, []);
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
  const guiding = queue !== null;
  useEffect(() => {
    // Returning to the window refreshes already (above).
    return visibleInterval(() => void refresh(), guiding ? GUIDE_POLL_MS : POLL_MS, { catchUp: false });
  }, [refresh, guiding]);

  const run = (id: PermissionId, action: () => Promise<unknown>) => {
    setBusy(id);
    setError("");
    if (PERMISSIONS.find(item => item.id === id)?.needsRestart) setRestartFor(current => current.includes(id) ? current : [...current, id]);
    void action()
      .catch(() => setError("System Settings could not be opened. Open it from the Apple menu > System Settings > Privacy & Security."))
      .finally(() => { setBusy(null); void refresh(); });
  };
  const allow = (id: PermissionId) => run(id, () => requestPermission(id));
  const openSettings = (id: PermissionId) => run(id, () => openPermissionSettings(id));
  // A denied permission changes only in System Settings; the rest may still prompt.
  const ask = (id: PermissionId) => (statuses[id] === "denied" ? openSettings(id) : allow(id));
  const askRef = useRef(ask);
  askRef.current = ask;

  // Moves to the next permission in the guide that is still not granted, and
  // asks for it; ends the guide after the last one.
  const advance = useCallback((from: number, ids: readonly PermissionId[], current: Partial<Record<PermissionId, PermissionStatus>>) => {
    let index = from;
    while (index < ids.length && current[ids[index]] === "granted") index++;
    if (index >= ids.length) {
      setQueue(null);
      return;
    }
    setQueue({ ids, index });
    askRef.current(ids[index]);
  }, []);
  const statusesRef = useRef(statuses);
  statusesRef.current = statuses;
  useEffect(() => {
    if (queue && statuses[queue.ids[queue.index]] === "granted") advance(queue.index + 1, queue.ids, statuses);
  }, [queue, statuses, advance]);

  const restart = () => {
    if (hasUnsavedWork()) {
      setError("Save or discard your editor and settings drafts, then restart.");
      return;
    }
    setRestarting(true);
    relaunchApp().catch(() => { setRestarting(false); setError("PzzaCode could not restart. Quit and reopen it to apply the change."); });
  };
  const actionable = (item: PermissionInfo) => statuses[item.id] !== undefined && statuses[item.id] !== "granted"
    && !(item.subject === "tmux" && tmuxMissing);
  return {
    statuses, tmuxMissing, actionable, busy, error, restarting, restart, allow, openSettings,
    restartNeeded: restartFor.filter(id => statuses[id] === "granted"),
    guide: queue ? { current: queue.ids[queue.index], step: queue.index + 1, total: queue.ids.length } : null,
    startGuide: subject => {
      const ids = PERMISSIONS.filter(item => (!subject || item.subject === subject) && actionable(item)).map(item => item.id);
      if (ids.length) advance(0, ids, statusesRef.current);
    },
    skipGuide: () => { if (queue) advance(queue.index + 1, queue.ids, statusesRef.current); },
    stopGuide: () => setQueue(null),
    repeatGuide: () => { if (queue) ask(queue.ids[queue.index]); },
  };
}

export function restartMessage(ids: readonly PermissionId[]): string {
  return `Restart PzzaCode so ${ids.map(id => PERMISSIONS.find(item => item.id === id)?.label).join(" and ")} also applies to the app itself. New terminals get it right away; running ones after Refresh sessions.`;
}
