import { useEffect } from "react";
import { Download, Loader2, RotateCw, X } from "lucide-react";
import { startUpdateChecks, useUpdates } from "../state/updates";
import { HAS_TAURI } from "../tauriEnv";

// Slim bar under the top bar. With automatic updates on it only appears once
// the new version is installed and a restart is all that is left; with them
// off it offers the update and installs on click.
export function UpdateBanner() {
  const status = useUpdates((s) => s.status);
  const dismissed = useUpdates((s) => s.dismissed);
  const install = useUpdates((s) => s.install);
  const relaunch = useUpdates((s) => s.relaunch);
  const dismiss = useUpdates((s) => s.dismiss);

  useEffect(() => {
    startUpdateChecks();
  }, []);

  if (!HAS_TAURI) return null;
  if (status.kind !== "available" && status.kind !== "installing" && status.kind !== "ready") return null;
  if (dismissed === status.update.version) return null;
  const v = status.update.version;

  return (
    <div className="update-banner" role="status">
      <span className="update-text">
        {status.kind === "ready" ? (
          <>
            PzzaCode <b>{v}</b> is installed. Restart to finish updating.
          </>
        ) : (
          <>
            PzzaCode <b>{v}</b> is available (you have {status.update.currentVersion}).
          </>
        )}
      </span>
      {status.kind === "available" ? (
        <button className="btn btn-accent btn-sm" onClick={install}>
          <Download size={13} strokeWidth={2} />
          Update and restart
        </button>
      ) : status.kind === "installing" ? (
        <span className="update-progress">
          <Loader2 size={13} className="sw-spin" />
          {status.pct < 1 ? `Downloading ${Math.round(status.pct * 100)}%` : "Installing…"}
        </span>
      ) : (
        <button className="btn btn-accent btn-sm" onClick={relaunch}>
          <RotateCw size={13} strokeWidth={2} />
          Restart now
        </button>
      )}
      <button
        className="icon-btn update-dismiss"
        title="Not now"
        onClick={dismiss}
        disabled={status.kind === "installing"}
      >
        <X size={14} />
      </button>
    </div>
  );
}
