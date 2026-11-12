import { useEffect } from "react";
import { Loader2, X } from "lucide-react";
import { checkPermissionsAtLaunch, dismissSessionRefreshNotice, localTileOnCanvas, useSessionRefresh } from "../state/sessionRefresh";
import { useStore } from "../state/store";
import "./SessionRefreshHost.css";

// Successful refreshes say so briefly; failures stay until dismissed.
const OK_NOTICE_MS = 6000;

/**
 * The non-blocking notice for local session refreshes and restores, wherever
 * they were started. It also reads permissions once after launch, so a grant
 * that needed a relaunch still refreshes the terminals.
 */
export function SessionRefreshHost() {
  const running = useSessionRefresh(state => state.running);
  const restoring = useSessionRefresh(state => state.restoring);
  const pending = useSessionRefresh(state => state.pending);
  const notice = useSessionRefresh(state => state.notice);
  // Local tiles on the canvas show "Refreshing session…" themselves and come
  // back on their own, so progress and success are only said here when none
  // of them is in view. Failures always are.
  const tileInView = useStore(localTileOnCanvas);
  useEffect(() => checkPermissionsAtLaunch(), []);
  useEffect(() => {
    if (notice?.tone !== "ok") return;
    const timer = window.setTimeout(dismissSessionRefreshNotice, OK_NOTICE_MS);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // The launch check is usually instant: it shows only what it restored.
  if (running && !pending && !tileInView) return <div className="session-refresh-notice" role="status">
    <Loader2 size={14} className="sw-spin" aria-hidden="true" />
    <span>{restoring ? "Restoring sessions…" : "Refreshing sessions…"}</span>
  </div>;
  if (!notice || (notice.tone === "ok" && tileInView)) return null;
  return <div className={`session-refresh-notice is-${notice.tone}`} role={notice.tone === "fail" ? "alert" : "status"}>
    <span>{notice.message}</span>
    <button type="button" className="session-refresh-dismiss" aria-label="Dismiss" onClick={dismissSessionRefreshNotice}>
      <X size={13} aria-hidden="true" />
    </button>
  </div>;
}
