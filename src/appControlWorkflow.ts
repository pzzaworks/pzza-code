import { registerAppControlHandler } from "./appControlRuntime";
import { redactTerminalOutput } from "./appControlTerminal";
import { isSessionTile, useStore } from "./state/store";
import { addPrompt, deletePrompt, usePrompts } from "./state/prompts";
import { refreshUsage, useUsage } from "./state/usage";
import { useSessionAgents } from "./state/sessionAgents";
import { fetchSessionCost, fetchWorktreeInfo } from "./serverApi";
import { reviewMessages, useDiffReview } from "./grid/diffReview";
import { landWorktree } from "./worktreeLand";
import { tileGitTarget } from "./tileGit";
import { sendFailingChecks } from "./grid/gitRemote";
import { moveAgentToWorktree } from "./sessionActions";
import { broadcastLine, sendPromptToTile } from "./terminal/broadcast";
import { compileQuery, searchTerminals } from "./terminal/terminalSearch";
import { runningAgent } from "./ui/LiveSessionIcon";
import { sessionAgent } from "../server/lib/session-agents.js";

// App commands for the agent workflow around a tile (saved prompts, failed CI,
// review comments, worktrees, cost, usage, terminal search).
// Each one reuses the function behind its visible control, including that
// control's own confirmation.

// A search answers with a few lines, not a page of scrollback.
const SEARCH_LINES = 20;
const SEARCH_LINE_CHARS = 200;

function requireTile(tileId: unknown) {
  const tile = useStore.getState().tiles.find(item => item.id === tileId);
  if (!tile) throw new Error("The requested session tile is not open.");
  // Every workflow command works through the tile's terminal or its session.
  if (!isSessionTile(tile)) throw new Error("This is a file or folder tile without a terminal. Open a terminal in it first.");
  return tile;
}

// The linked worktree a tile works in, with its branch and base.
async function tileWorktree(tileId: unknown) {
  const tile = requireTile(tileId);
  const target = tileGitTarget(tile.id);
  if (!target) throw new Error("This tile's folder is not known.");
  const info = await fetchWorktreeInfo(target.host, target.folder, AbortSignal.timeout(15000));
  if (!info.linked) throw new Error("This tile is not in a linked Git worktree. Use open_pull_request for its branch.");
  return { tile, target, info };
}

// The coding agent in the tile's foreground, as its footer shows it.
function tileAgent(tile: ReturnType<typeof requireTile>): string | undefined {
  return runningAgent(tile.session ?? tile.name, tile.window, tile.host);
}

