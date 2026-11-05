import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, ExternalLink, Loader2, LockOpen, RotateCcw, ShieldCheck, X } from "lucide-react";
import { AsyncButton } from "../ui/AsyncButton";
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

const STATUS_LABEL: Record<PermissionStatus, string> = {
  granted: "Allowed",
  notGranted: "Not allowed yet",
  denied: "Denied - change it in System Settings",
  unknown: "Not checked yet",
};

function StatusIcon({ status }: { status: PermissionStatus | undefined }) {
  if (!status) return <Loader2 size={15} className="sw-ic sw-spin" />;
  if (status === "granted") return <Check size={15} className="sw-ic sw-ok" />;
  if (status === "denied") return <X size={15} className="sw-ic sw-fail" />;
  return <AlertTriangle size={15} className="sw-ic sw-warn" />;
}

// One list for onboarding and Settings. Statuses refresh whenever the window
// regains focus, which is how the user comes back from System Settings.
export function PermissionsPanel() {
  const [statuses, setStatuses] = useState<Partial<Record<PermissionId, PermissionStatus>>>({});
  const [busy, setBusy] = useState<PermissionId | null>(null);
  const [error, setError] = useState("");
  // Grants made from here that only reach PzzaCode after a relaunch.
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
  const restartNeeded = restartFor.filter(id => statuses[id] === "granted");

  const group = (subject: "app" | "tmux") => <div className="sw-checks">
      {PERMISSIONS.filter(item => item.subject === subject).map(({ id, label, reason }) => {
        const status = statuses[id];
        return <div className="sw-row permissions-row" key={id}>
          <StatusIcon status={status} />
          <div className="sw-row-body">
            <div className="sw-row-label">{label}</div>
            <div className="sw-row-detail">{reason}</div>
            {status ? <div className={`sw-row-detail permissions-status permissions-${status}`}>{STATUS_LABEL[status]}</div> : null}
          </div>
          {status === "granted" || status === "denied" ? (
            <AsyncButton className="btn btn-sm permissions-action" icon={ExternalLink} loading={busy === id} disabled={busy !== null && busy !== id} onClick={() => run(id, () => openPermissionSettings(id))}>
              {status === "granted" ? "Manage" : "Open Settings"}
            </AsyncButton>
          ) : (
            <AsyncButton className="btn btn-sm btn-accent permissions-action" icon={LockOpen} loading={busy === id} disabled={!status || (busy !== null && busy !== id)} onClick={() => run(id, () => requestPermission(id))}>
              Allow
            </AsyncButton>
          )}
        </div>;
      })}
    </div>;

  return <div className="permissions-panel">
    <p className="sw-lead">
      <ShieldCheck size={14} className="permissions-lead-icon" aria-hidden="true" /> Grant these to both <b>PzzaCode</b> and <b>tmux</b> so every shell, agent and tool you start here has the access it needs.
    </p>
    <div className="sw-section-title permissions-group-title">PzzaCode</div>
    {group("app")}
    <div className="sw-section-title permissions-group-title">tmux</div>
    <p className="sw-row-detail permissions-group-note">macOS lists command-line tools only for these three. Microphone and Automation always go to PzzaCode, which starts tmux. A Homebrew upgrade moves tmux, so allow it again afterwards.</p>
    {group("tmux")}
    {error ? <p className="sw-row-hint" role="alert">{error}</p> : null}
    {restartNeeded.length ? <div className="permissions-restart" role="status">
      <span>Restart PzzaCode so {restartNeeded.map(id => PERMISSIONS.find(item => item.id === id)?.label).join(" and ")} applies. Terminals opened before the grant may need to be reopened.</span>
      <AsyncButton className="btn btn-sm" icon={RotateCcw} loading={restarting} onClick={restart}>Restart</AsyncButton>
    </div> : null}
  </div>;
}
