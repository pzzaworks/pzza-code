import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

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
