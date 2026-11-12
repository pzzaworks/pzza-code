import type { ConfirmationOptions } from "./state/confirmations";
import type { SyncOptions } from "./serverApi";

// The questions app control asks in the app before acting for a caller, for
// actions whose visible UI asks first too. Plain data in, so the wording can
// be checked without the app.

/** What one sync would do, as the Sync projects dialog shows it. */
export function syncEffects(options: Pick<SyncOptions, "cloneMissing" | "switchToDefault" | "stashDirty" | "syncEnvs">): string {
  return `This updates Git working files${options.cloneMissing ? ", clones missing projects" : ""}`
    + (options.switchToDefault ? ", and aligns clean checkouts to remote development or main" : ", but leaves existing checkouts untouched")
    + (options.stashDirty ? ". Tracked and untracked local changes are preserved before alignment." : ". Dirty projects are left alone.")
    // What the device skips on its own (see SYNC_FUNCS in server/lib/projects.js).
    + " Skipped and left as they are: checkouts where a terminal session is running a program, or that have uncommitted changes with a session open in them"
    + (options.switchToDefault ? ", and projects whose local development or main has commits that are not on origin." : ".")
    + (options.syncEnvs ? " Replaced environment files are backed up privately in the destination repository’s Git directory." : " Environment file copying is disabled.");
}

/** The Sync projects dialog's question, for a sync started through app control. */
export function syncProjectsConfirmation({ root, options, devices }: { root: string; options: SyncOptions; devices: readonly string[] }): ConfirmationOptions {
  const where = devices.length ? `on ${devices.join(", ")}` : "with no devices enabled";
  return { title: "Sync projects?", message: `Sync enabled projects under ${root} ${where}? ${syncEffects(options)}`, confirmLabel: "Sync projects", danger: true };
}

const RISKY_SYNC_CHOICES = [
  ["switchToDefault", "align clean checkouts to remote development or main"],
  ["stashDirty", "stash tracked and untracked local changes before aligning"],
  ["syncEnvs", "copy environment files between devices"],
] as const;

/**
 * The question before saved sync choices turn on something a later sync acts
 * on (switching branches, stashing edits, replacing environment files);
 * undefined when the change turns none of them on.
 */
export function configureSyncConfirmation(current: SyncOptions, requested: unknown): ConfirmationOptions | undefined {
  if (!requested || typeof requested !== "object") return undefined;
  const enabled = RISKY_SYNC_CHOICES.filter(([key]) => (requested as Partial<Record<typeof key, unknown>>)[key] === true && !current[key]).map(([, label]) => label);
  if (!enabled.length) return undefined;
  return {
    title: "Change sync choices?",
    message: `Let Sync ${enabled.join(", ")}? This applies to every enabled project and device the next time projects are synced.`,
    confirmLabel: "Save sync choices",
    danger: true,
  };
}

/** The question before app control ends a tmux session, or one window of it, on a device. */
export function terminateSessionConfirmation({ session, window, device }: { session: string; window?: number; device: string }): ConfirmationOptions {
  return window === undefined
    ? { title: "Terminate session?", message: `Stop session ${session} on ${device} and remove its tiles? Running processes will be terminated.`, confirmLabel: "Terminate", danger: true }
    : { title: "Terminate window?", message: `Stop window ${window} of session ${session} on ${device} and remove its tile? Running processes in it will be terminated.`, confirmLabel: "Terminate", danger: true };
}
