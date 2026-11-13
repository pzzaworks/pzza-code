import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { EditorView } from "@codemirror/view";
import { FileSearch, ListTree, TextSearch, type LucideIcon } from "lucide-react";
import { CODE_PICKERS, codePickerShortcut, registerCodePickers, type CodePickerKind } from "./pickerBus";
import { rememberRecentFile } from "./recentFiles";
import { QuickOpen } from "./QuickOpen";
import { ProjectSearch, type SearchOptions } from "./ProjectSearch";
import { SymbolOutline } from "./SymbolOutline";
import "./CodePickers.css";

export interface CodePickersOptions {
  tileId: string;
  host?: string;
  root?: string;
  /** The file open in the editor. */
  path?: string;
  /** The text editor showing `path`, when one is (not for images, diffs, previews). */
  view(): EditorView | null;
  /** Opens a file through the editor's unsaved-changes guard, at `line` when given. */
  open(path: string, line?: number): void;
}

const ICONS: Record<CodePickerKind, LucideIcon> = { files: FileSearch, search: TextSearch, symbols: ListTree };
const ORDER: CodePickerKind[] = ["files", "search", "symbols"];

// Quick Open, project search and the symbol outline for one editor: its
// toolbar buttons, its keyboard shortcuts (while focus is in this editor's
// tile) and the overlay of whichever is open.
export function useCodePickers({ tileId, host, root, path, view, open }: CodePickersOptions): { buttons: ReactNode; overlay: ReactNode } {
  const [active, setActive] = useState<CodePickerKind | null>(null);
  const [search, setSearch] = useState<SearchOptions>({ query: "", caseSensitive: false, regex: false });
  const latest = useRef({ view, open, root, path });
  latest.current = { view, open, root, path };

  const show = useCallback((kind: CodePickerKind) => {
    const { root: folder, path: file } = latest.current;
    if (!folder || (kind === "symbols" && !file)) return;
    setActive(kind);
  }, []);
  const close = useCallback((restoreFocus: boolean) => {
    setActive(null);
    if (restoreFocus) latest.current.view()?.focus();
  }, []);

  useEffect(() => { if (path) rememberRecentFile(tileId, path); }, [tileId, path]);
  useEffect(() => { if (!root) setActive(null); }, [root]);
  useEffect(() => registerCodePickers(tileId, show), [tileId, show]);
  // Capture phase, so the editor and terminal never see these keys.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const kind = codePickerShortcut(event);
      if (!kind) return;
      const tile = event.target instanceof Element ? event.target.closest("[data-tile-id]") : null;
      if (tile?.getAttribute("data-tile-id") !== tileId || !latest.current.root) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) show(kind);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [tileId, show]);

  const buttons = (
    <>
      {ORDER.map((kind) => {
        const Icon = ICONS[kind];
        const { label, shortcut, keys } = CODE_PICKERS[kind];
        return (
          <button
            key={kind}
            type="button"
            className={`tile-btn code-picker-btn ${active === kind ? "tile-btn-on" : ""}`}
            title={`${label} (${shortcut})`}
            aria-label={label}
            aria-keyshortcuts={keys}
            disabled={!root || (kind === "symbols" && !path)}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => (active === kind ? close(true) : show(kind))}
          >
            <Icon size={13} aria-hidden="true" />
          </button>
        );
      })}
    </>
  );

  const jump = (target: string) => (line?: number) => {
    setActive(null);
    latest.current.open(target, line);
  };
  const overlay = !active || !root ? null
    : active === "files" ? <QuickOpen tileId={tileId} host={host} root={root} path={path} onOpen={(target) => jump(target)()} onClose={close} />
    : active === "search" ? <ProjectSearch host={host} root={root} options={search} onOptions={setSearch} onOpen={(target, line) => jump(target)(line)} onClose={close} />
    : path ? <SymbolOutline view={view()} path={path} onJump={jump(path)} onClose={close} />
    : null;
  return { buttons, overlay };
}
