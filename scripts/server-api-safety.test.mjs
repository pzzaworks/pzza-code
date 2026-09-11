import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const output = await build({ entryPoints: [new URL("../src/serverApi.ts", import.meta.url).pathname], bundle: true, platform: "node", format: "esm", write: false });
const api = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`);
const originalFetch = globalThis.fetch;
test.after(() => { globalThis.fetch = originalFetch; });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// Requests use isolated in-memory responses; no real device or user file is touched.
test("file drops retain the explicit local target and validate the upload receipt", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: new URL(url), init });
    return json({ id: "a".repeat(32), paths: ["/tmp/drop/file name.txt"] });
  };
  const file = new File(["sample"], "file name.txt");
  const result = await api.uploadTerminalDrop([file], "", new AbortController().signal);
  assert.deepEqual(result.paths, ["/tmp/drop/file name.txt"]);
  assert.equal(calls[0].url.searchParams.get("host"), "");
  assert.deepEqual(JSON.parse(calls[0].url.searchParams.get("files")), [{ name: "file name.txt", size: 6 }]);
  assert.equal(await calls[0].init.body.text(), "sample");
  assert.equal(calls[0].init.method, "POST");
});

test("invalid returned paths clean the exact receipt without accepting arbitrary cleanup paths", async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: new URL(url), method: init.method });
    return init.method === "DELETE" ? json({ ok: true }) : json({ id: "b".repeat(32), paths: ["relative-path"] });
  };
  await assert.rejects(api.uploadTerminalDrop([new File(["x"], "one.txt")], "devbox", new AbortController().signal), /invalid uploaded file paths/);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url.searchParams.get("id"), "b".repeat(32));
  assert.equal(calls[1].url.searchParams.has("host"), false);
  assert.equal(calls[1].url.searchParams.has("path"), false);
  await assert.rejects(api.discardTerminalDrop("../file"), /Invalid upload receipt/);
  assert.equal(calls.length, 2);
});

test("cancelled drops cannot start a device request", async () => {
  const controller = new AbortController();
  controller.abort(new DOMException("Cancelled", "AbortError"));
  let writes = 0;
  globalThis.fetch = async (_url, init) => {
    if (init.signal.aborted) throw init.signal.reason;
    writes++;
    return json({});
  };
  await assert.rejects(api.uploadTerminalDrop([new File(["x"], "one.txt")], "devbox", controller.signal), { name: "AbortError" });
  assert.equal(writes, 0);
});

test("Quick Chat validates launcher and managed session identity", async () => {
  globalThis.fetch = async () => json({ session: "pzza-quick-chat", host: "devbox", agent: "codex", launcher: "codex", identity: "$1:22:33" });
  const chat = await api.openQuickChat("devbox", "codex");
  assert.equal(chat.identity, "$1:22:33");
  assert.equal(chat.launcher, "codex");
  // Reusing a managed conversation reports its actual owning profile rather
  // than pretending a changed preference restarted it.
  assert.equal((await api.openQuickChat("devbox", "claude")).agent, "codex");
  globalThis.fetch = async () => json({ session: "pzza-quick-chat", host: "devbox", agent: "codex", launcher: "claude", identity: "$1:22:33" });
  await assert.rejects(api.openQuickChat("devbox", "codex"), /Invalid Quick Chat response/);
  globalThis.fetch = async () => json({ verified: true });
  await api.verifyQuickChat("devbox", "codex", "$1:22:33");
  await assert.rejects(api.verifyQuickChat("devbox", "codex", "unknown"), /identity is unavailable/);
  globalThis.fetch = async () => json({ error: "Session no longer exists" }, 409);
  await assert.rejects(api.verifyQuickChat("devbox", "codex", "$1:22:33"), error => error.status === 409);
});

test("folder browsing retains target, cancellation, and authorization errors", async () => {
  const controller = new AbortController();
  globalThis.fetch = async (url, init) => {
    assert.equal(new URL(url).searchParams.get("host"), "");
    assert.equal(init.signal, controller.signal);
    return json({ error: "Folder is not permitted" }, 403);
  };
  await assert.rejects(api.listDir("/project", "", controller.signal), error => error.status === 403 && /not permitted/.test(error.message));
});
