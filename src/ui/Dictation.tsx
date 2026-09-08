import { Copy, Loader2, Mic, Square, X } from "lucide-react";
import { DICTATION_SUPPORTED, useDictation } from "../state/dictation";
import { useEffect, useState, type CSSProperties } from "react";
import "./Dictation.css";
import { useDelayedLoading } from "./useDelayedLoading";

export function DictationButton({ tileId, activate }: { tileId: string; activate: () => void }) {
  const enabled = useDictation((state) => state.enabled && state.model === "ready");
  const busy = useDictation((state) => state.recording !== null);
  const recording = useDictation((state) => state.recording?.tileId === tileId ? state.recording : null);
  const pending = !!recording && recording.phase !== "listening" && recording.phase !== "error";
  const showSpinner = useDelayedLoading(pending);
  if (!DICTATION_SUPPORTED || !enabled) return null;
  const listening = recording?.phase === "listening";
  const title = listening ? "Stop dictation" : "Start dictation";
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

export function DictationPreview({ tileId, style }: { tileId: string; style: CSSProperties }) {
  const recording = useDictation((state) => state.recording?.tileId === tileId ? state.recording : null);
  const [copyStatus, setCopyStatus] = useState("");
  useEffect(() => { setCopyStatus(""); }, [recording?.id]);
  if (!recording) return null;
  const preview = recording.text.startsWith(recording.committed) ? recording.text.slice(recording.committed.length).trimStart() : recording.text;
  const listening = recording.phase === "listening";
  const label = recording.phase === "loading" ? "Preparing microphone…" : listening ? "Listening…" : recording.phase === "error" ? "Dictation stopped" : "Finishing…";
  return <div className={`dictation-caret ${recording.phase === "error" ? "dictation-caret-error" : ""}`} style={style} onMouseDown={event => event.stopPropagation()}>
    <div className="dictation-caret-text">
      <span role={recording.error ? "alert" : "status"}>{recording.error ?? (preview || label)}</span>
      {recording.error && recording.text && <>
        <p className="dictation-recovery-text">{recording.text}</p>
        <button type="button" className="btn btn-sm" onClick={() => {
          void navigator.clipboard?.writeText(recording.text).then(() => setCopyStatus("Copied. Check existing terminal input before pasting."), () => setCopyStatus("Copy failed. Select the transcript above to copy it manually."));
          if (!navigator.clipboard) setCopyStatus("Select the transcript above to copy it manually.");
        }}><Copy size={11} />Copy transcript</button>
        <small role="status">{copyStatus || "Check existing terminal input before pasting."}</small>
      </>}
    </div>
    {listening && <button type="button" className="tile-btn" aria-label="Stop dictation" onClick={() => void useDictation.getState().stop()}><Square size={11} /></button>}
    <button type="button" className="tile-btn" aria-label={recording.phase === "error" ? "Dismiss dictation error" : "Cancel dictation"} onClick={() => void useDictation.getState().cancel()}><X size={12} /></button>
  </div>;
}
