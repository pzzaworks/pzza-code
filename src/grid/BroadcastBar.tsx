import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Bot, Loader2, MessageSquareText, Radio, SendHorizontal, SquareTerminal, X } from "lucide-react";
import { AgentIcon } from "../icons/AgentIcon";
import { broadcastLine, type BroadcastResult } from "../terminal/broadcast";
import { usePrompts } from "../state/prompts";
import { registerDictationTarget, useDictation, type PreviewActivity } from "../state/dictation";
import { DictationButton } from "../ui/Dictation";
import { INDICATOR_DOTS } from "../terminal/dictationComposition";

// Saved prompts beside the broadcast input. Picking one fills the input for
// review; it is sent only by Enter or Send, like a typed line.
function PromptPicker({ onPick }: { onPick: (text: string) => void }) {
  const prompts = usePrompts((s) => s.prompts);
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus();
    const away = (event: MouseEvent) => { if (!(event.target instanceof Node && root.current?.contains(event.target))) setOpen(false); };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);
  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(root.current?.querySelectorAll<HTMLElement>("[role='menuitem']") ?? [])];
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "Escape") { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
    else if ((event.key === "ArrowDown" || event.key === "ArrowUp") && items.length) {
      event.preventDefault();
      items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
    }
  };
  return <div className="broadcast-prompts" ref={root}>
    <button ref={trigger} type="button" className="tile-btn" title="Saved prompts" aria-label="Saved prompts" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
      <MessageSquareText size={14} aria-hidden="true" />
    </button>
    {open ? <div className="menu broadcast-prompts-menu" role="menu" aria-label="Saved prompts" onKeyDown={onMenuKey}>
      {prompts.length ? prompts.map((prompt) => (
        <button key={prompt.id} type="button" role="menuitem" className="menu-item broadcast-prompt" title={prompt.text} onClick={() => { setOpen(false); onPick(prompt.text); }}>
          <span className="broadcast-prompt-name">{prompt.name}</span>
          <span className="broadcast-prompt-text">{prompt.text}</span>
        </button>
      )) : <p className="broadcast-prompts-empty">No saved prompts yet. Add them in Settings, General, Saved prompts.</p>}
    </div> : null}
  </div>;
}

// The input grows with its text up to this many lines, then scrolls.
const MAX_INPUT_LINES = 6;
const MAX_INPUT_LENGTH = 4096;
// Whether dictated words need a space to stand apart from the text before
// them: not at the start, after whitespace, or before punctuation.
function needsSpace(before: string, words: string): boolean {
  return before.length > 0 && !/\s$/.test(before) && /^[\p{L}\p{N}]/u.test(words);
}

// The composer's dictation target: a fixed id outside the tile ids, like Quick Chat's.
const DICTATION_TARGET = "broadcast:composer";

export interface BroadcastTile {
  id: string;
  name: string;
  // The catalog agent in the foreground, for its logo; none for a shell.
  agent?: string;
}

