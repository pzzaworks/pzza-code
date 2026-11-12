import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { CircleCheck, GitCommitHorizontal, LoaderCircle, ShieldCheck, Trash2, TriangleAlert } from "lucide-react";
import { AgentIcon } from "../icons/AgentIcon";
import { Modal } from "../ui/Modal";
import { fetchGitChanges, type GitChangedFile } from "../serverApi";
import { previewTaskDiscard, type DiscardPreview } from "./taskApi";
import { findCandidate, useTasks, useTasksUi, type TaskCandidate } from "./taskStore";
import { commitCandidate, discardCandidate } from "./taskActions";
import { agentName } from "./TaskParts";
import { PanelHead } from "./TasksPanel";

// The steps of a task that need a closer look: committing an attempt's
// worktree (in place in the dropdown, or as a dialog over the task window)
// and discarding attempts after showing exactly what would be lost (a
// confirmation over the task window, like a checkpoint restore).

const MAX_LISTED = 8;
const STATUS_MARK = (status: string) => status[0].toUpperCase();

// The message and the files a commit takes; `actions` renders the buttons where the host wants them.
function useCommit(taskId: string, candidateId: string, onDone: () => void) {
  const found = findCandidate(taskId, candidateId);
  const task = found?.task;
  const candidate = found?.candidate;
  const [message, setMessage] = useState(task?.title.slice(0, 300) ?? "");
  const [files, setFiles] = useState<GitChangedFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!task || !candidate) return;
    const controller = new AbortController();
    fetchGitChanges(task.host, candidate.worktree, controller.signal).then((changes) => setFiles(changes.files)).catch((cause: unknown) => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "Could not read the changes.");
    });
    return () => controller.abort();
  }, [task?.host, candidate?.worktree]);
  const kept = new Set(candidate?.copied ?? []);
  const committed = files?.filter((file) => !kept.has(file.path)) ?? [];
  const excluded = files?.filter((file) => kept.has(file.path)) ?? [];
  const valid = message.trim().length > 0 && message.length <= 300 && !/[\u0000-\u001f\u007f]/.test(message);
  const ready = !!task && !!candidate && valid && !busy && committed.length > 0;
  const commit = async () => {
    if (!ready || !task || !candidate) return;
    setBusy(true);
    setError(null);
    try {
      const sha = await commitCandidate(task, candidate, message);
      onDone();
      useTasksUi.getState().say({ text: `Committed ${committed.length} ${committed.length === 1 ? "file" : "files"} as ${sha.slice(0, 7)}.`, failed: false });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not commit.");
    } finally {
      setBusy(false);
    }
  };
  const body: ReactNode = (
    <>
      <div className="ns-composer">
        <div className="ns-composer-line">
          <GitCommitHorizontal size={16} className="muted-icon" aria-hidden="true" />
          <input className="ns-input" value={message} maxLength={300} aria-label="Commit message" disabled={busy} autoFocus
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setMessage(event.target.value.replace(/[\r\n]+/g, " "))}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void commit(); } }} />
        </div>
      </div>
      {files === null && !error ? <p className="cp-note"><LoaderCircle size={14} className="sw-spin" aria-hidden="true" /> Reading the changes…</p> : null}
      {files ? (
        <div className="task-file-card">
          <p className="set-note">{committed.length} {committed.length === 1 ? "file" : "files"} will be committed with git add -A; hooks run as usual.</p>
          <ul className="cp-confirm-files">{committed.slice(0, 12).map((file) => <li key={file.path}><span className={`code-changes-status code-changes-status-${file.status}`} aria-hidden="true">{STATUS_MARK(file.status)}</span><span className="cp-confirm-path" title={file.path}>{file.path}</span></li>)}</ul>
          {committed.length > 12 ? <p className="set-note">and {committed.length - 12} more</p> : null}
          {excluded.length ? <p className="set-note">Left out, copied by the worktree setup: {excluded.map((file) => file.path).join(", ")}</p> : null}
        </div>
      ) : null}
      {error ? <p className="ns-error" role="alert">{error}</p> : null}
    </>
  );
  const button = (
    <button type="button" className="btn btn-sm btn-accent" disabled={!ready} aria-busy={busy || undefined} onClick={() => void commit()}>
      {busy ? <LoaderCircle size={12} className="sw-spin" aria-hidden="true" /> : <GitCommitHorizontal size={12} aria-hidden="true" />}Commit
    </button>
  );
  return { exists: !!task && !!candidate, body, button, busy };
}

