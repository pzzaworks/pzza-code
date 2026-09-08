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
import { watchDesktopLifetime } from "./lib/agent-lifecycle.js";
import { quickChatRouter } from "./lib/quick-chat.js";

import { DEVBOX, IS_CLIENT, MCP_PATH, PORT, STATE_DIR } from "./lib/config.js";
import { SSH_TOKEN, sh, shOn, shQuote } from "./lib/shell.js";
import {
  AGENT_ID,
  cors,
  hostOk,
  json,
  ndjson,
  readBody,
  requestToken,
  tokenOk,
} from "./lib/http.js";
import { listPorts, listPortDetails } from "./lib/ports.js";
import { listSessions, listWindows, scanSessions, sessionActivity, terminateSession, duplicateSession } from "./lib/tmux.js";
import { forwardStatus, setForwardEnabled, startForwardLoop } from "./lib/forward.js";
import { accountEnvArg, listAccounts } from "./lib/accounts.js";
import { USAGE_FRESH_MS, collectUsage } from "./lib/usage.js";
import { SPEND_FRESH_MS, computeSpend } from "./lib/spend.js";
import { deviceInfo } from "./lib/device-info.js";
import { deviceOs, doctor, sshHosts } from "./lib/system.js";
import { mcpConfigs, mcpInstall } from "./lib/mcp.js";
import { createAppControl, createAppControlRouter } from "./lib/app-control.js";
import { createBridge, createBridgeRouter } from "./lib/bridge.js";
import { createAgentsHub, createAgentsHubRouter } from "./lib/agents-hub.js";
import { installAgent } from "./lib/install.js";
import { filesRouter } from "./lib/files.js";
import { startPtyBridge, sweepOrphanViews } from "./lib/pty.js";
import { scanProjects, syncProjects, cancelProjectSync } from "./lib/projects.js";

// A query-param host, validated for safe ssh use ("" when absent/invalid).
const queryHost = (url) => {
  const h = url.searchParams.get("host") || "";
  return SSH_TOKEN.test(h) ? h : "";
};

