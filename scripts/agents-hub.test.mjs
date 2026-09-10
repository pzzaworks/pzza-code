import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

const memory = new Map();
globalThis.localStorage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
globalThis.window = Object.assign(new EventTarget(), { location: { protocol: "http:", hostname: "127.0.0.1", port: "1438" } });
const output = await build({ stdin: { contents: 'export * from "./src/agentsHubApi.ts"; export * from "./src/state/hubReads.ts"; export * from "./src/state/hubDraft.ts"; export * from "./src/agentsHubCatalog.ts";', resolveDir: fileURLToPath(new URL("../", import.meta.url)) }, bundle: true, platform: "browser", format: "esm", write: false });
const api = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`);
const tick = () => new Promise(resolve => setImmediate(resolve));
const summary = { revision: 7, frameworks: [], deployments: [], documents: Array.from({ length: 4 }, (_, index) => ({ id: `global-${index}`, name: `Global ${index}`, framework: "claude", contentBytes: 100 })), skills: [{ id: "review", name: "Review", contentBytes: 100, files: [{ path: "scripts/check.sh", executable: true, bytes: 10 }] }], profiles: [{ id: "reviewer", name: "Reviewer", framework: "claude", systemPromptBytes: 10, instructionIds: ["global-0"], skillIds: ["review"] }] };

test("healthy and local global reads publish before an offline peer and requests deduplicate", async () => {
  const waiting = new Map();
  let active = 0, maximum = 0;
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(url).pathname, "/agents-hub/global-discover");
    const { devices } = JSON.parse(options.body);
    assert.equal(devices.length, 1);
    active++; maximum = Math.max(maximum, active);
    const device = devices[0];
    return new Promise(resolve => waiting.set(device.host, () => { active--; resolve(Response.json({ devices: [{ ...device, files: [], ...(device.host === "offline" ? { error: "Offline" } : {}) }] })); }));
  };
  const devices = ["offline", "", "healthy", "fourth", "fifth"].map(host => ({ host, name: host || "Local" }));
  const published = [];
  const task = api.discoverGlobalInstructions(devices, device => published.push(device.host));
  await tick();
  assert.equal(waiting.size, 4);
  const joined = api.discoverGlobalInstructions([{ host: "", name: "Local" }], () => {});
  await tick(); assert.equal(waiting.size, 4);
  waiting.get("")(); await joined; await tick();
  assert.ok(published.includes("")); assert.ok(!published.includes("offline")); assert.ok(waiting.has("fifth"));
  waiting.get("healthy")(); await tick(); assert.ok(published.includes("healthy"));
  for (const host of ["fourth", "fifth", "offline"]) waiting.get(host)();
  await task; assert.equal(maximum, 4);
  let cached = 0;
  globalThis.fetch = () => assert.fail("Cached globals should not hit the network");
  await api.discoverGlobalInstructions(devices, () => cached++);
  assert.equal(cached, 5);
  assert.equal(api.cachedGlobalInstructions(devices).length, 5);
  globalThis.fetch = async (_url, options) => { const { devices } = JSON.parse(options.body); return Response.json({ devices: devices.map(device => ({ ...device, files: [] })) }); };
  await api.discoverGlobalInstructions(devices, () => {}, true);
});

test("metadata and selected details are cached separately and edits never send summaries or asset metadata", async () => {
  api.invalidateHub();
  const requests = [];
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ path, body });
    if (path.endsWith("/summary")) return Response.json(summary);
    if (path.endsWith("/item")) return Response.json({ revision: 7, item: { ...summary.skills[0], contentBytes: undefined, content: "Original instructions" } });
    if (path.endsWith("/update")) return Response.json({ ...summary, revision: 8 });
    assert.fail(`Unexpected full-library request: ${path}`);
  };
  await Promise.all([api.fetchHub(), api.fetchHub()]);
  assert.equal(requests.length, 1); assert.equal(requests[0].path, "/agents-hub/summary");
  const [detail] = await Promise.all([api.fetchHubItem("skill", "review", 7), api.fetchHubItem("skill", "review", 7)]);
  assert.equal(requests.length, 2); assert.equal(detail.item.files[0].contentBase64, undefined);
  const draft = api.changeHubDraft(api.emptyHubDraft(), 7, { op: "update", kind: "skill", item: { id: "review", content: "Edited instructions" } });
  await api.updateHub(draft.revision, draft.changes);
  assert.deepEqual(requests[2].body, { revision: 7, changes: [{ op: "update", kind: "skill", item: { id: "review", content: "Edited instructions" } }] });
  assert.equal(JSON.stringify(requests[2].body).includes("files"), false);
  assert.equal(api.peekHub(), undefined);
});

test("dirty drafts keep their original optimistic revision and preserve unrelated library items", () => {
  let draft = api.changeHubDraft(api.emptyHubDraft(), 7, { op: "update", kind: "skill", item: { id: "review", name: "Renamed" } });
  draft = api.changeHubDraft(draft, 8, { op: "update", kind: "skill", item: { id: "review", content: "Unsaved instructions" } });
  assert.equal(draft.revision, 7); assert.equal(draft.changes.length, 1);
  assert.deepEqual(draft.changes[0].item, { id: "review", name: "Renamed", content: "Unsaved instructions" });
  const view = api.hubDraftSummary(summary, draft);
  assert.deepEqual(view.documents, summary.documents);
  assert.equal(view.skills[0].files[0].path, "scripts/check.sh");
  assert.equal(view.skills[0].content, undefined);
  draft = api.changeHubDraft(draft, 8, { op: "remove", kind: "document", id: "global-0", detachReferences: true });
  assert.deepEqual(api.hubDraftSummary(summary, draft).profiles[0].instructionIds, []);
  assert.deepEqual(summary.profiles[0].instructionIds, ["global-0"]);
  let created = api.changeHubDraft(api.emptyHubDraft(), 7, { op: "update", kind: "skill", item: { id: "new", name: "New", content: "Draft" } });
  created = api.changeHubDraft(created, 7, { op: "update", kind: "profile", item: { id: "reviewer", skillIds: ["review", "new"] } });
  created = api.discardNewHubItem(created, "skill", "new");
  assert.equal(created.changes.length, 1); assert.deepEqual(created.changes[0].item.skillIds, ["review"]);
});

test("cache invalidation cannot be undone by an old in-flight response", async () => {
  const cache = api.createReadCache(2, 30000);
  let resolve;
  const old = cache.read("key", () => new Promise(done => { resolve = done; }));
  cache.clear();
  await cache.read("key", async () => "current");
  resolve("stale"); await old;
  assert.equal(cache.peek("key"), "current");
  await cache.read("second", async () => "second"); await cache.read("third", async () => "third");
  assert.equal(cache.peek("key"), undefined);
});

test("import update conflicts retain draft state and actionable errors preserve status and code", async () => {
  const draft = api.changeHubDraft(api.emptyHubDraft(), 7, { op: "update", kind: "skill", item: { id: "review", content: "Retained" } });
  globalThis.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(options.body);
    if (path.endsWith("/import-skill")) {
      assert.equal(body.updateId, "review");
      return Response.json({ error: "The public repository was not found. Check the URL.", code: "SOURCE_NOT_FOUND" }, { status: 404 });
    }
    assert.equal(body.revision, 7);
    return Response.json({ error: "Agent library changed. Draft is retained." }, { status: 409 });
  };
  await assert.rejects(api.importHubSkill(7, "https://github.com/example/skills", "review", "review"), { status: 404, code: "SOURCE_NOT_FOUND" });
  await assert.rejects(api.updateHub(draft.revision, draft.changes), { status: 409 });
  assert.equal(draft.changes[0].item.content, "Retained"); assert.equal(draft.revision, 7);
});

test("Discover renders immediately with real download icons while the library is unavailable", async () => {
  const rendered = await build({ stdin: { contents: 'import React from "react"; import { renderToStaticMarkup } from "react-dom/server"; import { AgentsHubContent } from "./src/panels/AgentsHub.tsx"; export const render = () => renderToStaticMarkup(React.createElement(AgentsHubContent, { active: true, section: "discover", onSectionChange() {}, onOpenSession() {} }));', resolveDir: fileURLToPath(new URL("../", import.meta.url)) }, bundle: true, platform: "browser", format: "esm", loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"production"' }, write: false });
  const { render } = await import(`data:text/javascript;base64,${Buffer.from(rendered.outputFiles[0].text).toString("base64")}`);
  const html = render();
  assert.match(html, /Search skill catalog/);
  assert.match(html, /Social media strategy/);
  assert.match(html, /lucide-download/);
  assert.doesNotMatch(html, /The library is unavailable/);
});

test("bundled discovery sources use verified current folders without the retired source", () => {
  const sources = api.SKILL_CATALOG.map(entry => `${entry.sourceUrl}/${entry.subpath}`);
  assert.ok(sources.includes("https://github.com/microsoft/playwright-cli/skills/playwright-cli"));
  assert.ok(sources.includes("https://github.com/coreyhaines31/marketingskills/skills/social"));
  assert.ok(sources.includes("https://github.com/vercel-labs/agent-skills/skills/web-design-guidelines"));
  assert.equal(sources.some(source => source.includes("openai/skills") || source.endsWith("social-content")), false);
});
