import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { githubDark, githubLight } from "@uiw/codemirror-theme-github";
import { GitCommitHorizontal, LoaderCircle } from "lucide-react";
import { CodeDiffView, type GitDiffState, type DiffAsk } from "../grid/CodeChanges";
import { useStore } from "../state/store";
import { themeById } from "../theme/themes";
import { sendPromptToTile } from "../terminal/broadcast";
import type { GitChangeStatus } from "../serverApi";
import { fetchTaskDiff, type TaskFile } from "./taskApi";
import type { CandidateLive } from "./taskLive";
import type { Task, TaskCandidate } from "./taskStore";

// One attempt's work against the task's base: its commits, the files it
// changed (committed or not) with line counts, and the selected file's diff
// in the same viewer as a tile's Changes view. Questions and review comments
// on lines go to the attempt's own agent. It sits in the task window like a
// checkpoint's changes, built from the same pieces.

const MARK: Record<GitChangeStatus, string> = { modified: "M", added: "A", untracked: "U", deleted: "D", renamed: "R", conflicted: "!" };

function useTaskDiff(task: Task, candidate: TaskCandidate, file: TaskFile | null, revision: string): GitDiffState {
  const [state, setState] = useState<GitDiffState & { key: string }>({ status: "idle", version: 0, key: "" });
  const key = file ? JSON.stringify([file.path, file.from, revision]) : "";
  useEffect(() => {
    if (!file) { setState((previous) => ({ status: "idle", version: previous.version, key: "" })); return; }
    const controller = new AbortController();
    setState((previous) => (previous.key === key ? previous : { status: "loading", version: previous.version, key }));
    fetchTaskDiff(task.host, candidate.worktree, task.base, file.path, file.status === "renamed" ? file.from : undefined, controller.signal)
      .then((diff) => { if (!controller.signal.aborted) setState((previous) => ({ status: "ready", diff, version: previous.version + 1, key })); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setState((previous) => ({ status: "error", error: cause instanceof Error ? cause.message : "File changes unavailable", version: previous.version, key })); });
    return () => controller.abort();
  }, [task.host, candidate.worktree, task.base, key]);
  return state.key === key ? state : { status: file ? "loading" : "idle", version: state.version };
}

export function TaskChanges({ task, candidate, live, initialPath }: { task: Task; candidate: TaskCandidate; live: CandidateLive; initialPath?: string }) {
  const stats = live.stats;
  const files = stats?.files ?? [];
  const [selectedPath, setSelectedPath] = useState<string | null>(initialPath ?? null);
  const file = files.find((item) => item.path === selectedPath) ?? files[0] ?? null;
  // A new commit or edit reads the open file again.
  const revision = `${stats?.head ?? ""}:${stats?.added ?? 0}:${stats?.removed ?? 0}:${stats?.uncommitted ?? 0}`;
  const diff = useTaskDiff(task, candidate, file, revision);
  const themeId = useStore((state) => state.themeId);
  const editorTheme = themeById(themeId).appearance === "light" ? githubLight : githubDark;
  const tileOpen = useStore((state) => state.tiles.some((tile) => tile.id === candidate.tileId));
  const ask: DiffAsk = { tileId: candidate.tileId, available: tileOpen && live.agentRunning !== false, send: (line) => sendPromptToTile(candidate.tileId, line) };
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const onKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = event.key === "ArrowDown" ? files[index + 1] : event.key === "ArrowUp" ? files[index - 1] : undefined;
    if (!next) return;
    event.preventDefault();
    setSelectedPath(next.path);
    rows.current.get(next.path)?.focus();
  };

  if (!stats) {
    return <div className="cp-body task-changes-body"><div className="cp-note">{live.statsError ? <span role="alert">{live.statsError}</span> : <><LoaderCircle size={14} className="sw-spin" aria-hidden="true" /> Reading changes…</>}</div></div>;
  }
  return (
    <div className="cp-body task-changes-body" role="region" aria-label="Changes against the base">
      {!files.length ? <div className="cp-note">No changes against {task.base} yet.</div> : <>
        <div className="cp-files-pane">
          {stats.commits.length ? (
            <details className="task-commits">
              <summary><GitCommitHorizontal size={12} aria-hidden="true" />{stats.commits.length} {stats.commits.length === 1 ? "commit" : "commits"} on {stats.branch ?? candidate.branch}</summary>
              <ul>{stats.commits.map((commit) => <li key={commit.sha}><code>{commit.sha.slice(0, 7)}</code> {commit.subject}</li>)}</ul>
            </details>
          ) : null}
          <div className="cp-files" role="list" aria-label="Changed files">
            {files.map((item, index) => {
              const at = item.path.lastIndexOf("/");
              const on = item.path === file?.path;
              return (
                <div role="listitem" key={`${item.status}:${item.path}`}>
                  <button type="button" className={`cp-file${on ? " on" : ""}`} aria-current={on ? "true" : undefined}
                    ref={(element) => { if (element) rows.current.set(item.path, element); else rows.current.delete(item.path); }}
                    onClick={() => setSelectedPath(item.path)} onKeyDown={(event) => onKey(event, index)} title={item.path}
                    aria-label={`${item.path}, ${item.status}${item.added === null ? ", binary" : `, ${item.added} added, ${item.removed} removed`}`}>
                    <span className={`code-changes-status code-changes-status-${item.status}`} aria-hidden="true">{MARK[item.status]}</span>
                    <span className="cp-file-name">{at < 0 ? item.path : item.path.slice(at + 1)}</span>
                    {at > 0 ? <span className="cp-file-dir">{item.path.slice(0, at)}</span> : null}
                    <span className="cp-file-lines" aria-hidden="true">
                      {item.added === null ? <span className="cp-binary">binary</span> : <>{item.added ? <span className="cp-add">+{item.added}</span> : null}{item.removed ? <span className="cp-del">−{item.removed}</span> : null}</>}
                    </span>
                  </button>
                </div>
              );
            })}
          </div>
          {stats.truncated ? <div className="cp-note">Showing the first {files.length} files</div> : null}
          {!stats.baseFound ? <div className="cp-note">{task.base} is not a local branch here, so only uncommitted changes show.</div> : null}
        </div>
        <div className="cp-diff">
          {file ? <CodeDiffView state={diff} file={{ path: file.path, status: file.status, ...(file.from ? { from: file.from } : {}) }} theme={editorTheme} ask={ask} /> : null}
        </div>
      </>}
    </div>
  );
}