const appControl = createAppControl();
const appControlRouter = createAppControlRouter(appControl, json);
const bridge = createBridge({ stateDir: STATE_DIR, appControl });
const bridgeRouter = createBridgeRouter(bridge, json);
const agentsHubRouter = createAgentsHubRouter(createAgentsHub({ stateDir: STATE_DIR }), json);
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
  // Signed bridge requests authenticate independently and never receive the local token.
  if (await bridgeRouter(req, res, url, true)) return;
  // Everything except the liveness probe needs the per-launch token.
  if (url.pathname !== "/health" && !tokenOk(requestToken(req, url))) {
    return json(res, 401, { error: "unauthorized" });
  }
  if (await bridgeRouter(req, res, url)) return;
  if (await agentsHubRouter(req, res, url)) return;
  if (await appControlRouter(req, res, url)) return;
  if (await quickChatRouter(req, res, url, json)) return;

  if (url.pathname === "/capabilities") {
    return json(res, 200, { role: IS_CLIENT ? "client" : "source", forward: IS_CLIENT, host: DEVBOX || null });
  }
  if (url.pathname === "/doctor") return json(res, 200, await doctor());
  if (url.pathname === "/usage") {
    return json(res, 200, await collectUsage({ fresh: url.searchParams.get("fresh") === "1" }));
  }
  if (url.pathname === "/accounts") return json(res, 200, listAccounts());
  if (url.pathname === "/spend") return json(res, 200, await computeSpend({ fresh: url.searchParams.get("fresh") === "1" }));

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
  if (url.pathname === "/scan") {
    const host = url.searchParams.has("host") ? url.searchParams.get("host") : undefined;
    if (host && !SSH_TOKEN.test(host)) return json(res, 400, { error: "invalid host" });
    try { return json(res, 200, await scanSessions(host)); }
    catch { return json(res, 503, { error: "Could not scan sessions on this device" }); }
  }
  if (url.pathname === "/sessions/activity" && req.method === "GET") {
    const host = url.searchParams.has("host") ? url.searchParams.get("host") : undefined;
    if (host && !SSH_TOKEN.test(host)) return json(res, 400, { error: "invalid host" });
    return json(res, 200, await sessionActivity(host));
  }
  if (url.pathname === "/device/info" && req.method === "GET") {
    const host = url.searchParams.get("host") || "";
    if (host && !SSH_TOKEN.test(host)) return json(res, 400, { error: "invalid host" });
    return json(res, 200, await deviceInfo(host, { fresh: url.searchParams.get("fresh") === "1" }));
  }
  if (url.pathname === "/device/os" && req.method === "GET") {
    const host = url.searchParams.get("host") || "";
    if (host && !SSH_TOKEN.test(host)) return json(res, 400, { error: "invalid host" });
    return json(res, 200, await deviceOs(host));
  }
  if (url.pathname === "/ssh/hosts") return json(res, 200, sshHosts());
  if (url.pathname === "/windows") return json(res, 200, await listWindows());
  if (url.pathname === "/ports/details") {
    const host = url.searchParams.has("host") ? url.searchParams.get("host") : undefined;
    if (host && !SSH_TOKEN.test(host)) return json(res, 400, { error: "invalid host" });
    try { return json(res, 200, await listPortDetails(host)); }
    catch (error) { return json(res, 503, { error: error.message }); }
  }
  if (url.pathname === "/ports") return json(res, 200, await listPorts());
  if (url.pathname === "/health") return json(res, 200, { ok: true, id: AGENT_ID });
  if (url.pathname === "/forward/status") return json(res, 200, forwardStatus());

  if (url.pathname === "/kill" && req.method === "POST") {
    const body = await readBody(req);
    if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "invalid request" });
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return json(res, 400, { error: "session name is required" });
    if (body.host !== undefined && (typeof body.host !== "string" || (body.host && !SSH_TOKEN.test(body.host)))) {
      return json(res, 400, { error: "invalid host" });
    }
    const hasWin = body.window !== undefined && body.window !== null;
    if (hasWin && (!Number.isInteger(body.window) || body.window < 0)) return json(res, 400, { error: "invalid window" });
    try {
      await terminateSession(name, hasWin ? body.window : undefined, body.host);
      json(res, 200, { ok: true });
    } catch {
      json(res, 500, { error: "Could not close the session on this device" });
    }
    return;
  }
  if (url.pathname === "/sessions/duplicate" && req.method === "POST") {
    const body = await readBody(req);
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        typeof body.name !== "string" || !body.name.trim() || /[\x00-\x1f\x7f]/.test(body.name) ||
        (body.window !== undefined && (!Number.isInteger(body.window) || body.window < 0)) ||
        (body.host !== undefined && (typeof body.host !== "string" || (body.host && !SSH_TOKEN.test(body.host))))) {
      return json(res, 400, { error: "Invalid source session, window, or device" });
    }
    try { return json(res, 200, await duplicateSession(body.name, body.window, body.host)); }
    catch { return json(res, 500, { error: "Could not duplicate the session on this device. Check that the source window is still running." }); }
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
  // Project sync: git repos under the projects root, across every device.
  if (url.pathname === "/projects/scan" && req.method === "POST") {
    const body = await readBody(req);
    if (req.headers.accept === "application/x-ndjson") {
      const send = ndjson(res);
      try {
        const result = await scanProjects(body, {
          redact: true,
          onProgress: (progress) => send({ type: "progress", progress }),
        });
        send(result.error ? { type: "error", error: result.error } : { type: "result", result });
      } catch {
        send({ type: "error", error: "Project scan failed" });
      }
      return res.end();
    }
    const out = await scanProjects(body, { redact: true });
    return json(res, out.error ? 400 : 200, out);
  }
  if (url.pathname === "/projects/sync/cancel" && req.method === "POST") {
    const body = await readBody(req);
    const result = cancelProjectSync(body.operationId);
    return json(res, result.error ? 400 : 200, result);
  }
  if (url.pathname === "/projects/sync" && req.method === "POST") {
    const out = await syncProjects(await readBody(req));
    return json(res, out.error ? 400 : 200, out);
  }
  if (url.pathname === "/mcp/config") {
    const agentHost = url.searchParams.get("agentHost") || "";
    const mcpPath = url.searchParams.get("mcpPath") || MCP_PATH;
    if (mcpPath.length > 4096 || /[\x00-\x1f]/.test(mcpPath)) return json(res, 400, { error: "Invalid MCP path" });
    try { return json(res, 200, { path: mcpPath, ...mcpConfigs(mcpPath, { agentHost }) }); }
    catch { return json(res, 400, { error: "Invalid SSH agent host" }); }
  }
  if (url.pathname === "/mcp/install" && req.method === "POST") {
    const body = await readBody(req);
    return json(res, 200, await mcpInstall(String(body.framework || ""), MCP_PATH));
  }

  json(res, 404, { error: "not found" });
});

// If the port is already taken, a previous agent that has not yet noticed its
// own parent died may still hold it, so retry the bind for a few seconds to let
// that stale sibling self-exit. Past that window the occupant is not a
// self-releasing agent, so fail loudly - another process must not silently
// become "the agent" the app talks to (the app also verifies /health's id).
const BIND_DEADLINE = Date.now() + 8000;
server.on("error", (e) => {
  if (e && e.code === "EADDRINUSE" && Date.now() < BIND_DEADLINE) {
    setTimeout(() => server.listen(PORT, "127.0.0.1"), 500).unref();
    return;
  }
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


// Cancel owned bridge jobs before the device agent exits normally.
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  // Bound cleanup even when bridge jobs or sockets have not settled.
  const timeout = setTimeout(() => process.exit(1), 3000);
  void bridge.close().then(() => {
    clearTimeout(timeout);
    process.exit(0);
  }, () => process.exit(1));
}
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, shutdown);
watchDesktopLifetime(shutdown);
