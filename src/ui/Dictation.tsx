import { Mic, Square } from "lucide-react";
import { DICTATION_SUPPORTED, useDictation } from "../state/dictation";
import "./Dictation.css";

const WAVE_HEIGHTS = [0.4, 0.75, 1, 0.75, 0.4];

export function DictationButton({ tileId, activate }: { tileId: string; activate: () => void }) {
  const enabled = useDictation((state) => state.enabled && state.model === "ready");
  const busy = useDictation((state) => state.recording !== null);
  const recording = useDictation((state) => state.recording?.tileId === tileId ? state.recording : null);
  // Live decoding is not shown as busy: the level meter stays live while listening.
  const loading = recording?.phase === "loading";
  const finishing = recording?.phase === "finalizing";
  const pending = loading || finishing;
  if (!DICTATION_SUPPORTED || !enabled) return null;
  const failed = recording?.phase === "error";
  const active = !!recording && !failed;
  const title = failed ? `${recording.error ?? "Dictation failed."} Click to retry dictation.`
    : finishing ? "Finishing dictation. Click to cancel." : active ? "Stop dictation" : "Start dictation";
  const status = loading ? "Preparing microphone" : finishing ? "Finishing dictation" : recording?.voice ? "Hearing speech" : "Listening";
  const level = recording?.phase === "listening" ? recording.level : 0;
  return <button type="button" className={`tile-btn ${active ? "dictation-mic-on" : failed ? "dictation-mic-error" : ""}`} title={title} aria-label={title}
    disabled={busy && !recording} aria-busy={pending} aria-description={active ? status : undefined}
    onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
    onClick={(event) => {
      event.stopPropagation();
      if (active) void useDictation.getState().stop();
      else void (async () => {
        if (failed) await useDictation.getState().cancel();
        activate();
        await useDictation.getState().start(tileId);
      })();
    }}>
    {active ? <>
      <span className={`dictation-wave${loading ? " dictation-wave-processing" : finishing ? " dictation-wave-finishing" : ""}`} aria-hidden="true">
        {WAVE_HEIGHTS.map((height, index) => <span key={index} style={{ transform: `scaleY(${0.15 + level * height * 0.85})` }} />)}
      </span>
      <Square size={12} />
    </> : <Mic size={13} />}
  </button>;
}

