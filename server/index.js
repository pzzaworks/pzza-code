// PzzaCode backend. Runs in one of two roles:
//
//   source   (default, on the devbox): tmux/ports are local; it cannot forward.
//   receiver (PZZA_SERVER_HOST set, on the Mac): tmux/ports come from the devbox
//            over ssh, and it OWNS port forwarding (ssh -L), so the UI exposes a
//            global enable/disable - the "receiver controls" only show here.
//
// The frontend asks /capabilities and shows forwarding controls only when the
// connected backend can actually forward. This file is the composition root: it
// wires the HTTP routes to the focused modules in ./lib and boots the server.
import http from "node:http";

import { DEVBOX, IS_CLIENT, MCP_PATH, PORT } from "./lib/config.js";
import { SSH_TOKEN, sh, shOn, shQuote } from "./lib/shell.js";
import {
  AGENT_ID,
  cors,
  hostOk,
  json,
  readBody,
  requestToken,
  tokenOk,
} from "./lib/http.js";
import { listPorts } from "./lib/ports.js";
import { listSessions, listWindows, scanSessions } from "./lib/tmux.js";
import { forwardStatus, setForwardEnabled, startForwardLoop } from "./lib/forward.js";
import { accountEnvArg, listAccounts } from "./lib/accounts.js";
import { USAGE_FRESH_MS, collectUsage } from "./lib/usage.js";
import { SPEND_FRESH_MS, computeSpend } from "./lib/spend.js";
import { doctor, sshHosts } from "./lib/system.js";
import { mcpConfigs, mcpInstall } from "./lib/mcp.js";
import { installAgent } from "./lib/install.js";
import { filesRouter } from "./lib/files.js";
import { startPtyBridge, sweepOrphanViews } from "./lib/pty.js";

// A query-param host, validated for safe ssh use ("" when absent/invalid).
const queryHost = (url) => {
  const h = url.searchParams.get("host") || "";
  return SSH_TOKEN.test(h) ? h : "";
};

const server = http.createServer(async (req, res) => {
  // Defeat DNS rebinding: only a loopback Host on our port is served at all.
  if (!hostOk(req)) {
    res.writeHead(421, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: "bad host" }));
  }
  if (req.method === "OPTIONS") {
    cors(res);
    res.writeHead(204);
    return res.end();
  }
  const url = new URL(req.url, `http://${req.headers.host}`);
  // Everything except the liveness probe needs the per-launch token.
  if (url.pathname !== "/health" && !tokenOk(requestToken(req, url))) {
    return json(res, 401, { error: "unauthorized" });
  }

  if (url.pathname === "/capabilities") {
    return json(res, 200, { role: IS_CLIENT ? "client" : "source", forward: IS_CLIENT, host: DEVBOX || null });
  }
  if (url.pathname === "/doctor") return json(res, 200, await doctor());
  if (url.pathname === "/usage") return json(res, 200, await collectUsage());
  if (url.pathname === "/accounts") return json(res, 200, listAccounts());
  if (url.pathname === "/spend") return json(res, 200, await computeSpend());

  // File access (local + ssh-proxied): /fs/list, /file/read|raw|write, /paste-image.
  if (await filesRouter(req, res, url)) return;

  if (url.pathname === "/agent/install" && req.method === "POST") {
    return installAgent(await readBody(req), res);
  }
  if (url.pathname === "/sessions") return json(res, 200, await listSessions());
  // Live current directory of a session's active pane, so the code editor can
  // root at wherever the terminal actually is right now (a fresh session, or one
  // that has cd'd since the last scan).
  if (url.pathname === "/session/path") {
    const name = String(url.searchParams.get("name") || "").trim();
    if (!name) return json(res, 400, { error: "name required" });
    const win = url.searchParams.get("window");
    const target = win !== null && win !== "" ? `${name}:${win}` : name;
    const cmd = `tmux display-message -p -t ${shQuote(target)} '#{pane_current_path}'`;
    const out = await new Promise((resolve) =>
      shOn(queryHost(url), cmd, (err, o) => resolve(err ? "" : String(o || "").trim())),
    );
    return json(res, 200, { path: out });
  }
  if (url.pathname === "/scan") return json(res, 200, await scanSessions(queryHost(url)));
  if (url.pathname === "/ssh/hosts") return json(res, 200, sshHosts());
  if (url.pathname === "/windows") return json(res, 200, await listWindows());
  if (url.pathname === "/ports") return json(res, 200, await listPorts());
  if (url.pathname === "/health") return json(res, 200, { ok: true, id: AGENT_ID });
  if (url.pathname === "/forward/status") return json(res, 200, forwardStatus());

  if (url.pathname === "/kill" && req.method === "POST") {
    const body = await readBody(req);
    const name = String(body.name || "").trim();
    if (name) {
      const hasWin = body.window !== undefined && body.window !== null;
      const cmd = hasWin
        ? `tmux kill-window -t ${shQuote(name + ":" + body.window)}`
        : `tmux kill-session -t ${shQuote(name)}`;
      const host = SSH_TOKEN.test(String(body.host || "")) ? String(body.host) : "";
      shOn(host, cmd, () => {});
    }
    return json(res, 200, { ok: true });
  }
  if (url.pathname === "/forward/toggle" && req.method === "POST") {
    const body = await readBody(req);
    return json(res, 200, { enabled: setForwardEnabled(body.enabled) });
  }
  if (url.pathname === "/create" && req.method === "POST") {
    const body = await readBody(req);
    const name = String(body.name || "").trim();
    if (name) {
      const cwd = body.cwd ? ` -c ${shQuote(body.cwd)}` : "";
      const env = accountEnvArg(body.account); // binds a Claude/Codex account
      sh(`tmux new-session -d -s ${shQuote(name)}${cwd}${env}`, () => {});
    }
    return json(res, 200, { ok: true });
  }
  if (url.pathname === "/mcp/config") return json(res, 200, { path: MCP_PATH, ...mcpConfigs(MCP_PATH) });
  if (url.pathname === "/mcp/install" && req.method === "POST") {
    const body = await readBody(req);
    return json(res, 200, await mcpInstall(String(body.framework || ""), MCP_PATH));
  }

  json(res, 404, { error: "not found" });
});

// Fail loudly if the port is already taken (another process must not silently
// become "the agent" the app talks to); the app verifies /health's id as well.
server.on("error", (e) => {
  console.error(`PzzaCode agent: cannot listen on 127.0.0.1:${PORT} (${e && e.code ? e.code : e})`);
  process.exit(2);
});
server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `PzzaCode agent on 127.0.0.1:${PORT} · role=${IS_CLIENT ? `client (ssh ${DEVBOX})` : "source"}`,
  );
  sweepOrphanViews();
  startPtyBridge(server);
  startForwardLoop();
  // Warm the spend estimate in the background and keep it fresh, so the usage
  // panel gets it instantly instead of waiting on a multi-second transcript scan.
  const warmSpend = () => computeSpend().catch(() => undefined);
  setTimeout(warmSpend, 1500);
  setInterval(warmSpend, SPEND_FRESH_MS);
  // Warm the account usage the same way: the provider round-trips happen in the
  // background so the first time the panel opens it is already populated.
  const warmUsage = () => collectUsage().catch(() => undefined);
  setTimeout(warmUsage, 800);
  setInterval(warmUsage, USAGE_FRESH_MS);
});
