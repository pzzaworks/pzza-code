import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import { createAppControl, createAppControlRouter, validateCommand } from "../lib/app-control.js";
import { APP_COMMANDS } from "../lib/app-control-schema.js";
import { TOOLS } from "../../mcp/lib/tools.js";

test("UI command is acknowledged by the selected live client only", async () => {
  const broker = createAppControl();
  broker.register("one", "First window");
  broker.register("two", "Second window");
  const waiting = broker.poll("one");
  const result = broker.command("one", "open_editor", { tileId: "tile-1", path: "/project/a.ts", layout: "stacked" });
  const { command } = await waiting;
  assert.equal(command.action, "open_editor");
  assert.throws(() => broker.result("two", command.id, {}), /unowned/);
  assert.deepEqual(broker.result("one", command.id, { opened: true }), { ok: true });
  assert.deepEqual(await result, { opened: true });
  assert.throws(() => broker.result("one", command.id, {}), /unowned/);
});

test("queued commands survive re-registration but cannot be acknowledged before delivery", async () => {
  const broker = createAppControl();
  broker.register("one", "Window");
  const result = broker.command("one", "get_state");
  broker.register("one", "Renamed window");
  assert.equal(broker.list()[0].label, "Renamed window");
  assert.throws(() => broker.result("one", "unknown", {}), /unowned/);
  const { command } = await broker.poll("one");
  broker.result("one", command.id, { tiles: [] });
  assert.deepEqual(await result, { tiles: [] });
});

test("timeout removes queued commands without replay or late acknowledgement", async () => {
  const broker = createAppControl({ commandMs: 5, pollMs: 5 });
  broker.register("one", "Window");
  await assert.rejects(broker.command("one", "get_state"), /not be replayed/);
  assert.deepEqual(await broker.poll("one"), { command: null });
  const pending = broker.command("one", "get_state");
  const rejected = assert.rejects(pending, /not be replayed/);
  const { command } = await broker.poll("one");
  await rejected;
  assert.throws(() => broker.result("one", command.id, {}), /expired/);
});

test("disconnect rejects pending calls and releases long polls", async () => {
  const broker = createAppControl();
  broker.register("one", "Window");
  const pending = assert.rejects(broker.command("one", "get_state"), /disconnected/);
  broker.remove("one");
  await pending;
  assert.throws(() => broker.command("one", "get_state"), /offline/);
  assert.throws(() => broker.command(undefined, "get_state"), /clientId/);
  broker.register("two", "Window");
  const poll = broker.poll("two");
  assert.throws(() => broker.poll("two"), /already active/);
  broker.remove("two");
  assert.deepEqual(await poll, { command: null });
});

test("UI failures propagate and command queues are bounded", async () => {
  const broker = createAppControl();
  broker.register("one", "Window");
  const failed = assert.rejects(broker.command("one", "focus_tile", { tileId: "missing" }), /Tile not found/);
  const { command } = await broker.poll("one");
  broker.result("one", command.id, undefined, "Tile not found");
  await failed;
  const pending = Array.from({ length: 32 }, () => assert.rejects(broker.command("one", "get_state"), /disconnected/));
  assert.throws(() => broker.command("one", "get_state"), /queue is full/);
  broker.remove("one");
  await Promise.all(pending);
});

test("client limits, stale cleanup and aborted polls are bounded", async () => {
  const broker = createAppControl({ staleMs: 5 });
  for (let i = 0; i < 16; i++) broker.register(`client-${i}`, "Window");
  assert.throws(() => broker.register("overflow", "Window"), /Too many/);
  const controller = new AbortController();
  const poll = broker.poll("client-0", controller.signal);
  controller.abort();
  assert.deepEqual(await poll, { command: null });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.deepEqual(broker.list(), []);
});

test("strict UI action and argument validation rejects unsafe or unsupported requests", () => {
  for (const [action, args] of [
    ["click", {}], ["get_state", { token: "not-allowed" }], ["focus_tile", { tileId: "bad\nId" }],
    ["open_editor", { tileId: "tile", path: "bad\u0000path" }],
    ["set_layout", { tileId: "tile", panel: "editor", layout: "full" }], ["set_layout", { tileId: "tile", layout: "floating" }],
    ["set_columns", { columns: 9 }], ["set_columns", { columns: 1.5 }],
  ]) assert.throws(() => validateCommand(action, args));
  assert.deepEqual(validateCommand("open_editor", { tileId: "tile", root: "/project", layout: "side-by-side" }), { tileId: "tile", root: "/project", layout: "side-by-side" });
  for (const tileId of ["devbox::my session", "session::w::2", "devbox::çalışma"]) assert.equal(validateCommand("focus_tile", { tileId }).tileId, tileId);
});

test("MCP UI tools require explicit clients and expose no page-content automation", () => {
  const tools = TOOLS.filter((tool) => tool.name.startsWith("app_"));
  assert.equal(tools.length, Object.keys(APP_COMMANDS).length + 1);
  assert.deepEqual(new Set(tools.filter(tool => tool.name !== "app_list_clients").map(tool => tool.name.slice(4))), new Set(Object.keys(APP_COMMANDS)));
  for (const tool of tools.filter((tool) => tool.name !== "app_list_clients")) assert.ok(tool.inputSchema.required.includes("clientId"));
  assert.ok(!tools.some((tool) => /click|evaluate|inspect/.test(tool.name)));
});

test("isolated HTTP broker routes registration, commands and actual UI results", async (t) => {
  const router = createAppControlRouter(createAppControl({ pollMs: 10 }));
  const server = http.createServer((req, res) => router(req, res, new URL(req.url, "http://localhost")));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}/app/control`;
  const post = (path, data) => fetch(`${base}/${path}`, { method: "POST", body: JSON.stringify(data) });
  assert.equal((await post("register", { clientId: "window", label: "Window" })).status, 200);
  const pending = post("command", { clientId: "window", action: "set_columns", args: { columns: 3 } });
  const { command } = await (await fetch(`${base}/poll?clientId=window`)).json();
  assert.equal(command.args.columns, 3);
  assert.equal((await post("result", { clientId: "window", id: command.id, result: { columns: 3 } })).status, 200);
  assert.deepEqual(await (await pending).json(), { columns: 3 });
  assert.equal((await post("register", { clientId: "bad", label: "x".repeat(1024 * 1024) })).status, 413);
});

test("array uniqueness ignores object key order and rejects duplicate nested preferences", () => {
  assert.throws(() => validateCommand("configure_notifications", { categories: [{ category: "sync", enabled: true }, { enabled: true, category: "sync" }] }), /unique/);
  assert.throws(() => validateCommand("configure_notifications", { categories: [{ category: "sync", enabled: true, unknown: true }] }), /Unknown/);
});

test("app tool annotations distinguish explicit reads, mutations and destructive operations", () => {
  for (const action of ["get_state", "editor_read_buffer", "terminal_read_output", "get_integrations"]) {
    const tool = TOOLS.find(item => item.name === `app_${action}`);
    assert.equal(tool.annotations.readOnlyHint, true, action);
    assert.equal(tool.annotations.destructiveHint, false, action);
  }
  for (const action of ["terminate_tile", "editor_discard", "editor_delete_file", "terminal_submit", "close_app"]) {
    const tool = TOOLS.find(item => item.name === `app_${action}`);
    assert.equal(tool.annotations.readOnlyHint, false, action);
    assert.equal(tool.annotations.destructiveHint, true, action);
  }
});
