import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Loader2, MessageSquareText, Radio, Send, X } from "lucide-react";
import { broadcastLine, type BroadcastResult } from "../terminal/broadcast";
import { usePrompts } from "../state/prompts";

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

// Docked under the grid while 2+ tiles are selected. Nothing is sent until the
// user presses Enter or Send; each terminal gets the line followed by Enter.
export function BroadcastBar({ tiles, onClear }: { tiles: { id: string; name: string }[]; onClear: () => void }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<{ sent: number; failed: (BroadcastResult & { name: string })[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const label = `Send to ${tiles.length} sessions`;

  const send = async () => {
    if (sending) return;
    setError(null);
    setOutcome(null);
    setSending(true);
    try {
      const results = await broadcastLine(tiles.map((tile) => tile.id), text);
      const failed = results.filter((result) => result.error !== null)
        .map((result) => ({ ...result, name: tiles.find((tile) => tile.id === result.tileId)?.name ?? result.tileId }));
      setOutcome({ sent: results.length - failed.length, failed });
      if (!failed.length) setText("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Sending failed.");
    } finally {
      setSending(false);
    }
  };

  return <div className="broadcast-bar" role="region" aria-label="Broadcast to selected sessions">
    <Radio size={14} className="broadcast-icon" aria-hidden="true" />
    <span className="broadcast-targets" title={tiles.map((tile) => tile.name).join(", ")}>{tiles.map((tile) => tile.name).join(", ")}</span>
    <PromptPicker onPick={(prompt) => { setText(prompt); setOutcome(null); setError(null); input.current?.focus(); }} />
    <input
      ref={input}
      className="broadcast-input"
      value={text}
      placeholder={label}
      aria-label={label}
      spellCheck={false}
      maxLength={4096}
      onChange={(event) => { setText(event.target.value); setOutcome(null); setError(null); }}
      onKeyDown={(event) => {
        if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
        else if (event.key === "Escape") { event.preventDefault(); onClear(); }
      }}
    />
    <button type="button" className="btn btn-sm btn-accent broadcast-send" disabled={sending || !text.trim()} onClick={() => void send()}>
      {sending ? <Loader2 size={13} className="async-spinner" aria-hidden="true" /> : <Send size={13} aria-hidden="true" />}Send
    </button>
    <button type="button" className="tile-btn" title="Clear selection (Esc)" aria-label="Clear selection" onClick={onClear}><X size={14} /></button>
    {error || outcome ? <div className={`broadcast-status ${error || outcome?.failed.length ? "broadcast-status-error" : ""}`} role="status">
      {error ?? (outcome && outcome.failed.length
        ? `Sent to ${outcome.sent} of ${tiles.length}. ${outcome.failed.map((item) => `${item.name}: ${item.error}`).join(" ")}`
        : `Sent to ${outcome?.sent ?? 0} sessions.`)}
    </div> : null}
  </div>;
}
