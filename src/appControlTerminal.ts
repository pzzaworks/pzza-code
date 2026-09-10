import { registerAppControlHandler, registerAppControlState } from "./appControlRuntime";
import { TERMINAL_APP_COMMANDS } from "../server/lib/app-control-terminal-schema.js";

export interface TerminalControlState {
  connected: boolean; cols: number; rows: number; bufferLines: number; viewportY: number; hasSelection: boolean; bracketedPasteMode: boolean;
}
export interface TerminalControlAdapter {
  state(): TerminalControlState;
  lines(): string[] | Promise<string[]>;
  selection(): string;
  paste(text: string): Promise<void>;
  pasteClipboard(): Promise<void>;
  sendControl(value: string): Promise<void>;
  copy(): Promise<void>;
  selectAll(): void;
  clearSelection(): void;
  clear(): void;
  scroll(target: "top" | "bottom" | "relative", lines: number): void;
}
export function validateTerminalPaste(text: string, bracketedPaste: boolean, singleLine = false): void {
  if (typeof text !== "string" || new TextEncoder().encode(text).byteLength > 65536 || /[\x00-\x08\x0b-\x1f\x7f]/.test(text)) throw new Error("Terminal text must be at most 64 KiB without control characters.");
  if (/[\n\t]/.test(text) && (singleLine || !bracketedPaste)) throw new Error(singleLine ? "Literal input must be a single line without tabs. Submit Enter separately." : "Multiline or tabbed paste requires bracketed paste mode. Insert one line and submit separately.");
}
export function redactTerminalOutput(text: string): { text: string; redacted: boolean } {
  let redacted = false;
  let privateKey = false;
  const mask = () => { redacted = true; return "[REDACTED]"; };
  const lines = text.split("\n").map(line => {
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(line)) privateKey = true;
    if (privateKey) { if (/-----END [A-Z ]*PRIVATE KEY-----/.test(line)) privateKey = false; return mask(); }
    if (/\b(?:[A-Za-z0-9_]*(?:token|password|passwd|secret|credential|api[_-]?key|access[_-]?key|private[_-]?key)[A-Za-z0-9_]*)["']?\s*[:=]\s*\S/i.test(line) || /\b(?:authorization|proxy-authorization)\s*:\s*\S/i.test(line)) return mask();
    return line.replace(/\b(?:https?:\/\/)[^\s/@]+@/gi, match => match.slice(0, match.indexOf("://") + 3) + mask() + "@")
      .replace(/(\w+:\/\/)[^\s/@:]+:[^\s/@]*@/g, (_, scheme: string) => scheme + mask() + "@")
      .replace(/\b(?:Bearer|Basic)\s+\S+/gi, mask)
      .replace(/(?:gh[pousr]_|github_pat_|sk-|xox[baprs]-)[A-Za-z0-9_-]{16,}|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, mask)
      .replace(/[A-Za-z0-9_+\/-]{32,}={0,2}/g, value => {
        const counts = new Map<string, number>();
        for (const character of value) counts.set(character, (counts.get(character) ?? 0) + 1);
        const entropy = [...counts.values()].reduce((total, count) => { const p = count / value.length; return total - p * Math.log2(p); }, 0);
        return entropy > 3.5 ? mask() : value;
      });
  });
  return { text: lines.join("\n"), redacted };
}
const KEYS: Record<string, string> = { escape: "\x1b", tab: "\t", backspace: "\x7f", delete: "\x1b[3~", up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", home: "\x1b[H", end: "\x1b[F", page_up: "\x1b[5~", page_down: "\x1b[6~", interrupt: "\x03", eof: "\x04", suspend: "\x1a", redraw: "\x0c" };
export function createTerminalAppController(adapter: TerminalControlAdapter) {
  const connected = () => { if (!adapter.state().connected) throw new Error("The terminal is disconnected or still opening. Wait for its connection before sending input."); };
  return {
    state: () => adapter.state(),
    async execute(action: string, args: Readonly<Record<string, unknown>>): Promise<unknown> {
      switch (action) {
        case "terminal_get_state": return adapter.state();
        case "terminal_read_output": {
          const source = await adapter.lines();
          const raw = source.join("\n");
          if (raw.length > 4 * 1024 * 1024) throw new Error("Terminal buffer exceeds the safe read limit. Clear old scrollback before reading.");
          const safe = redactTerminalOutput(raw);
          const lines = (args.lines as number | undefined) ?? 100;
          const start = (args.startLine as number | undefined) ?? Math.max(0, source.length - lines);
          if (start > source.length) throw new Error("Requested line is outside the terminal buffer.");
          const page = safe.text.split("\n").slice(start, start + lines).join("\n");
          const limit = (args.maxChars as number | undefined) ?? 65536;
          return { text: page.slice(0, limit), startLine: start, nextLine: Math.min(source.length, start + lines), totalLines: source.length, truncated: page.length > limit, redacted: safe.redacted };
        }
        case "terminal_read_selection": { const value = redactTerminalOutput(adapter.selection()); return { ...value, text: value.text.slice(0, 65536), truncated: value.text.length > 65536 }; }
        case "terminal_input": case "terminal_paste": {
          connected(); const text = args.text as string;
          validateTerminalPaste(text, adapter.state().bracketedPasteMode, action === "terminal_input");
          await adapter.paste(text); return { inserted: text.length };
        }
        case "terminal_paste_clipboard": connected(); await adapter.pasteClipboard(); return { pasted: true };
        case "terminal_submit": connected(); await adapter.sendControl("\r"); return { submitted: true };
        case "terminal_key": { connected(); const value = KEYS[args.key as string]; if (!value) throw new Error("Unsupported terminal key."); await adapter.sendControl(value); return { sent: true }; }
        case "terminal_copy": await adapter.copy(); return { copied: true };
        case "terminal_select_all": adapter.selectAll(); return adapter.state();
        case "terminal_clear_selection": adapter.clearSelection(); return adapter.state();
        case "terminal_clear": adapter.clear(); return adapter.state();
        case "terminal_scroll": {
          const target = args.target as "top" | "bottom" | "relative";
          if (target === "relative" && args.lines === undefined) throw new Error("Relative scrolling requires a line count.");
          adapter.scroll(target, (args.lines as number | undefined) ?? 0); return adapter.state();
        }
        default: throw new Error("Unknown terminal action.");
      }
    },
  };
}
type Controller = ReturnType<typeof createTerminalAppController>;
const terminals = new Map<string, Controller>();
export function registerTerminalAppControl(tileId: string, controller: Controller): () => void {
  terminals.set(tileId, controller);
  return () => { if (terminals.get(tileId) === controller) terminals.delete(tileId); };
}
export function initTerminalAppControlHandlers(): () => void {
  const cleanups = Object.keys(TERMINAL_APP_COMMANDS).map(action => registerAppControlHandler(action, args => {
    const terminal = terminals.get(args.tileId as string);
    if (!terminal) throw new Error("Open the terminal tile before controlling it.");
    return terminal.execute(action, args);
  }));
  cleanups.push(registerAppControlState("terminals", () => [...terminals].map(([tileId, terminal]) => ({ tileId, ...terminal.state() }))));
  return () => { for (const cleanup of cleanups) cleanup(); };
}
