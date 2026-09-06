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

const server = new Server(
  { name: "pzzacode-mcp", version: "0.2.20" },
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
