import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";

test("the remote status probe preserves significant whitespace in existing credentials", () => {
  const nativeSource = readFileSync("src-tauri/src/rdp.rs", "utf8");
  const source = nativeSource.match(/let script = r#"python3 - <<'PY'\n([\s\S]*?)\nPY"#;/)?.[1];
  assert.ok(source);
  const user = " remote account ";
  const password = ` ${randomBytes(16).toString("hex")} `;
  const status = `RDP:\n\tStatus: enabled\n\tPort: 3389\n\tUsername: ${user}\n\tPassword: ${password}\n\tTLS fingerprint: ${"ab:".repeat(31)}ab\n`;
  const result = spawnSync("python3", ["-c", `
import json, subprocess, sys, types
request = json.load(sys.stdin)
def run(args, **kwargs):
    if args == ['sudo', '-n', 'grdctl', '--system', 'status', '--show-credentials']:
        return types.SimpleNamespace(returncode=0, stdout=request['status'])
    if args == ['systemctl', 'is-active', 'gnome-remote-desktop.service']:
        return types.SimpleNamespace(returncode=0, stdout='active\\n')
    raise AssertionError('Unexpected remote operation')
subprocess.run = run
exec(request['source'])
`], { input: JSON.stringify({ source, status }), encoding: "utf8", timeout: 2000 });
  assert.equal(result.status, 0);
  const state = JSON.parse(result.stdout);
  assert.ok(state.login.user === user);
  assert.ok(state.login.password === password);
  assert.equal(state.login.port, 3389);
  assert.equal(state.login.fingerprint, "ab".repeat(32));
});

const notices = [];
const saved = [];
const device = { id: "remote", name: "Remote server", host: "server" };
globalThis.rdpFixture = {
  invoke: async () => false,
  notify: notice => notices.push(notice),
  state: { devices: [device], deviceRdp: {}, setDeviceRdp: (id, config) => saved.push({ id, config }) },
};
const bundle = await build({
  stdin: { contents: 'export { rdpErrorMessage } from "./src/rdp"; export { openSaved, useRdpConnection } from "./src/panels/RdpMenu";', resolveDir: process.cwd() },
  bundle: true, write: false, platform: "browser", format: "esm", loader: { ".css": "empty" },
  plugins: [{ name: "rdp-boundaries", setup(builder) {
    builder.onResolve({ filter: /^(?:@tauri-apps\/api\/core|\.\.\/tauriEnv|\.\.\/state\/(?:notifications|store))$/ }, args => ({ path: args.path, namespace: "boundary" }));
    builder.onLoad({ filter: /.*/, namespace: "boundary" }, args => ({ contents:
      args.path.endsWith("/core") ? "export const invoke = (...args) => globalThis.rdpFixture.invoke(...args);" :
      args.path.endsWith("tauriEnv") ? "export const HAS_TAURI = true;" :
      args.path.endsWith("notifications") ? "export const notify = notice => globalThis.rdpFixture.notify(notice);" :
      "export const useStore = { getState: () => globalThis.rdpFixture.state };"
    }));
  } }],
});
const { rdpErrorMessage, openSaved, useRdpConnection } = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
const reset = () => {
  notices.length = 0;
  saved.length = 0;
  useRdpConnection.setState({ serverId: device.id, busy: false });
};

test("recognized desktop failures preserve short actionable native messages", () => {
  for (const code of ["RDP_INVALID_OPTIONS", "RDP_CREDENTIALS", "RDP_SETUP_FAILED", "RDP_DESKTOP_LOCKED", "RDP_SSH_FAILED", "RDP_VIEWER_MISSING", "RDP_AUTH_FAILED", "RDP_CONNECT_FAILED", "RDP_TASK_FAILED"]) {
    assert.equal(rdpErrorMessage({ code, message: "  Unlock the remote desktop, then try again.  " }), "Unlock the remote desktop, then try again.");
  }
});

test("unknown failures and malformed native messages never expose raw process output", () => {
  const fallback = rdpErrorMessage(undefined);
  const rawOutput = "[process] Connection failed\n[process] Diagnostic output";
  for (const error of [
    null, 42, rawOutput, new Error(rawOutput), { message: rawOutput },
    { code: "UNRECOGNIZED", message: "Unexpected process output" },
    { code: "RDP_CONNECT_FAILED", message: rawOutput },
    { code: "RDP_CONNECT_FAILED", message: "\u001b[31mProcess output" },
    { code: "RDP_CONNECT_FAILED", message: "Process\u2028output" },
    { code: "RDP_CONNECT_FAILED", message: "x".repeat(301) },
    { code: "RDP_CONNECT_FAILED", message: "  " },
    { code: "RDP_CONNECT_FAILED", message: {} },
    { toString: () => assert.fail("Errors must not be stringified") },
  ]) assert.equal(rdpErrorMessage(error), fallback);
  assert.match(fallback, /Settings/);
  assert.ok(fallback.length < 150);
});

test("failed launches publish one compact notification and release the busy state", async () => {
  reset();
  const error = { code: "RDP_DESKTOP_LOCKED", message: "Unlock the remote desktop, then try again." };
  globalThis.rdpFixture.invoke = async command => {
    if (command === "rdp_is_open") return false;
    throw error;
  };
  assert.equal(await openSaved(), false);
  assert.deepEqual(notices, [{ category: "app", title: "Could not open remote desktop", body: error.message }]);
  assert.equal(useRdpConnection.getState().busy, false);
  assert.deepEqual(saved, []);
});

test("raw native rejection uses the safe fallback and a later successful launch still saves its connection", async () => {
  reset();
  globalThis.rdpFixture.invoke = async () => { throw "[process] Raw diagnostic output"; };
  assert.equal(await openSaved(), false);
  assert.equal(notices[0].body, rdpErrorMessage(null));
  assert.equal(useRdpConnection.getState().busy, false);
  globalThis.rdpFixture.invoke = async command => command === "rdp_is_open" ? false : { port: 3389, mode: "system" };
  assert.equal(await openSaved(), true);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].config.port, 3389);
  assert.equal(saved[0].config.mode, "system");
  assert.equal(notices.length, 1);
  assert.equal(useRdpConnection.getState().busy, false);
});
