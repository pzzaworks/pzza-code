import { Download, Loader2, RotateCw } from "lucide-react";
import { useUpdates } from "../state/updates";
import { HAS_TAURI } from "../tauriEnv";

// Beside the version in the top bar while an update needs something: Update
// (automatic updates off), the download progress, then Restart once the new
// version is installed. Hidden otherwise; checks run from the app shell.
export function UpdateButton() {
  const status = useUpdates((s) => s.status);
  const install = useUpdates((s) => s.install);
  const relaunch = useUpdates((s) => s.relaunch);
  if (!HAS_TAURI) return null;

  if (status.kind === "available") {
    const { version, currentVersion } = status.update;
    return <button type="button" className="update-button" onClick={() => void install()}
      title={`PzzaCode ${version} is available (you have ${currentVersion}). Download and install it.`}>
      <Download size={12} strokeWidth={2.2} aria-hidden="true" />Update
    </button>;
  }
  if (status.kind === "installing") {
    const label = status.pct < 1 ? `${Math.round(status.pct * 100)}%` : "Installing";
    return <span className="update-button update-button-busy" role="status" title={`Downloading PzzaCode ${status.update.version}`}>
      <Loader2 size={12} className="sw-spin" aria-hidden="true" />{label}
    </span>;
  }
  if (status.kind === "ready") {
    const title = status.error ?? `PzzaCode ${status.update.version} is installed. Restart to finish updating.`;
    return <button type="button" className="update-button update-button-ready" onClick={() => void relaunch()} disabled={status.restarting} title={title}>
      <RotateCw size={12} strokeWidth={2.2} aria-hidden="true" />{status.restarting ? "Restarting" : "Restart"}
    </button>;
  }
  return null;
}
