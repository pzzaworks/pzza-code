// Keeps typed input out of tmux pane modes. With `mouse on` (a common
// tmux.conf setting) a wheel-up or a drag over a pane puts it in copy-mode,
// and while a mode is active tmux hands every key to the mode, so typing
// would move a copy cursor instead of reaching the program. The gate tracks
// when the pane may be in a mode (a wheel-up or drag it forwarded, or a fresh
// attachment) and, before the next typed input, leaves the mode once and then
// delivers that input and everything after it in order.

export type InputKind = "typing" | "mode-entry" | "passthrough";
/**
 * Who sent the input: the user's own keyboard, mouse or paste in the tile
 * ("keyboard"), or the app on the user's behalf ("app": an approval answer,
 * an app-control key, the Enter that submits a broadcast). Only a keystroke
 * can be the habit of leaving the scrollback, so only it is ever held back.
 */
export type InputOrigin = "keyboard" | "app";

const SGR_MOUSE = /\x1b\[<(\d+);\d+;\d+([Mm])/g;
const SGR_MOUSE_ONLY = /^(?:\x1b\[<\d+;\d+;\d+[Mm])+$/;
// Focus reports and the terminal's answers to queries (device attributes,
// mode and status reports, window sizes, OSC colors, DCS). Keys never
// produce these, so they pass without leaving a mode.
const TERMINAL_REPORTS = /^(?:\x1b\[[IO]|\x1b\[[?>][\d;]*[cnR]|\x1b\[0n|\x1b\[\??[\d;]*\$y|\x1b\[\d+(?:;\d+)*t|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\)+$/;

// SGR mouse buttons: low bits pick the button (3 means none), 4/8/16 are
// shift/meta/ctrl, 32 marks motion and 64 the wheel.
function entersMode(button: number): boolean {
  const code = button & ~(4 | 8 | 16);
  if (code === 64) return true; // wheel up
  return (code & 32) !== 0 && (code & 64) === 0 && (code & 3) !== 3; // drag with a button held
}

export function classifyInput(data: string): InputKind {
  if (SGR_MOUSE_ONLY.test(data)) {
    for (const [, button, final] of data.matchAll(SGR_MOUSE)) {
      if (final === "M" && entersMode(Number(button))) return "mode-entry";
    }
    return "passthrough";
  }
  return TERMINAL_REPORTS.test(data) ? "passthrough" : "typing";
}

export interface PaneModeGate {
  /** Delivers input in order, leaving a pane mode first when typed input needs it. */
  send(data: string, origin: InputOrigin): Promise<void>;
  /** The pane may be in a mode (a new attachment): the next typed input leaves it first. */
  mark(): void;
  /** Marks so far; pass to settle() with a probe started now. */
  generation(): number;
  /** A probe started at `generation` found the pane in a mode or not. */
  settle(generation: number, inMode: boolean): void;
  /** Whether typed input would leave a mode first. */
  mayBeInMode(): boolean;
  /** The attachment ended: queued input is rejected and never reaches a later one. */
  reset(reason: Error): void;
}

interface Pending {
  data: string;
  kind: InputKind;
  origin: InputOrigin;
  resolve: (written: Promise<void>) => void;
  reject: (error: Error) => void;
}

// Keys that only leave a mode when they are what found it active (see pump).
const LEAVE_KEYS: ReadonlySet<string> = new Set(["\x1b", "\x03"]);

export function createPaneModeGate({ write, leave }: {
  write: (data: string) => Promise<void>;
  leave: () => Promise<void>;
}): PaneModeGate {
  let inMode = false;
  // The user is known to be in a scrollback: their own wheel-up or drag
  // entered the mode, or a probe found the pane in one. A fresh attachment
  // alone only may have left one behind.
  let scrolled = false;
  let marks = 0;
  let attachment = 0;
  let pumping = false;
  // Settles once the latest write reached the transport, so a wheel-up or
  // drag already sent is in tmux before the mode is left.
  let written: Promise<void> = Promise.resolve();
  const queue: Pending[] = [];

  const mark = () => {
    inMode = true;
    marks++;
  };
  const deliver = (data: string, kind: InputKind): Promise<void> => {
    let done: Promise<void>;
    try { done = write(data); } catch (error) { done = Promise.reject(error instanceof Error ? error : new Error(String(error))); }
    written = done.then(() => undefined, () => undefined);
    if (kind === "mode-entry") { mark(); scrolled = true; }
    return done;
  };
  const pump = async () => {
    pumping = true;
    const current = attachment;
    while (queue.length && current === attachment) {
      const next = queue[0];
      if (next.kind === "typing" && inMode) {
        const before = marks;
        await written;
        if (current !== attachment) return;
        // A failed exit still delivers the input: keys are never dropped,
        // and later keys do not each wait on a device that is not answering.
        await leave().catch(() => undefined);
        if (current !== attachment) return;
        const leftScroll = scrolled;
        if (marks === before) { inMode = false; scrolled = false; }
        // Esc or Ctrl+C typed right after the user's own scroll is the habit
        // for leaving the scrollback, not a key for the agent: both would
        // interrupt it, so the key that left the mode stops there. A key the
        // app sends (an approval's Reject, an interrupt) is always delivered,
        // and so is one after a reattach that may not have left a mode at all.
        if (leftScroll && next.origin === "keyboard" && LEAVE_KEYS.has(next.data)) {
          queue.shift();
          next.resolve(Promise.resolve());
          continue;
        }
      }
      queue.shift();
      next.resolve(deliver(next.data, next.kind));
    }
    if (current === attachment) pumping = false;
  };

  return {
    send(data, origin) {
      const kind = classifyInput(data);
      if (!pumping && !(kind === "typing" && inMode)) return deliver(data, kind);
      return new Promise<void>((resolve, reject) => {
        queue.push({ data, kind, origin, resolve, reject });
        if (!pumping) void pump();
      });
    },
    // A new attachment may find the pane in a mode, but not one the user
    // scrolled into from this tile.
    mark() { mark(); scrolled = false; },
    generation: () => marks,
    settle(generation, found) {
      if (generation !== marks) return;
      if (found) scrolled = true;
      else { inMode = false; scrolled = false; }
    },
    mayBeInMode: () => inMode,
    reset(reason) {
      attachment++;
      pumping = false;
      scrolled = false;
      written = Promise.resolve();
      for (const pending of queue.splice(0)) pending.reject(reason);
    },
  };
}
