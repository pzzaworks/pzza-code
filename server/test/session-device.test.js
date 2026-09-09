import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { shQuote } from "../lib/shell.js";

const result = await build({ entryPoints: ["src/connection.ts"], bundle: true, write: false, format: "esm", platform: "node" });
const { sessionConnection, attachCommand } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);

test("explicit local sessions never inherit a remote default connection", () => {
  const connection = sessionConnection("", { host: "remote-device" });
  assert.equal(connection.host, null);
  const command = attachCommand(connection, "same-name");
  assert.equal(command.cmd, "sh");
  assert.ok(!command.args.includes("remote-device"));
  assert.equal(connection.host ?? "", "");
});

test("named remote and inherited connections retain their target", () => {
  for (const [host, expected] of [["other-device", "other-device"], [undefined, "default-device"]]) {
    const connection = sessionConnection(host, { host: "default-device" });
    assert.equal(connection.host, expected);
    const command = attachCommand(connection, "same-name");
    assert.equal(command.cmd, "ssh");
    assert.ok(command.args.includes(expected));
  }
  assert.equal(attachCommand(sessionConnection(undefined, { host: null }), "same-name").cmd, "sh");
});

test("local attach routes every command through the managed socket with literal shell arguments", async (t) => {
  const root = await mkdtemp("/tmp/pzza-attach-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = path.join(root, "calls");
  const socket = path.join(root, "sock ' $(touch injected); $HOME");
  await writeFile(path.join(root, "tmux"), `#!/bin/sh\nprintf '%s\\0' "$@" >> ${shQuote(log)}\nprintf '\\n' >> ${shQuote(log)}\n`, { mode: 0o700 });
  for (const window of [undefined, 2]) {
    await writeFile(log, "");
    const command = attachCommand({ host: null }, "session ' $(touch injected)", "/tmp/folder ' quote", window);
    await promisify(execFile)(command.cmd, [command.args[0], `PATH=${shQuote(root)}:$PATH; ${command.args[1]}`], {
      timeout: 5000, cwd: root, env: { ...process.env, PZZA_TMUX_SOCKET: socket, TMUX: "/tmp/unrelated,1,0" },
    });
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => line.split("\0").slice(0, -1));
    assert.ok(calls.length >= 2);
    for (const args of calls) assert.deepEqual(args.slice(0, 3), ["-N", "-S", socket]);
    assert.equal(calls.at(-1)[3], "-u");
    assert.equal(calls.at(-1)[4], window === undefined ? "new-session" : "attach");
  }
  await assert.rejects(stat(path.join(root, "injected")), { code: "ENOENT" });
  for (const window of [undefined, 2]) {
    const remote = attachCommand({ host: "remote" }, "session", undefined, window);
    assert.ok(!remote.args.at(-1).includes("PZZA_TMUX_SOCKET"));
    assert.ok(!remote.args.at(-1).includes("-N -S"));
    assert.match(remote.args.at(-1), /exec tmux -u/);
  }
});

test("local attachment rejects an empty or relative managed socket before invoking tmux", async () => {
  const command = attachCommand({ host: null }, "session");
  for (const socket of ["", "relative"]) {
    await assert.rejects(promisify(execFile)(command.cmd, command.args, {
      timeout: 5000, env: { ...process.env, PZZA_TMUX_SOCKET: socket },
    }), { code: 1 });
  }
});
