import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  FolderGit2, GitBranch, GitMerge, GitPullRequestCreateArrow, Info, ListTodo, Loader2, RefreshCw, Save, Search, ShieldCheck, SlidersHorizontal, Trash2, TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import {
  approveWorktreeSetup, fetchGitRepositories, fetchGitWorktrees, fetchSessionPath, fetchWorktreeSetup, removeGitWorktree, saveWorktreeSetup,
  type GitMergeKind, type GitWorktree, type WorktreeSetup,
} from "../serverApi";
import { landWorktree, worktreeTask, type LandRequest, type LandResult } from "../worktreeLand";
import { useTasks } from "../tasks/taskStore";
import { openWebPage } from "../tileGit";
import { confirmAction } from "../ui/ConfirmDialog";
import { isFileTile, sessionTileById, tileFolder, useStore, type Tile } from "../state/store";
import { deviceNameFor } from "../devices";
import { Modal } from "../ui/Modal";
import { IconButton } from "../ui/IconButton";
import { useAutoGrow } from "../ui/useAutoGrow";
import { compactPath } from "./compactPath";

// The extra Git worktrees of the repository a session works in, or of every
// repository directly inside its folder of projects (New session → Worktree
// creates them), read when the dialog opens. A worktree can be removed when it
// is clean, unlocked and no tile works in it; a merged branch is deleted with
// it. Squash- and rebase-merged branches count as merged; the server re-proves
// that right before deleting them, and nothing unmerged is ever forced. A
// worktree's branch can be brought back as a pull request or merged into the
// base in the main checkout, and each repository's setup for new worktrees
// (files to copy, commands to run before the agent) is edited here.

const MERGE_LABELS: Record<GitMergeKind, string> = { ancestor: "Merged", squash: "Squash-merged", patch: "Rebase-merged" };
const SKELETON_ROWS = 4;

