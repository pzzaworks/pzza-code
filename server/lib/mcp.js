// Wiring the pzzacode-mcp MCP server into agent frameworks: the per-framework
// config snippets, and the CLI install where one exists.
import { run, SSH_TOKEN } from "./shell.js";

// Per-framework config snippets for adding the pzzacode-mcp MCP server.
export function mcpConfigs(mcpPath, { agentHost = "" } = {}) {
  if (agentHost && !SSH_TOKEN.test(agentHost)) throw new Error("Invalid SSH agent host");
  const env = agentHost ? { PZZA_AGENT_HOST: agentHost } : {};
  const jsonEntry = { command: "node", args: [mcpPath], ...(agentHost ? { env } : {}) };
  const jsonBlock = (root) => JSON.stringify({ [root]: { "pzzacode-mcp": jsonEntry } }, null, 2);
  return {
    frameworks: {
      claude: { label: "Claude Code", cli: true, config: jsonBlock("mcpServers") },
      codex: {
        label: "Codex",
        cli: true,
        config: `[mcp_servers.pzzacode-mcp]\ncommand = "node"\nargs = [${JSON.stringify(mcpPath)}]${agentHost ? `\n\n[mcp_servers.pzzacode-mcp.env]\nPZZA_AGENT_HOST = ${JSON.stringify(agentHost)}` : ""}`,
      },
      cursor: { label: "Cursor", cli: false, config: jsonBlock("mcpServers") },
      windsurf: { label: "Windsurf", cli: false, config: jsonBlock("mcpServers") },
      zed: {
        label: "Zed",
        cli: false,
        config: JSON.stringify(
          { context_servers: { "pzzacode-mcp": { command: { path: "node", args: [mcpPath], ...(agentHost ? { env } : {}) } } } },
          null,
          2,
        ),
      },
    },
  };
}

export async function mcpInstall(framework, mcpPath) {
  if (framework === "claude") {
    const r = await run("claude", ["mcp", "add", "-s", "user", "pzzacode-mcp", "--", "node", mcpPath]);
    return { framework, ...r, via: "claude mcp add" };
  }
  if (framework === "codex") {
    const r = await run("codex", ["mcp", "add", "pzzacode-mcp", "--", "node", mcpPath]);
    return { framework, ...r, via: "codex mcp add" };
  }
  return { framework, ok: false, manual: true, error: "no CLI - copy the config into your settings" };
}
