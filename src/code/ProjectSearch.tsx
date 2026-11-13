import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { CaseSensitive, FileText, Loader2, Regex, TextSearch } from "lucide-react";
import { searchCode, type CodeSearchResult } from "../serverApi";
import { IS_MAC } from "../shortcuts";
import { PickerFrame, RangedText } from "./PickerFrame";
import { CODE_PICKERS } from "./pickerBus";
import { joinRoot } from "./QuickOpen";

export interface SearchOptions {
  query: string;
  caseSensitive: boolean;
  regex: boolean;
}

const DEBOUNCE_MS = 220;
const MIN_QUERY = 2;
const ALT = IS_MAC ? "⌥" : "Alt+";

// A regular expression the browser refuses, worded for the status line.
function regexError(options: SearchOptions): string | null {
  if (!options.regex) return null;
  try { new RegExp(options.query); return null; } catch { return "Invalid regular expression"; }
}

const plural = (count: number, word: string) => `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;

// Project search: as the query settles, the editor's folder is searched on its
// device and the hits are listed by file. Each new query cancels the one
// before it, so only the latest answer is ever shown.
export function ProjectSearch({ host, root, options, onOptions, onOpen, onClose }: {
  host?: string;
  root: string;
  options: SearchOptions;
  onOptions(next: SearchOptions): void;
  onOpen(path: string, line: number): void;
  onClose(restoreFocus: boolean): void;
}) {
  const listId = useId();
  const [result, setResult] = useState<CodeSearchResult | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const latest = useRef(0);

  const query = options.query.trim() ? options.query : "";
  const invalid = regexError(options);
  useEffect(() => {
    const request = ++latest.current;
    if (query.length < MIN_QUERY || invalid) {
      setResult(null);
      setPending(false);
      setError(null);
      return;
    }
    const controller = new AbortController();
    setPending(true);
    const timer = setTimeout(() => {
      searchCode({ root, host, query, caseSensitive: options.caseSensitive, regex: options.regex }, controller.signal)
        .then((next) => { if (request === latest.current) { setResult(next); setError(null); setCursor(0); } })
        .catch((cause: unknown) => { if (request === latest.current && !controller.signal.aborted) { setResult(null); setError(cause instanceof Error ? cause.message : "Search is unavailable"); } })
        .finally(() => { if (request === latest.current && !controller.signal.aborted) setPending(false); });
    }, DEBOUNCE_MS);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [root, host, query, options.caseSensitive, options.regex, invalid]);

  // Matches are the selectable rows; file headings only group them.
  const flat = useMemo(() => (result?.files ?? []).flatMap((file) => file.matches.map((match) => ({ file: file.path, match }))), [result]);
  const current = Math.min(cursor, Math.max(0, flat.length - 1));
  const optionId = (index: number) => `${listId}-${index}`;
  const open = (index: number) => {
    const row = flat[index];
    if (row && result) onOpen(joinRoot(result.root, row.file), row.match.line);
  };
  const toggle = (key: "caseSensitive" | "regex") => onOptions({ ...options, [key]: !options[key] });
  // Alt+C and Alt+R flip the options without leaving the field.
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!event.altKey || event.metaKey || event.ctrlKey) return false;
    if (event.code === "KeyC") { toggle("caseSensitive"); return true; }
    if (event.code === "KeyR") { toggle("regex"); return true; }
    return false;
  };

  const status = invalid ? <span className="code-picker-error">{invalid}</span>
    : error ? <span className="code-picker-error">{error}</span>
    : pending ? <><Loader2 size={12} className="sw-spin" aria-hidden="true" /> Searching…</>
    : !query ? null
    : query.length < MIN_QUERY ? `Type at least ${MIN_QUERY} characters.`
    : result ? [
      result.matchCount ? `${plural(result.matchCount, "result")} in ${plural(result.files.length, "file")}` : "No results",
      result.timedOut ? "the search stopped early, narrow it down to see everything" : result.truncated ? "only the first results are shown" : "",
    ].filter(Boolean).join(", ") + "."
    : null;

  let index = -1;
  return (
    <PickerFrame
      label={CODE_PICKERS.search.label}
      icon={TextSearch}
      placeholder="Search in this folder"
      query={options.query}
      onQuery={(value) => onOptions({ ...options, query: value })}
      count={flat.length}
      cursor={current}
      onCursor={setCursor}
      onPick={open}
      onClose={onClose}
      onKey={onKey}
      listId={listId}
      activeId={flat.length ? optionId(current) : undefined}
      status={status}
      className="code-picker-search-panel"
      tools={<>
        <button type="button" className={`tile-btn code-picker-toggle ${options.caseSensitive ? "tile-btn-on" : ""}`} aria-pressed={options.caseSensitive}
          title={`Match case (${ALT}C)`} aria-label="Match case" onMouseDown={(event) => event.preventDefault()} onClick={() => toggle("caseSensitive")}>
          <CaseSensitive size={15} aria-hidden="true" />
        </button>
        <button type="button" className={`tile-btn code-picker-toggle ${options.regex ? "tile-btn-on" : ""}`} aria-pressed={options.regex}
          title={`Use regular expression (${ALT}R)`} aria-label="Use regular expression" onMouseDown={(event) => event.preventDefault()} onClick={() => toggle("regex")}>
          <Regex size={15} aria-hidden="true" />
        </button>
      </>}
    >
      {(result?.files ?? []).map((file) => {
        const slash = file.path.lastIndexOf("/");
        return (
          <div key={file.path} className="code-picker-group" role="group" aria-label={file.path}>
            <div className="code-picker-file" title={file.path} onMouseDown={(event) => event.preventDefault()}
              onClick={() => result && file.matches[0] && onOpen(joinRoot(result.root, file.path), file.matches[0].line)}>
              <FileText size={13} aria-hidden="true" />
              <span className="code-picker-file-name">{file.path.slice(slash + 1)}</span>
              <span className="code-picker-dir">{slash > 0 ? file.path.slice(0, slash) : ""}</span>
              <span className="code-picker-count">{file.matches.length}</span>
            </div>
            {file.matches.map((match) => {
              const at = ++index;
              return (
                <div
                  key={match.line}
                  id={optionId(at)}
                  role="option"
                  aria-selected={at === current}
                  className={`cmdk-row code-picker-row code-picker-match ${at === current ? "cmdk-row-active" : ""}`}
                  onMouseMove={() => { if (at !== current) setCursor(at); }}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => open(at)}
                >
                  <span className="code-picker-line">{match.line}</span>
                  <span className="cmdk-row-label code-picker-text"><RangedText text={match.text} ranges={match.ranges} /></span>
                </div>
              );
            })}
          </div>
        );
      })}
      {result && !pending && !result.files.length ? (
        <div className="cmdk-empty" role="status">Nothing in this folder matches “{query}”.</div>
      ) : null}
    </PickerFrame>
  );
}