const inside = (folder: string, root: string) => folder === root || folder.startsWith(root.endsWith("/") ? root : `${root}/`);
const folderName = (path: string) => path.split("/").filter(Boolean).pop() ?? path;
const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString()} ${count === 1 ? one : many}`;
const errorText = (error: unknown, fallback: string) => (error instanceof Error && error.message ? error.message : fallback);

interface Repo {
  key: string;
  host: string;
  /** The main checkout (the folder that was read, when it could not be). */
  root: string;
  base: string | null;
  worktrees: GitWorktree[];
  error: string | null;
}

interface Scan { folder: string; repos: Repo[] }

type ScanState =
  | { status: "loading"; scan: Scan | null }
  | { status: "ready"; scan: Scan }
  | { status: "error"; scan: null; folder: string; message: string }
  /** Neither the terminal nor the session list knows the session's folder. */
  | { status: "unknown"; scan: null };

type Facet = "all" | "open" | "merged";

interface OpenFolder { tileId: string; host: string; folder: string }

/** The session a dialog was opened for: what it runs on and the folder it works in. */
interface Origin { tileId: string; session: string; window?: number; tileHost?: string; host: string; folder: string | undefined; device: string }

function useOrigin(tileId: string): Origin | null {
  const tile = useStore((state) => sessionTileById(state.tiles, tileId));
  const allSessions = useStore((state) => state.allSessions);
  const connectionHost = useStore((state) => state.connection.host) ?? "";
  const devices = useStore((state) => state.devices);
  const sessionPaths = useMemo(() => new Map(allSessions.flatMap((session) => (session.path ? [[session.name, session.path] as const] : []))), [allSessions]);
  if (!tile) return null;
  return {
    tileId, session: tile.session ?? tile.name, window: tile.window, tileHost: tile.host,
    host: tile.host ?? connectionHost, folder: tileFolder(tile, sessionPaths), device: deviceNameFor(devices, tile.host),
  };
}

// The repositories in the session's folder and their worktrees, read again on
// each `revision`. The previous list stays (dimmed) while a new one loads.
function useWorktreeScan(origin: Origin | null, revision: number): ScanState {
  const [state, setState] = useState<ScanState>({ status: "loading", scan: null });
  const key = origin ? JSON.stringify([origin.session, origin.window ?? null, origin.tileHost ?? null, origin.host, origin.folder ?? null]) : "";
  const latest = useRef(origin);
  latest.current = origin;
  useEffect(() => {
    const current = latest.current;
    if (!current) return;
    const { host, session, window, tileHost, folder: known } = current;
    const controller = new AbortController();
    const { signal } = controller;
    setState((previous) => ({ status: "loading", scan: previous.status === "ready" || previous.status === "loading" ? previous.scan : null }));
    void (async () => {
      // The terminal's folder right now, which can be newer than the last session scan.
      const live = await fetchSessionPath(session, tileHost, window);
      if (signal.aborted) return;
      const folder = live.startsWith("/") ? live : known;
      if (!folder) { setState({ status: "unknown", scan: null }); return; }
      let folders: string[];
      try {
        // A folder of projects reads every repository directly inside it.
        folders = await fetchGitRepositories(host, folder, signal);
      } catch (error) {
        if (!signal.aborted) setState({ status: "error", scan: null, folder, message: errorText(error, "Repositories unavailable") });
        return;
      }
      const results = await Promise.all(folders.map((path) => fetchGitWorktrees(host, path, signal).then(
        (result) => ({ path, result, error: null }),
        (error: unknown) => ({ path, result: null, error: errorText(error, "Worktrees unavailable") }),
      )));
      if (signal.aborted) return;
      const repos = new Map<string, Repo>();
      for (const { path, result, error } of results) {
        const main = result?.worktrees.find((worktree) => worktree.main);
        const root = main?.path ?? path;
        const repoKey = JSON.stringify([host, root]);
        if (repos.has(repoKey)) continue;
        repos.set(repoKey, {
          key: repoKey, host, root, base: result?.base ?? null,
          worktrees: result?.worktrees.filter((worktree) => !worktree.main) ?? [],
          error: error ?? (main ? null : "Its main checkout could not be read."),
        });
      }
      setState({ status: "ready", scan: { folder, repos: [...repos.values()] } });
    })();
    return () => controller.abort();
  }, [key, revision]);
  return state;
}

export function WorktreesPanel({ tileId, onClose }: { tileId: string; onClose(): void }) {
  const origin = useOrigin(tileId);
  const tiles = useStore((state) => state.tiles);
  const allSessions = useStore((state) => state.allSessions);
  const connectionHost = useStore((state) => state.connection.host) ?? "";
  // Read so a row's task, and so its landing path, follows Tasks.
  useTasks((state) => state.tasks);
  const [revision, setRevision] = useState(0);
  const state = useWorktreeScan(origin, revision);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<LandResult | null>(null);
  const [text, setText] = useState("");
  const [facet, setFacet] = useState<Facet>("all");
  const searchRef = useRef<HTMLInputElement>(null);
  const reload = () => setRevision((value) => value + 1);

  useEffect(() => {
    // A pull request link stays until the next action.
    if (!note || note.failed || note.url) return;
    const timer = window.setTimeout(() => setNote(null), 5000);
    return () => window.clearTimeout(timer);
  }, [note]);

  // Every open tile, in any workspace, keeps its worktree from being removed.
  const openFolders = useMemo<OpenFolder[]>(() => {
    const sessionPaths = new Map(allSessions.flatMap((session) => (session.path ? [[session.name, session.path] as const] : [])));
    return tiles.flatMap((tile: Tile) => {
      const folder = tileFolder(tile, sessionPaths);
      return folder ? [{ tileId: tile.id, host: (isFileTile(tile) ? undefined : tile.host) ?? connectionHost, folder }] : [];
    });
  }, [tiles, allSessions, connectionHost]);

  const scan = state.scan;
  const repos = scan?.repos ?? [];
  // This session's folders: the one the store knows and the live one just read.
  const here = [origin?.folder, scan?.folder].filter((path): path is string => path !== undefined);
  const isHere = (worktree: GitWorktree) => here.some((path) => inside(path, worktree.path));
  const blocker = (repo: Repo, worktree: GitWorktree): string | null => {
    if (isHere(worktree)) return "This session is working in it";
    if (openFolders.some((open) => open.host === repo.host && inside(open.folder, worktree.path))) return "A tile is working in it";
    if (worktree.locked) return "Locked";
    if (worktree.dirty) return "Has uncommitted changes";
    return null;
  };
  const removable = repos.flatMap((repo) => repo.worktrees.filter((worktree) => worktree.merged && !blocker(repo, worktree)).map((worktree) => ({ repo, worktree })));

  const remove = async (targets: Array<{ repo: Repo; worktree: GitWorktree }>, confirmMessage: string) => {
    if (!targets.length || busy !== null) return;
    if (!(await confirmAction({ title: targets.length > 1 ? `Remove ${targets.length} worktrees?` : "Remove worktree?", message: confirmMessage, confirmLabel: "Remove", danger: true }))) return;
    setNote(null);
    const failures: string[] = [];
    let deleted = 0;
    for (const { repo, worktree } of targets) {
      setBusy(`remove:${worktree.path}`);
      try {
        const result = await removeGitWorktree(repo.host, repo.root, worktree.path, worktree.merged && worktree.branch !== null);
        if (result.branchDeleted) deleted += 1;
      } catch (error) {
        failures.push(`${worktree.branch ?? compactPath(worktree.path)}: ${errorText(error, "Could not remove the worktree")}`);
      }
    }
    setBusy(null);
    const done = targets.length - failures.length;
    setNote(failures.length
      ? { text: failures.join(" · "), failed: true }
      : { text: `Removed ${done} worktree${done === 1 ? "" : "s"}${deleted ? ` and ${deleted} merged branch${deleted === 1 ? "" : "es"}` : ""}.`, failed: false });
    reload();
  };

  // Open PR and Merge: one at a time through the shared landing path, then the
  // list is read again. A task's worktree hands over to its task window.
  const land = async (request: LandRequest) => {
    if (busy !== null) return;
    setNote(null);
    setBusy(`${request.kind}:${request.path}`);
    const handOff = worktreeTask(request.host, request.path) !== null;
    let result: LandResult | null;
    try {
      result = await landWorktree(request, { interactive: true });
    } catch (error) {
      result = { text: errorText(error, request.kind === "pr" ? "Could not open the pull request" : "Could not merge"), failed: true };
    } finally {
      setBusy(null);
    }
    if (handOff) { onClose(); return; }
    if (!result) return;
    setNote(result);
    if (!result.failed) reload();
  };

  // ---- search and the merged / not merged facets
  const query = text.trim().toLowerCase();
  const matches = (repo: Repo, worktree: GitWorktree) => !query || [worktree.branch ?? "", worktree.head.slice(0, 12), worktree.path, worktreeTask(repo.host, worktree.path)?.task.title ?? ""]
    .some((value) => value.toLowerCase().includes(query));
  const searched = repos.map((repo) => ({ repo, worktrees: repo.worktrees.filter((worktree) => matches(repo, worktree)) }));
  const counts = { all: 0, open: 0, merged: 0 };
  for (const { worktrees } of searched) for (const worktree of worktrees) { counts.all += 1; counts[worktree.merged ? "merged" : "open"] += 1; }
  const shown = searched.map(({ repo, worktrees }) => ({ repo, worktrees: worktrees.filter((worktree) => facet === "all" || (facet === "merged") === worktree.merged) }));
  const filtered = Boolean(query) || facet !== "all";
  const total = repos.reduce((sum, repo) => sum + repo.worktrees.length, 0);
  const shownTotal = shown.reduce((sum, { worktrees }) => sum + worktrees.length, 0);

  const folder = scan?.folder ?? (state.status === "error" ? state.folder : origin?.folder);
  const firstLoad = state.status === "loading" && !scan;
  const loading = state.status === "loading";
  const removeMessage = (worktree: GitWorktree) => `Removes the folder ${worktree.path}${worktree.merged && worktree.branch ? ` and deletes the merged branch ${worktree.branch}`
    : worktree.branch ? `. The branch ${worktree.branch} is not merged and is kept` : ""}.`;

  const status = (): ReactNode => {
    if (!origin) return "This session is no longer open.";
    if (state.status === "unknown") return "This session's folder is not known yet.";
    if (firstLoad || !folder) return "Reading worktrees…";
    const where = <span title={folder}>{compactPath(folder)}</span>;
    if (state.status === "error") return <>Could not read {where}</>;
    return <>
      <strong>{plural(total, "worktree")}</strong>
      {repos.length > 1 ? ` in ${plural(repos.length, "repository", "repositories")}` : ""} in {where} on {origin.device}
    </>;
  };

  // What the list shows: a reason it cannot, the repositories found, or why none matched.
  const body = (): ReactNode => {
    if (!origin) return <Empty icon={FolderGit2} heading="This session is no longer open" text="Open Worktrees from a session's top bar to see the worktrees of its repository." />;
    if (state.status === "unknown") {
      return <Empty icon={FolderGit2} heading="This session's folder is not known yet" text="It shows up once the session has been read. Try again in a moment." action={{ label: "Try again", run: reload }} />;
    }
    if (state.status === "error") {
      return <div className="as-device-error wtm-error" role="alert">
        <TriangleAlert size={14} aria-hidden="true" />
        <span><strong>Could not read the repositories</strong>{state.message}</span>
        <button type="button" className="btn btn-sm" onClick={reload}>Try again</button>
      </div>;
    }
    if (firstLoad) return <Skeleton />;
    // Not an error: the folder is simply outside Git with no repositories in it.
    if (!repos.length) {
      return <Empty icon={FolderGit2} heading="No Git repositories here"
        text={`${folder ? compactPath(folder) : "This folder"} is not inside a Git repository and has no repositories directly inside it. Worktrees show up for a session working in a repository or in a folder of projects.`} />;
    }
    if (filtered && !shownTotal) {
      return <Empty icon={Search} heading={query ? `Nothing matches "${text.trim()}"` : "No worktrees for this filter"} text="Widen the search to find it:" actions={[
        ...(query ? [{ label: "Clear search", run: () => { setText(""); searchRef.current?.focus(); } }] : []),
        ...(facet !== "all" ? [{ label: "All worktrees", run: () => setFacet("all") }] : []),
      ]} />;
    }
    return shown.filter(({ repo, worktrees }) => !filtered || worktrees.length || repo.error).map(({ repo, worktrees }) => <RepoSection
      key={repo.key} repo={repo} worktrees={worktrees} filtered={filtered} onRetry={reload}
      row={(worktree) => <WorktreeRow key={worktree.path} repo={repo} worktree={worktree} blocked={blocker(repo, worktree)} busy={busy}
        current={isHere(worktree)}
        onLand={(request) => void land(request)} onRemove={() => void remove([{ repo, worktree }], removeMessage(worktree))} />}
    />);
  };

  return <Modal open onClose={onClose} title="Worktrees" icon={FolderGit2} size="xl" className="wtm-modal" pending={busy !== null} initialFocusRef={searchRef}>
    <div className="wtm">
      <div className="as-bar">
        <label className="as-search">
          <Search size={14} aria-hidden="true" />
          <input
            ref={searchRef} type="search" value={text} onChange={(event) => setText(event.target.value)}
            // Escape clears the search first; the dialog closes on the next one.
            onKeyDown={(event) => { if (event.key === "Escape" && text) { event.preventDefault(); setText(""); } }}
            placeholder="Search branches, folders or tasks" aria-label="Search worktrees" autoComplete="off" spellCheck={false}
          />
        </label>
        {removable.length ? <button type="button" className="btn btn-sm" aria-disabled={busy !== null || undefined}
          title="Removes every merged worktree no tile works in, with its merged branch"
          onClick={() => void remove(removable, `Removes ${removable.length} merged worktree folder${removable.length === 1 ? "" : "s"} and their merged branches. Git refuses anything with uncommitted or unmerged work.`)}>
          <Trash2 size={13} aria-hidden="true" />
          Clean up {removable.length} merged
        </button> : null}
        <IconButton icon={RefreshCw} title="Read again" size={14} spin={loading && revision > 0} disabled={!origin || loading} onClick={reload} />
      </div>
      {total ? <div className="as-agents" role="group" aria-label="Show">
        {([["all", "All"], ["open", "Not merged"], ["merged", "Merged"]] as const).map(([id, label]) => <button key={id} type="button"
          className={`as-chip ${facet === id ? "on" : ""}`} aria-pressed={facet === id} onClick={() => setFacet(id)}>
          {label}<span className="as-chip-count">{counts[id].toLocaleString()}</span>
        </button>)}
      </div> : null}

      <div className="as-status" aria-live="polite"><span>{status()}</span></div>

      <div className={`wtm-list${loading && !firstLoad ? " is-stale" : ""}`} aria-busy={loading || undefined}>{body()}</div>

      <footer className="as-foot">
        <div className="as-foot-info" aria-live="polite">
          {note ? <span className={`as-banner is-${note.failed ? "error" : "ok"}`} role={note.failed ? "alert" : "status"}>
            {note.failed ? <TriangleAlert size={13} aria-hidden="true" /> : null}
            <span>{note.text}{note.url ? <>{" "}<button type="button" className="wt-link" onClick={() => { if (note.url) openWebPage(note.url); }}>{note.url}</button></> : null}</span>
          </span>
            : <span className="as-reason"><Info size={13} aria-hidden="true" />Start an agent in a new worktree with Worktree in New session. Merged worktrees can be removed with their branch.</span>}
        </div>
      </footer>
    </div>
  </Modal>;
}

// ------------------------------------------------------------------- parts

function RepoSection({ repo, worktrees, filtered, onRetry, row }: {
  repo: Repo; worktrees: GitWorktree[]; filtered: boolean;
  onRetry(): void; row(worktree: GitWorktree): ReactNode;
}) {
  return <section className="wtm-repo" aria-label={`${folderName(repo.root)}, ${plural(repo.worktrees.length, "worktree")}`}>
    <div className="wtm-repo-head">
      <FolderGit2 size={13} className="wtm-repo-icon" aria-hidden="true" />
      <span className="wtm-repo-name">{folderName(repo.root)}</span>
      <span className="wtm-repo-path" title={repo.root}>{compactPath(repo.root)}</span>
      {repo.base ? <span className="as-badge wtm-repo-base" title={`Worktrees merge into ${repo.base}`}><GitBranch size={10} aria-hidden="true" />{repo.base}</span> : null}
      <span className="wtm-repo-count">{(filtered ? worktrees.length : repo.worktrees.length).toLocaleString()}</span>
      {repo.error ? null : <SetupDropdown host={repo.host} root={repo.root} />}
    </div>
    {repo.error ? <div className="as-device-error wtm-error" role="alert">
      <TriangleAlert size={14} aria-hidden="true" />
      <span><strong>Could not read its worktrees</strong>{repo.error}</span>
      <button type="button" className="btn btn-sm" onClick={onRetry}>Try again</button>
    </div>
      : worktrees.length ? worktrees.map(row)
        : <p className="wtm-none">No extra worktrees. Sessions started with Worktree in New session show up here.</p>}
  </section>;
}

function WorktreeRow({ repo, worktree, blocked, busy, current, onLand, onRemove }: {
  repo: Repo; worktree: GitWorktree; blocked: string | null; busy: string | null; current: boolean;
  onLand(request: LandRequest): void; onRemove(): void;
}) {
  const merge = worktree.merged ? `${MERGE_LABELS[worktree.mergedBy ?? "ancestor"]} into ${repo.base ?? "the main branch"}` : "Not merged";
  const label = worktree.branch ?? worktree.path;
  // A task's worktree lands from its task window, which also offers to commit.
  const task = worktreeTask(repo.host, worktree.path)?.task.title;
  const viaTask = task ? `Part of the task "${task}": opens its land checks` : null;
  const prWhy = !worktree.branch ? "it is on a detached HEAD" : null;
  const mergeWhy = !worktree.branch ? "it is on a detached HEAD" : !repo.base ? "the base branch is unknown"
    : worktree.merged ? `it is already in ${repo.base}` : worktree.dirty && !task ? "it has uncommitted changes" : null;
  const start = (kind: LandRequest["kind"]) => {
    if (worktree.branch) onLand({ kind, host: repo.host, path: worktree.path, branch: worktree.branch, base: repo.base });
  };
  const Icon = worktree.merged ? GitMerge : GitBranch;
  return <div className={`wtm-row${current ? " is-current" : ""}`}>
    <span className={`wtm-row-icon${worktree.merged ? " is-merged" : ""}`} aria-hidden="true"><Icon size={15} /></span>
    <span className="wtm-row-main">
      <span className="wtm-row-head">
        <span className="wtm-row-title" title={worktree.branch ?? worktree.head}>{worktree.branch ?? `detached ${worktree.head.slice(0, 7)}`}</span>
        {current ? <span className="as-badge">This session</span> : null}
        {task ? <span className="as-badge wtm-task" title={`Task: ${task}`}><ListTodo size={10} aria-hidden="true" />{task}</span> : null}
      </span>
      <span className="wtm-row-meta" title={[merge, blocked, worktree.path].filter(Boolean).join(" · ")}>
        <span className={worktree.merged ? "wtm-merged" : undefined}>{merge}</span>
        {blocked ? <span className="wtm-blocker">{blocked}</span> : null}
        <span className="wtm-row-path">{compactPath(worktree.path)}</span>
      </span>
    </span>
    <span className="wtm-row-actions">
      <RowAction icon={GitPullRequestCreateArrow} text="Open PR" label={viaTask ?? `Push ${worktree.branch ?? "the branch"} and open a pull request`}
        ariaLabel={`Open pull request for ${label}`} reason={prWhy ? `Can't open a pull request: ${prWhy}` : null}
        busy={busy === `pr:${worktree.path}`} locked={busy !== null} onClick={() => start("pr")} />
      <RowAction icon={GitMerge} text="Merge" label={viaTask ?? `Merge into ${repo.base ?? "the base branch"} in the main checkout`}
        ariaLabel={`Merge ${label} into ${repo.base ?? "the base branch"}`} reason={mergeWhy ? `Can't merge: ${mergeWhy}` : null}
        busy={busy === `merge:${worktree.path}`} locked={busy !== null} onClick={() => start("merge")} />
      <RowAction icon={Trash2} danger label={worktree.merged ? "Remove the folder and its merged branch" : "Remove the folder (the unmerged branch is kept)"}
        ariaLabel={`Remove worktree ${label}`} reason={blocked ? `Can't remove: ${blocked.toLowerCase()}` : null}
        busy={busy === `remove:${worktree.path}`} locked={busy !== null} onClick={onRemove} />
    </span>
  </div>;
}

