import { Fragment, useEffect, useLayoutEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

// The shared shell of the editor's pickers: a search field over a list, at
// the top of the editor. Arrow keys move through the rows, Enter picks, Escape
// closes and gives focus back to the editor; a click or focus elsewhere
// closes it too.
export interface PickerFrameProps {
  label: string;
  icon: LucideIcon;
  placeholder: string;
  query: string;
  onQuery(value: string): void;
  /** Selectable rows, and which is selected. */
  count: number;
  cursor: number;
  onCursor(index: number): void;
  onPick(index: number): void;
  onClose(restoreFocus: boolean): void;
  listId: string;
  activeId?: string;
  /** Controls beside the field (search options). */
  tools?: ReactNode;
  /** Extra keys handled in the field before the list's own. */
  onKey?(event: KeyboardEvent<HTMLInputElement>): boolean;
  status?: ReactNode;
  className?: string;
  children: ReactNode;
}

const PAGE = 10;

export function PickerFrame(props: PickerFrameProps) {
  const { label, icon: Icon, placeholder, query, onQuery, count, cursor, onCursor, onPick, onClose, listId, activeId, tools, onKey, status, className, children } = props;
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  // A press anywhere outside closes the picker and leaves focus where it went.
  useEffect(() => {
    const away = (event: MouseEvent) => {
      // This editor's toolbar buttons toggle the picker themselves.
      if (event.target instanceof Element && event.target.closest(".code-picker-btn") && root.current?.closest(".tile-code")?.contains(event.target)) return;
      if (event.target instanceof Node && !root.current?.contains(event.target)) closeRef.current(false);
    };
    document.addEventListener("mousedown", away, true);
    return () => document.removeEventListener("mousedown", away, true);
  }, []);
  useLayoutEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [cursor, activeId]);

  const move = (step: number, wrap: boolean) => {
    if (!count) return;
    const next = cursor + step;
    onCursor(wrap ? (next + count) % count : Math.max(0, Math.min(count - 1, next)));
  };
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (onKey?.(event)) { event.preventDefault(); return; }
    const handled = event.key === "ArrowDown" ? (move(1, true), true)
      : event.key === "ArrowUp" ? (move(-1, true), true)
      : event.key === "PageDown" ? (move(PAGE, false), true)
      : event.key === "PageUp" ? (move(-PAGE, false), true)
      : event.key === "Enter" ? (count ? onPick(Math.min(cursor, count - 1)) : undefined, true)
      : event.key === "Escape" ? (onClose(true), true)
      : false;
    if (handled) { event.preventDefault(); event.stopPropagation(); }
  };

  return (
    <div
      ref={root}
      className={`menu code-picker ${className ?? ""}`}
      role="dialog"
      aria-label={label}
      onMouseDown={(event) => event.stopPropagation()}
      onBlur={(event) => {
        // Tabbing out of the picker closes it; leaving the window does not.
        if (event.relatedTarget instanceof Node && !root.current?.contains(event.relatedTarget)) onClose(false);
      }}
    >
      <div className="code-picker-search">
        <Icon size={14} aria-hidden="true" className="code-picker-search-icon" />
        <input
          ref={input}
          className="code-picker-input"
          value={query}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          role="combobox"
          aria-label={label}
          aria-expanded="true"
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeId}
          onChange={(event) => onQuery(event.target.value)}
          onKeyDown={keyDown}
        />
        {tools}
      </div>
      {status ? <div className="code-picker-status" role="status">{status}</div> : null}
      <div className="code-picker-list" id={listId} ref={list} role="listbox" aria-label={label}>
        {children}
      </div>
    </div>
  );
}

/** Text with the characters at `positions` marked. */
export function MarkedText({ text, positions }: { text: string; positions: readonly number[] }): ReactNode {
  if (!positions.length) return text;
  const marks = new Set(positions);
  const parts: ReactNode[] = [];
  let run = "";
  let marked = false;
  const flush = (key: number) => { if (run) parts.push(marked ? <mark key={key}>{run}</mark> : <Fragment key={key}>{run}</Fragment>); run = ""; };
  for (let index = 0; index < text.length; index++) {
    const next = marks.has(index);
    if (next !== marked) { flush(index); marked = next; }
    run += text[index];
  }
  flush(text.length);
  return parts;
}

/** Text with the [from, to) `ranges` marked. */
export function RangedText({ text, ranges }: { text: string; ranges: readonly (readonly [number, number])[] }): ReactNode {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [from, to] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (from < at || to <= from) continue;
    if (from > at) parts.push(<Fragment key={`t${at}`}>{text.slice(at, from)}</Fragment>);
    parts.push(<mark key={`m${from}`}>{text.slice(from, to)}</mark>);
    at = to;
  }
  if (at < text.length) parts.push(<Fragment key={`t${at}`}>{text.slice(at)}</Fragment>);
  return parts;
}
