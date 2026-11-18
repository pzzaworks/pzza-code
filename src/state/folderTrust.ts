import { detectFolderTrustPrompt, folderTrustAnswer, type FolderTrustPrompt } from "../terminal/folderTrustPrompts";
import type { Screen } from "../terminal/permissionPrompts";
import type { PaneForeground } from "./permissionPrompts";

// Auto-trust folders (Settings > General > Terminal, off by default): when a
// coding agent asks whether to trust the folder it starts in, the app answers
// Yes for it. Only folder trust prompts are answered (see
// folderTrustPrompts); approval prompts always wait for the user. Keys go out
// once per appearance of a prompt, only to a pane known to run that agent
// alone in its window, and only while a fresh read of the screen still shows
// the very same prompt; the trust choice must show as highlighted before
// Enter is sent.

/** One terminal's screen and input, as seen by the folder trust responder. */
export interface FolderTrustTarget {
  /** The visible screen as currently parsed. */
  screen(): Screen;
  /** The visible screen after all received output has been parsed. */
  freshScreen(): Promise<Screen>;
  /** Raw input over the live attachment; rejects when the tile is detached. */
  send(data: string): Promise<void>;
  /** What runs in the pane this tile's input reaches; `fresh` skips any cache. */
  foreground(fresh: boolean): Promise<PaneForeground | null>;
}

export interface FolderTrustOptions {
  /** Whether the setting is on, read before every step. */
  enabled(): boolean;
}

// A prompt must stay on screen this long before it is answered: a CLI can
// show a half-drawn frame, and Claude Code ignores keys sent the moment its
// dialog opens.
const SETTLE_MS = 300;
// An answered prompt must stay gone this long before the same prompt counts
// as shown again: a redraw can blank the screen for a frame.
const ABSENT_MS = 700;
// How long the trust choice may take to show as highlighted after the arrows.
const HIGHLIGHT_TIMEOUT_MS = 1500;
const POLL_MS = 60;
// A highlight that did not move is tried again after this, a few times.
const RETRY_MS = 1000;
const MAX_ATTEMPTS = 3;
// A pane that could not be confirmed is checked again after this, doubling
// up to the maximum: activity can lag an agent that just started.
const RECHECK_MS = 2000;
const RECHECK_MAX_MS = 32_000;

export interface FolderTrustResponder {
  /** Looks at the screen and answers a trust prompt when one is due. Cheap when the setting is off. */
  check(): void;
  dispose(): void;
}

/** Answers the folder trust prompts one terminal shows, while `enabled()`. */
export function createFolderTrustResponder(target: FolderTrustTarget, options: FolderTrustOptions): FolderTrustResponder {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // The prompt being looked at and since when.
  let seen: { signature: string; at: number } | null = null;
  // The prompt answered (or given up on) in its current appearance; no key
  // goes to it again until it has left the screen.
  let handled: string | null = null;
  let absentSince = 0;
  let attempts = 0;
  let busy = false;
  let notBefore = 0;
  let paneDelay = RECHECK_MS;

  const later = (delay: number) => {
    clearTimeout(timer);
    timer = setTimeout(check, Math.max(0, delay));
  };
  const forget = () => {
    seen = null;
    handled = null;
    absentSince = 0;
    attempts = 0;
    notBefore = 0;
    paneDelay = RECHECK_MS;
  };
  const read = (screen: Screen, agent?: string): FolderTrustPrompt | null => {
    try { return detectFolderTrustPrompt(screen, agent); } catch { return null; }
  };
  const live = () => !disposed && options.enabled();

  // Polls fresh screens until `until` holds or the time is up.
  async function waitFor(until: (screen: Screen) => boolean, timeoutMs: number): Promise<boolean> {
    const deadline = performance.now() + timeoutMs;
    for (;;) {
      if (!live()) return false;
      if (until(await target.freshScreen())) return true;
      if (performance.now() >= deadline) return false;
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }
  }

  async function answer(prompt: FolderTrustPrompt): Promise<void> {
    const foreground = await target.foreground(true).catch(() => null);
    if (!live()) return;
    // Keys reach the window's active pane only: it must run this agent, alone.
    if (!foreground || foreground.panes !== 1 || foreground.agent !== prompt.agent) {
      notBefore = performance.now() + paneDelay;
      paneDelay = Math.min(paneDelay * 2, RECHECK_MAX_MS);
      return;
    }
    // The screen may have moved on while the pane was checked.
    const current = read(await target.freshScreen(), prompt.agent);
    if (!live() || !current || current.signature !== prompt.signature) return;
    attempts++;
    const plan = folderTrustAnswer(current);
    if (plan.moves) await target.send(plan.moves);
    if (await waitFor(plan.ready, HIGHLIGHT_TIMEOUT_MS)) {
      handled = prompt.signature;
      await target.send(plan.confirm);
      return;
    }
    if (!live()) return;
    // The highlight did not reach the trust choice: try again from the screen
    // as it is then, a few times, and leave the rest to the user.
    if (attempts >= MAX_ATTEMPTS) handled = prompt.signature;
    else notBefore = performance.now() + RETRY_MS;
  }

  function check() {
    timer = undefined;
    if (disposed || busy) return;
    if (!options.enabled()) { forget(); return; }
    const prompt = read(target.screen());
    const now = performance.now();
    if (!prompt) {
      seen = null;
      if (handled !== null && !absentSince) absentSince = now;
      return;
    }
    if (handled !== null) {
      // The same prompt still showing, or back within a redraw: answered already.
      if (prompt.signature === handled && (!absentSince || now - absentSince < ABSENT_MS)) { absentSince = 0; return; }
      forget();
    }
    absentSince = 0;
    if (!seen || seen.signature !== prompt.signature) {
      seen = { signature: prompt.signature, at: now };
      attempts = 0;
      later(SETTLE_MS);
      return;
    }
    const due = Math.max(seen.at + SETTLE_MS, notBefore);
    if (now < due) { later(due - now); return; }
    busy = true;
    void answer(prompt).catch(() => {
      // A send failed (the tile detached): nothing more goes to this prompt.
      handled = prompt.signature;
    }).finally(() => {
      busy = false;
      // Look again: a retry may be due, or the screen changed meanwhile.
      if (!disposed && handled === null) later(Math.max(0, notBefore - performance.now()));
    });
  }

  return {
    check,
    dispose() {
      disposed = true;
      clearTimeout(timer);
    },
  };
}
