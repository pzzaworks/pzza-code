// The service definitions install.sh writes must never let the service
// manager take a tmux server down with the agent.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const installer = await readFile(new URL("../../install.sh", import.meta.url), "utf8");
const section = (start, end) => {
  const from = installer.indexOf(start);
  const to = installer.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `${start} block is present`);
  return installer.slice(from, to);
};

test("the systemd unit stops only the agent process, never the tmux server it started", () => {
  const unit = section("<<UNIT", "\nUNIT\n");
  const service = unit.slice(unit.indexOf("[Service]"), unit.indexOf("[Install]"));
  assert.match(service, /^KillMode=process$/m);
  assert.doesNotMatch(service, /^KillMode=(?!process$)/m);
  assert.match(service, /^Restart=on-failure$/m);
  // Existing installs pick the new unit up when the installer runs again.
  const register = section("register_systemd() {", "\n}\n");
  assert.ok(register.indexOf("systemctl --user daemon-reload") > register.indexOf("\nUNIT\n"));
});

test("the launchd job abandons its process group so tmux outlives an agent restart", () => {
  const plist = section("<<PLIST", "\nPLIST\n");
  assert.match(plist, /<key>AbandonProcessGroup<\/key><true\/>/);
});