/** Commit in place in the dropdown. */
export function CommitView({ taskId, candidateId }: { taskId: string; candidateId: string }) {
  const leave = () => useTasksUi.getState().go({ kind: "task", taskId });
  const commit = useCommit(taskId, candidateId, leave);
  if (!commit.exists) return null;
  return (
    <section className="task-step" aria-label="Commit the changes">
      <PanelHead title="Commit the changes" view={{ kind: "commit", taskId, candidateId }} />
      {commit.body}
      <div className="usage-footer task-actions">
        <span />
        <button type="button" className="btn btn-sm" onClick={leave} disabled={commit.busy}>Cancel</button>
        {commit.button}
      </div>
    </section>
  );
}

/** Commit as a dialog over the task window. */
export function CommitDialog({ taskId, candidateId, onClose }: { taskId: string; candidateId: string; onClose(): void }) {
  const commit = useCommit(taskId, candidateId, onClose);
  if (!commit.exists) return null;
  return (
    <Modal open onClose={onClose} title="Commit the changes" icon={GitCommitHorizontal} size="md" className="cp-confirm" pending={commit.busy}>
      {commit.body}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose} disabled={commit.busy}>Cancel</button>
        {commit.button}
      </div>
    </Modal>
  );
}

export interface DiscardRequest { taskId: string; candidateIds: string[]; afterLanding?: boolean }
type PreviewState = { status: "loading" } | { status: "ready"; preview: DiscardPreview } | { status: "error"; error: string };

