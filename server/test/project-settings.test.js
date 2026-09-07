import assert from "node:assert/strict";
import test from "node:test";
import { deviceExclusions, projectSettings } from "../../src/projectSettings.ts";

const defaults = { cloneMissing: true, switchToDefault: true, stashDirty: true, syncEnvs: true, envExclude: [], repos: {} };

test("saved device exclusions remain arrays when the sync menu is reopened", () => {
  const loaded = deviceExclusions(JSON.parse('["devbox"]'));
  assert.equal(loaded.includes("devbox"), true);
  assert.deepEqual(deviceExclusions([]), []);
  for (const value of [null, {}, "devbox", 1]) assert.deepEqual(deviceExclusions(value), []);
});

test("malformed persisted sync options cannot break render-time array and repository operations", () => {
  for (const value of [null, [], "invalid", { envExclude: null, repos: null }, { envExclude: "text", repos: { broken: null } }]) {
    const settings = projectSettings(value, defaults);
    assert.equal(settings.envExclude.join(", "), "");
    assert.deepEqual(settings.repos, {});
  }
  const settings = projectSettings({ stashDirty: false, envExclude: ["*.secret", 42], repos: { app: { enabled: false, env: false } } }, defaults);
  assert.equal(settings.stashDirty, false);
  assert.deepEqual(settings.envExclude, ["*.secret"]);
  assert.deepEqual(settings.repos.app, { enabled: false, env: false });
});
