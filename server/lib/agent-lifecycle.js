// The desktop app owns the other end of stdin. EOF also arrives after a crash
// or force-quit, without depending on a PID that the OS could reuse. The app's
// native side also writes messages to it (see readDesktopMessages), handed to
// `onMessage`.
export function watchDesktopLifetime(shutdown, onMessage) {
  if (process.env.PZZA_MANAGED_AGENT !== "1") return;
  process.stdin.once("end", shutdown);
  process.stdin.once("error", shutdown);
  if (onMessage) readDesktopMessages(process.stdin, onMessage);
  process.stdin.resume();
}

// Longest message line kept; a longer one is skipped whole.
export const DESKTOP_MESSAGE_LIMIT = 16 * 1024;

// Messages from the desktop app: one JSON object per line on the pipe only
// the app holds the write end of. Nothing that talks to the agent over HTTP
// (the webview, MCP clients, any token holder) can write to it, which is what
// lets it carry grants (paths.js grantOpenedPath). A line that is not a JSON
// object, or is longer than the limit, is dropped.
export function readDesktopMessages(stream, onMessage) {
  let line = "";
  let skipping = false;
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    const parts = chunk.split("\n");
    for (let index = 0; index < parts.length - 1; index++) {
      const complete = line + parts[index];
      line = "";
      if (skipping) { skipping = false; continue; }
      let message;
      try { message = JSON.parse(complete); } catch { continue; }
      if (message && typeof message === "object" && !Array.isArray(message)) onMessage(message);
    }
    line += parts[parts.length - 1];
    if (line.length > DESKTOP_MESSAGE_LIMIT) {
      line = "";
      skipping = true;
    }
  });
}

export function createServerShutdown(server, exit, { graceMs = 3000 } = {}) {
  const connections = new Map();
  let stopping = false;
  let finished = false;
  let deadline;
  const finish = () => {
    if (finished) return;
    finished = true;
    clearTimeout(deadline);
    exit();
  };
  server.on("connection", socket => {
    connections.set(socket, new Set());
    socket.once("close", () => connections.delete(socket));
    if (stopping) socket.destroy();
  });
  server.on("request", (req, res) => {
    if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
    const writes = connections.get(req.socket);
    if (!writes) return;
    writes.add(res);
    const complete = () => {
      writes.delete(res);
      res.off("finish", complete);
      res.off("close", complete);
      if (stopping && writes.size === 0) req.socket.destroySoon();
    };
    res.once("finish", complete);
    res.once("close", complete);
  });
  return {
    get stopping() { return stopping; },
    stop() {
      if (stopping) return;
      stopping = true;
      deadline = setTimeout(() => {
        for (const socket of connections.keys()) socket.destroy();
        finish();
      }, graceMs).unref();
      server.close(finish);
      // Polls and terminal transports have no work to commit after the app
      // closes. Only in-flight writes need the bounded grace period.
      for (const [socket, writes] of connections) {
        if (writes.size === 0) socket.destroySoon();
      }
    },
  };
}
