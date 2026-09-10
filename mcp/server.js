#!/usr/bin/env node
// pzzacode-mcp server. Exposes everything PzzaCode's device agent manages -
// terminals, ports, forwarding, accounts/usage/spend, files, MCP wiring and
// remote install - as tools any MCP-speaking agent (Claude, Codex, Zed, …) can
// call. It drives the same guarded HTTP backend the app uses, so nothing here
// runs shell directly. The HTTP client lives in ./lib/agent.js and the tool
// table in ./lib/tools.js; this file just wires them to the MCP transport.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { TOOLS } from "./lib/tools.js";
import { toolResult } from "./lib/results.js";
import { redactTerminalOutput } from "../server/lib/terminal-redaction.js";
import { GIT_PROTECTION_INSTRUCTIONS } from "../server/lib/git-protection-policy.js";

const server = new Server(
  { name: "pzzacode-mcp", version: "0.2.21" },
  { capabilities: { tools: {} }, instructions: GIT_PROTECTION_INSTRUCTIONS },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map(({ name, description, inputSchema, annotations }) => ({ name, description, inputSchema, ...(annotations ? { annotations } : {}) })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = TOOLS.find((t) => t.name === req.params.name);
  if (!tool) throw new Error(`unknown tool: ${req.params.name}`);
  try {
    const result = await tool.run(req.params.arguments ?? {});
    return toolResult(tool.name, result);
  } catch (e) {
    return { content: [{ type: "text", text: JSON.stringify({ error: { code: typeof e.code === "string" && /^[A-Z_]{1,80}$/.test(e.code) ? e.code : "TOOL_FAILED", status: Number.isInteger(e.status) ? e.status : 500, message: redactTerminalOutput(String(e.message || "Tool failed")).text.slice(0, 4096), ...(typeof e.requestId === "string" && /^[a-f0-9-]{36}$/.test(e.requestId) ? { requestId: e.requestId } : {}) } }) }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