/** Discarding attempts, over the task window: each one's unmerged commits and changes are listed first. */
export function DiscardDialog({ request, onClose }: { request: DiscardRequest; onClose(): void }) {
  const task = useTasks((state) => state.tasks.find((item) => item.id === request.taskId));
  const candidates = task?.candidates.filter((candidate) => request.candidateIds.includes(candidate.id)) ?? [];
  const [previews, setPreviews] = useState<Record<string, PreviewState>>(() => Object.fromEntries(candidates.map((candidate) => [candidate.id, { status: "loading" } as PreviewState])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const description = useId();
  const preview = (candidate: TaskCandidate, signal?: AbortSignal) => {
    if (!task) return;
    previewTaskDiscard(task.host, candidate.worktree, task.base, signal)
      .then((result) => { if (!signal?.aborted) setPreviews((current) => ({ ...current, [candidate.id]: { status: "ready", preview: result } })); })
      .catch((cause: unknown) => { if (!signal?.aborted) setPreviews((current) => ({ ...current, [candidate.id]: { status: "error", error: cause instanceof Error ? cause.message : "Could not read the worktree." } })); });
  };
  useEffect(() => {
    const controller = new AbortController();
    for (const candidate of candidates) preview(candidate, controller.signal);
    return () => controller.abort();
  }, []);
  if (!task || !candidates.length) return null;
  const states = candidates.map((candidate) => previews[candidate.id]);
  const loading = states.some((state) => !state || state.status === "loading");
  const unmerged = states.some((state) => state?.status === "ready" && !state.preview.locked && (state.preview.commits.length > 0 || state.preview.uncommitted.length > 0));
  // git worktree remove deletes ignored files too (dependencies, build
  // output, local settings): they are listed, never called safe.
  const ignoredDeleted = states.some((state) => state?.status === "ready" && !state.preview.locked && state.preview.ignored.length > 0);
  const discard = async () => {
    setBusy(true);
    setError(null);
    const failures: string[] = [];
    const kept: string[] = [];
    const retry: TaskCandidate[] = [];
    for (const candidate of candidates) {
      const state = previews[candidate.id];
      try {
        // A worktree that could not be read is kept; only its session closes.
        const outcome = await discardCandidate(task, candidate, state?.status === "ready" && !state.preview.locked ? state.preview : null);
        if (outcome === "kept") kept.push(agentName(candidate));
      } catch (cause) {
        failures.push(`${agentName(candidate)}: ${cause instanceof Error ? cause.message : "could not discard"}`);
        retry.push(candidate);
      }
    }
    setBusy(false);
    if (failures.length) {
      // Show what is there now: the worktree changed, or the session is gone and it can be removed now.
      setError(`${failures.join(" ")} Review the list again before discarding.`);
      for (const candidate of retry) setPreviews((current) => ({ ...current, [candidate.id]: { status: "loading" } }));
      for (const candidate of retry) preview(candidate);
      return;
    }
    const removed = candidates.length - kept.length;
    onClose();
    useTasksUi.getState().say({
      text: [removed ? `Discarded ${removed} ${removed === 1 ? "attempt" : "attempts"}.` : "", kept.length ? `Closed the session of ${kept.join(", ")}; ${kept.length === 1 ? "its worktree was" : "their worktrees were"} kept.` : ""].filter(Boolean).join(" "),
      failed: false,
    });
  };
  const title = request.afterLanding ? `Discard the other ${candidates.length === 1 ? "attempt" : `${candidates.length} attempts`}?` : `Discard ${candidates.length === 1 ? agentName(candidates[0]) : `${candidates.length} attempts`}?`;
  return (
    <Modal open onClose={onClose} title={title} icon={TriangleAlert} role="alertdialog" size="md" className="cp-confirm" pending={busy} initialFocusRef={cancel} describedBy={description}>
      <p id={description} className="cp-confirm-lead">
        {request.afterLanding ? "The pick has landed. " : ""}Each session closes and its worktree folder and pzza/ branch are deleted. {unmerged ? `The commits and changes listed below are not in ${task.base} and are deleted for good.` : `Every branch is already in ${task.base}, so no commits or changes are lost.`}{ignoredDeleted ? " The ignored files listed below (dependencies, build output, local settings) are deleted with their worktree." : ""}
      </p>
      {candidates.map((candidate) => {
        const state = previews[candidate.id];
        return (
          <section key={candidate.id} className="task-discard-item" aria-label={agentName(candidate)}>
            <div className="cp-detail-meta">
              <span className="cp-detail-agent"><AgentIcon id={candidate.agent.id} size={12} />{agentName(candidate)}</span>
              <code className="cp-detail-branch">{state?.status === "ready" ? state.preview.branch : candidate.branch}</code>
            </div>
            {!state || state.status === "loading" ? <p className="cp-note"><LoaderCircle size={14} className="sw-spin" aria-hidden="true" /> Checking for unmerged work…</p>
              : state.status === "error" ? <p className="cp-detail-warn"><TriangleAlert size={12} aria-hidden="true" />{state.error} Its folder is kept; only the session closes.</p>
                : state.preview.locked ? <p className="cp-detail-warn"><TriangleAlert size={12} aria-hidden="true" />This worktree is locked (git worktree lock), so it is kept; only the session closes.</p>
                  : (
                    <>
                      {!state.preview.commits.length && !state.preview.uncommitted.length ? <p className="cp-confirm-safe"><CircleCheck size={13} aria-hidden="true" />No unmerged commits or uncommitted changes.</p> : null}
                      {state.preview.commits.length || state.preview.uncommitted.length || state.preview.ignored.length ? (
                        <ul className="cp-confirm-files task-loss" aria-label={`What ${agentName(candidate)} would lose`}>
                          {state.preview.commits.length ? <li className="cp-confirm-more">{state.preview.commits.length} {state.preview.commits.length === 1 ? "commit" : "commits"} not in {state.preview.base ?? task.base}</li> : null}
                          {state.preview.commits.slice(0, MAX_LISTED).map((commit) => <li key={commit.sha}><code className="cp-confirm-action">{commit.sha.slice(0, 7)}</code><span className="cp-confirm-path" title={commit.subject}>{commit.subject}</span></li>)}
                          {state.preview.uncommitted.length ? <li className="cp-confirm-more">{state.preview.uncommitted.length}{state.preview.truncated ? "+" : ""} uncommitted {state.preview.uncommitted.length === 1 ? "change" : "changes"}</li> : null}
                          {state.preview.uncommitted.slice(0, MAX_LISTED).map((file) => <li key={file.path}><span className={`code-changes-status code-changes-status-${file.status}`} aria-hidden="true">{STATUS_MARK(file.status)}</span><span className="cp-confirm-path" title={file.path}>{file.path}</span></li>)}
                          {state.preview.ignored.length ? <li className="cp-confirm-more">{state.preview.ignored.length}{state.preview.truncated ? "+" : ""} ignored {state.preview.ignored.length === 1 ? "file or folder" : "files and folders"}, deleted with the worktree</li> : null}
                          {state.preview.ignored.slice(0, MAX_LISTED).map((entry) => <li key={`ignored:${entry}`}><span className="cp-confirm-path" title={entry}>{entry}</span></li>)}
                        </ul>
                      ) : null}
                    </>
                  )}
          </section>
        );
      })}
      {unmerged ? null : <p className="cp-confirm-safe"><ShieldCheck size={13} aria-hidden="true" />Only these worktree folders and their pzza/ branches are removed; your main checkout is not touched.</p>}
      {error ? <div className="cp-confirm-alert" role="alert"><TriangleAlert size={14} aria-hidden="true" /><span>{error}</span></div> : null}
      <div className="modal-actions">
        <button type="button" className="btn" ref={cancel} onClick={onClose} disabled={busy}>{request.afterLanding ? "Keep them" : "Cancel"}</button>
        <button type="button" className="btn btn-danger" disabled={loading || busy} aria-busy={busy || undefined} onClick={() => void discard()}>
          {busy ? <LoaderCircle size={13} className="sw-spin" aria-hidden="true" /> : <Trash2 size={13} aria-hidden="true" />}
          {unmerged ? "Delete unmerged work and discard" : "Discard"}
        </button>
      </div>
    </Modal>
  );
}
