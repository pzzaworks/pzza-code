// Wiring the pzzacode-mcp MCP server into agent frameworks: the per-framework
// config snippets, and the CLI install where one exists.
import { run } from "./shell.js";

// Per-framework config snippets for adding the pzzacode-mcp MCP server.
export function mcpConfigs(mcpPath) {
  const jsonEntry = { command: "node", args: [mcpPath] };
  const jsonBlock = (root) => JSON.stringify({ [root]: { "pzzacode-mcp": jsonEntry } }, null, 2);
  return {
    frameworks: {
      claude: { label: "Claude Code", cli: true, config: jsonBlock("mcpServers") },
      codex: {
        label: "Codex",
        cli: true,
        config: `[mcp_servers.pzzacode-mcp]\ncommand = "node"\nargs = ["${mcpPath}"]`,
      },
      cursor: { label: "Cursor", cli: false, config: jsonBlock("mcpServers") },
      windsurf: { label: "Windsurf", cli: false, config: jsonBlock("mcpServers") },
      zed: {
        label: "Zed",
        cli: false,
        config: JSON.stringify(
          { context_servers: { "pzzacode-mcp": { command: { path: "node", args: [mcpPath] } } } },
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
