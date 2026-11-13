import { useId, useMemo, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { Box, Braces, Hash, ListTree, SquareFunction, Type, Variable, type LucideIcon } from "lucide-react";
import { fuzzyMatch } from "../fuzzyMatch";
import { extractSymbols, type CodeSymbol, type SymbolKind } from "./symbols";
import { MarkedText, PickerFrame } from "./PickerFrame";
import { CODE_PICKERS } from "./pickerBus";

const ICONS: Record<SymbolKind, LucideIcon> = {
  function: SquareFunction, method: SquareFunction, class: Box, struct: Box, interface: Type, type: Type,
  enum: Braces, namespace: Braces, impl: Braces, constant: Variable, heading: Hash,
};

interface Row { symbol: CodeSymbol; positions: number[] }

// The open file's symbols, read once when the outline opens. Typing filters
// them by fuzzy match; with no query they keep file order and nesting, and the
// one around the cursor is selected.
export function SymbolOutline({ view, path, onJump, onClose }: {
  view: EditorView | null;
  path: string;
  onJump(line: number): void;
  onClose(restoreFocus: boolean): void;
}) {
  const listId = useId();
  const [query, setQuery] = useState("");
  const symbols = useMemo(() => (view ? extractSymbols(view.state, path) : []), [view, path]);
  // The last symbol starting at or above the cursor line.
  const [cursor, setCursor] = useState(() => {
    if (!view) return 0;
    const line = view.state.doc.lineAt(view.state.selection.main.head).number;
    let at = 0;
    symbols.forEach((symbol, index) => { if (symbol.line <= line) at = index; });
    return at;
  });
  const rows = useMemo<Row[]>(() => {
    if (!query.trim()) return symbols.map((symbol) => ({ symbol, positions: [] }));
    const ranked: (Row & { score: number })[] = [];
    for (const symbol of symbols) {
      const match = fuzzyMatch(query, symbol.name);
      if (match) ranked.push({ symbol, positions: match.positions, score: match.score });
    }
    return ranked.sort((a, b) => b.score - a.score || a.symbol.line - b.symbol.line);
  }, [symbols, query]);
  const current = Math.min(cursor, Math.max(0, rows.length - 1));
  const optionId = (index: number) => `${listId}-${index}`;
  const nested = !query.trim();

  return (
    <PickerFrame
      label={CODE_PICKERS.symbols.label}
      icon={ListTree}
      placeholder="Go to symbol in this file"
      query={query}
      onQuery={(value) => { setQuery(value); setCursor(0); }}
      count={rows.length}
      cursor={current}
      onCursor={setCursor}
      onPick={(index) => { const row = rows[index]; if (row) onJump(row.symbol.line); }}
      onClose={onClose}
      listId={listId}
      activeId={rows.length ? optionId(current) : undefined}
      className="code-picker-symbols"
    >
      {rows.map((row, index) => {
        const Icon = ICONS[row.symbol.kind];
        return (
          <div
            key={`${row.symbol.line}:${row.symbol.name}:${index}`}
            id={optionId(index)}
            role="option"
            aria-selected={index === current}
            className={`cmdk-row code-picker-row code-picker-kind-${row.symbol.kind} ${index === current ? "cmdk-row-active" : ""}`}
            style={nested && row.symbol.depth ? { paddingLeft: 10 + Math.min(row.symbol.depth, 6) * 14 } : undefined}
            onMouseMove={() => { if (index !== current) setCursor(index); }}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onJump(row.symbol.line)}
          >
            <Icon size={14} className="cmdk-row-icon" aria-hidden="true" />
            <span className="cmdk-row-label"><MarkedText text={row.symbol.name} positions={row.positions} /></span>
            <span className="cmdk-row-detail">{row.symbol.kind}</span>
            <span className="code-picker-line">{row.symbol.line}</span>
          </div>
        );
      })}
      {!rows.length ? (
        <div className="cmdk-empty" role="status">
          {!view ? "Open a text file to see its symbols." : symbols.length ? `No symbol matches “${query.trim()}”.` : "No symbols in this file."}
        </div>
      ) : null}
    </PickerFrame>
  );
}
