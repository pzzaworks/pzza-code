// Account balances that some agents print from a CLI subcommand, read only when
// that agent is installed. Each command is a fixed argv run without a shell,
// with a short timeout, and only the numbers below are taken from its output
// (which also names the signed-in account).
import { execFile } from "node:child_process";
import { installedAgents } from "../system.js";

const RUN_TIMEOUT_MS = 10_000;
const MAX_OUTPUT = 256 * 1024;
// Where each agent's binary is, re-checked now and then, never per refresh.
const LOOKUP_TTL_MS = 10 * 60 * 1000;

const amount = (value) => {
  const n = typeof value === "string" ? Number.parseFloat(value) : Number(value);
  return Number.isFinite(n) ? n : null;
};

// The JSON object a command printed, ignoring any notice lines around it.
export function jsonOutput(stdout) {
  const text = String(stdout);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end < start) return null;
  try {
    const value = JSON.parse(text.slice(start, end + 1));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

export const CLI_LIMITS = [
  {
    // `kilo profile --json` (packages/opencode/src/kilocode/cli/cmd/profile.ts):
    // { name, email, team, organizationId, balance } with balance in USD from
    // the Kilo Gateway. A failed balance fetch also prints 0, so only a
    // positive balance is shown.
    id: "kilo",
    label: "Kilo Code",
    args: ["profile", "--json"],
    parse(stdout) {
      const balance = amount(jsonOutput(stdout)?.balance);
      if (balance === null || balance <= 0) return null;
      return { plan: null, usage: { five_hour: null, seven_day: null, scoped: [], balances: [{ name: "Balance", amount: balance, unit: "usd" }] } };
    },
  },
  {
    // `auggie account status --json` (Auggie 0.x): { planName, usageUnit
    // ("credits" | "usd"), amountRemaining, amountIncludedPerCycle,
    // billingCycleEndDate }, amounts possibly as strings.
    id: "auggie",
    label: "Auggie",
    args: ["account", "status", "--json"],
    parse(stdout) {
      const status = jsonOutput(stdout);
      if (!status) return null;
      const unit = status.usageUnit === "usd" ? "usd" : status.usageUnit === "credits" ? "credits" : null;
      const remaining = amount(status.amountRemaining);
      const included = amount(status.amountIncludedPerCycle);
      if (!unit || remaining === null) return null;
      const resets = typeof status.billingCycleEndDate === "string" && Number.isFinite(Date.parse(status.billingCycleEndDate))
        ? new Date(status.billingCycleEndDate).toISOString()
        : null;
      const scoped = included !== null && included > 0
        ? [{ name: "Plan", percent: Math.min(100, Math.max(0, (1 - remaining / included) * 100)), resets_at: resets }]
        : [];
      return {
        plan: typeof status.planName === "string" && status.planName ? status.planName : null,
        usage: { five_hour: null, seven_day: null, scoped, balances: [{ name: "Remaining", amount: Math.max(0, remaining), unit }] },
      };
    },
  },
];

let lookup = { at: 0, paths: null };

// The installed binary of each CLI_LIMITS agent (id -> absolute path).
export async function limitBinaries({ now = Date.now, find = installedAgents } = {}) {
  if (lookup.paths && now() - lookup.at < LOOKUP_TTL_MS) return lookup.paths;
  const ids = new Set(CLI_LIMITS.map((item) => item.id));
  const paths = new Map();
  for (const { id, path } of await find().catch(() => [])) if (ids.has(id) && path) paths.set(id, path);
  lookup = { at: now(), paths };
  return paths;
}

/** Runs one CLI_LIMITS command and parses it; rejects when it fails. */
export function runCliLimit(item, binary, run = execFile) {
  return new Promise((resolve, reject) => {
    run(binary, item.args, { timeout: RUN_TIMEOUT_MS, maxBuffer: MAX_OUTPUT, env: { ...process.env, NO_COLOR: "1" } }, (error, stdout) => {
      // Never pass the output on: it names the signed-in account.
      if (error) return reject(Object.assign(new Error(`${item.label} did not report a balance`), { unsupported: true }));
      const parsed = item.parse(stdout);
      if (!parsed) return reject(Object.assign(new Error(`${item.label} did not report a balance`), { unsupported: true }));
      resolve(parsed);
    });
  });
}