export function initWorkflowAppControlHandlers(): () => void {
  const handlers: Record<string, (args: Readonly<Record<string, unknown>>) => unknown> = {
    get_usage: async args => {
      const state = useStore.getState();
      if (args.fresh === true || !useUsage.getState().accounts.length) await refreshUsage(state.activeDevices, { fresh: args.fresh === true });
      const usage = useUsage.getState();
      const percent = (value: number | undefined) => value === undefined ? null : Math.round(value);
      return {
        failed: usage.failed,
        accounts: usage.accounts.slice(0, 12).map(account => ({
          provider: account.provider, label: account.label, plan: account.plan ?? null, device: account.sourceName ?? null, error: account.error,
          fiveHour: account.usage?.five_hour ? { percentUsed: percent(account.usage.five_hour.utilization), resetsAt: account.usage.five_hour.resets_at } : null,
          weekly: account.usage?.seven_day ? { percentUsed: percent(account.usage.seven_day.utilization), resetsAt: account.usage.seven_day.resets_at } : null,
          scoped: (account.usage?.scoped ?? []).slice(0, 4).map(item => ({ name: item.name, percentUsed: percent(item.percent), resetsAt: item.resets_at })),
          balances: (account.usage?.balances ?? []).slice(0, 4).map(item => ({ name: item.name, amount: item.amount, unit: item.unit })),
        })),
      };
    },
    get_session_cost: async args => {
      const state = useStore.getState();
      const tile = requireTile(args.tileId);
      // Cost reads this Mac's agent transcripts, like the tile footer.
      if (tile.host) throw new Error("Session cost is only known for sessions on this Mac.");
      const provider = [tileAgent(tile), useSessionAgents.getState().agents[tile.id]?.id].map(id => sessionAgent(id)?.id).find(id => id !== undefined);
      if (!provider) throw new Error("This tile has no coding agent session to price.");
      const folder = tileGitTarget(tile.id)?.folder;
      const createdAt = state.allSessions.find(session => session.name === (tile.session ?? tile.name))?.createdAt;
      if (!folder || !createdAt) throw new Error("This tile's folder or start time is not known yet.");
      const cost = await fetchSessionCost(provider, folder, createdAt, AbortSignal.timeout(15000));
      if (!cost.found) return { found: false };
      return { found: true, provider: cost.provider, costUsd: cost.cost ?? null, pricedCostUsd: cost.pricedCost ?? null, unpricedModels: cost.unpricedModels ?? [],
        costBasis: cost.pricingBasis ?? null,
        startedAt: cost.startedAt, lastAt: cost.lastAt, models: cost.models ?? [], subagents: cost.subagents ?? 0, tokens: cost.tokens ?? null };
    },
    search_terminals: async args => {
      const state = useStore.getState();
      const pattern = compileQuery(args.query as string, args.regex === true);
      if (!pattern) throw new Error("That search pattern is not valid.");
      const groups = await searchTerminals(state.tiles.filter(isSessionTile).map(tile => tile.id), pattern, AbortSignal.timeout(10000), () => {});
      let budget = SEARCH_LINES;
      return {
        tiles: groups.filter(group => group.matches.length).map(group => {
          const lines = group.matches.slice(0, Math.max(0, budget)).map(match => redactTerminalOutput(match.text.slice(0, SEARCH_LINE_CHARS)).text);
          budget -= lines.length;
          return { tileId: group.tileId, title: state.tileTitles[group.tileId] ?? state.tiles.find(tile => tile.id === group.tileId)?.name ?? group.tileId, matches: group.matches.length, capped: group.capped, lines };
        }),
      };
    },
    get_saved_prompts: () => ({ prompts: usePrompts.getState().prompts.map(({ id, name, text }) => ({ id, name, text })) }),
    add_saved_prompt: args => { const prompt = addPrompt(args.name as string, args.text as string); return { id: prompt.id, name: prompt.name }; },
    delete_saved_prompt: args => {
      if (!usePrompts.getState().prompts.some(item => item.id === args.promptId)) throw new Error("Unknown saved prompt. Read get_saved_prompts for their IDs.");
      deletePrompt(args.promptId as string);
      return { deleted: true };
    },
    send_saved_prompt: async args => {
      const tile = requireTile(args.tileId);
      const prompt = usePrompts.getState().prompts.find(item => item.id === args.promptId);
      if (!prompt) throw new Error("Unknown saved prompt. Read get_saved_prompts for their IDs.");
      await sendPromptToTile(tile.id, prompt.text);
      return { sent: true, tileId: tile.id, prompt: prompt.name };
    },
    send_failing_checks: async args => {
      const tile = requireTile(args.tileId);
      if (!tileAgent(tile)) throw new Error("No coding agent is running in this tile to send the failing checks to.");
      const target = tileGitTarget(tile.id);
      if (!target) throw new Error("This tile's folder is not known.");
      await sendFailingChecks(tile.id, target.host, target.folder);
      return { sent: true, tileId: tile.id };
    },
    move_to_worktree: async args => {
      const tile = requireTile(args.tileId);
      const provider = sessionAgent(tileAgent(tile))?.id;
      const target = tileGitTarget(tile.id);
      if (!provider) throw new Error("No coding agent is running in this tile to move.");
      if (!target) throw new Error("This tile's folder is not known.");
      const created = await moveAgentToWorktree({ tileId: tile.id, session: tile.session ?? tile.name, host: tile.host, cwd: target.folder, provider });
      if (created === null) throw new Error("The action was cancelled in the app.");
      return { moved: true, tileId: created };
    },
    send_review_comments: async args => {
      const tile = requireTile(args.tileId);
      const comments = useDiffReview.getState().comments[tile.id] ?? [];
      if (!comments.length) throw new Error("This tile has no pending review comments.");
      if (!tileAgent(tile)) throw new Error("No coding agent is running in this tile to send the review to.");
      // Like the Changes view: sent comments leave the review, a failure keeps the rest.
      const messages = reviewMessages(comments);
      for (const [index, message] of messages.entries()) {
        const [result] = await broadcastLine([tile.id], message);
        if (result?.error) throw new Error(index ? `Sent ${index} of ${messages.length} parts, then: ${result.error}` : result.error);
      }
      for (const comment of comments) useDiffReview.getState().remove(tile.id, comment.id);
      return { sent: comments.length, tileId: tile.id };
    },
    // Both go through the shared landing path: a task's worktree lands behind
    // its task's checks (outcome recorded), any other behind the generic ones.
    open_worktree_pr: async args => {
      const { target, info } = await tileWorktree(args.tileId);
      if (!info.branch) throw new Error("The worktree is on a detached HEAD.");
      const result = await landWorktree({ kind: "pr", host: target.host, path: target.folder, branch: info.branch, base: info.base }, { interactive: false });
      if (!result) throw new Error("The action was cancelled in the app.");
      if (result.failed) throw new Error(result.text);
      return { text: result.text, url: result.url ?? null };
    },
    merge_worktree: async args => {
      const { target, info } = await tileWorktree(args.tileId);
      if (!info.branch || !info.base) throw new Error(!info.branch ? "The worktree is on a detached HEAD." : "The worktree's base branch is unknown.");
      const result = await landWorktree({ kind: "merge", host: target.host, path: target.folder, branch: info.branch, base: info.base }, { interactive: false });
      if (!result) throw new Error("The action was cancelled in the app.");
      if (result.failed) throw new Error(result.text);
      return { text: result.text };
    },
  };
  const cleanups = Object.entries(handlers).map(([action, handler]) => registerAppControlHandler(action, handler));
  return () => cleanups.forEach(cleanup => cleanup());
}
