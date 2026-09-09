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
  if (host) return "tmux";
  const options = tmuxArgs([]);
  return options.length ? `tmux -N -S ${shQuote(options[2])}` : "tmux";
}
