import { create } from "zustand";
import { notify } from "./notifications";
import { PERMISSIONS_SUPPORTED, setupInstall, setupStatus, type SetupItem, type SetupStatus } from "./permissions";

// Requirements for running PzzaCode on this Mac. Node.js (runs the agent) and
// tmux (keeps terminals alive) install themselves with Homebrew as soon as the
// app finds them missing, once per item per launch. Homebrew needs the user's
// password, so it is never installed silently: onboarding offers it and the
// status re-check picks up the rest once it appears.
interface SetupState {
  status: SetupStatus | null;
  /** A status read has finished, even if it failed. */
  checked: boolean;
  busy: SetupItem | null;
  errors: Partial<Record<SetupItem, string>>;
  /** Items already installed or tried during this launch. */
  attempted: readonly SetupItem[];
}

export const useSetup = create<SetupState>(() => ({ status: null, checked: false, busy: null, errors: {}, attempted: [] }));

const LABELS: Record<SetupItem, string> = { homebrew: "Homebrew", node: "Node.js", tmux: "tmux" };
const FORMULAS: Record<SetupItem, string> = { homebrew: "", node: "node", tmux: "tmux" };
const AUTO_ITEMS = ["node", "tmux"] as const;

// Only the newest status read applies, so a slow read that started before an
// install finished can never overwrite the fresh result.
let sequence = 0;

export function refreshSetup(): Promise<void> {
  if (!PERMISSIONS_SUPPORTED) return Promise.resolve();
  const ticket = ++sequence;
  return setupStatus().then(
    status => { if (ticket === sequence) useSetup.setState({ status, checked: true }); },
    () => { if (ticket === sequence) useSetup.setState({ checked: true }); },
  ).finally(() => { if (ticket === sequence) continueAutoInstall(); });
}

// Installs the next missing requirement, one at a time: Homebrew runs a single
// install at once, and Node.js goes first so the agent can start.
function continueAutoInstall(): void {
  const { status, busy, attempted } = useSetup.getState();
  if (!status?.homebrew || busy) return;
  const next = AUTO_ITEMS.find(item => !status[item] && !attempted.includes(item));
  if (next) void installRequirement(next);
}

/** Installs one requirement now, also when the automatic attempt already failed. */
export async function installRequirement(item: SetupItem): Promise<void> {
  if (!PERMISSIONS_SUPPORTED || useSetup.getState().busy) return;
  useSetup.setState(state => {
    const errors = { ...state.errors };
    delete errors[item];
    return { busy: item, errors, attempted: state.attempted.includes(item) ? state.attempted : [...state.attempted, item] };
  });
  try {
    await setupInstall(item);
    // Homebrew only opens its installer in Terminal; there is no result to report yet.
    if (item !== "homebrew") notify({
      event: "setup-installed", category: "app", source: "Setup", dedupeKey: `setup-installed:${item}`,
      title: `${LABELS[item]} installed`,
      body: item === "node" ? "Node.js is ready and the PzzaCode agent on this Mac has started." : "tmux is ready. Terminals keep running when you close PzzaCode.",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    useSetup.setState(state => ({ errors: { ...state.errors, [item]: message } }));
    if (item !== "homebrew") notify({
      event: "setup-failed", category: "app", source: "Setup", dedupeKey: `setup-failed:${item}`,
      title: `${LABELS[item]} could not be installed`,
      body: `${message} Run brew install ${FORMULAS[item]} in a terminal, then reopen PzzaCode.`,
    });
  } finally {
    useSetup.setState({ busy: null });
    await refreshSetup();
  }
}

let started = false;

/** The launch-time requirements pass; later calls in the same launch do nothing. */
export function startSetupAutoInstall(): void {
  if (started || !PERMISSIONS_SUPPORTED) return;
  started = true;
  void refreshSetup();
}
