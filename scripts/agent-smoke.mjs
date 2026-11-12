// Boot a device agent from a server/ directory and wait for /health, fully
// isolated from the user's real state: a throwaway HOME, its own tmux socket and
// a free loopback port. Used by the bundle test (against a copy laid out exactly
// as the app bundle config lays it out) and by the release script (against the
// built .app), so an agent that cannot start never reaches anyone.
//
//   node scripts/agent-smoke.mjs <path/to/server>
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const BOOT_TIMEOUT_MS = 15_000;

function freePort() {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => done(port));
    });
  });
}

async function healthy(port, id) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) return false;
    const body = await response.json();
    return body.ok === true && body.id === id;
  } catch {
    return false;
  }
}

/**
 * Start `<serverDir>/index.js` and resolve once /health answers with this run's
 * agent id. Rejects with the agent's own output when it exits or never answers.
 * @param {string} serverDir
 */
export async function bootAgent(serverDir) {
  const home = await mkdtemp(join(tmpdir(), "pzza-agent-smoke-"));
  const port = await freePort();
  const id = `smoke-${process.pid}-${port}`;
  const child = spawn(process.execPath, [join(serverDir, "index.js")], {
    cwd: serverDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      TMPDIR: home,
      PORT: String(port),
      PZZA_AGENT_TOKEN: id,
      PZZA_AGENT_ID: id,
      PZZA_SERVER_HOST: "",
      PZZA_TMUX_SOCKET: join(home, "tmux.sock"),
    },
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  let exited = null;
  child.once("exit", (code, signal) => { exited = signal ?? code; });

  const stop = async () => {
    if (exited === null) {
      child.kill("SIGTERM");
      await new Promise((done) => {
        const force = setTimeout(() => { child.kill("SIGKILL"); }, 3000);
        child.once("exit", () => { clearTimeout(force); done(undefined); });
      });
    }
    await rm(home, { recursive: true, force: true });
  };

  try {
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (exited !== null) throw new Error(`agent exited (${exited}) before answering /health:\n${output.trim()}`);
      if (await healthy(port, id)) return;
      await new Promise((done) => setTimeout(done, 150));
    }
    throw new Error(`agent did not answer /health within ${BOOT_TIMEOUT_MS / 1000}s:\n${output.trim()}`);
  } finally {
    await stop();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: node scripts/agent-smoke.mjs <path/to/server>");
    process.exit(64);
  }
  bootAgent(resolve(dir)).then(
    () => console.log(`agent boots: ${resolve(dir)}`),
    (error) => {
      console.error(`agent smoke failed for ${resolve(dir)}\n${error instanceof Error ? error.message : error}`);
      process.exit(1);
    },
  );
}
