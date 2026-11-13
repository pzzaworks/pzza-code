import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Extension } from "@codemirror/state";
import { GitCommitHorizontal } from "lucide-react";
import { isFileTile, useStore } from "../state/store";
import { broadcastLine, focusTileTerminal, typeIntoTile } from "../terminal/broadcast";
import { openTerminalInFileTile } from "../openFiles";
import { gitEditor, gitRepoFile } from "./gitEditor";
import { setInlineBlame, useInlineBlame } from "./gitLines";
import { checkPromptSize, selectionActions, selectionPrompt, type SelectionAction, type SelectionActionsConfig, type SelectedCode } from "./selectionActions";
import type { EditorState } from "@codemirror/state";
import "./EditorAssist.css";

// The editor's Git gutter, inline blame and selection actions, as the
// extensions one tile's editor adds to its own.

// The path an agent should read: inside the repository when known, else
// inside the editor folder, else as is.
export function displayPath(path: string, root: string | undefined, repoFile: string | null): string {
  if (repoFile) return repoFile;
  const base = root?.replace(/\/+$/, "");
  return base && path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
}

export function useEditorAssist({ tileId, host, path, root, reload, agentRunning }: {
  tileId: string;
  host: string | undefined;
  path: string | undefined;
  root: string | undefined;
  /** Changes after a save, so HEAD is read again. */
  reload: number;
  agentRunning: boolean;
}): Extension[] {
  const fileTile = useStore((s) => s.tiles.some((tile) => tile.id === tileId && isFileTile(tile)));
  const blame = useInlineBlame();
  const target = fileTile ? "file" : agentRunning ? "agent" : "shell";

  const run = useCallback(async (action: SelectionAction, selected: SelectedCode, state: EditorState) => {
    if (!path) return;
    const text = selectionPrompt(action, { ...selected, path: displayPath(path, root, gitRepoFile(state)) });
    checkPromptSize(text);
    // Explain and Fix go straight to an agent; anything for a plain shell, and
    // Send, is only typed, so nothing runs before the user presses Enter.
    if (action !== "send" && target === "agent") {
      const [result] = await broadcastLine([tileId], text, { multiline: true });
      if (result?.error) throw new Error(result.error);
      return;
    }
    await typeIntoTile(tileId, text);
    focusTileTerminal(tileId);
  }, [path, root, target, tileId]);

  const openTerminal = useCallback(async () => { await openTerminalInFileTile(tileId); }, [tileId]);

  const selection = useMemo(() => {
    const config: SelectionActionsConfig = { target, run, openTerminal };
    return selectionActions(config);
  }, [target, run, openTerminal]);
  const git = useMemo(() => (path ? gitEditor({ host: host ?? "", path, reload, blame }) : []), [host, path, reload, blame]);
  return useMemo(() => [git, selection], [git, selection]);
}

// Below this editor width the bar's room goes to the file name; the setting
// is global, so any wider editor (or a wider pane) can still change it.
const TOGGLE_MIN_WIDTH = 520;

/** Editor toolbar switch for inline blame on the cursor line. */
export function InlineBlameToggle() {
  const on = useInlineBlame();
  const probe = useRef<HTMLSpanElement>(null);
  const [roomy, setRoomy] = useState(false);
  useEffect(() => {
    const editor = probe.current?.closest(".tile-code");
    if (!editor) return;
    const observer = new ResizeObserver(([entry]) => setRoomy((entry?.contentRect.width ?? 0) > TOGGLE_MIN_WIDTH));
    observer.observe(editor);
    return () => observer.disconnect();
  }, []);
  return (
    <>
      <span ref={probe} hidden />
      {roomy ? (
        <button
          type="button"
          className={`tile-btn ${on ? "tile-btn-on" : ""}`}
          title={on ? "Inline blame is on: the cursor line shows its last commit. Click to hide it." : "Show inline blame: the cursor line's last commit, author and date"}
          aria-label="Inline blame"
          aria-pressed={on}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => setInlineBlame(!on)}
        >
          <GitCommitHorizontal size={13} />
        </button>
      ) : null}
    </>
  );
}
