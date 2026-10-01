import { DEVBOX, IS_CLIENT } from "./config.js";
import { shQuote } from "./shell.js";

export function tmuxArgs(args, socket = process.env.PZZA_TMUX_SOCKET) {
  if (socket === undefined) return args;
  if (typeof socket !== "string" || !socket.startsWith("/") || socket.includes("\0")) {
    throw new Error("Invalid local terminal service socket");
  }
  // A managed client must never create a server outside the service lifecycle.
  return ["-N", "-S", socket, ...args];
}

export function tmuxCommand(host = IS_CLIENT ? DEVBOX : "") {
  // A non-interactive SSH command often has no UTF-8 locale, and tmux then
  // prints tabs in -F output as "_" and mangles non-ASCII names; -u forces UTF-8.
  if (host) return "tmux -u";
  const options = tmuxArgs([]);
  return options.length ? `tmux -N -S ${shQuote(options[2])}` : "tmux";
}