// A floating composer docked under the grid while 2+ tiles are selected. The
// selected sessions are chips in their own row, so the message box keeps its
// width however many are picked. Nothing is sent until Enter or Send; each
// terminal gets the text followed by Enter. Shift+Enter adds a line: agents
// take a multi-line message as one prompt, while a plain shell refuses it
// rather than running each line.
export function BroadcastBar({ tiles, agentTiles, onSelectAgents, onRemove, onClear, leaving = false }: {
  tiles: BroadcastTile[];
  // Tiles in this workspace with a coding agent in the foreground.
  agentTiles: readonly string[];
  onSelectAgents: () => void;
  onRemove: (tileId: string) => void;
  onClear: () => void;
  // Selection dropped below two: the dock slides away, then the parent unmounts it.
  leaving?: boolean;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<{ sent: number; skipped: string[]; failed: (BroadcastResult & { name: string })[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [covering, setCovering] = useState(false);
  // Words still being recognized and where they will land (the caret), shown in the field like a session shows them at its cursor.
  const [dictation, setDictation] = useState<{ text: string; activity: PreviewActivity | null; at: number } | null>(null);
  const ghost = useRef<HTMLDivElement>(null);
  // The recording that last typed here, to tell its first words from the rest.
  const lastRecording = useRef<string | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  // Where the caret goes once dictated words land in the text.
  const caret = useRef<number | null>(null);
  const label = `Send to ${tiles.length} sessions`;
  const selected = new Set(tiles.map((tile) => tile.id));
  const missingAgents = agentTiles.filter((id) => !selected.has(id)).length;

  // The dock is fixed over the canvas's visible box, so its fade reaches the
  // canvas edges exactly and its slide-in never changes what scrolls. A spacer
  // in the canvas flow keeps room for the composer under the grid, and the
  // grid leaves that room at rest. The fade reaches up over the tiles only
  // while they actually run under the composer, so at rest the last lines of
  // a terminal are never blurred.
  const spacer = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<{ left: number; width: number; bottom: number } | null>(null);
  useLayoutEffect(() => {
    const element = root.current;
    const host = spacer.current?.parentElement;
    if (!element || !host) return;
    const grid = host.querySelector<HTMLElement>(":scope > .grid");
    const measure = () => {
      host.style.setProperty("--broadcast-h", `${Math.ceil(element.getBoundingClientRect().height)}px`);
      const rect = host.getBoundingClientRect();
      const left = Math.round(rect.left);
      const width = host.clientWidth;
      const bottom = Math.round(document.documentElement.clientHeight - rect.bottom);
      setBox((previous) => previous && previous.left === left && previous.width === width && previous.bottom === bottom ? previous : { left, width, bottom });
      setCovering(!!grid && grid.getBoundingClientRect().bottom > element.getBoundingClientRect().top + 1);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(host);
    if (grid) observer.observe(grid);
    host.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      host.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      host.style.removeProperty("--broadcast-h");
    };
  }, []);

  // Grow with the text, one line at a time, up to MAX_INPUT_LINES.
  useLayoutEffect(() => {
    const element = input.current;
    if (!element) return;
    element.style.height = "auto";
    const style = getComputedStyle(element);
    const line = parseFloat(style.lineHeight) || 18;
    const chrome = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    // Empty, the field is one line: a long placeholder is cut, never grown into.
    // Live dictation grows the field too, so its preview is never cut.
    const content = Math.max(text ? element.scrollHeight : 0, dictation ? ghost.current?.scrollHeight ?? 0 : 0);
    element.style.height = content ? `${Math.min(content, line * MAX_INPUT_LINES + chrome)}px` : `${line + chrome}px`;
    if (ghost.current) ghost.current.scrollTop = element.scrollTop;
    if (caret.current !== null) {
      element.setSelectionRange(caret.current, caret.current);
      caret.current = null;
    }
  }, [text, dictation]);

  const edit = (value: string) => { setText(value); setOutcome(null); setError(null); };

  // Dictation writes into the message at the caret, like typing; the words
  // still being recognized show at the caret, underlined, until they are final.
  useEffect(() => registerDictationTarget(DICTATION_TARGET, {
    focus: () => input.current?.focus(),
    preview: (words, activity) => setDictation({ text: words, activity: activity ?? null, at: input.current?.selectionStart ?? input.current?.value.length ?? 0 }),
    clearPreview: () => setDictation(null),
    // The composer is a text field, not a terminal: sending checks each tile for approvals.
    awaitingApproval: () => false,
    insert: (words) => {
      const element = input.current;
      if (!element) return false;
      const value = element.value;
      const start = element.selectionStart ?? value.length;
      const end = element.selectionEnd ?? start;
      // A recording's first words after typed text get a separating space.
      const recording = useDictation.getState().recording?.id ?? null;
      const first = recording !== lastRecording.current;
      lastRecording.current = recording;
      const chunk = first && needsSpace(value.slice(0, start), words) ? ` ${words}` : words;
      const next = value.slice(0, start) + chunk + value.slice(end);
      if (next.length > MAX_INPUT_LENGTH) return false;
      caret.current = start + chunk.length;
      setText(next);
      setOutcome(null);
      setError(null);
      return true;
    },
  }), []);

  const send = async () => {
    if (sending) return;
    setError(null);
    setOutcome(null);
    setSending(true);
    try {
      const results = await broadcastLine(tiles.map((tile) => tile.id), text, { multiline: true });
      const named = (result: BroadcastResult) => ({ ...result, name: tiles.find((tile) => tile.id === result.tileId)?.name ?? result.tileId });
      const skipped = results.filter((result) => result.skipped).map((result) => named(result).name);
      const failed = results.filter((result) => result.error !== null && !result.skipped).map(named);
      setOutcome({ sent: results.length - failed.length - skipped.length, skipped, failed });
      if (!failed.length && !skipped.length) setText("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Sending failed.");
    } finally {
      setSending(false);
    }
  };

  const status = (): string => {
    if (error) return error;
    if (!outcome) return "";
    const parts = [outcome.failed.length || outcome.skipped.length ? `Sent to ${outcome.sent} of ${tiles.length}.` : `Sent to ${outcome.sent} sessions.`];
    if (outcome.skipped.length) parts.push(`Skipped ${outcome.skipped.join(", ")}: waiting on an approval prompt.`);
    for (const item of outcome.failed) parts.push(`${item.name}: ${item.error}`);
    return parts.join(" ");
  };
  const problem = Boolean(error || outcome?.failed.length || outcome?.skipped.length);

  return <>
  <div ref={spacer} className="broadcast-spacer" aria-hidden="true" />
  <div
    className={`broadcast-dock${covering ? " broadcast-dock-covering" : ""}${leaving ? " broadcast-dock-leaving" : ""}${box ? "" : " broadcast-dock-measuring"}`}
    style={box ?? undefined}
  >
    {/* Blur that deepens toward the bottom edge, so whatever scrolls under the
        composer fades out behind it instead of running into its edge. */}
    <div className="broadcast-fade" aria-hidden="true"><span /><span /><span /><span /></div>
    <div ref={root} className="broadcast-bar" role="region" aria-label="Broadcast to selected sessions">
      <div className="broadcast-head">
        <span className="broadcast-title"><Radio size={14} className="broadcast-icon" aria-hidden="true" />Broadcast</span>
        <ul
          className="broadcast-targets"
          aria-label="Selected sessions"
          // A vertical wheel scrolls the chip row sideways.
          onWheel={(event) => { if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) event.currentTarget.scrollLeft += event.deltaY; }}
        >
          {tiles.map((tile) => (
            <li key={tile.id} className="broadcast-chip" title={tile.name}>
              {tile.agent ? <AgentIcon id={tile.agent} size={12} /> : <SquareTerminal size={12} aria-hidden="true" />}
              <span className="broadcast-chip-name">{tile.name}</span>
              <button type="button" className="broadcast-chip-remove" aria-label={`Remove ${tile.name}`} title="Remove from the broadcast" onClick={() => onRemove(tile.id)}><X size={11} /></button>
            </li>
          ))}
        </ul>
        {missingAgents ? (
          <button type="button" className="tile-btn broadcast-agents" title="Add every tile running a coding agent in this workspace" onClick={onSelectAgents}>
            <Bot size={14} aria-hidden="true" />All agents<span className="broadcast-agents-count">+{missingAgents}</span>
          </button>
        ) : null}
        <button type="button" className="tile-btn broadcast-close" title="Clear selection (Esc)" aria-label="Clear selection" onClick={onClear}><X size={14} /></button>
      </div>
      <div className="broadcast-compose">
        <PromptPicker onPick={(prompt) => { edit(prompt); input.current?.focus(); }} />
        <div className="broadcast-field">
        {dictation ? (
          // The same text, invisible, so the live words sit exactly at the caret.
          <div ref={ghost} className="broadcast-ghost" aria-hidden="true">
            <span className="broadcast-ghost-text">{text.slice(0, dictation.at)}</span>
            {dictation.text ? <span className="broadcast-ghost-words">{lastRecording.current !== useDictation.getState().recording?.id && needsSpace(text.slice(0, dictation.at), dictation.text) ? " " : ""}{dictation.text}</span> : null}
            {dictation.activity ? <span className="broadcast-ghost-dots">{dictation.text ? " " : ""}{Array.from(INDICATOR_DOTS).map((dot, index) => <span key={index} className="terminal-dictation-dot" style={{ animationDelay: `${index * 160}ms` }}>{dot}</span>)}</span> : null}
            <span className="broadcast-ghost-text">{text.slice(dictation.at)}</span>
          </div>
        ) : null}
        <textarea
          ref={input}
          className="broadcast-input"
          data-dictation-target={DICTATION_TARGET}
          onScroll={(event) => { if (ghost.current) ghost.current.scrollTop = event.currentTarget.scrollTop; }}
          value={text}
          rows={1}
          placeholder={`Type a message to send to ${tiles.length === 2 ? "both" : `all ${tiles.length}`} sessions…`}
          aria-label={label}
          aria-describedby="broadcast-foot"
          spellCheck={false}
          maxLength={MAX_INPUT_LENGTH}
          onChange={(event) => edit(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
            else if (event.key === "Escape") { event.preventDefault(); onClear(); }
          }}
        />
        </div>
        <DictationButton tileId={DICTATION_TARGET} activate={() => input.current?.focus()} />
        <button type="button" className="tile-btn broadcast-send" aria-label="Send" title="Send (Enter). Shift+Enter adds a line. Sessions waiting on an approval prompt are skipped."
          disabled={sending || !text.trim()} onClick={() => void send()}>
          {sending ? <Loader2 size={15} className="async-spinner" aria-hidden="true" /> : <SendHorizontal size={15} aria-hidden="true" />}
        </button>
      </div>
      <div id="broadcast-foot" className={`broadcast-foot ${error || outcome ? "broadcast-status" : ""} ${problem ? "broadcast-status-error" : ""}`} role="status">
        {error || outcome ? status() : null}
      </div>
    </div>
  </div>
  </>;
}

// How long the dock takes to slide away (matches broadcast-dock-out).
const LEAVE_MS = 200;

/**
 * Keeps the last shown value while the composer slides away, so it leaves
 * with the same content instead of vanishing. `leaving` is set during the exit.
 */
export function useBroadcastPresence<T>(value: T | null): { shown: T | null; leaving: boolean } {
  // What was last on screen, kept without re-rendering the parent; it is
  // dropped (with one re-render) when the exit finishes.
  const last = useRef<T | null>(value);
  const [, finished] = useState(0);
  const present = value !== null;
  useLayoutEffect(() => { if (value !== null) last.current = value; });
  useEffect(() => {
    if (present) return;
    const timer = window.setTimeout(() => { last.current = null; finished((count) => count + 1); }, LEAVE_MS);
    return () => window.clearTimeout(timer);
  }, [present]);
  if (present) return { shown: value, leaving: false };
  return { shown: last.current, leaving: last.current !== null };
}
