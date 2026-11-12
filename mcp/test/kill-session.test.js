import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TOOLS } from "../lib/tools.js";
import { validateAppCommand } from "../../server/lib/app-control-schema.js";
import { createAppControl, createAppControlRouter } from "../../server/lib/app-control.js";

// kill_session ends a session only after the user confirms it in an app
// window: it never calls the device agent's /kill directly.
async function harness(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pzza-kill-session-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const broker = createAppControl({ pollMs: 200, commandMs: 2000 });
  const router = createAppControlRouter(broker);
  const direct = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (await router(req, res, url)) return;
    direct.push(url.pathname);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const client = new Client({ name: "pzza-kill-session-test", version: "1.0.0" });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../server.js", import.meta.url))],
    cwd: directory,
    env: { HOME: directory, XDG_CONFIG_HOME: directory, PZZA_SERVER_URL: `http://127.0.0.1:${server.address().port}`, PZZA_AGENT_HOST: "" },
    stderr: "pipe",
  }), { timeout: 5000 });
  return { broker, client, direct };
}

const errorOf = outcome => JSON.parse(outcome.content[0].text).error.message;

test("kill_session is advertised as destructive and asks for the app's confirmation", () => {
  const tool = TOOLS.find(item => item.name === "kill_session");
  assert.equal(tool.annotations.destructiveHint, true);
  assert.equal(tool.annotations.readOnlyHint, false);
  assert.match(tool.description, /must confirm it in the PzzaCode app/);
  assert.deepEqual(validateAppCommand("terminate_session", { session: "api", window: 1, host: "devbox" }), { session: "api", window: 1, host: "devbox" });
  for (const args of [{}, { session: "" }, { session: "bad\nname" }, { session: "api", window: -1 }, { session: "api", host: "-oProxyCommand=x" }, { session: "api", extra: true }]) {
    assert.throws(() => validateAppCommand("terminate_session", args), undefined, JSON.stringify(args));
  }
});

test("without an app window to confirm in, kill_session kills nothing", { timeout: 15000 }, async t => {
  const { client, direct } = await harness(t);
  const outcome = await client.callTool({ name: "kill_session", arguments: { name: "api" } });
  assert.equal(outcome.isError, true);
  assert.match(errorOf(outcome), /needs the user's confirmation in the PzzaCode app/);
  assert.deepEqual(direct, [], "the device agent was never asked to kill");
});

test("kill_session goes to the app as terminate_session and reports the user's answer", { timeout: 15000 }, async t => {
  const { broker, client, direct } = await harness(t);
  broker.register("only-window", "Disposable window");
  t.after(() => broker.remove("only-window"));

  // Confirmed in the app: the app ends the session and reports it.
  let waiting = broker.poll("only-window");
  let pending = client.callTool({ name: "kill_session", arguments: { name: "api", window: 2, host: "devbox" } });
  let { command } = await waiting;
  assert.equal(command.action, "terminate_session");
  assert.deepEqual(command.args, { session: "api", window: 2, host: "devbox" });
  broker.result("only-window", command.id, { terminated: true, closedTiles: [] });
  let outcome = await pending;
  assert.ok(!outcome.isError);
  assert.deepEqual(JSON.parse(outcome.content[0].text), { terminated: true, closedTiles: [] });

  // Declined in the app: the call fails and nothing is killed.
  waiting = broker.poll("only-window");
  pending = client.callTool({ name: "kill_session", arguments: { name: "api" } });
  ({ command } = await waiting);
  assert.deepEqual(command.args, { session: "api" });
  broker.result("only-window", command.id, undefined, "The action was cancelled in the app.");
  outcome = await pending;
  assert.equal(outcome.isError, true);
  assert.match(errorOf(outcome), /cancelled in the app/);
  assert.deepEqual(direct, [], "the device agent was never asked to kill directly");
});

test("with several app windows open, kill_session needs the window to ask in", { timeout: 15000 }, async t => {
  const { broker, client, direct } = await harness(t);
  broker.register("first-window", "Disposable first window");
  broker.register("second-window", "Disposable second window");
  t.after(() => { broker.remove("first-window"); broker.remove("second-window"); });
  const ambiguous = await client.callTool({ name: "kill_session", arguments: { name: "api" } });
  assert.equal(ambiguous.isError, true);
  assert.match(errorOf(ambiguous), /Pass clientId from app_list_clients/);
  const waiting = broker.poll("second-window");
  const pending = client.callTool({ name: "kill_session", arguments: { name: "api", clientId: "second-window" } });
  const { command } = await waiting;
  assert.equal(command.action, "terminate_session");
  broker.result("second-window", command.id, { terminated: true, closedTiles: ["api"] });
  assert.ok(!(await pending).isError);
  assert.deepEqual(direct, []);
});
