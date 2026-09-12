// The desktop app owns the other end of stdin. EOF also arrives after a crash
// or force-quit, without depending on a PID that the OS could reuse.
export function watchDesktopLifetime(shutdown) {
  if (process.env.PZZA_MANAGED_AGENT !== "1") return;
  process.stdin.once("end", shutdown);
  process.stdin.once("error", shutdown);
  process.stdin.resume();
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
