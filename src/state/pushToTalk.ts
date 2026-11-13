import { create } from "zustand";
import { DICTATION_SUPPORTED, useDictation } from "./dictation";
import { sessionTileById, useStore } from "./store";
import { initializeKeyTrigger, SilenceStop, TRIGGER_HOLD_MS, type TriggerMode } from "./keyTrigger";

// Push to talk: either Option key on its own dictates into the active
// terminal. Hold mode (default) records while the key is held past HOLD_MS;
// tap mode starts on a tap and stops on the next tap or after a pause in
// speech. Option+key typing never starts a recording, and one already
// started by the hold is discarded.
export const PUSH_TO_TALK_HOLD_MS = TRIGGER_HOLD_MS;
const KEY = "pzza.dictation.pushToTalk";
const MODE_KEY = "pzza.dictation.pushToTalkMode";
// Dictation can run longer than a command; tap mode still ends on its own.
const TAP_MAX_MS = 120_000;

function load(): boolean {
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch {
    return true;
  }
}
function loadMode(): TriggerMode {
  try {
    return localStorage.getItem(MODE_KEY) === "tap" ? "tap" : "hold";
  } catch {
    return "hold";
  }
}

export const usePushToTalk = create<{ enabled: boolean; mode: TriggerMode }>(() => ({ enabled: load(), mode: loadMode() }));

export function setPushToTalk(enabled: boolean): void {
  try {
    localStorage.setItem(KEY, enabled ? "1" : "0");
  } catch {
    /* preferences are optional */
  }
  usePushToTalk.setState({ enabled });
}

export function setPushToTalkMode(mode: TriggerMode): void {
  try {
    localStorage.setItem(MODE_KEY, mode);
  } catch {
    /* preferences are optional */
  }
  usePushToTalk.setState({ mode });
}

// Install the window-level key listeners; returns the cleanup.
export function initializePushToTalk(supported = DICTATION_SUPPORTED): () => void {
  // The tile a push-to-talk recording was started for.
  let owned: string | null = null;
  let silence: SilenceStop | null = null;
  const mine = () => owned !== null && useDictation.getState().recording?.tileId === owned;
  const finish = (cancel: boolean) => {
    const tileId = owned;
    owned = null;
    silence = null;
    // Only end the recording this trigger started; a click-started one is left
    // alone. One that failed (the tile waits on an approval prompt, say) stays
    // as it is, so its microphone button keeps showing why.
    const recording = useDictation.getState().recording;
    if (tileId && recording?.tileId === tileId && recording.phase !== "error") void (cancel ? useDictation.getState().cancel() : useDictation.getState().stop());
  };
  const stopTrigger = initializeKeyTrigger({
    codes: ["AltLeft", "AltRight"],
    modifier: "altKey",
    mode: () => usePushToTalk.getState().mode,
    enabled: () => supported && usePushToTalk.getState().enabled,
    active: mine,
    begin: () => {
      const dictation = useDictation.getState();
      // A failed recording only shows its error: a new hold retries, as a click on its button does.
      const failed = dictation.recording?.phase === "error";
      if (!dictation.enabled || dictation.model !== "ready" || (dictation.recording && !failed)) return;
      // A focused field that takes dictation (the broadcast composer) is the
      // target; otherwise the active tile is.
      const focused = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>("[data-dictation-target]")?.dataset.dictationTarget : undefined;
      const tileId = focused ?? useStore.getState().activeId;
      // A file tile has no terminal to dictate into.
      if (!tileId || (!focused && !sessionTileById(useStore.getState().tiles, tileId))) return;
      owned = tileId;
      silence = usePushToTalk.getState().mode === "tap" ? new SilenceStop({ maxMs: TAP_MAX_MS }) : null;
      // Push to talk keeps its own ending: the key release, or tap mode's pause.
      void (async () => {
        if (failed) await dictation.cancel();
        await useDictation.getState().start(tileId, { silenceStop: false });
      })();
    },
    release: () => finish(false),
    cancel: () => finish(true),
    // Switching windows can swallow the keyup; treat it as a release.
    onBlur: "release",
  });
  // A tap-started recording stops itself after a pause in speech.
  const stopSilence = useDictation.subscribe(state => {
    const recording = state.recording;
    if (!silence || !owned || recording?.tileId !== owned || recording.phase !== "listening") return;
    if (silence.push(recording.level, Date.now())) finish(false);
  });
  return () => {
    stopTrigger();
    stopSilence();
    finish(false);
  };
}
