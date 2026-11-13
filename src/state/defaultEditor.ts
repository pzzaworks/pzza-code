import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { notify } from "./notifications";
import { PERMISSIONS_SUPPORTED } from "./permissions";

// PzzaCode as the default macOS editor for the code and text file types the
// app declares. Only the macOS app can ask Launch Services; everywhere else
// (and on a native side that reports it unsupported) setup leaves the step out.

/** One file type PzzaCode can become the default for. */
export interface DefaultEditorType {
  /** The macOS type identifier; the native setter takes these back. */
  id: string;
  label: string;
  /** Extensions without their dot. */
  extensions: string[];
  /** PzzaCode already opens this type by default. */
  owned: boolean;
}

export interface DefaultEditorStatus {
  supported: boolean;
  isDefault: boolean;
  /** Declared file types. */
  total: number;
  /** Declared file types PzzaCode already opens by default. */
  owned: number;
  types: DefaultEditorType[];
}

export interface DefaultEditorResult {
  updated: number;
  /** The file types that could not be changed. */
  failed: string[];
}

const count = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === "string");

function parseType(value: unknown): DefaultEditorType {
  if (!value || typeof value !== "object") throw new Error("Invalid default editor status.");
  const { id, label, extensions, owned } = value as Record<string, unknown>;
  if (typeof id !== "string" || !id || typeof label !== "string" || !strings(extensions) || typeof owned !== "boolean") throw new Error("Invalid default editor status.");
  return { id, label, extensions, owned };
}

function parseStatus(value: unknown): DefaultEditorStatus {
  if (!value || typeof value !== "object") throw new Error("Invalid default editor status.");
  const { supported, isDefault, total, owned, types } = value as Record<string, unknown>;
  if (typeof supported !== "boolean" || typeof isDefault !== "boolean" || !count(total) || !count(owned) || !Array.isArray(types)) throw new Error("Invalid default editor status.");
  return { supported, isDefault, total, owned, types: types.map(parseType) };
}

function parseResult(value: unknown): DefaultEditorResult {
  if (!value || typeof value !== "object") throw new Error("Invalid default editor response.");
  const { updated, failed } = value as Record<string, unknown>;
  if (!count(updated) || !strings(failed)) throw new Error("Invalid default editor response.");
  return { updated, failed };
}

// Native commands reject with a plain string.
const message = (error: unknown, fallback: string) =>
  error instanceof Error ? error.message : typeof error === "string" && error ? error : fallback;

interface DefaultEditorState {
  status: DefaultEditorStatus | null;
  /** A status read has finished, even if it failed. */
  checked: boolean;
  busy: boolean;
  /** What the last "make default" did during this launch. */
  result: DefaultEditorResult | null;
  error: string | null;
}

export const useDefaultEditor = create<DefaultEditorState>(() => ({ status: null, checked: false, busy: false, result: null, error: null }));

// Only the newest status read applies (see refreshSetup).
let sequence = 0;

export function refreshDefaultEditor(): Promise<void> {
  if (!PERMISSIONS_SUPPORTED) return Promise.resolve();
  const ticket = ++sequence;
  return invoke<unknown>("default_editor_status").then(parseStatus).then(
    status => { if (ticket === sequence) useDefaultEditor.setState({ status, checked: true }); },
    () => { if (ticket === sequence) useDefaultEditor.setState({ checked: true }); },
  );
}

/** Makes PzzaCode the default editor for the given file types (ids from the status). */
export async function makeDefaultEditor(types: readonly string[]): Promise<void> {
  if (!PERMISSIONS_SUPPORTED || useDefaultEditor.getState().busy || types.length === 0) return;
  useDefaultEditor.setState({ busy: true, error: null, result: null });
  try {
    const result = parseResult(await invoke<unknown>("set_default_editor", { types: [...types] }));
    useDefaultEditor.setState({ result });
  } catch (error) {
    const text = message(error, "Could not change the default editor.");
    useDefaultEditor.setState({ error: text });
    notify({ category: "app", source: "Setup", dedupeKey: "default-editor-failed", title: "PzzaCode could not become the default editor", body: text });
  } finally {
    useDefaultEditor.setState({ busy: false });
    await refreshDefaultEditor();
  }
}
