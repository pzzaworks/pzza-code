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
import { APP_TOOLS } from "../lib/app-tools.js";
import { APP_COMMANDS, validateAppCommand } from "../../server/lib/app-control-schema.js";
import { createAppControl, createAppControlRouter } from "../../server/lib/app-control.js";

const viewCommands = [
  "get_notification_view", "set_notification_view",
  "get_sync_view", "set_sync_view",
];

function rejects(action, cases) {
  for (const args of cases) assert.throws(() => validateAppCommand(action, args), undefined, JSON.stringify(args));
}

test("the four mounted view tools expose matching strict schemas and explicit client selection", () => {
  for (const action of viewCommands) {
    const matches = APP_TOOLS.filter(tool => tool.name === `app_${action}`);
    assert.equal(matches.length, 1, action);
    const [tool] = matches;
    assert.equal(tool.description, APP_COMMANDS[action].description);
    assert.equal(tool.inputSchema.additionalProperties, false);
    assert.deepEqual(tool.inputSchema.required, ["clientId"]);
    assert.deepEqual(tool.inputSchema.properties, {
      clientId: { type: "string", minLength: 1, maxLength: 128, description: "Explicit app client ID from app_list_clients" },
      ...APP_COMMANDS[action].properties,
    });
    assert.equal(tool.annotations.readOnlyHint, action.startsWith("get_"));
    assert.equal(tool.annotations.destructiveHint, false);
    assert.equal(tool.annotations.openWorldHint, action.startsWith("set_"));
    assert.deepEqual(validateAppCommand(action, {}), {});
    rejects(action, [{ unknown: true }, [], null]);
  }
});

test("notification view validation rejects unsupported filters and non-integer page sizes", () => {
  const action = "set_notification_view";
  for (const category of ["all", "sync", "terminal", "devices", "app"]) {
    const args = { category, unreadOnly: true, eventsExpanded: false, limit: 300 };
    assert.deepEqual(validateAppCommand(action, args), args);
  }
  assert.deepEqual(validateAppCommand(action, { limit: 1 }), { limit: 1 });
  rejects(action, [
    { category: "all categories" }, { category: "" }, { category: "bridge" }, { unreadOnly: 1 }, { eventsExpanded: "false" },
    { limit: 0 }, { limit: 301 }, { limit: 1.5 }, { limit: "15" },
  ]);
});

test("Sync view validation bounds unique folder and project arrays and permits clearing disclosure", () => {
  const action = "set_sync_view";
  for (const args of [
    { filter: "all", expandedFolders: [], expandedProjects: [] },
    { filter: "attention", expandedFolders: ["/group", "/group/nested"], expandedProjects: ["local:one"] },
    { expandedFolders: Array.from({ length: 1000 }, (_, i) => `/folder-${i}`), expandedProjects: ["x".repeat(4096)] },
  ]) assert.deepEqual(validateAppCommand(action, args), args);
  rejects(action, [
    { filter: "dirty" }, { expandedFolders: ["/same", "/same"] }, { expandedProjects: ["same", "same"] },
    { expandedFolders: [""] }, { expandedProjects: ["bad\nproject"] }, { expandedFolders: [`/bad${String.fromCharCode(0)}path`] },
    { expandedProjects: ["x".repeat(4097)] }, { expandedFolders: Array.from({ length: 1001 }, (_, i) => `/folder-${i}`) },
    { expandedFolders: "/group" }, { expandedProjects: [1] },
  ]);
});

test("source MCP advertises all four views and preserves selected-client results and errors", { timeout: 15000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pzza-view-tools-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const broker = createAppControl({ pollMs: 200, commandMs: 2000 });
  broker.register("first-view-window", "Disposable first window");
  broker.register("second-view-window", "Disposable second window");
  const router = createAppControlRouter(broker);
  const server = http.createServer((req, res) => router(req, res, new URL(req.url, "http://127.0.0.1")));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { broker.remove("first-view-window"); broker.remove("second-view-window"); server.closeAllConnections(); server.close(); });
  const client = new Client({ name: "pzza-view-tools-test", version: "1.0.0" });
  t.after(() => client.close());
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../server.js", import.meta.url))],
    cwd: directory,
    env: { HOME: directory, XDG_CONFIG_HOME: directory, PZZA_SERVER_URL: `http://127.0.0.1:${server.address().port}`, PZZA_AGENT_HOST: "" },
    stderr: "pipe",
  });
  await client.connect(transport, { timeout: 5000 });
  const { tools } = await client.listTools();
  const expected = APP_TOOLS.filter(tool => viewCommands.includes(tool.name.slice(4))).map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, annotations }));
  assert.deepEqual(tools.filter(tool => viewCommands.includes(tool.name.slice(4))), expected);
  const listed = await client.callTool({ name: "app_list_clients", arguments: {} });
  assert.deepEqual(JSON.parse(listed.content[0].text).map(item => item.clientId), ["first-view-window", "second-view-window"]);

  for (const [action, args] of [
    ["get_notification_view", {}], ["set_notification_view", { unreadOnly: true, category: "sync", limit: 15 }],
    ["get_sync_view", {}], ["set_sync_view", { filter: "attention", expandedFolders: ["/group"], expandedProjects: ["local:one"] }],
  ]) {
    const waiting = broker.poll("second-view-window");
    const pending = client.callTool({ name: `app_${action}`, arguments: { clientId: "second-view-window", ...args } });
    const { command } = await waiting;
    assert.equal(command.action, action);
    assert.deepEqual(command.args, args);
    assert.throws(() => broker.result("first-view-window", command.id, {}), /unowned/);
    const result = action.startsWith("get_") ? { page: "disposable", query: "needle" } : { configured: true };
    broker.result("second-view-window", command.id, result);
    const outcome = await pending;
    assert.ok(!outcome.isError);
    assert.deepEqual(JSON.parse(outcome.content[0].text), result);
  }

  for (const [args, expectedError] of [
    [{}, /clientId/], [{ clientId: "offline-window" }, /offline/],
    [{ clientId: "second-view-window", limit: 0 }, /Invalid limit/],
    [{ clientId: "second-view-window", category: "unknown" }, /Invalid category/],
  ]) {
    const outcome = await client.callTool({ name: "app_set_notification_view", arguments: args });
    assert.equal(outcome.isError, true);
    assert.match(outcome.content[0].text, expectedError);
  }
  const waiting = broker.poll("second-view-window");
  const pending = client.callTool({ name: "app_set_sync_view", arguments: { clientId: "second-view-window", filter: "attention" } });
  const { command } = await waiting;
  broker.result("second-view-window", command.id, undefined, "Open the Sync repositories page first.");
  const failure = await pending;
  assert.equal(failure.isError, true);
  assert.match(failure.content[0].text, /422.*Open the Sync repositories page first/);
});
