import { redactTerminalOutput } from "../../server/lib/terminal-redaction.js";

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
  isFocused?: () => boolean;
  // Live screen hooks (provided by the terminal view). Both are optional: when
  // absent the signals fall back to generic text. Rows are absolute buffer
  // rows; readRow returns trimmed line text or null for missing rows.
  cursorRow?: () => number | null;
  readRow?: (row: number) => string | null;
  isWrappedRow?: (row: number) => boolean;
}

const CONTEXT_CHARS = 120;
const MESSAGE_CHARS = 220;

function safeText(text: string): string {
  // Strip formatting before redaction so escape codes cannot split a credential.
  const plain = text.replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
  return redactTerminalOutput(plain).text;
}

function quote(text: string): string {
  const clean = safeText(text).replace(/\s+/g, " ").trim();
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
  { attachment, now = () => performance.now(), isFocused = () => false, cursorRow, readRow, isWrappedRow }: SignalOptions,
) {
  let disposed = false;
  let exited = false;
  let commandStarted = false;
  let commandStartRow: number | null = null;
  let lastBell = -Infinity;
  let pendingBell = false;
  const emit = (title: string, body: string, key: TerminalSignalNotification["event"], detail = "") => {
    if (disposed || exited) return;
    send({ category: "terminal", event: key, title, body, target: { tileId }, dedupeKey: `${key}:${tileId}${detail ? `:${detail}` : ""}` });
  };
  // Most recent non-empty screen line at or above the cursor.
  const lastLine = () => {
    const cursor = cursorRow?.() ?? null;
    const lines = screenLines(readRow, cursor === null ? null : cursor - 10, cursor);
    return lines.length ? lines[lines.length - 1] : null;
  };
  const recentOutput = () => {
    const cursor = cursorRow?.() ?? null;
    if (cursor === null || !readRow) return "";
    const rows: string[] = [];
    for (let row = Math.max(0, cursor - 40); row <= cursor; row++) {
      const text = readRow(row) ?? "";
      if (isWrappedRow?.(row) && rows.length) rows[rows.length - 1] += text;
      else rows.push(text);
    }
    const lines = safeText(rows.join("\n")).split("\n");
    // Exclude whole input lines, including their wrapped rows. Output after a
    // completed shell prompt remains useful, but never establishes the cause.
    const prompt = /^\s*[│┃]?\s*(?:[›❯»>$#%](?:\s|$)|\S*[@:/~]\S*\s*[$#%](?:\s|$))/;
    const output = lines.filter(line =>
      !prompt.test(line) && /[\p{L}\p{N}]/u.test(line) &&
      !/^\s*(?:[?] for shortcuts|esc to |\d+% context left|password\b|passphrase\b)/i.test(line));
    const text = output.slice(-2).join(" ").replace(/\s+/g, " ").trim();
    return text.length > MESSAGE_CHARS ? `${text.slice(0, MESSAGE_CHARS - 1)}…` : text;
  };
  const message = (title: string, body: string) => {
    pendingBell = false;
    if (disposed || exited || isFocused()) return;
    const cleanTitle = safeText(title).replace(/\s+/g, " ").trim().slice(0, 120);
    const cleanBody = safeText(body).replace(/\s+/g, " ").trim().slice(0, MESSAGE_CHARS);
    if (!cleanTitle && !cleanBody) return;
    lastBell = now();
    emit(cleanTitle || "Terminal notification", cleanBody || cleanTitle, "terminal-bell", `${cleanTitle}:${cleanBody}`);
  };
  return {
    bell() {
      if (disposed || exited || pendingBell || isFocused() || now() - lastBell < 10_000) return;
      pendingBell = true;
      // Finish parsing the output batch first. A message in the same batch
      // supersedes its bell, and the screen preview includes the final text.
      queueMicrotask(() => {
        if (!pendingBell) return;
        pendingBell = false;
        if (disposed || exited || isFocused()) return;
        lastBell = now();
        const output = recentOutput();
        emit("Terminal rang its bell", output ? `Recent output: ${output}`
          : "No message was provided. Open this terminal to check what needs attention.", "terminal-bell");
      });
    },
    osc9(data: string) {
      // Numeric subcommands are progress or shell metadata, not notifications.
      if (!data || data.length > 4096 || /^\d+;/.test(data)) return false;
      message("", data);
      return true;
    },
    osc777(data: string) {
      if (!data.startsWith("notify;") || data.length > 4096) return false;
      const separator = data.indexOf(";", 7);
      message(separator < 0 ? data.slice(7) : data.slice(7, separator), separator < 0 ? "" : data.slice(separator + 1));
      return true;
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
          const context = command ? ` ${quote(command)}${output ? ` - last line ${quote(output)}` : ""}` : "";
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
    dispose() { disposed = true; pendingBell = false; commandStarted = false; commandStartRow = null; },
  };
}