// A row button that stays focusable and explains itself when it cannot run.
function RowAction({ icon: Icon, text, label, ariaLabel, reason, busy, locked, danger = false, onClick }: {
  icon: LucideIcon; text?: string; label: string; ariaLabel: string; reason: string | null; busy: boolean; locked: boolean; danger?: boolean; onClick(): void;
}) {
  const blocked = reason !== null || locked;
  return <button type="button" className={`wtm-btn${text ? " has-text" : ""}${danger ? " is-danger" : ""}${blocked ? " is-blocked" : ""}`}
    aria-disabled={blocked || undefined} aria-busy={busy || undefined} title={reason ?? label} aria-label={ariaLabel}
    onClick={() => { if (!blocked) onClick(); }}>
    {busy ? <Loader2 size={12} className="async-spinner" aria-hidden="true" /> : <Icon size={12} aria-hidden="true" />}
    {text ? <span>{text}</span> : null}
  </button>;
}

interface EmptyAction { label: string; run(): void }

function Empty({ icon: Icon, heading, text, action, actions = action ? [action] : [] }: { icon: LucideIcon; heading: string; text: string; action?: EmptyAction; actions?: EmptyAction[] }) {
  return <div className="as-empty">
    <span className="as-empty-icon" aria-hidden="true"><Icon size={20} /></span>
    <strong>{heading}</strong>
    <p>{text}</p>
    {actions.length ? <div className="as-empty-actions">
      {actions.map((item) => <button key={item.label} type="button" className="btn btn-sm" onClick={item.run}>{item.label}</button>)}
    </div> : null}
  </div>;
}

