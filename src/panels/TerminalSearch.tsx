import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Regex, Search, TextSearch } from "lucide-react";
import { useStore } from "../state/store";
import { useModalFocus } from "../ui/Modal";
import { announceMenu } from "../ui/menuBus";
import { runLocalAppCommand } from "../appControl";
import { sessionDisplayName } from "../sessionMeta";
import { SEARCH_TERMINALS_SHORTCUT } from "../shortcuts";
import { compileQuery, MAX_TOTAL_MATCHES, revealInTerminal, searchTerminals, type TerminalMatch, type TileMatches } from "../terminal/terminalSearch";

// Search across every open terminal (Cmd+Shift+F, or the command palette).
// Results are grouped by tile with the matching line and its neighbours;
// Enter or a click activates the tile, scrolls to the line and marks it.

// Typing settles briefly before a search starts; each new query cancels the last.
const DEBOUNCE_MS = 120;
// Characters shown before the match on a long line.
const LEAD = 48;

function MatchLine({ match }: { match: TerminalMatch }): ReactNode {
  const from = Math.max(0, match.start - LEAD);
  const head = (from > 0 ? "…" : "") + match.text.slice(from, match.start);
  const tail = match.text.slice(match.end, match.end + 200).trimEnd();
  return <span className="term-search-line">{head}<mark>{match.text.slice(match.start, match.end)}</mark>{tail}</span>;
}

interface Props { open: boolean; onClose: () => void; onError: (message: string) => void }

