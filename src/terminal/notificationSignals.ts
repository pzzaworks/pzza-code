export interface TerminalSignalNotification {
  category: "terminal";
  event: "terminal-bell" | "terminal-command" | "terminal-exit";
  title: string;
  body: string;
  target: { tileId: string };
  dedupeKey: string;
}

interface SignalOptions {
  attachment: boolean;
  now?: () => number;
}

// Observe explicit terminal signals. Output becoming quiet is never completion.
export function createTerminalSignals(
  tileId: string,
  send: (notification: TerminalSignalNotification) => void,
  { attachment, now = () => performance.now() }: SignalOptions,
) {
  let disposed = false;
  let exited = false;
  let commandStarted = false;
  let lastBell = -Infinity;
  const emit = (title: string, body: string, key: TerminalSignalNotification["event"]) => {
    if (disposed || exited) return;
    send({ category: "terminal", event: key, title, body, target: { tileId }, dedupeKey: `${key}:${tileId}` });
  };
  return {
    bell() {
      if (disposed || exited || now() - lastBell < 10_000) return;
      lastBell = now();
      emit("Terminal needs attention", "This terminal emitted an attention signal.", "terminal-bell");
    },
    osc133(data: string) {
      if (disposed || exited || data.length > 32) return false;
      // Shell integration brackets a running command with C and D;status.
      // Requiring C avoids notifying for the initial prompt's previous status.
      if (data === "A") commandStarted = false;
      else if (data === "C") commandStarted = true;
      else if (data === "D" || data.startsWith("D;")) {
        const started = commandStarted;
        commandStarted = false;
        const status = /^D;(0|[1-9][0-9]{0,2})$/.exec(data);
        if (started && status && Number(status[1]) <= 255) {
          const code = Number(status[1]);
          emit(code === 0 ? "Terminal reported completion" : "Terminal reported failure",
            code === 0 ? "Shell integration reported that a command finished successfully." : `Shell integration reported a command exit status of ${code}.`,
            "terminal-command");
        }
      }
      // Other shell-integration handlers may observe the same sequence.
      return false;
    },
    processExit(code: number) {
      if (disposed || exited) return;
      // A successful tmux/SSH client exit can be an intentional detach. Its
      // status does not establish that the process inside the session finished.
      if (code !== 0 || !attachment) {
        emit(code === 0 ? "Terminal process finished" : "Terminal process failed",
          Number.isInteger(code) && code >= 0 && code <= 255 ? `The terminal process exited with status ${code}.` : "The terminal process ended without a successful exit status.",
          "terminal-exit");
      }
      exited = true;
      commandStarted = false;
    },
    dispose() { disposed = true; commandStarted = false; },
  };
}
