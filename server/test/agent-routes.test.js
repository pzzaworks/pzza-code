// The real agent process: malformed JSON bodies are answered with 400 and
// never end the process. It runs with a private HOME and a tmux socket path
// no server listens on, so it can reach none of the user's sessions or files.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const entry = fileURLToPath(new URL("../index.js", import.meta.url));

async function freePort() {
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const { port } = listener.address();
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

async function startAgent(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pzza-agent-routes-"));
  const port = await freePort();
  const token = randomBytes(24).toString("hex");
  const agent = spawn(process.execPath, [entry], {
    env: { ...process.env, PORT: String(port), HOME: root, XDG_CONFIG_HOME: root, PZZA_SERVER_HOST: "",
      PZZA_TMUX_SOCKET: path.join(root, "no-server"), PZZA_AGENT_TOKEN: token, PZZA_MANAGED_AGENT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    if (agent.exitCode === null && agent.signalCode === null) {
      agent.kill("SIGTERM");
      await once(agent, "exit");
    }
    await rm(root, { recursive: true, force: true });
  });
  await once(agent.stdout, "data");
  const post = async (pathname, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body,
    });
    return { status: response.status, text: await response.text() };
  };
  const get = async (pathname) => {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { headers: { Authorization: `Bearer ${token}` } });
    return { status: response.status, text: await response.text() };
  };
  return { agent, port, post, get };
}

test("a JSON null, array or primitive body is refused on every route and never ends the agent", { timeout: 30_000 }, async (t) => {
  const { agent, port, post } = await startAgent(t);
  const routes = ["/projects/sync/cancel", "/projects/sync", "/projects/scan", "/forward/toggle", "/mcp/install",
    "/file/write", "/agent/install", "/create", "/kill", "/sessions/duplicate", "/ports/kill", "/mcp/repair", "/usage/fix"];
  for (const route of routes) {
    for (const body of ["null", "[]", "7", '"text"']) {
      const response = await post(route, body);
      assert.equal(response.status, 400, `${route} ${body}: ${response.text}`);
    }
  }
  const health = await fetch(`http://127.0.0.1:${port}/health`);
  assert.equal(health.status, 200);
  assert.equal(agent.exitCode, null, "the agent is still running");
});

test("window termination validates the window id it is given", { timeout: 30_000 }, async (t) => {
  const { post } = await startAgent(t);
  for (const windowId of ["1", "@", "@1 ; true", 5, "@-1"]) {
    const response = await post("/kill", JSON.stringify({ name: "work", window: 1, windowId }));
    assert.equal(response.status, 400, JSON.stringify(windowId));
  }
  // A well-formed id on a device with no tmux server fails without crashing.
  assert.equal((await post("/kill", JSON.stringify({ name: "work", window: 1, windowId: "@3" }))).status, 500);
});

test("window listings take a validated device, and one without a tmux server has none", { timeout: 30_000 }, async (t) => {
  const { get } = await startAgent(t);
  for (const host of ["bad host", "-oProxyCommand=x", "a;b"]) {
    assert.equal((await get(`/windows?host=${encodeURIComponent(host)}`)).status, 400, host);
  }
  assert.deepEqual(await get("/windows?host="), { status: 200, text: "[]" });
  assert.deepEqual(await get("/windows"), { status: 200, text: "[]" });
});