export function TerminalSearch({ open, onClose, onError }: Props) {
  const dialog = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();
  const tiles = useStore((s) => s.tiles);
  const tileTitles = useStore((s) => s.tileTitles);
  const activeId = useStore((s) => s.activeId);
  const [query, setQuery] = useState("");
  const [regex, setRegex] = useState(false);
  const [result, setResult] = useState<{ groups: TileMatches[]; done: boolean; error: string | null }>({ groups: [], done: true, error: null });
  const [cursor, setCursor] = useState(0);
  useModalFocus(open, dialog, onClose, false, input);
  useEffect(() => {
    if (!open) return;
    announceMenu("terminal-search");
    input.current?.select();
  }, [open]);

  // The active tile is searched first, then the rest in grid order.
  const order = useMemo(() => {
    const ids = tiles.map((tile) => tile.id);
    return activeId && ids.includes(activeId) ? [activeId, ...ids.filter((id) => id !== activeId)] : ids;
  }, [tiles, activeId]);
  const orderRef = useRef(order);
  orderRef.current = order;

  useEffect(() => {
    if (!open) return;
    let pattern: RegExp | null;
    try {
      pattern = compileQuery(query.trim() ? query : "", regex);
    } catch (error) {
      setResult({ groups: [], done: true, error: error instanceof Error ? error.message : "Invalid regular expression." });
      return;
    }
    if (!pattern) { setResult({ groups: [], done: true, error: null }); return; }
    const controller = new AbortController();
    const search = pattern;
    const timer = window.setTimeout(() => {
      setResult({ groups: [], done: false, error: null });
      setCursor(0);
      void searchTerminals(orderRef.current, search, controller.signal, (groups, done) => setResult({ groups, done, error: null }));
    }, DEBOUNCE_MS);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [open, query, regex]);

  const rows = useMemo(() => result.groups.flatMap((group) => group.matches), [result.groups]);
  const current = rows.length ? rows[Math.min(cursor, rows.length - 1)] : undefined;
  const optionId = (match: TerminalMatch) => `${listId}-${rows.indexOf(match)}`;
  useLayoutEffect(() => {
    if (!current) return;
    list.current?.querySelector(`#${CSS.escape(optionId(current))}`)?.scrollIntoView({ block: "nearest" });
  });
  if (!open) return null;

  const names = new Map(tiles.map((tile) => [tile.id, sessionDisplayName(tile, tileTitles)]));
  const jump = (match: TerminalMatch | undefined) => {
    if (!match) return;
    onClose();
    // After the panel is gone, so the focus lands in the terminal.
    window.setTimeout(() => {
      void runLocalAppCommand("focus_tile", { tileId: match.tileId }).then(() => {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          if (!revealInTerminal(match.tileId, { row: match.row, col: match.col, length: match.length, query: query.trim() ? query : "", regex })) {
            onError("That terminal is no longer open.");
          }
        }));
      }).catch((error: unknown) => onError(error instanceof Error ? error.message : String(error)));
    }, 0);
  };
  const move = (step: number) => { if (rows.length) setCursor((index) => (Math.min(index, rows.length - 1) + step + rows.length) % rows.length); };
  const total = rows.length;
  const capped = total >= MAX_TOTAL_MATCHES || result.groups.some((group) => group.capped);
  const status = result.error ?? (!query.trim() ? "Type to search the scrollback of every open terminal."
    : !result.done ? (total ? `${total} matches so far…` : "Searching…")
    : total ? `${total} match${total === 1 ? "" : "es"} in ${result.groups.length} terminal${result.groups.length === 1 ? "" : "s"}${capped ? ", showing the first ones" : ""}`
    : "");

  return createPortal(
    <div className="modal-backdrop pzza-portal cmdk-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="cmdk term-search" ref={dialog} role="dialog" aria-modal="true" aria-label="Search all terminals" tabIndex={-1}>
        <div className="cmdk-search">
          <TextSearch size={16} strokeWidth={1.9} aria-hidden="true" />
          <input ref={input} className="cmdk-input" value={query} placeholder="Search every terminal" spellCheck={false} autoComplete="off"
            role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list" aria-label="Search terminal output"
            aria-activedescendant={current ? optionId(current) : undefined}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); move(event.key === "ArrowDown" ? 1 : -1); }
              else if (event.key === "Enter") { event.preventDefault(); jump(current); }
            }} />
          <button type="button" className={`tile-btn ${regex ? "tile-btn-on" : ""}`} aria-pressed={regex} aria-label="Regular expression"
            title={regex ? "Regular expression on" : "Regular expression off"} onClick={() => { setRegex((value) => !value); input.current?.focus(); }}>
            <Regex size={14} aria-hidden="true" />
          </button>
          <kbd className="kbd" aria-hidden="true">{SEARCH_TERMINALS_SHORTCUT.label}</kbd>
        </div>
        <div className="cmdk-list term-search-list" id={listId} ref={list} role="listbox" aria-label="Matches">
          {result.groups.map((group) => (
            <div className="cmdk-group" role="group" aria-label={names.get(group.tileId) ?? group.tileId} key={group.tileId}>
              <div className="cmdk-group-title term-search-group" aria-hidden="true">
                <span>{names.get(group.tileId) ?? group.tileId}</span>
                <span>{group.matches.length}{group.capped ? "+" : ""}</span>
              </div>
              {group.matches.map((match) => {
                const selected = match === current;
                return (
                  <div key={`${match.row}:${match.col}`} id={optionId(match)} role="option" aria-selected={selected}
                    className={`cmdk-row term-search-row ${selected ? "cmdk-row-active" : ""}`}
                    onMouseMove={() => { if (!selected) setCursor(rows.indexOf(match)); }}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => jump(match)}>
                    <span className="term-search-number" aria-label={`Line ${match.line}`}>{match.line}</span>
                    <span className="term-search-context">
                      {match.before.trim() ? <span className="term-search-near">{match.before}</span> : null}
                      <MatchLine match={match} />
                      {match.after.trim() ? <span className="term-search-near">{match.after}</span> : null}
                    </span>
                  </div>
                );
              })}
            </div>
          ))}
          {result.done && query.trim() && !result.error && !total ? (
            <div className="cmdk-empty" role="status">
              <Search size={15} aria-hidden="true" />
              <span>No terminal output matches “{query.trim()}”.</span>
            </div>
          ) : null}
        </div>
        <div className="cmdk-foot term-search-foot">
          <span className={result.error ? "term-search-error" : ""} role={result.error ? "alert" : "status"}>{status}</span>
          <span aria-hidden="true"><kbd className="kbd">↵</kbd> jump</span>
          <span aria-hidden="true"><kbd className="kbd">esc</kbd> close</span>
        </div>
      </div>
    </div>, document.body,
  );
}
