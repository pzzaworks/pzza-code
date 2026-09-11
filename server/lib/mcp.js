// Wiring the pzzacode-mcp MCP server into agent frameworks: the per-framework
// config snippets, and the automatic install - through the framework CLI where
// one exists, otherwise by merging the entry straight into the client's
// config file (with a private backup of the original).
import { run, SSH_TOKEN } from "./shell.js";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
      opencode: {
        label: "OpenCode",
        cli: true,
        config: JSON.stringify(
          { mcp: { "pzzacode-mcp": { type: "local", command: ["node", mcpPath], ...(agentHost ? { environment: env } : {}) } } },
          null,
          2,
        ),
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

async function resolveOpencode() {
  const direct = await run("opencode", ["--version"]);
  if (direct.ok) return "opencode";
  const home = os.homedir();
  for (const candidate of [
    path.join(home, ".opencode", "bin", "opencode"),
    "/opt/homebrew/bin/opencode",
    "/usr/local/bin/opencode",
  ]) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* try the next location */
    }
  }
  return "opencode";
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
  if (framework === "opencode") {
    // The installer puts opencode outside PATH (~/.opencode/bin), so fall back
    // to its well-known locations when the bare command does not resolve.
    const r = await run(await resolveOpencode(), ["mcp", "add", "pzzacode-mcp", "--", "node", mcpPath]);
    return { framework, ...r, via: "opencode mcp add" };
  }
  if (framework === "cursor" || framework === "windsurf" || framework === "zed") {
    return installFileEntry(framework, mcpPath);
  }
  return { framework, ok: false, manual: true, error: "no installer - copy the config into your settings" };
}

// Frameworks without an `mcp add` CLI: merge the server entry directly into
// the client's JSON config file. Existing settings are preserved, the
// original is backed up next to the file, and writes are atomic.
const FILE_FRAMEWORKS = {  cursor: { rel: path.join(".cursor", "mcp.json"), keys: ["mcpServers"], entry: (mcpPath) => ({ command: "node", args: [mcpPath] }) },
  windsurf: { rel: path.join(".codeium", "windsurf", "mcp_config.json"), keys: ["mcpServers"], entry: (mcpPath) => ({ command: "node", args: [mcpPath] }) },
  zed: { rel: path.join(".config", "zed", "settings.json"), keys: ["context_servers"], entry: (mcpPath) => ({ command: { path: "node", args: [mcpPath] } }) },
};

export function installFileEntry(framework, mcpPath, home = os.homedir()) {
  const spec = FILE_FRAMEWORKS[framework];
  if (!spec) return { framework, ok: false, manual: true, error: "no installer - copy the config into your settings" };
  if (typeof mcpPath !== "string" || !mcpPath || /[\0-\x1f\x7f]/.test(mcpPath)) {
    return { framework, ok: false, manual: true, error: "invalid MCP script path" };
  }
  try {
    const file = path.join(home, spec.rel);
    if (path.relative(home, file).startsWith("..") || path.isAbsolute(spec.rel)) {
      return { framework, ok: false, manual: true, error: "invalid client configuration location" };
    }
    let config = {};
    let original = null;
    if (fs.existsSync(file)) {
      original = fs.readFileSync(file, "utf8");
      let parsed;
      try {
        parsed = JSON.parse(original);
      } catch {
        parsed = null;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { framework, ok: false, manual: true, error: `existing ${spec.rel} is not valid JSON - copy the config manually` };
      }
      config = parsed;
    }
    let node = config;
    for (const key of spec.keys) {
      if (node[key] === undefined) node[key] = {};
      if (!node[key] || typeof node[key] !== "object" || Array.isArray(node[key])) {
        return { framework, ok: false, manual: true, error: `existing ${spec.rel} has an incompatible section - copy the config manually` };
      }
      node = node[key];
    }
    const wanted = spec.entry(mcpPath);
    if (node["pzzacode-mcp"] !== undefined && JSON.stringify(node["pzzacode-mcp"]) === JSON.stringify(wanted)) {
      return { framework, ok: true, via: spec.rel, unchanged: true };
    }
    node["pzzacode-mcp"] = wanted;
    const content = `${JSON.stringify(config, null, 2)}\n`;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    if (original !== null) {
      const backup = `${file}.pzza-backup-${crypto.createHash("sha256").update(original).digest("hex").slice(0, 8)}`;
      try {
        fs.writeFileSync(backup, original, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        if (fs.readFileSync(backup, "utf8") !== original) {
          return { framework, ok: false, manual: true, error: "existing configuration backup looks unsafe - copy the config manually" };
        }
      }
    }
    const temporary = `${file}.pzza-tmp-${process.pid}`;
    fs.writeFileSync(temporary, content, { mode: 0o600 });
    fs.renameSync(temporary, file);
    return { framework, ok: true, via: spec.rel };
  } catch (error) {
    const message = error instanceof Error ? error.message : "could not write the client configuration";
    return { framework, ok: false, manual: true, error: message };
  }
}
