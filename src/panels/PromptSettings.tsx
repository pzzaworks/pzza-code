import { useState, type FormEvent, type KeyboardEvent } from "react";
import { ChevronDown, ChevronUp, Pencil, Trash2 } from "lucide-react";
import { addPrompt, deletePrompt, movePrompt, PROMPT_NAME_MAX, PROMPT_TEXT_MAX, PROMPTS_MAX, updatePrompt, usePrompts, type SavedPrompt } from "../state/prompts";
import { confirmAction } from "../ui/ConfirmDialog";
import { COMMAND_PALETTE_SHORTCUT } from "../shortcuts";

// Settings, General, Saved prompts: add, edit, reorder and delete the prompts
// offered in the command palette and the broadcast bar.
function PromptForm({ prompt, submitLabel, onDone, onCancel }: {
  prompt?: SavedPrompt; submitLabel: string; onDone: (name: string, text: string) => void; onCancel?: () => void;
}) {
  const [name, setName] = useState(prompt?.name ?? "");
  const [text, setText] = useState(prompt?.text ?? "");
  const [error, setError] = useState<string | null>(null);
  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    try {
      onDone(name, text);
      if (!prompt) { setName(""); setText(""); }
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The prompt could not be saved.");
    }
  };
  // Prompts are one line: Enter saves instead of starting a new line.
  const onTextKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); submit(); }
    else if (event.key === "Escape" && onCancel) { event.preventDefault(); onCancel(); }
  };
  const prefix = prompt ? "Edit" : "New";
  return <form className="settings-form prompt-form" onSubmit={submit} aria-label={prompt ? `Edit ${prompt.name}` : "Add a prompt"}>
    <label className="settings-field">
      <span className="field-label">Name</span>
      <input className="field-input" aria-label={`${prefix} prompt name`} value={name} maxLength={PROMPT_NAME_MAX} placeholder="Write tests" spellCheck={false}
        onChange={(event) => { setName(event.target.value); setError(null); }} onKeyDown={(event) => { if (event.key === "Escape" && onCancel) { event.preventDefault(); onCancel(); } }} />
    </label>
    <label className="settings-field">
      <span className="field-label">Prompt <span className="field-hint">One line, sent with Enter</span></span>
      <textarea className="field-input prompt-text-input" aria-label={`${prefix} prompt text`} value={text} maxLength={PROMPT_TEXT_MAX} rows={3}
        placeholder="Write tests for the current changes." onChange={(event) => { setText(event.target.value); setError(null); }} onKeyDown={onTextKey} />
    </label>
    {error ? <p className="prompt-error" role="alert">{error}</p> : null}
    <div className="settings-actions">
      {onCancel ? <button type="button" className="btn btn-sm" onClick={onCancel}>Cancel</button> : null}
      <button type="submit" className="btn btn-sm btn-accent" disabled={!name.trim() || !text.trim()}>{submitLabel}</button>
    </div>
  </form>;
}

export function PromptSettings() {
  const prompts = usePrompts((s) => s.prompts);
  const [editing, setEditing] = useState<string | null>(null);
  const remove = async (prompt: SavedPrompt) => {
    if (await confirmAction({ title: "Delete this prompt?", message: `“${prompt.name}” is removed from the command palette and the broadcast bar.`, confirmLabel: "Delete prompt", danger: true })) deletePrompt(prompt.id);
  };
  return <section className="set-section settings-section" aria-label="Saved prompts">
    <h3 className="set-title">Saved prompts</h3>
    <p className="set-note prompt-intro">
      Send one to the active tile from the command palette ({COMMAND_PALETTE_SHORTCUT.label}, type “Prompt”), or pick one in the broadcast bar
      to send it to every selected tile. {prompts.length} of {PROMPTS_MAX} saved.
    </p>
    {prompts.length ? <ol className="prompt-list" aria-label="Saved prompts">
      {prompts.map((prompt, index) => <li key={prompt.id} className="prompt-row">
        {editing === prompt.id
          ? <PromptForm prompt={prompt} submitLabel="Save" onDone={(name, text) => { updatePrompt(prompt.id, name, text); setEditing(null); }} onCancel={() => setEditing(null)} />
          : <>
            <div className="prompt-row-body">
              <span className="prompt-row-name">{prompt.name}</span>
              <span className="prompt-row-text" title={prompt.text}>{prompt.text}</span>
            </div>
            <div className="prompt-row-actions">
              <button type="button" className="tile-btn" aria-label={`Move ${prompt.name} up`} title="Move up" disabled={index === 0} onClick={() => movePrompt(prompt.id, -1)}><ChevronUp size={14} aria-hidden="true" /></button>
              <button type="button" className="tile-btn" aria-label={`Move ${prompt.name} down`} title="Move down" disabled={index === prompts.length - 1} onClick={() => movePrompt(prompt.id, 1)}><ChevronDown size={14} aria-hidden="true" /></button>
              <button type="button" className="tile-btn" aria-label={`Edit ${prompt.name}`} title="Edit" onClick={() => setEditing(prompt.id)}><Pencil size={13} aria-hidden="true" /></button>
              <button type="button" className="tile-btn" aria-label={`Delete ${prompt.name}`} title="Delete" onClick={() => void remove(prompt)}><Trash2 size={13} aria-hidden="true" /></button>
            </div>
          </>}
      </li>)}
    </ol> : <p className="set-note">No saved prompts. Add one below.</p>}
    {prompts.length < PROMPTS_MAX
      ? <>
        <h4 className="prompt-add-title">Add a prompt</h4>
        <PromptForm submitLabel="Add prompt" onDone={(name, text) => { addPrompt(name, text); }} />
      </>
      : <p className="set-note">You have {PROMPTS_MAX} prompts, the most that can be kept. Delete one to add another.</p>}
  </section>;
}
