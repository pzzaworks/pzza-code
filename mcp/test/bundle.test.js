import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { TOOLS } from "../lib/tools.js";

test("packaged MCP initializes and calls the agent without installed dependencies", { timeout: 15000 }, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pzza-mcp-bundle-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const resources = path.join(directory, "PzzaCode.app", "Contents", "Resources");
  const mcp = path.join(resources, "mcp");
  await mkdir(mcp, { recursive: true });

  // Copy the actual resource mappings into an isolated app, with no source
  // modules or node_modules available to hide a packaging regression.
  const configUrl = new URL("../../src-tauri/tauri.conf.json", import.meta.url);
  const config = JSON.parse(await readFile(configUrl, "utf8"));
  for (const destination of ["mcp/server.js", "mcp/package.json"]) {
    const source = Object.entries(config.bundle.resources).find(([, target]) => target === destination)?.[0];
    assert.ok(source, `Missing bundled resource: ${destination}`);
    await copyFile(new URL(source, configUrl), path.join(resources, destination));
  }
  assert.deepEqual((await readdir(mcp)).sort(), ["package.json", "server.js"]);

  const token = randomBytes(24).toString("hex");
  const requests = [];
  const agent = http.createServer((req, res) => {
    requests.push({ url: req.url, method: req.method, authorized: req.headers.authorization === `Bearer ${token}` });
    res.setHeader("Content-Type", "application/json");
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: "unauthorized" }));
    } else if (req.url === "/capabilities") {
      res.end(JSON.stringify({ role: "source", forward: false, host: null }));
    } else {
      res.writeHead(503);
      res.end(JSON.stringify({ error: "Device unavailable" }));
    }
  });
  t.after(() => new Promise((resolve, reject) => agent.close((error) => error ? reject(error) : resolve())));
  agent.listen(0, "127.0.0.1");
  await once(agent, "listening");
  const address = agent.address();
  assert.ok(address && typeof address === "object");

  const client = new Client({ name: "pzza-mcp-bundle-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(mcp, "server.js")],
    cwd: directory,
    env: { PZZA_SERVER_URL: `http://127.0.0.1:${address.port}`, PZZA_AGENT_TOKEN: token },
    stderr: "pipe",
  });
  t.after(() => client.close());
  await client.connect(transport, { timeout: 5000 });
  assert.equal(client.getServerVersion()?.name, "pzzacode-mcp");

  const { tools } = await client.listTools();
  assert.deepEqual(tools, TOOLS.map(({ name, description, inputSchema, annotations }) => ({
    name, description, inputSchema, ...(annotations ? { annotations } : {}),
  })));

  const result = await client.callTool({ name: "capabilities", arguments: {} });
  assert.ok(!result.isError);
  assert.deepEqual(result.content, [{ type: "text", text: JSON.stringify({ role: "source", forward: false, host: null }, null, 2) }]);
  const failure = await client.callTool({ name: "device_info", arguments: {} });
  assert.equal(failure.isError, true);
  assert.match(failure.content[0].text, /503.*Device unavailable/);
  assert.deepEqual(requests, [
    { url: "/capabilities", method: "GET", authorized: true },
    { url: "/device/info", method: "GET", authorized: true },
  ]);
});
