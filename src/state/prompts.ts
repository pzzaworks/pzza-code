import { create } from "zustand";

// Saved prompts: reusable one-line requests sent to a tile's agent from the
// command palette, or dropped into the broadcast bar. Kept in localStorage,
// validated on every load and save, and capped in count and size. Each prompt
// is a single line because it is submitted with one Enter, like a broadcast.
export interface SavedPrompt {
  id: string;
  name: string;
  text: string;
}

const KEY = "pzza.prompts.v1";
export const PROMPT_NAME_MAX = 60;
export const PROMPT_TEXT_MAX = 2000;
export const PROMPTS_MAX = 50;

export const DEFAULT_PROMPTS: readonly SavedPrompt[] = [
  { id: "default-tests", name: "Write tests", text: "Write tests for the current changes. Cover the edge cases, run them and fix anything that fails." },
  { id: "default-review", name: "Review this diff", text: "Review this diff for bugs, edge cases and security issues. List the findings by severity with file and line." },
  { id: "default-pr", name: "Write the PR description", text: "Write the PR description for the current changes: what changed, why, and how it was tested." },
  { id: "default-explain", name: "Explain this code", text: "Explain what the code in this folder does and how the main pieces fit together." },
  { id: "default-commit", name: "Write a commit message", text: "Write a concise commit message for the staged changes, with a short body listing the main changes." },
];

// Control characters (tabs and newlines included) and line separators are
// refused: the text is pasted into a terminal and submitted with Enter.
const UNSAFE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

export function validatePrompt(name: string, text: string): { name: string; text: string } {
  const cleanName = name.trim();
  const cleanText = text.trim();
  if (!cleanName) throw new Error("Give the prompt a name.");
  if (cleanName.length > PROMPT_NAME_MAX) throw new Error(`Names are at most ${PROMPT_NAME_MAX} characters.`);
  if (UNSAFE.test(cleanName)) throw new Error("Names must be one line without control characters.");
  if (!cleanText) throw new Error("Write the prompt text.");
  if (cleanText.length > PROMPT_TEXT_MAX) throw new Error(`Prompts are at most ${PROMPT_TEXT_MAX} characters.`);
  if (UNSAFE.test(cleanText)) throw new Error("Prompts are one line without tabs or control characters, because they are sent with a single Enter.");
  return { name: cleanName, text: cleanText };
}

function load(): SavedPrompt[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return [...DEFAULT_PROMPTS];
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [...DEFAULT_PROMPTS];
    const prompts: SavedPrompt[] = [];
    const ids = new Set<string>();
    for (const item of value.slice(0, PROMPTS_MAX)) {
      if (!item || typeof item !== "object") continue;
      const { id, name, text } = item as Record<string, unknown>;
      if (typeof id !== "string" || !/^[\w-]{1,64}$/.test(id) || ids.has(id) || typeof name !== "string" || typeof text !== "string") continue;
      try {
        prompts.push({ id, ...validatePrompt(name, text) });
        ids.add(id);
      } catch {
        /* a tampered or outdated entry is dropped */
      }
    }
    return prompts;
  } catch {
    return [...DEFAULT_PROMPTS];
  }
}

export const usePrompts = create<{ prompts: SavedPrompt[] }>(() => ({ prompts: load() }));

function save(prompts: SavedPrompt[]): void {
  usePrompts.setState({ prompts });
  try {
    localStorage.setItem(KEY, JSON.stringify(prompts));
  } catch {
    /* kept for this run; storage may be full or unavailable */
  }
}

function newId(): string {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function addPrompt(name: string, text: string): SavedPrompt {
  const prompts = usePrompts.getState().prompts;
  if (prompts.length >= PROMPTS_MAX) throw new Error(`You can keep up to ${PROMPTS_MAX} prompts. Delete one first.`);
  const prompt = { id: newId(), ...validatePrompt(name, text) };
  save([...prompts, prompt]);
  return prompt;
}

export function updatePrompt(id: string, name: string, text: string): void {
  const valid = validatePrompt(name, text);
  const prompts = usePrompts.getState().prompts;
  if (!prompts.some((prompt) => prompt.id === id)) throw new Error("That prompt no longer exists.");
  save(prompts.map((prompt) => (prompt.id === id ? { id, ...valid } : prompt)));
}

export function deletePrompt(id: string): void {
  save(usePrompts.getState().prompts.filter((prompt) => prompt.id !== id));
}

export function movePrompt(id: string, step: -1 | 1): void {
  const prompts = [...usePrompts.getState().prompts];
  const from = prompts.findIndex((prompt) => prompt.id === id);
  const to = from + step;
  if (from < 0 || to < 0 || to >= prompts.length) return;
  [prompts[from], prompts[to]] = [prompts[to], prompts[from]];
  save(prompts);
}