function Skeleton() {
  return <div className="as-skeleton" aria-hidden="true">
    <div className="as-skel-head" />
    {Array.from({ length: SKELETON_ROWS }, (_, index) => <div key={index} className="as-skel-row" style={{ animationDelay: `${index * 70}ms` }}>
      <span className="as-skel-icon" /><span className="as-skel-lines"><span style={{ width: `${56 - (index % 3) * 12}%` }} /><span /></span><span className="as-skel-time" />
    </div>)}
  </div>;
}

const setupLines = (text: string) => text.split("\n").map((line) => line.trim()).filter(Boolean);

// A repository's .pzzacode/worktree.json, kept in its main checkout: untracked
// files to copy into each new worktree and commands typed into its terminal
// before the agent starts. Saving approves the commands on this device; a
// file changed elsewhere (a pull, a teammate) needs an explicit approval first.
// The repository's Setup button and its dropdown: the editor opens anchored
// under the button, above the dialog (portaled like a Select list, so the
// dialog keeps focus inside it and Escape closes only the dropdown). A click
// outside, a window resize or a blur closes it.
const SETUP_WIDTH = 440;
function SetupDropdown({ host, root }: { host: string; root: string }) {
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const close = () => setAnchor(null);
  useEffect(() => {
    if (!anchor) return;
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => { window.removeEventListener("resize", close); window.removeEventListener("blur", close); };
  }, [anchor]);
  // Right-aligned under the button, kept on screen; above it when there is no room below.
  useLayoutEffect(() => {
    const element = panel.current;
    if (!anchor || !element) return;
    const place = () => {
      const width = Math.min(SETUP_WIDTH, window.innerWidth - 24);
      const height = element.offsetHeight;
      element.style.width = `${width}px`;
      element.style.left = `${Math.max(12, Math.min(anchor.right - width, window.innerWidth - width - 12))}px`;
      const below = anchor.bottom + 6;
      element.style.top = `${below + height > window.innerHeight - 12 ? Math.max(12, anchor.top - height - 6) : below}px`;
    };
    place();
    // The editor grows as it loads and as its fields grow.
    const observer = new ResizeObserver(place);
    observer.observe(element);
    return () => observer.disconnect();
  }, [anchor]);
  return <>
    <button ref={trigger} type="button" className={`wtm-setup-toggle${anchor ? " on" : ""}`} aria-expanded={anchor !== null} aria-haspopup="dialog"
      title="Setup for new worktrees: files to copy and commands to run before the agent"
      onClick={() => setAnchor(anchor ? null : trigger.current?.getBoundingClientRect() ?? null)}>
      <SlidersHorizontal size={12} aria-hidden="true" />Setup
    </button>
    {anchor ? createPortal(<div className="cselect-backdrop pzza-portal" onMouseDown={close}>
      <div ref={panel} className="menu wtm-setup-pop" role="dialog" aria-label="Setup for new worktrees" onMouseDown={(event) => event.stopPropagation()}>
        <WorktreeSetupEditor host={host} root={root} />
      </div>
    </div>, document.body) : null}
  </>;
}

