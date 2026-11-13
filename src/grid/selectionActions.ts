import { Facet, Prec, StateEffect, StateField, type EditorState, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, keymap, showTooltip, type Tooltip } from "@codemirror/view";
import { TERMINAL_TEXT_MAX_BYTES } from "../appControlTerminal";
import { IS_MAC } from "../shortcuts";

// A small action bar beside a selection in the editor: Explain, Fix and Send
// to agent, each sending the selected code to the terminal in the same tile.
// A file tile has no terminal, so it offers to open one instead.

export type SelectionAction = "explain" | "fix" | "send";
/** Where the code goes: a coding agent, a plain shell, or nowhere yet (a file tile). */
export type SelectionTarget = "agent" | "shell" | "file";
export interface SelectedCode { code: string; fromLine: number; toLine: number }
export interface SelectionActionsConfig {
  target: SelectionTarget;
  run: (action: SelectionAction, selected: SelectedCode, state: EditorState) => Promise<void>;
  openTerminal: () => Promise<void>;
}

const selectionConfig = Facet.define<SelectionActionsConfig, SelectionActionsConfig | null>({ combine: (values) => values[0] ?? null });

export const SEND_SHORTCUT = IS_MAC ? "⌘L" : "Ctrl+L";

// ------------------------------------------------------------------ prompts

const LANGUAGES: Record<string, string> = {
  ts: "ts", tsx: "tsx", mts: "ts", cts: "ts", js: "js", jsx: "jsx", mjs: "js", cjs: "js", py: "python", rb: "ruby", rs: "rust", go: "go",
  java: "java", kt: "kotlin", swift: "swift", c: "c", h: "c", cc: "cpp", cpp: "cpp", hpp: "cpp", cs: "csharp", php: "php", sh: "bash",
  bash: "bash", zsh: "bash", css: "css", scss: "scss", html: "html", vue: "vue", svelte: "svelte", json: "json", yml: "yaml", yaml: "yaml",
  toml: "toml", md: "markdown", sql: "sql", lua: "lua", dart: "dart", ex: "elixir", exs: "elixir", zig: "zig",
};

export function fenceLanguage(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? LANGUAGES[name.slice(dot + 1).toLowerCase()] ?? "" : "";
}

// The terminal refuses control characters other than line breaks and tabs.
const sanitize = (code: string) => code.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "�");

const linesLabel = (from: number, to: number) => (from === to ? `line ${from}` : `lines ${from}-${to}`);

/**
 * The text typed into the agent: where the code is (repository-relative path
 * and line range) and the code in a fenced block, led by a short instruction
 * for Explain and Fix. Send leaves room after the block for the user's question.
 */
