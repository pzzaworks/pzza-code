// Modifier-key triggers for dictation push to talk (Option), kept generic
// for any modifier key. Two modes:
// - hold: the capture runs while the key is held on its own past HOLD_MS.
// - tap: a short press on its own starts it, another tap stops it.
// A trigger key used in a shortcut never fires: any other key while it is
// down, or right after a tap, cancels.
export type TriggerMode = "hold" | "tap";
export const TRIGGER_HOLD_MS = 250;
/** A longer press is not a tap. */
export const TAP_MAX_MS = 400;
/** A key pressed this soon after a tap still cancels it, like a shortcut. */
export const TAP_SETTLE_MS = 200;

type Modifier = "altKey" | "metaKey" | "ctrlKey" | "shiftKey";
export interface KeyTriggerOptions {
  /** KeyboardEvent.code values of the trigger key. */
  codes: readonly string[];
  /** The modifier flag the trigger key itself sets. */
  modifier: Modifier;
  mode(): TriggerMode;
  enabled(): boolean;
  /** Whether this trigger's capture runs now; it can also end on its own. */
  active(): boolean;
  begin(): void;
  release(): void;
  cancel(): void;
  /** What leaving the window does to a running capture. */
  onBlur: "release" | "cancel";
}

// Installs the window-level key listeners; returns the cleanup.
export function initializeKeyTrigger(options: KeyTriggerOptions): () => void {
  const others = (["altKey", "metaKey", "ctrlKey", "shiftKey"] as const).filter(flag => flag !== options.modifier);
  let holdTimer: ReturnType<typeof setTimeout> | undefined;
  let tapTimer: ReturnType<typeof setTimeout> | undefined;
  let pressedAt: number | null = null;
  let shortcut = false;
  let holding = false;

  const clearHold = () => { clearTimeout(holdTimer); holdTimer = undefined; };
  const clearTap = () => { clearTimeout(tapTimer); tapTimer = undefined; };

  const onKeyDown = (event: KeyboardEvent) => {
    if (options.codes.includes(event.code)) {
      if (event.repeat || pressedAt !== null) return;
      // A second tap inside the settle window is not a toggle.
      if (tapTimer !== undefined) { clearTap(); return; }
      if (others.some(flag => event[flag]) || !options.enabled()) return;
      pressedAt = Date.now();
      shortcut = false;
      if (options.mode() === "hold" && !options.active()) {
        holdTimer = setTimeout(() => { holdTimer = undefined; holding = true; options.begin(); }, TRIGGER_HOLD_MS);
      }
      return;
    }
    // Any other key: the trigger is part of a shortcut, or a tap is being
    // followed by typing. Neither starts or stops a capture.
    if (pressedAt !== null) shortcut = true;
    clearHold();
    clearTap();
    if (holding) {
      holding = false;
      options.cancel();
    } else if (options.mode() === "tap" && options.active() && (pressedAt !== null || event.key === "Escape")) {
      options.cancel();
    }
  };

  const onKeyUp = (event: KeyboardEvent) => {
    if (!options.codes.includes(event.code)) return;
    const pressed = pressedAt;
    pressedAt = null;
    clearHold();
    if (holding) {
      holding = false;
      options.release();
      return;
    }
    if (options.mode() !== "tap" || pressed === null || shortcut || Date.now() - pressed > TAP_MAX_MS || !options.enabled()) return;
    tapTimer = setTimeout(() => {
      tapTimer = undefined;
      if (options.active()) options.release(); else options.begin();
    }, TAP_SETTLE_MS);
  };

  const onBlur = () => {
    clearHold();
    clearTap();
    pressedAt = null;
    const running = holding || (options.mode() === "tap" && options.active());
    holding = false;
    if (running) (options.onBlur === "release" ? options.release : options.cancel)();
  };

  window.addEventListener("keydown", onKeyDown, true);
  window.addEventListener("keyup", onKeyUp, true);
  window.addEventListener("blur", onBlur);
  return () => {
    window.removeEventListener("keydown", onKeyDown, true);
    window.removeEventListener("keyup", onKeyUp, true);
    window.removeEventListener("blur", onBlur);
    clearHold();
    clearTap();
    if (holding) { holding = false; options.cancel(); }
  };
}

export interface SilenceStopOptions {
  /** Input level (0 to 1) that counts as speech. */
  speech: number;
  /** Speech needed before silence can end the capture. */
  minSpeechMs: number;
  /** Quiet time after speech that ends the capture. */
  silenceMs: number;
  /** Longest capture. */
  maxMs: number;
}
export const SILENCE_STOP_DEFAULTS: SilenceStopOptions = { speech: 0.08, minSpeechMs: 150, silenceMs: 1500, maxMs: 30_000 };

// Ends a tap-started capture once speech was heard and then ~1.5 seconds pass
// in silence, or at the maximum length. Fed with the microphone level events.
export class SilenceStop {
  private readonly options: SilenceStopOptions;
  private started: number | null = null;
  private last = 0;
  private voicedMs = 0;
  private lastVoiced = 0;
  constructor(options: Partial<SilenceStopOptions> = {}) {
    this.options = { ...SILENCE_STOP_DEFAULTS, ...options };
  }
  /** Returns true when the capture should stop. */
  push(level: number, now: number): boolean {
    if (this.started === null) { this.started = now; this.last = now; this.lastVoiced = now; }
    const elapsed = Math.min(Math.max(0, now - this.last), 250);
    this.last = now;
    if (level >= this.options.speech) { this.voicedMs += elapsed; this.lastVoiced = now; }
    if (now - this.started >= this.options.maxMs) return true;
    return this.voicedMs >= this.options.minSpeechMs && now - this.lastVoiced >= this.options.silenceMs;
  }
}
