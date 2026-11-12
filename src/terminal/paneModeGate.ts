// Keeps typed input out of tmux pane modes. With `mouse on` (a common
// tmux.conf setting) a wheel-up or a drag over a pane puts it in copy-mode,
// and while a mode is active tmux hands every key to the mode, so typing
// would move a copy cursor instead of reaching the program. The gate tracks
// when the pane may be in a mode (a wheel-up or drag it forwarded, or a fresh
// attachment) and, before the next typed input, leaves the mode once and then
// delivers that input and everything after it in order.

export type InputKind = "typing" | "mode-entry" | "passthrough";

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
  send(data: string): Promise<void>;
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
    if (kind === "mode-entry") mark();
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
        if (marks === before) inMode = false;
        // Esc or Ctrl+C right after a scroll is the habit for leaving the
        // scrollback, not a key for the agent: both would interrupt it, so the
        // key that left the mode stops there.
        if (LEAVE_KEYS.has(next.data)) {
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
    send(data) {
      const kind = classifyInput(data);
      if (!pumping && !(kind === "typing" && inMode)) return deliver(data, kind);
      return new Promise<void>((resolve, reject) => {
        queue.push({ data, kind, resolve, reject });
        if (!pumping) void pump();
      });
    },
    mark,
    generation: () => marks,
    settle(generation, found) {
      if (!found && generation === marks) inMode = false;
    },
    mayBeInMode: () => inMode,
    reset(reason) {
      attachment++;
      pumping = false;
      written = Promise.resolve();
      for (const pending of queue.splice(0)) pending.reject(reason);
    },
  };
}
