import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { Check, ChevronDown, ChevronUp, CircleSlash, Loader2, MessageSquare } from "lucide-react";
import { answerPermission, CLIPPED_MESSAGE, pendingForNotice, usePermissionPrompts, type PendingPermission } from "../state/permissionPrompts";
import { declinesPermission, permissionAgentLabel, sanitizePermissionFeedback, type PermissionChoice } from "../terminal/permissionPrompts";
import type { Notice, PermissionOutcome } from "../state/notifications";
import "./PermissionPrompt.css";

// Answers for an agent's approval prompt: the same choices its terminal
// offers, as buttons in notification rows, for agents waiting in tiles that
// are hidden, in another workspace or not the one in view. A visible tile
// shows the agent's own prompt, answered there with the keyboard.

const FEEDBACK_MAX = 300;

function choiceClass(choice: PermissionChoice): string {
  if (choice.role === "allow") return "perm-btn perm-btn-allow";
  if (choice.role === "deny" || choice.role === "deny-feedback") return "perm-btn perm-btn-deny";
  return "perm-btn";
}

function ChoiceIcon({ choice }: { choice: PermissionChoice }) {
  if (choice.role === "allow") return <Check size={13} aria-hidden="true" />;
  if (choice.role === "deny-feedback") return <MessageSquare size={13} aria-hidden="true" />;
  if (choice.role === "deny") return <CircleSlash size={13} aria-hidden="true" />;
  return null;
}

function Subject({ entry, lines }: { entry: PendingPermission; lines: number }) {
  const ref = useRef<HTMLElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const text = entry.prompt.subject;
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1 || element.scrollWidth > element.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text, expanded]);
  if (!text) return null;
  return <div className="perm-subject-wrap">
    <code ref={ref} className={`perm-subject ${expanded ? "is-expanded" : ""}`} style={{ WebkitLineClamp: expanded ? "unset" : lines }} title={expanded ? undefined : text}>{text}</code>
    {overflows || expanded ? <button type="button" className="perm-link" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
      {expanded ? <>Show less <ChevronUp size={12} aria-hidden="true" /></> : <>Show all <ChevronDown size={12} aria-hidden="true" /></>}
    </button> : null}
  </div>;
}

function Feedback({ entry, choice, onCancel }: { entry: PendingPermission; choice: PermissionChoice; onCancel(): void }) {
  const [text, setText] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const agent = permissionAgentLabel(entry.prompt.agent);
  useEffect(() => { input.current?.focus(); }, []);
  const busy = entry.phase !== "waiting";
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    void answerPermission(entry.tileId, entry.id, choice.id, sanitizePermissionFeedback(text));
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onCancel(); }
  };
  return <form className="perm-feedback" onSubmit={submit}>
    <input ref={input} className="perm-feedback-input" value={text} maxLength={FEEDBACK_MAX} disabled={busy}
      placeholder={`Tell ${agent} what to do instead`} aria-label={`Tell ${agent} what to do instead`}
      onChange={event => setText(event.target.value)} onKeyDown={onKeyDown} />
    <button type="submit" className="perm-btn perm-btn-deny" disabled={busy}>{text.trim() ? "Deny and send" : "Deny"}</button>
    <button type="button" className="perm-btn perm-btn-quiet" onClick={onCancel}>Cancel</button>
  </form>;
}

function Status({ entry }: { entry: PendingPermission }) {
  if (entry.error) return <p className="perm-status perm-status-error" role="alert">{entry.error}</p>;
  if (entry.phase === "sending") return <p className="perm-status" role="status"><Loader2 size={12} className="perm-spin" aria-hidden="true" /> Checking the terminal</p>;
  if (entry.phase === "sent") return <p className="perm-status" role="status"><Loader2 size={12} className="perm-spin" aria-hidden="true" /> Sent {entry.sentLabel ? `“${entry.sentLabel}”` : "the answer"}. Waiting for the agent</p>;
  if (entry.prompt.clipped) return <p className="perm-status" role="status">{CLIPPED_MESSAGE}</p>;
  return null;
}

/** The choice buttons for one pending prompt, with the inline feedback field. Buttons show short labels; the agent's full option text is their name. */
function Choices({ entry }: { entry: PendingPermission }) {
  const [feedbackFor, setFeedbackFor] = useState<string | null>(null);
  const busy = entry.phase !== "waiting";
  // A cut-off input cannot be approved from here: part of it is unreadable.
  // Declining approves nothing, so it stays available.
  const blocked = (choice: PermissionChoice) => !!entry.prompt.clipped && !declinesPermission(choice);
  const feedbackChoice = entry.prompt.choices.find(choice => choice.id === feedbackFor);
  useEffect(() => { setFeedbackFor(null); }, [entry.id]);
  if (feedbackChoice) return <Feedback entry={entry} choice={feedbackChoice} onCancel={() => setFeedbackFor(null)} />;
  return <div className="perm-choices" role="group" aria-label="Answers">
    {entry.prompt.choices.map(choice => <button key={choice.id} type="button" className={choiceClass(choice)} disabled={busy || blocked(choice)}
      title={choice.label === choice.shortLabel ? undefined : choice.label}
      aria-label={choice.label}
      onClick={() => {
        if (choice.role === "deny-feedback") setFeedbackFor(choice.id);
        else void answerPermission(entry.tileId, entry.id, choice.id);
      }}>
      <ChoiceIcon choice={choice} /><span>{choice.shortLabel}</span>
    </button>)}
  </div>;
}

const outcomeCopy: Record<PermissionOutcome, string> = {
  answered: "Answered from here",
  elsewhere: "Already answered in the terminal",
  closed: "No longer waiting",
  interrupted: "Not finished from here. Check the terminal",
  unverified: "Not sent: this pane could not be confirmed to run the agent. Answer in the terminal",
};

/** Choices or outcome for a notification about an approval prompt. */
export function PermissionNoticeActions({ notice }: { notice: Notice }) {
  const action = notice.action?.kind === "permission" ? notice.action : undefined;
  const entry = usePermissionPrompts(state => action ? pendingForNotice(state, notice.target?.tileId, action.promptId) : undefined);
  if (!action) return null;
  if (entry) return <div className="perm-notice">
    <Subject entry={entry} lines={3} />
    <Choices entry={entry} />
    <Status entry={entry} />
  </div>;
  const outcome = action.outcome ?? "closed";
  return <p className={`perm-outcome perm-outcome-${outcome}`}>
    {outcome === "answered" ? <Check size={12} aria-hidden="true" /> : <CircleSlash size={12} aria-hidden="true" />}
    {outcome === "answered" && action.choice ? `Answered “${action.choice}” from here` : outcomeCopy[outcome]}
  </p>;
}

/** Whether a notice is an approval prompt that can still be answered. */
export function useNoticeWaiting(notice: Notice): boolean {
  const action = notice.action?.kind === "permission" ? notice.action : undefined;
  return usePermissionPrompts(state => !!action && !!pendingForNotice(state, notice.target?.tileId, action.promptId));
}
