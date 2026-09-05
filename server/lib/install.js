// Install the agent on a remote device the user already has SSH access to. We
// only take their SSH details; the whole install runs over that connection:
// push the agent files, then run install.sh on the device. Progress streams
// back line by line as chunked text.
import { spawn } from "node:child_process";
import { REPO_ROOT } from "./config.js";
import { SSH_TOKEN, sshBaseArgs } from "./shell.js";
import { cors } from "./http.js";

export function installAgent(opts, res) {
  cors(res);
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-cache",
  });
  const say = (line) => res.write(String(line).replace(/\r/g, ""));

  const target = String(opts.target || "").trim();
  if (!SSH_TOKEN.test(target)) {
    say("ERROR: invalid SSH target\n");
    return res.end();
  }
  const port = opts.port ? Number(opts.port) : 0;
  if (opts.port && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    say("ERROR: invalid port\n");
    return res.end();
  }
  const identity = opts.identity ? String(opts.identity) : "";
  const serverHost = opts.serverHost ? String(opts.serverHost) : "";
  if (serverHost && !SSH_TOKEN.test(serverHost)) {
    say("ERROR: invalid devbox host\n");
    return res.end();
  }
  const agentPort = Number.isInteger(Number(opts.agentPort)) ? Number(opts.agentPort) : 5190;
  const base = sshBaseArgs({ port, identity });

  const runSsh = (remoteCmd) =>
    new Promise((resolve) => {
      const p = spawn("ssh", [...base, target, remoteCmd]);
      p.stdout.on("data", (d) => say(d.toString()));
      p.stderr.on("data", (d) => say(d.toString()));
      p.on("error", (e) => {
        say(`ERROR: ${e.message}\n`);
        resolve(1);
      });
      p.on("close", (code) => resolve(code ?? 0));
    });

  (async () => {
    say(`==> Connecting to ${target} ...\n`);
    if ((await runSsh("echo pzza-ok")) !== 0) {
      say("ERROR: could not SSH in. Set up key-based access first (e.g. ssh-copy-id).\n");
      return res.end();
    }
    say("Connected.\n\n==> Transferring agent files ...\n");

    // The agent entry, its lib/ modules and package manifest, plus the MCP
    // server and installer. Explicit paths so no node_modules is ever shipped.
    const files = [
      "server/index.js",
      "server/lib",
      "server/package.json",
      "mcp/server.js",
      "mcp/package.json",
      "install.sh",
    ];
    const tar = spawn("tar", ["czf", "-", "-C", REPO_ROOT, ...files]);
    const ssh = spawn("ssh", [
      ...base,
      target,
      "mkdir -p ~/pzzacode-agent && tar xzf - -C ~/pzzacode-agent",
    ]);
    tar.stderr.on("data", (d) => say(d.toString()));
    ssh.stderr.on("data", (d) => say(d.toString()));
    tar.stdout.pipe(ssh.stdin);
    const xfer = await new Promise((r) => ssh.on("close", (c) => r(c ?? 0)));
    if (xfer !== 0) {
      say("ERROR: file transfer failed.\n");
      return res.end();
    }
    say("Files in ~/pzzacode-agent\n\n==> Running installer on the device (may take a minute) ...\n");

    const envPrefix = `PORT=${agentPort} PZZA_SERVER_HOST='${serverHost}'`;
    const code = await runSsh(
      `cd ~/pzzacode-agent && chmod +x install.sh && ${envPrefix} bash install.sh`,
    );
    if (code !== 0) {
      say(`\nERROR: installer exited with code ${code}\n`);
      return res.end();
    }
    say(`\n==> DONE - agent installed and started on ${target}.\n`);
    res.end();
  })();
}