function WorktreeSetupEditor({ host, root }: { host: string; root: string }) {
  const [setup, setSetup] = useState<WorktreeSetup | null>(null);
  const [copyText, setCopyText] = useState("");
  const [runText, setRunText] = useState("");
  const copyRef = useRef<HTMLTextAreaElement>(null);
  const runRef = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(copyRef, copyText, { minLines: 3, maxLines: 8 });
  useAutoGrow(runRef, runText, { minLines: 2, maxLines: 8 });
  const [status, setStatus] = useState<{ text: string; failed: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const id = useId();
  const show = (value: WorktreeSetup) => { setSetup(value); setCopyText(value.copy.join("\n")); setRunText(value.run.join("\n")); };
  const fail = (error: unknown, fallback: string) => setStatus({ text: errorText(error, fallback), failed: true });

  useEffect(() => {
    const controller = new AbortController();
    fetchWorktreeSetup(host, root, controller.signal).then(show, (error: unknown) => { if (!controller.signal.aborted) fail(error, "Worktree setup unavailable"); });
    return () => controller.abort();
  }, [host, root]);

  if (!setup) {
    return <div className="wtm-setup">
      {status ? <p className="wtm-setup-note is-error" role="alert">{status.text}</p>
        : <p className="wtm-setup-note"><Loader2 size={12} className="sw-spin" aria-hidden="true" /> Reading setup…</p>}
    </div>;
  }
  const copy = setupLines(copyText);
  const run = setupLines(runText);
  const changed = copy.join("\n") !== setup.copy.join("\n") || run.join("\n") !== setup.run.join("\n");
  const pending = setup.run.length > 0 && !setup.approved && !setup.error && !changed;
  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      // Untouched default patterns stay implicit, so the file only lists what was chosen.
      const saved = await saveWorktreeSetup(host, root, setup.defaultCopy && copy.join("\n") === setup.copy.join("\n") ? null : copy, run);
      show(saved);
      setStatus({ text: `Saved ${saved.file} in the main checkout. Commit it to share this setup.`, failed: false });
    } catch (error) {
      fail(error, "Could not save the worktree setup");
    } finally {
      setSaving(false);
    }
  };
  const approve = async () => {
    setSaving(true);
    setStatus(null);
    try {
      show(await approveWorktreeSetup(host, root, setup.run));
      setStatus({ text: "Approved. New worktrees run these commands before the agent.", failed: false });
    } catch (error) {
      fail(error, "Could not approve the setup commands");
    } finally {
      setSaving(false);
    }
  };

  return <div className="wtm-setup" role="group" aria-label="Setup for new worktrees">
    <p className="wtm-setup-note">
      {setup.exists ? <>From <code>{setup.file}</code> in the main checkout.</> : <>No <code>{setup.file}</code> yet: ignored <code>.env*</code> files at the repository root are copied.</>}
    </p>
    {setup.error ? <p className="wtm-setup-note is-error">{setup.error}</p> : null}
    <label className="wtm-setup-label" htmlFor={`${id}-copy`}>Copy from the main checkout <span className="field-hint">untracked files, one glob per line</span></label>
    <textarea ref={copyRef} id={`${id}-copy`} className="field-input wtm-setup-input" rows={3} spellCheck={false} value={copyText} onChange={(event) => setCopyText(event.target.value)} />
    <label className="wtm-setup-label" htmlFor={`${id}-run`}>Run before the agent <span className="field-hint">one command per line, shown in the terminal</span></label>
    <textarea ref={runRef} id={`${id}-run`} className="field-input wtm-setup-input" rows={2} spellCheck={false} placeholder="e.g. npm install" value={runText} onChange={(event) => setRunText(event.target.value)} />
    {pending ? <p className="wtm-setup-note is-pending">These commands are not approved on this device yet, so new worktrees skip them.</p> : null}
    <div className="wtm-setup-actions">
      {pending ? <button type="button" className="btn btn-sm" disabled={saving} onClick={() => void approve()}>
        <ShieldCheck size={13} aria-hidden="true" />
        Approve commands
      </button> : null}
      <button type="button" className="btn btn-sm" disabled={!changed || saving} onClick={() => void save()}>
        {saving ? <Loader2 size={13} className="sw-spin" aria-hidden="true" /> : <Save size={13} aria-hidden="true" />}
        Save setup
      </button>
    </div>
    {status ? <p className={`wtm-setup-note${status.failed ? " is-error" : ""}`} role="status">{status.text}</p> : null}
  </div>;
}
