#!/usr/bin/env node
// pzzacode-mcp server. Exposes the devbox sessions / windows / ports that
// PzzaCode manages as tools any MCP-speaking agent (Claude, Codex, Zed, …)
// can call. It drives the PzzaCode HTTP backend, so nothing here runs shell
// directly - the same guarded endpoints the app uses.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const BASE = process.env.PZZA_SERVER_URL || "http://127.0.0.1:5190";

async function api(path, opts) {
  const res = await fetch(`${BASE}${path}`, opts);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
const get = (p) => api(p);
const post = (p, body) =>
  api(p, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });

const TOOLS = [
  {
    name: "list_sessions",
    description: "List the tmux sessions on the devbox (name, windows, active command, path).",
    inputSchema: { type: "object", properties: {} },
    run: () => get("/sessions"),
  },
  {
    name: "list_windows",
    description: "List every tmux window across sessions (session, index, name, command, path).",
    inputSchema: { type: "object", properties: {} },
    run: () => get("/windows"),
  },
  {
    name: "list_ports",
    description: "List the TCP ports the devbox is currently listening on.",
    inputSchema: { type: "object", properties: {} },
    run: () => get("/ports"),
  },
  {
    name: "create_session",
    description: "Create a new detached tmux session on the devbox.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Session name" },
        cwd: { type: "string", description: "Working directory (optional)" },
      },
      required: ["name"],
    },
    run: (a) => post("/create", { name: a.name, cwd: a.cwd }),
  },
  {
    name: "kill_session",
    description: "Terminate a tmux session (or a single window with `window`) on the devbox.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Session name" },
        window: { type: "number", description: "Window index (optional)" },
      },
      required: ["name"],
    },
    run: (a) => post("/kill", { name: a.name, window: a.window }),
  },
  {
    name: "forwarding_status",
    description: "Get the port-forwarding status (enabled + active ports).",
    inputSchema: { type: "object", properties: {} },
    run: () => get("/forward/status"),
  },
  {
    name: "set_forwarding",
    description: "Enable or disable port forwarding (only effective on the forwarding client).",
    inputSchema: {
      type: "object",
      properties: { enabled: { type: "boolean" } },
      required: ["enabled"],
    },
    run: (a) => post("/forward/toggle", { enabled: a.enabled }),
  },
];

const server = new Server(
  { name: "pzzacode-mcp", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = TOOLS.find((t) => t.name === req.params.name);
  if (!tool) throw new Error(`unknown tool: ${req.params.name}`);
  try {
    const result = await tool.run(req.params.arguments ?? {});
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    return { content: [{ type: "text", text: `error: ${e.message}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
