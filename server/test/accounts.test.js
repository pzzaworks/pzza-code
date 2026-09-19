import assert from "node:assert/strict";
import test from "node:test";
import { maskApiKey } from "../lib/accounts.js";

test("api key fingerprints keep head and tail while hiding the middle", () => {
  assert.equal(maskApiKey("sk-ant-abcdefghijklmnop123456"), "sk-a…3456");
  assert.equal(maskApiKey("abcdefghij123"), "abcd…j123");
  assert.equal(maskApiKey("abcde"), "ab…de");
  assert.equal(maskApiKey("abcd"), "••••");
  assert.equal(maskApiKey(""), "••••");
  assert.equal(maskApiKey(null), "••••");
});

test("fingerprints never contain the full key", () => {
  for (const key of ["sk-ant-abcdefghijklmnop123456", "op_0123456789abcdef", "short-key-1"]) {
    const hint = maskApiKey(key);
    assert.ok(hint.length < key.length, `${hint} must be shorter than the key`);
    assert.ok(!hint.includes(key.slice(4, -4)), `${hint} must hide the key middle`);
  }
});
