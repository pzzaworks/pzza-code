// Writes src-tauri/src/agent_catalog.json from the agent catalog
// (server/lib/session-agents.js), the only copy the native side reads: the
// commands a restored terminal may type and the binaries setup looks for,
// with the path fragments that tell an agent's binary from a same-named tool.
// Run `node scripts/agent-catalog.mjs` after changing the catalog; the
// agent-catalog test fails while the file is out of date.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SESSION_AGENTS, agentBinaryPathRules, sessionAgentResumeAllowlist } from "../server/lib/session-agents.js";

export const NATIVE_CATALOG_PATH = fileURLToPath(new URL("../src-tauri/src/agent_catalog.json", import.meta.url));

export function nativeAgentCatalog() {
  const catalog = {
    agents: SESSION_AGENTS.map(agent => {
      const { exclude, require } = agentBinaryPathRules(agent);
      return { id: agent.id, binaries: [...agent.binaries], installDirs: [...agent.installDirs], excludePaths: exclude, requirePaths: require };
    }),
    resume: sessionAgentResumeAllowlist().map(({ command, programs, versionProgram }) => ({ command, programs, versionProgram })),
  };
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) writeFileSync(NATIVE_CATALOG_PATH, nativeAgentCatalog());
