import { Mic, Square } from "lucide-react";
import { DICTATION_SUPPORTED, useDictation } from "../state/dictation";
import "./Dictation.css";

export function DictationButton({ tileId, activate }: { tileId: string; activate: () => void }) {
  const enabled = useDictation((state) => state.enabled && state.model === "ready");
  const busy = useDictation((state) => state.recording !== null);
  const recording = useDictation((state) => state.recording?.tileId === tileId ? state.recording : null);
  const pending = !!recording && recording.phase !== "listening" && recording.phase !== "error";
  if (!DICTATION_SUPPORTED || !enabled) return null;
  const failed = recording?.phase === "error";
  const active = !!recording && !failed;
  const title = failed ? `${recording.error ?? "Dictation failed."} Click to retry dictation.`
    : recording?.phase === "finalizing" ? "Cancel dictation" : active ? "Stop dictation" : "Start dictation";
  return <button type="button" className={`tile-btn ${active ? "dictation-mic-on" : failed ? "dictation-mic-error" : ""}`} title={title} aria-label={title}
    disabled={busy && !recording} aria-busy={pending} onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
    onClick={(event) => {
      event.stopPropagation();
      if (active) void useDictation.getState().stop();
      else void (async () => {
        if (failed) await useDictation.getState().cancel();
        activate();
        await useDictation.getState().start(tileId);
      })();
    }}>
    {active ? <Square size={12} /> : <Mic size={13} />}
  </button>;
}
