import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { maskApiKey, readOpencodeKeysFile } from "../lib/accounts.js";

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

test("shell key files parse quoted and bare exports, skipping comments and short values", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pzza-keysfile-"));
  const file = path.join(root, ".opencode-keys");
  await writeFile(file, [
    "# comment line",
    'export OP_KEY_A="filekey-AAAAAAAAAAAAAAAAAAAAAAAA"',
    "export OP_KEY_B='filekey-BBBBBBBBBBBBBBBBBBBBBBBB'",
    "export OP_KEY_C=filekey-CCCCCCCCCCCCCCCCCCCCCCCC # trailing comment",
    "export SHORT=abc",
    "export EMPTY=\"\"",
    "not an export",
    "",
  ].join("\n"));
  assert.deepEqual(readOpencodeKeysFile(file), [
    "filekey-AAAAAAAAAAAAAAAAAAAAAAAA",
    "filekey-BBBBBBBBBBBBBBBBBBBBBBBB",
    "filekey-CCCCCCCCCCCCCCCCCCCCCCCC",
  ]);
  assert.deepEqual(readOpencodeKeysFile(path.join(root, "missing")), []);
});
