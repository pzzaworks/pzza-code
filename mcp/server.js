#!/usr/bin/env node
// pzzacode-mcp server. Exposes everything PzzaCode's device agent manages -
// terminals, ports, forwarding, accounts/usage/spend, files, MCP wiring and
// remote install - as tools any MCP-speaking agent (Claude, Codex, Zed, …) can
// call. It drives the same guarded HTTP backend the app uses, so nothing here
// runs shell directly.
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
const qs = (params) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && `${v}` !== "") u.set(k, `${v}`);
  }
  const s = u.toString();
  return s ? `?${s}` : "";
};

// The tools map one-to-one onto the local device agent's HTTP API, so an MCP
// client (Claude, Codex, Zed, …) can drive everything PzzaCode itself does:
// terminals, ports, forwarding, accounts/usage/spend, files, MCP wiring, and
// installing the agent onto another device.
const TOOLS = [
  {
    name: "list_sessions",
    description: "List the tmux sessions on this device (name, windows, active command, path).",
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
    name: "scan_device",
    description:
      "Scan every tmux session on a device. host empty = this device; otherwise an ssh alias / user@host of an added device.",
    inputSchema: {
      type: "object",
      properties: { host: { type: "string", description: "ssh host (optional; blank = local)" } },
    },
    run: (a) => get(`/scan${qs({ host: a.host })}`),
  },
  {
    name: "session_path",
    description: "Get the live working directory of a session's active pane.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Session name" },
        window: { type: "number", description: "Window index (optional)" },
        host: { type: "string", description: "ssh host (optional)" },
      },
      required: ["name"],
    },
    run: (a) => get(`/session/path${qs({ name: a.name, window: a.window, host: a.host })}`),
  },
  {
    name: "create_session",
    description:
      "Create a new detached tmux session on this device, optionally bound to a Claude/Codex account.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Session name" },
        cwd: { type: "string", description: "Working directory (optional)" },
        account: {
          type: "object",
          description: "Optional agent account to bind: { provider, dir }.",
          properties: {
            provider: { type: "string" },
            dir: { type: "string" },
          },
        },
      },
      required: ["name"],
    },
    run: (a) => post("/create", { name: a.name, cwd: a.cwd, account: a.account }),
  },
  {
    name: "kill_session",
    description: "Terminate a tmux session (or a single window with `window`) on a device.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Session name" },
        window: { type: "number", description: "Window index (optional)" },
        host: { type: "string", description: "ssh host (optional; blank = local)" },
      },
      required: ["name"],
    },
    run: (a) => post("/kill", { name: a.name, window: a.window, host: a.host }),
  },
  {
    name: "list_ports",
    description: "List the TCP ports this device is currently listening on.",
    inputSchema: { type: "object", properties: {} },
    run: () => get("/ports"),
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
  {
    name: "capabilities",
    description: "Report the agent's role (source/client), whether it can forward, and its host.",
    inputSchema: { type: "object", properties: {} },
    run: () => get("/capabilities"),
  },
  {
    name: "doctor",
    description: "Environment diagnostics for this device's agent (role, tmux, storage, backend).",
    inputSchema: { type: "object", properties: {} },
    run: () => get("/doctor"),
  },
  {
    name: "list_accounts",
    description: "List the Claude / Codex agent accounts (config dirs) on this device.",
    inputSchema: { type: "object", properties: {} },
    run: () => get("/accounts"),
  },
  {
    name: "get_usage",
    description: "Claude/Codex account usage on this device (5h + weekly windows, per account).",
    inputSchema: { type: "object", properties: {} },
    run: () => get("/usage"),
  },
  {
    name: "get_spend",
    description: "Estimated spend per account (today / yesterday / trailing window).",
    inputSchema: { type: "object", properties: {} },
    run: () => get("/spend"),
  },
  {
    name: "mcp_config",
    description: "Show the MCP server path and which agent frameworks it is wired into.",
    inputSchema: { type: "object", properties: {} },
    run: () => get("/mcp/config"),
  },
  {
    name: "mcp_install",
    description: "Wire this MCP server into an agent framework's config (claude, codex, …).",
    inputSchema: {
      type: "object",
      properties: { framework: { type: "string", description: "Framework key, e.g. claude" } },
      required: ["framework"],
    },
    run: (a) => post("/mcp/install", { framework: a.framework }),
  },
  {
    name: "list_dir",
    description: "List a directory on this device (restricted to the home tree).",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Directory (optional; blank = home)" } },
    },
    run: (a) => get(`/fs/list${qs({ path: a.path })}`),
  },
  {
    name: "read_file",
    description: "Read a text file on this device (restricted to the home tree).",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string", description: "Absolute file path" } },
      required: ["path"],
    },
    run: (a) => get(`/file/read${qs({ path: a.path })}`),
  },
  {
    name: "write_file",
    description: "Write a text file on this device (restricted to the home tree).",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Absolute file path" },
        content: { type: "string", description: "New file contents" },
      },
      required: ["path", "content"],
    },
    run: (a) => post("/file/write", { path: a.path, content: a.content }),
  },
  {
    name: "ssh_hosts",
    description:
      "Auto-discover SSH targets from ~/.ssh/config and private-key identity files in ~/.ssh.",
    inputSchema: { type: "object", properties: {} },
    run: () => get("/ssh/hosts"),
  },
  {
    name: "install_agent",
    description:
      "Install the PzzaCode agent onto another device over SSH (you must already have SSH access). Returns the full install log.",
    inputSchema: {
      type: "object",
      properties: {
        target: { type: "string", description: "user@host or ssh alias" },
        port: { type: "number", description: "SSH port (optional)" },
        identity: { type: "string", description: "Identity file (optional)" },
        devboxHost: {
          type: "string",
          description: "For a client-role device: the source host it forwards to (optional)",
        },
        agentPort: { type: "number", description: "Agent port on the target (optional; 5190)" },
      },
      required: ["target"],
    },
    run: (a) =>
      post("/agent/install", {
        target: a.target,
        port: a.port,
        identity: a.identity,
        devboxHost: a.devboxHost,
        agentPort: a.agentPort,
      }),
  },
];

const server = new Server(
  { name: "pzzacode-mcp", version: "0.2.3" },
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
