import { useLayoutEffect, useRef } from "react";
import { confirmEditorDiscard, hasSavingEditors, hasUnsavedEditors } from "../editorChanges";
import { confirmAction } from "./confirmations";

export interface UnsavedDraft {
  label: string;
  dirty: boolean;
  saving?: boolean;
  revision?: string | number;
}
const drafts = new Map<string, () => UnsavedDraft>();

export function registerUnsavedDraft(id: string, read: () => UnsavedDraft): () => void {
  drafts.set(id, read);
  return () => { if (drafts.get(id) === read) drafts.delete(id); };
}

export function useUnsavedDraft(id: string, state: UnsavedDraft): void {
  const latest = useRef(state);
  latest.current = state;
  useLayoutEffect(() => registerUnsavedDraft(id, () => latest.current), [id]);
}

export function hasUnsavedWork(): boolean {
  return hasUnsavedEditors() || [...drafts.values()].some(read => { const state = read(); return state.dirty || state.saving; });
}

export function hasPendingSaves(): boolean {
  return hasSavingEditors() || [...drafts.values()].some(read => read().saving);
}

let checking: Promise<boolean> | null = null;
export function confirmUnsavedWork(): Promise<boolean> {
  if (checking) return checking;
  checking = checkUnsavedWork().finally(() => { checking = null; });
  return checking;
}
async function checkUnsavedWork(): Promise<boolean> {
  if (hasPendingSaves()) return false;
  const snapshot = () => [...drafts.entries()].map(([id, read]) => ({ id, ...read() })).filter(state => state.dirty || state.saving);
  const before = snapshot();
  // Approval authorizes this exit only. Never reset draft/editor state here:
  // another guard may still cancel, and ordinary navigation retains drafts.
  if (before.length && !await confirmAction({ title: "Discard unsaved settings?", message: `Unsaved changes in ${before.map(state => state.label).join(", ")} will be lost if you close or restart the app. Save them first to keep your work.`, confirmLabel: "Discard and continue", danger: true })) return false;
  if (hasPendingSaves() || JSON.stringify(snapshot()) !== JSON.stringify(before)) return false;
  if (!await confirmEditorDiscard()) return false;
  return !hasPendingSaves() && JSON.stringify(snapshot()) === JSON.stringify(before);
}

export function protectUnsavedUnload(event: BeforeUnloadEvent): void {
  if (hasUnsavedWork()) { event.preventDefault(); event.returnValue = ""; }
}
