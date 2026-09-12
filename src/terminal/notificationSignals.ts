export interface TerminalSignalNotification {
  category: "terminal";
  event: "terminal-bell" | "terminal-command" | "terminal-exit";
  title: string;
  body: string;
  target: { tileId: string };
  dedupeKey: string;
}

interface SignalOptions {
  attachment: boolean;
  now?: () => number;
  // Live screen hooks (provided by the terminal view). Both are optional: when
  // absent the signals fall back to generic text. Rows are absolute buffer
  // rows; readRow returns trimmed line text or null for missing rows.
  cursorRow?: () => number | null;
  readRow?: (row: number) => string | null;
}

const CONTEXT_CHARS = 120;

function quote(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return `"${clean.length > CONTEXT_CHARS ? `${clean.slice(0, CONTEXT_CHARS - 1)}…` : clean}"`;
}

// Non-empty screen lines in [from, to], oldest first.
function screenLines(readRow: ((row: number) => string | null) | undefined, from: number | null, to: number | null): string[] {
  if (!readRow || from === null || to === null) return [];
  const lines: string[] = [];
  for (let row = Math.max(0, from); row <= to; row++) {
    const text = readRow(row)?.trim();
    if (text) lines.push(text);
  }
  return lines;
}

// Observe explicit terminal signals. Output becoming quiet is never completion.
export function createTerminalSignals(
  tileId: string,
  send: (notification: TerminalSignalNotification) => void,
  { attachment, now = () => performance.now(), cursorRow, readRow }: SignalOptions,
) {
  let disposed = false;
  let exited = false;
  let commandStarted = false;
  let commandStartRow: number | null = null;
  let lastBell = -Infinity;
  const emit = (title: string, body: string, key: TerminalSignalNotification["event"]) => {
    if (disposed || exited) return;
    send({ category: "terminal", event: key, title, body, target: { tileId }, dedupeKey: `${key}:${tileId}` });
  };
  // Most recent non-empty screen line at or above the cursor.
  const lastLine = () => {
    const cursor = cursorRow?.() ?? null;
    const lines = screenLines(readRow, cursor === null ? null : cursor - 10, cursor);
    return lines.length ? lines[lines.length - 1] : null;
  };
  return {
    bell() {
      if (disposed || exited || now() - lastBell < 10_000) return;
      lastBell = now();
      const line = lastLine();
      emit("Terminal needs attention",
        line ? `Attention signal after ${quote(line)}.` : "This terminal emitted an attention signal.",
        "terminal-bell");
    },
    osc133(data: string) {
      if (disposed || exited || data.length > 32) return false;
      // Shell integration brackets a running command with C and D;status.
      // Requiring C avoids notifying for the initial prompt's previous status.
      if (data === "A") { commandStarted = false; commandStartRow = null; }
      else if (data === "C") { commandStarted = true; commandStartRow = cursorRow?.() ?? null; }
      else if (data === "D" || data.startsWith("D;")) {
        const started = commandStarted;
        const startRow = commandStartRow;
        commandStarted = false;
        commandStartRow = null;
        const status = /^D;(0|[1-9][0-9]{0,2})$/.exec(data);
        if (started && status && Number(status[1]) <= 255) {
          const code = Number(status[1]);
          const cursor = cursorRow?.() ?? null;
          const lines = screenLines(readRow, startRow ?? (cursor === null ? null : cursor - 30), cursor);
          const command = lines.length ? lines[0] : null;
          const output = lines.length > 1 && lines[lines.length - 1] !== command ? lines[lines.length - 1] : null;
          const context = command ? ` ${quote(command)}${output ? ` — last line ${quote(output)}` : ""}` : "";
          emit(code === 0 ? "Terminal reported completion" : "Terminal reported failure",
            code === 0
              ? (command ? `Finished${context}.` : "Shell integration reported that a command finished successfully.")
              : `Command exited with status ${code}${command ? ` after${context}` : "."}`,
            "terminal-command");
        }
      }
      // Other shell-integration handlers may observe the same sequence.
      return false;
    },
    processExit(code: number) {
      if (disposed || exited) return;
      // A successful tmux/SSH client exit can be an intentional detach. Its
      // status does not establish that the process inside the session finished.
      if (code !== 0 || !attachment) {
        const line = lastLine();
        const status = Number.isInteger(code) && code >= 0 && code <= 255
          ? `exited with status ${code}` : "ended without a successful exit status";
        emit(code === 0 ? "Terminal process finished" : "Terminal process failed",
          line ? `The terminal process ${status}. Last line ${quote(line)}.` : `The terminal process ${status}.`,
          "terminal-exit");
      }
      exited = true;
      commandStarted = false;
      commandStartRow = null;
    },
    dispose() { disposed = true; commandStarted = false; commandStartRow = null; },
  };
}