export function selectionPrompt(action: SelectionAction, { path, code, fromLine, toLine }: SelectedCode & { path: string }): string {
  const clean = sanitize(code).replace(/\n+$/, "");
  const ticks = Math.max(3, ...Array.from(clean.matchAll(/`+/g), (match) => match[0].length + 1));
  const fence = "`".repeat(ticks);
  const block = `${fence}${fenceLanguage(path)}\n${clean}\n${fence}`;
  const where = `${path} ${linesLabel(fromLine, toLine)}`;
  if (action === "explain") return `Explain this code from ${where}:\n\n${block}`;
  if (action === "fix") return `Fix any bugs in this code from ${where}, edit the file, and briefly say what was wrong:\n\n${block}`;
  return `In ${where}:\n\n${block}\n\n`;
}

export function checkPromptSize(text: string): void {
  if (new TextEncoder().encode(text).byteLength > TERMINAL_TEXT_MAX_BYTES) {
    throw new Error("The selection is too large to send. Select at most about 60 KB of code.");
  }
}

/** The selected text and its 1-based line range; a selection ending at a line start leaves that line out. */
export function selectedCode(state: EditorState): SelectedCode | null {
  const range = state.selection.main;
  if (range.empty) return null;
  const doc = state.doc;
  const fromLine = doc.lineAt(range.from).number;
  const end = doc.lineAt(range.to);
  const toLine = end.from === range.to && end.number > fromLine ? end.number - 1 : end.number;
  const code = doc.sliceString(range.from, range.to);
  return code.trim() ? { code, fromLine, toLine } : null;
}

// ---------------------------------------------------------------- the bar

const hideBar = StateEffect.define<boolean>();
const setDragging = StateEffect.define<boolean>();

// Hidden by Esc, while typing and when the editor loses focus; a new
// selection shows it again. Not shown while a mouse selection is still moving.
const barField = StateField.define<{ hidden: boolean; dragging: boolean }>({
  create: () => ({ hidden: false, dragging: false }),
  update(value, tr) {
    let next = value;
    if (tr.docChanged) next = { ...next, hidden: true };
    else if (tr.selection) next = { ...next, hidden: false };
    for (const effect of tr.effects) {
      if (effect.is(hideBar)) next = { ...next, hidden: effect.value };
      if (effect.is(setDragging)) next = { ...next, dragging: effect.value };
    }
    return next;
  },
});

const ACTIONS: Array<{ action: SelectionAction; label: string; hint: Record<"agent" | "shell", string> }> = [
  { action: "explain", label: "Explain", hint: { agent: "Ask the agent in this tile to explain the selected code", shell: "Type an explain request with the selected code into the shell" } },
  { action: "fix", label: "Fix", hint: { agent: "Ask the agent in this tile to fix the selected code", shell: "Type a fix request with the selected code into the shell" } },
  { action: "send", label: "Send to agent", hint: { agent: `Send to agent (${SEND_SHORTCUT})\nPastes the code into the agent's input without sending it, so you can add your question`, shell: `Send to terminal (${SEND_SHORTCUT})\nPastes the code into the shell without running it` } },
];
const NO_AGENT = "No agent is running in this tile: the text is typed into the shell, and Enter is not pressed.";

function button(label: string, title: string): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "cm-pz-selbar-btn";
  element.textContent = label;
  element.title = title;
  // Keep the editor's focus and selection when a button is pressed.
  element.addEventListener("mousedown", (event) => event.preventDefault());
  return element;
}

// Runs one action from the bar or the shortcut; failures show in the bar.
const running = new WeakMap<EditorView, boolean>();
async function perform(view: EditorView, action: SelectionAction, report: (message: string | null) => void): Promise<void> {
  const config = view.state.facet(selectionConfig);
  const selected = selectedCode(view.state);
  if (!config || config.target === "file" || !selected || running.get(view)) return;
  running.set(view, true);
  report(null);
  try {
    await config.run(action, selected, view.state);
    view.dispatch({ effects: hideBar.of(true) });
  } catch (error) {
    report(error instanceof Error ? error.message : "Sending failed.");
  } finally {
    running.delete(view);
  }
}

function barTooltip(state: EditorState): Tooltip | null {
  const config = state.facet(selectionConfig);
  const bar = state.field(barField);
  const range = state.selection.main;
  if (!config || bar.hidden || bar.dragging || range.empty || state.selection.ranges.length > 1 || !state.sliceDoc(range.from, range.to).trim()) return null;
  return {
    pos: range.head,
    // Beside the selection's end, on the side away from the selected text.
    above: range.head < range.anchor,
    arrow: false,
    create: (view) => {
      const dom = document.createElement("div");
      dom.className = "cm-pz-selbar";
      dom.setAttribute("role", "toolbar");
      dom.setAttribute("aria-label", "Selection actions");
      const status = document.createElement("span");
      status.className = "cm-pz-selbar-status";
      status.setAttribute("role", "status");
      const report = (message: string | null) => {
        status.textContent = message ?? "";
        status.hidden = !message;
      };
      report(null);
      if (config.target === "file") {
        const open = button("Open terminal here", "Open terminal here\nThis file tile has no terminal yet: start a session beside the file, then send code to its agent");
        open.addEventListener("click", () => {
          open.disabled = true;
          void config.openTerminal().finally(() => { open.disabled = false; });
        });
        dom.append(open);
      } else {
        const target = config.target;
        for (const { action, label, hint } of ACTIONS) {
          const element = button(label, target === "agent" ? hint.agent : `${hint.shell}\n${NO_AGENT}`);
          element.addEventListener("click", () => void perform(view, action, report));
          dom.append(element);
        }
      }
      dom.append(status);
      // A shortcut-triggered failure reports through the bar that is showing.
      reporters.set(view, report);
      return { dom, destroy: () => { if (reporters.get(view) === report) reporters.delete(view); } };
    },
  };
}
const reporters = new WeakMap<EditorView, (message: string | null) => void>();

const bar = showTooltip.compute(["selection", barField, selectionConfig], barTooltip);

// Mouse selections show the bar once the button is released.
const dragTracker = ViewPlugin.fromClass(class {
  private release = () => {
    document.removeEventListener("mouseup", this.release, true);
    if (this.view.state.field(barField).dragging) this.view.dispatch({ effects: setDragging.of(false) });
  };
  constructor(readonly view: EditorView) {}
  destroy() { document.removeEventListener("mouseup", this.release, true); }
  begin() {
    document.addEventListener("mouseup", this.release, true);
    this.view.dispatch({ effects: setDragging.of(true) });
  }
}, {
  eventHandlers: {
    mousedown(event) {
      if (event.button === 0) this.begin();
      return false;
    },
  },
});

const barKeys = Prec.high(keymap.of([
  {
    key: "Mod-l",
    // With a selection: send it to the agent. Without one, the editor's own Select line.
    run: (view) => {
      const config = view.state.facet(selectionConfig);
      if (!config || config.target === "file" || !selectedCode(view.state)) return false;
      void perform(view, "send", (message) => reporters.get(view)?.(message));
      return true;
    },
  },
  {
    key: "Escape",
    run: (view) => {
      const state = view.state.field(barField);
      if (state.hidden || view.state.selection.main.empty) return false;
      view.dispatch({ effects: hideBar.of(true) });
      return true;
    },
  },
]));

const hideOnBlur = EditorView.focusChangeEffect.of((_state, focused) => (focused ? null : hideBar.of(true)));

export function selectionActions(config: SelectionActionsConfig): Extension {
  return [selectionConfig.of(config), barField, bar, dragTracker, barKeys, hideOnBlur];
}
