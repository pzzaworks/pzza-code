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
  // Absolute screen rows, including spaces at wrap boundaries. Missing screen
  // hooks leave message-free bells without a preview.
  cursorRow?: () => number | null;
  lastRow?: () => number;
  readRow?: (row: number) => string | null;
  isWrappedRow?: (row: number) => boolean;
}

const CONTEXT_CHARS = 120;
const MESSAGE_CHARS = 220;
const OUTPUT_CHARS = 3000;

function rowContent(text: string): string {
  return text.trim().replace(/^[\s\u2500-\u257f\u2013\u2014]+|[\s\u2500-\u257f\u2013\u2014]+$/g, "");
}

function isInputRow(text: string): boolean {
  return /^(?:[›❯»>$#%](?:[\s\u2800-\u28ff]|$)|\S*[@:/~]\S*\s*[$#%](?:\s|$)|(?:password|passphrase)(?:\s|:\s*$|$))/i.test(text);
}

function isDividerRow(text: string): boolean {
  return /^\s*[─━═]{3,}/u.test(text);
}

function isStatusRow(text: string): boolean {
  return /^(?:Worked for|[✻✽✶✳✢✦]\s+[\p{L}-]+ for)\s+(?:\d+(?:\.\d+)?\s*(?:ms|s|m|h|d)\s*)+(?:·\s*done\b.*)?$/iu.test(text) ||
    /^▣\s+.+\s+·\s+\d+(?:\.\d+)?(?:ms|s|m|h)$/.test(text) ||
    /^(?:[?] for shortcuts|esc to |\d+% context left|\d+ background terminals? running\b)/i.test(text);
}

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
  { attachment, now = () => performance.now(), isFocused = () => false, cursorRow, lastRow, readRow, isWrappedRow }: SignalOptions,
) {
  let disposed = false;
  let exited = false;
  let commandStarted = false;
  let commandStartRow: number | null = null;
  let lastBell = -Infinity;
  let pendingBell = false;
  let capturedOutput = "";
  let capturedFrames: string[] = [];
  let previousTurnOutput = "";
  let capturedAt = -Infinity;
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
  const recentOutput = (beforeErase = false) => {
    const cursor = cursorRow?.() ?? null;
    if (cursor === null || !readRow) return "";
    let end = Math.max(cursor, lastRow?.() ?? cursor);
    for (let row = end; row >= Math.max(0, end - 80); row--) {
      const content = rowContent(readRow(row) ?? "");
      if (/^[›❯»>$#%]$/u.test(content) || (!beforeErase && row === cursor && isInputRow(content))) { end = row; break; }
    }
    const rows: string[] = [];
    let joinPrevious = false;
    let skipWrapped = false;
    let skipDividerWrap = false;
    let pendingInput = false;
    for (let row = Math.max(0, end - 80); row <= end; row++) {
      const text = readRow(row) ?? "";
      const content = rowContent(text);
      const wrapped = isWrappedRow?.(row) ?? false;
      skipDividerWrap = isDividerRow(text) || (wrapped && skipDividerWrap);
      const indented = /^[ \t]/.test(text);
      if ((!wrapped && !indented) || !content) skipWrapped = false;
      if (isInputRow(content)) pendingInput = true;
      if (isInputRow(content) || isStatusRow(content)) skipWrapped = true;
      // Classify physical rows before joining. A full-width divider can wrap
      // straight into a prompt, even though they are separate UI elements.
      if (skipDividerWrap || skipWrapped || !/[\p{L}\p{N}]/u.test(content)) {
        joinPrevious = false;
        if (rows.length && rows[rows.length - 1] !== "") rows.push("");
        continue;
      }
      if (pendingInput) { rows.length = 0; joinPrevious = false; pendingInput = false; }
      if (wrapped && joinPrevious) rows[rows.length - 1] += text;
      // A multiplexer can redraw wrapped prose as separate, indented rows.
      else if (indented && joinPrevious) {
        const previous = rows[rows.length - 1].trimEnd();
        const separator = /[\p{L}\p{N}][/-]$/u.test(previous) ? "" : " ";
        rows[rows.length - 1] = previous + separator + text.trimStart();
      }
      else rows.push(text);
      joinPrevious = true;
    }
    const lines = safeText(rows.join("\n")).split("\n");
    // A status label can itself span rows in a narrow pane. Check the joined
    // text too, after redacting complete output lines and credential blocks.
    const output = lines.map(line => {
      const content = rowContent(line);
      return isInputRow(content) || isStatusRow(content) ? "" : line;
    });
    const paragraphs = output.join("\n").trim().split(/\n\s*\n/);
    let responseStart = -1;
    for (let index = output.length - 1; index >= 0; index--) {
      if (/^\s*⏺\s/u.test(output[index])) { responseStart = index; break; }
    }
    const response = responseStart < 0 ? paragraphs[paragraphs.length - 1] : output.slice(responseStart).join("\n");
    return response.replace(/[ \t]+/g, " ").trim();
  };
  const captureOutput = (beforeErase = false) => {
    let current = recentOutput(beforeErase);
    if (now() - capturedAt > 300_000) { capturedOutput = ""; capturedFrames = []; }
    if (!current) return capturedOutput;
    // A delayed bell may arrive after a resize has clipped the opening rows.
    // Retain the complete, already-redacted paragraph when its tail is still visible.
    const flat = (text: string) => text.replace(/\s+/g, " ").trim();
    if (previousTurnOutput && previousTurnOutput.includes(flat(current))) return current;
    if (current.length >= 32) previousTurnOutput = "";
    const complete = current.length >= 32 ? capturedFrames.filter(frame => flat(frame).endsWith(flat(current))).sort((a, b) => b.length - a.length)[0] : undefined;
    // Cache observed snapshots only. Overlapping redraws are not proof that
    // text was appended, and stitching them can invent duplicated sentences.
    current = current.length > OUTPUT_CHARS ? `${current.slice(0, OUTPUT_CHARS - 1)}…` : current;
    if (current.length >= 32) capturedFrames = [current, ...capturedFrames.filter(frame => frame !== current)].slice(0, 16);
    capturedOutput = complete ?? current;
    capturedAt = now();
    return capturedOutput;
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
    captureOutput,
    input(text: string) {
      if (/[\r\n\x03\x0c]/.test(text)) {
        previousTurnOutput = recentOutput().replace(/\s+/g, " ").trim().slice(0, OUTPUT_CHARS);
        capturedOutput = "";
        capturedFrames = [];
      }
    },
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
        const output = captureOutput();
        emit("Terminal rang its bell", output ? safeText(output)
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
