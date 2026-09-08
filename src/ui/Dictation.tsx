import { Loader2, Mic, Square, X } from "lucide-react";
import { DICTATION_SUPPORTED, useDictation } from "../state/dictation";
import { useDelayedLoading } from "./useDelayedLoading";

export function DictationButton({ tileId, activate }: { tileId: string; activate: () => void }) {
  const enabled = useDictation((state) => state.enabled && state.model === "ready");
  const busy = useDictation((state) => state.recording !== null);
  const recording = useDictation((state) => state.recording?.tileId === tileId ? state.recording : null);
  const pending = !!recording && recording.phase !== "listening" && recording.phase !== "error";
  const showSpinner = useDelayedLoading(pending);
  if (!DICTATION_SUPPORTED || !enabled) return null;
  const listening = recording?.phase === "listening";
  const title = listening ? "Stop dictation and insert text" : "Start dictation";
  return <button type="button" className={`tile-btn ${recording ? "dictation-mic-on" : ""}`} title={title} aria-label={title}
    disabled={busy && !listening} aria-busy={pending} onMouseDown={(event) => event.stopPropagation()}
    onClick={(event) => {
      event.stopPropagation();
      if (listening) void useDictation.getState().stop();
      else { activate(); void useDictation.getState().start(tileId); }
    }}>
    {listening ? <Square size={12} /> : showSpinner ? <Loader2 size={13} className="async-spinner" /> : <Mic size={13} />}
  </button>;
}

export function DictationIndicator({ tileId }: { tileId: string }) {
  const recording = useDictation((state) => state.recording?.tileId === tileId ? state.recording : null);
  if (!recording) return null;
  const listening = recording.phase === "listening";
  const label = recording.phase === "loading" ? "Preparing microphone…" : listening ? "Listening on this Mac" : recording.phase === "error" ? "Dictation stopped" : "Finishing transcription…";
  return <div className="dictation-panel" onMouseDown={(event) => event.stopPropagation()}>
    <div className="dictation-panel-head">
      <span className="dictation-wave" aria-hidden="true">
        {[0.5, 0.8, 1, 0.7, 0.45].map((scale, index) => <i key={index} style={{ height: `${4 + recording.level * scale * 18}px` }} />)}
      </span>
      <span role="status">{label}</span>
      {listening ? <button type="button" className="btn btn-sm" onClick={() => void useDictation.getState().stop()}><Square size={11} /> Insert text</button> : null}
      <button type="button" className="tile-btn" aria-label={recording.phase === "error" ? "Dismiss dictation" : "Cancel dictation"} onClick={() => void useDictation.getState().cancel()}><X size={14} /></button>
    </div>
    {recording.text ? <p className="dictation-transcript" aria-live="polite">{recording.text}</p> : listening ? <p className="dictation-hint">Speak naturally. Text appears here, then goes into this terminal when you stop. Up to 5 minutes.</p> : null}
    {recording.error ? <p className="dictation-error" role="alert">{recording.error}</p> : null}
  </div>;
}
