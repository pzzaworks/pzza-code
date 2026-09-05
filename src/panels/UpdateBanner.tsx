import { useEffect, useState } from "react";
import { Download, Loader2, X } from "lucide-react";
import { checkForUpdate, relaunchApp, type AvailableUpdate } from "../updater";
import { HAS_TAURI } from "../tauriEnv";

const RECHECK_MS = 6 * 60 * 60 * 1000;

// Quiet startup update check. Shows a slim bar under the top bar when a newer
// release is published; one click downloads, installs and relaunches.
export function UpdateBanner() {
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!HAS_TAURI) return;
    let alive = true;
    const run = () =>
      checkForUpdate()
        .then((u) => alive && setUpdate(u))
        .catch(() => undefined); // offline / rate-limited: stay quiet
    run();
    const id = setInterval(run, RECHECK_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, []);

  if (!update || dismissed === update.version) return null;

  const install = async () => {
    setError(null);
    setProgress(0);
    try {
      await update.install(setProgress);
      await relaunchApp();
    } catch (e) {
      setError(String((e as Error)?.message || e));
      setProgress(null);
    }
  };

  return (
    <div className="update-banner" role="status">
      <span className="update-text">
        PzzaCode <b>{update.version}</b> is available (you have {update.currentVersion}).
      </span>
      {error ? <span className="update-err">{error}</span> : null}
      {progress === null ? (
        <button className="btn btn-accent btn-sm" onClick={install}>
          <Download size={13} strokeWidth={2} />
          Update and relaunch
        </button>
      ) : (
        <span className="update-progress">
          <Loader2 size={13} className="sw-spin" />
          {progress < 1 ? `Downloading ${Math.round(progress * 100)}%` : "Installing…"}
        </span>
      )}
      <button
        className="icon-btn update-dismiss"
        title="Not now"
        onClick={() => setDismissed(update.version)}
        disabled={progress !== null}
      >
        <X size={14} />
      </button>
    </div>
  );
}
