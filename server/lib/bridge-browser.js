import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { bridgeError, browserOrigin } from "./bridge-safety.js";
import { redactTerminalOutput } from "./terminal-redaction.js";

// The extension handshake, tool schemas and single-tab response format are verified
// against this package, not whatever a package manager's moving tag resolves to.
export const BROWSER_CONNECTOR_VERSION = "0.0.80";
const PARAMETERS = {
  browser_tabs: { required: ["action"], properties: { action: "string" }, enums: { action: "list" } },
  browser_snapshot: { required: [], properties: { depth: "number" } },
  browser_take_screenshot: { required: [], properties: { type: "string", scale: "string", fullPage: "boolean" }, enums: { type: "png", scale: "css" } },
  browser_navigate: { required: ["url"], properties: { url: "string" } },
  browser_click: { required: ["target"], properties: { target: "string" } },
  browser_type: { required: ["target", "text"], properties: { target: "string", text: "string", submit: "boolean" } },
  browser_press_key: { required: ["key"], properties: { key: "string" } },
};
export function validateBrowserToolSchemas(tools) {
  if (!Array.isArray(tools)) throw bridgeError("Browser connector returned an invalid tool catalog", 503, "BROWSER_SCHEMA_MISMATCH");
  for (const [name, expected] of Object.entries(PARAMETERS)) {
    const matches = tools.filter(tool => tool.name === name);
    const schema = matches[0]?.inputSchema;
    if (matches.length !== 1 || schema?.type !== "object" || !schema.properties ||
        JSON.stringify([...(schema.required || [])].sort()) !== JSON.stringify([...expected.required].sort()) ||
        Object.entries(expected.properties).some(([key, type]) => schema.properties[key]?.type !== type) ||
        Object.entries(expected.enums || {}).some(([key, value]) => !schema.properties[key]?.enum?.includes(value))) {
      throw bridgeError(`Installed browser connector schema does not match the verified ${name} contract`, 503, "BROWSER_SCHEMA_MISMATCH");
    }
  }
}
const WIRE_LIMIT = 12 * 1024 * 1024;
const ALLOWED = new Set(["browser_tabs", "browser_snapshot", "browser_take_screenshot", "browser_navigate", "browser_click", "browser_type", "browser_press_key"]);
const digest = value => createHash("sha256").update(value).digest("hex");
const plainText = result => (result?.content || []).filter(item => item.type === "text" && typeof item.text === "string").map(item => item.text).join("\n");
export function connectorEnvironment(source = process.env) {
  // No inherited settings, debugging endpoints, node hooks or approval-bypass credentials.
  return Object.fromEntries(["HOME", "PATH", "LANG", "LC_ALL", "TMPDIR", "DISPLAY", "XAUTHORITY", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"].filter(key => typeof source[key] === "string").map(key => [key, source[key]]));
}
export async function findSupportedBrowser() {
  const applications = [["Google Chrome", "Google Chrome.app/Contents/MacOS/Google Chrome"], ["Microsoft Edge", "Microsoft Edge.app/Contents/MacOS/Microsoft Edge"], ["Brave", "Brave Browser.app/Contents/MacOS/Brave Browser"], ["Chromium", "Chromium.app/Contents/MacOS/Chromium"]];
  if (process.platform === "darwin") for (const root of ["/Applications", path.join(os.homedir(), "Applications")]) for (const [name, relative] of applications) {
    const executable = path.join(root, relative);
    try { await fs.access(executable, 1); return { name, executable }; } catch { /* Check known installed applications only. */ }
  }
  throw bridgeError("No supported Chromium browser was found in a standard application location. Install or select a supported receiving Mac browser and its official extension; Safari is not supported.", 503, "BROWSER_APPLICATION_MISSING");
}
export async function findBrowserConnector(root) {
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    let cli;
    try { cli = await fs.realpath(path.join(directory, "playwright-mcp")); } catch { continue; }
    if (cli === root || cli.startsWith(root + path.sep)) continue;
    try {
      const metadata = JSON.parse(await fs.readFile(path.join(path.dirname(cli), "package.json"), "utf8"));
      if (metadata.name !== "@playwright/mcp" || metadata.version !== BROWSER_CONNECTOR_VERSION) continue;
      return cli;
    } catch { /* Only the verified installed package layout is accepted. */ }
  }
  throw bridgeError(`Install @playwright/mcp@${BROWSER_CONNECTOR_VERSION} so playwright-mcp is on the receiving app's PATH, plus the official browser extension. Nothing is installed automatically.`, 503, "BROWSER_DEPENDENCY_MISSING");
}
export function parseApprovedTab(result, expectedOrigin) {
  const rows = plainText(result).split("\n").filter(line => /^- \d+:/.test(line));
  const match = rows.length === 1 ? /^- 0: \(current\) \[(.*)\]\((https?:\/\/.*)\)$/.exec(rows[0]) : null;
  if (!match || browserOrigin(match[2]) !== expectedOrigin) throw bridgeError("The extension must expose exactly the one human-selected tab on the approved origin. Close other tabs in this connection group or detach and request a new connection.", 403, "BROWSER_TAB_SCOPE_CHANGED");
  return { title: redactTerminalOutput(match[1]).text.slice(0, 240), url: new URL(match[2]).origin, identity: digest(match[2]), index: 0 };
}
function rpcTransport(cli, cwd, origin, application, startProcess) {
  const child = startProcess(process.execPath, [cli, "--extension", "--browser", "chrome", "--executable-path", application.executable, "--output-dir", cwd,
    "--output-max-size", "16777216", "--snapshot-mode", "none", "--codegen", "none", "--timeout-action", "5000", "--timeout-navigation", "10000", "--allowed-origins", origin],
  { cwd, env: connectorEnvironment(), shell: false, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map(); let sequence = 0; let buffer = ""; let dead = false;
  const close = () => {
    if (dead) return;
    dead = true;
    child.stdin.destroy(); child.kill("SIGTERM");
    const kill = setTimeout(() => child.kill("SIGKILL"), 1000); kill.unref?.();
    child.once("close", () => clearTimeout(kill));
    for (const item of waiting.values()) { clearTimeout(item.timer); item.reject(bridgeError("Browser connector disconnected. Request a new attachment; do not replay a consequential action.", 503, "BROWSER_DISCONNECTED")); }
    waiting.clear();
  };
  child.once("error", close); child.once("close", close); child.stdin.on("error", close);
  child.stderr.on("data", () => {});
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > WIRE_LIMIT) return close();
    let end;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      if (!line.trim()) continue;
      let message;
      try { message = JSON.parse(line); } catch { close(); return; }
      // Never fulfill a server-initiated request to read roots, sample, or elicit consent.
      if (message.method && message.id !== undefined) {
        child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Client requests are disabled" } }) + "\n");
        continue;
      }
      const item = waiting.get(message.id);
      if (!item) continue;
      waiting.delete(message.id); clearTimeout(item.timer);
      if (message.error || message.result?.isError) item.reject(bridgeError("Browser operation failed. Check that Chrome, the official extension and the human-selected tab are connected. No browser approval is automated.", 503, "BROWSER_OPERATION_FAILED"));
      else item.resolve(message.result);
    }
  });
  const request = (method, params, timeout = 15000) => {
    if (dead) return Promise.reject(bridgeError("Browser connector disconnected", 503, "BROWSER_DISCONNECTED"));
    const id = ++sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiting.delete(id); reject(bridgeError("Browser connection timed out. Install the official extension if missing, then approve the connection and select a tab in Chrome.", 504, "BROWSER_HUMAN_SELECTION_REQUIRED")); close(); }, timeout);
      waiting.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  };
  return { close, request, notify: (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"),
    call: (name, args, timeout) => {
      if (!ALLOWED.has(name) || (name === "browser_tabs" && (args.action !== "list" || Object.keys(args).length !== 1))) throw bridgeError("Browser operation is not allowlisted", 403);
      return request("tools/call", { name, arguments: args }, timeout);
    } };
}
export function createBrowserConnector({ stateDir, locate = findBrowserConnector, locateApplication = findSupportedBrowser, startProcess = spawn } = {}) {
  const sessions = new Map();
  let pendingAttachments = 0;
  let closed = false;
  const view = session => ({ sessionId: session.id, tabId: session.tabId, status: session.status, origin: session.origin, ...(session.error ? { error: session.error } : {}) });
  const owned = (context, args) => {
    const session = sessions.get(args.sessionId);
    if (!session || session.peerId !== context.peerId || session.projectId !== args.projectId) throw bridgeError("Browser session not found", 404);
    if (args.tabId !== undefined && args.tabId !== session.tabId) throw bridgeError("Tab is not granted to this session", 403, "BROWSER_TAB_DENIED");
    return session;
  };
  const detach = async session => { session.transport?.close(); session.status = "detached"; await fs.rm(session.cwd, { recursive: true, force: true }); };
  const currentTab = async session => {
    if (session.status !== "attached") throw bridgeError("Browser is not attached. Read session status and complete human tab selection.", 409, "BROWSER_NOT_ATTACHED");
    try { return parseApprovedTab(await session.transport.call("browser_tabs", { action: "list" }), session.origin); }
    catch (error) { await detach(session); throw error; }
  };
  return {
    async preflight(root) {
      try { await locate(root); const application = await locateApplication(); return { application: application.name, status: "ready", packageVersion: BROWSER_CONNECTOR_VERSION, extension: "human_check_required", tabSelection: "human_required", sidePanels: "unsupported" }; }
      catch (error) { return { status: "unavailable", code: error.code || "BROWSER_DEPENDENCY_MISSING", message: error.message, packageVersion: BROWSER_CONNECTOR_VERSION, sidePanels: "unsupported" }; }
    },
    async attach(context, args, root, recheck = async () => {}) {
      for (const [id, session] of sessions) if (["failed", "detached"].includes(session.status) && (sessions.size >= 32 || session.finishedAt + 5 * 60000 <= Date.now())) sessions.delete(id);
      if (closed) throw bridgeError("Browser connector is shutting down", 503, "BROWSER_DISCONNECTED");
      if (pendingAttachments + [...sessions.values()].filter(session => !["failed", "detached"].includes(session.status)).length >= 8) throw bridgeError("Eight browser sessions are already active; detach one before requesting another", 429);
      pendingAttachments++;
      try {
      await recheck();
      const cli = await locate(root);
      const application = await locateApplication();
      const id = randomUUID(); const cwd = path.join(stateDir, `browser-${id}`);
      await fs.mkdir(cwd, { recursive: true, mode: 0o700 });
      const session = { id, tabId: randomUUID(), projectId: args.projectId, peerId: context.peerId, origin: browserOrigin(args.origin), status: "awaiting_extension", cwd, refs: new Set(), tail: Promise.resolve() };
      try { await recheck(); if (closed) throw bridgeError("Browser connector is shutting down", 503); } catch (error) { await fs.rm(cwd, { recursive: true, force: true }); throw error; }
      sessions.set(id, session);
      session.transport = rpcTransport(cli, cwd, session.origin, application, startProcess);
      // Browser consent can outlive the HTTP request. Retain one connector, never retry it automatically.
      session.pending = (async () => {
        const init = await session.transport.request("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "PzzaCode device bridge", version: "1.0.0" } });
        if (!init?.protocolVersion) throw bridgeError("Unsupported browser connector protocol", 503);
        session.transport.notify("notifications/initialized", {});
        const tools = await session.transport.request("tools/list", {});
        validateBrowserToolSchemas(tools?.tools);
        parseApprovedTab(await session.transport.call("browser_tabs", { action: "list" }, 55000), session.origin);
        await recheck();
        if (session.status === "detached") return;
        session.status = "attached";
      })().catch(async error => { session.error = { code: error.code || "BROWSER_UNAVAILABLE", message: error.message }; await detach(session); session.status = "failed"; session.finishedAt = Date.now(); });
      return view(session);
      } finally { pendingAttachments--; }
    },
    status(context, args) { return args.sessionId ? view(owned(context, args)) : { sessions: [...sessions.values()].filter(session => session.peerId === context.peerId && session.projectId === args.projectId).map(view) }; },
    async detach(context, args) { const session = owned(context, args); await detach(session); sessions.delete(session.id); return { sessionId: session.id, status: "detached" }; },
    binding(context, args) {
      const session = owned(context, args);
      if (!session.snapshotDigest || !session.snapshotId) throw bridgeError("Read a fresh snapshot before requesting a browser interaction", 409, "SNAPSHOT_REQUIRED");
      if (args.target && !session.refs.has(args.target)) throw bridgeError("Target is not in the current snapshot", 409, "STALE_ELEMENT_REFERENCE");
      return { snapshotId: session.snapshotId, snapshotDigest: session.snapshotDigest };
    },
    async perform(action, context, args, recheck) {
      const session = owned(context, args);
      const operation = session.tail.catch(() => {}).then(async () => {
        await recheck(); const tab = await currentTab(session);
        if (action === "browser.tabs") return { sessionId: session.id, tabs: [{ tabId: session.tabId, ...tab }] };
        if (["browser.navigate", "browser.click", "browser.type", "browser.keys"].includes(action)) {
          if (!args.binding || args.binding.snapshotId !== session.snapshotId) throw bridgeError("Snapshot changed since local approval was requested; request a new action", 409, "STALE_APPROVAL");
          const live = await session.transport.call("browser_snapshot", { depth: 12 });
          if (digest(plainText(live)) !== args.binding.snapshotDigest) throw bridgeError("Page changed since the reviewed snapshot. Read it again before requesting another interaction.", 409, "STALE_APPROVAL");
        }
        const params = {};
        const names = { "browser.snapshot": "browser_snapshot", "browser.screenshot": "browser_take_screenshot", "browser.navigate": "browser_navigate", "browser.click": "browser_click", "browser.type": "browser_type", "browser.keys": "browser_press_key" };
        if (action === "browser.navigate") {
          if (browserOrigin(args.url) !== session.origin) throw bridgeError("Navigation is outside the approved origin", 403, "ORIGIN_DENIED");
          params.url = args.url;
        }
        if (["browser.click", "browser.type"].includes(action)) {
          if (!session.refs.has(args.target)) throw bridgeError("Use a current element reference from this session's snapshot", 409, "STALE_ELEMENT_REFERENCE");
          params.target = args.target;
          if (action === "browser.type") { params.text = args.text; params.submit = false; }
        }
        if (action === "browser.keys") params.key = args.key;
        if (action === "browser.snapshot") params.depth = 12;
        if (action === "browser.screenshot") { params.type = "png"; params.scale = "css"; params.fullPage = false; }
        await recheck();
        const result = await session.transport.call(names[action], params);
        await recheck(); await currentTab(session);
        if (action === "browser.screenshot") {
          const image = result.content?.find(item => item.type === "image" && item.mimeType === "image/png");
          if (!image || typeof image.data !== "string" || image.data.length > 12 * 1024 * 1024) throw bridgeError("Browser screenshot is unavailable or too large", 503);
          const bytes = Buffer.from(image.data, "base64");
          if (bytes.length > 8 * 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw bridgeError("Browser returned an invalid PNG screenshot", 503);
          return { content: image.data, encoding: "base64", mimeType: "image/png" };
        }
        const output = redactTerminalOutput(plainText(result));
        session.refs.clear();
        if (action === "browser.snapshot") {
          session.snapshotId = randomUUID(); session.snapshotDigest = digest(plainText(result));
          for (const match of output.text.slice(0, 65536).matchAll(/\[ref=(e\d+)\]/g)) session.refs.add(match[1]);
        } else { session.snapshotId = null; session.snapshotDigest = null; }
        return { sessionId: session.id, tabId: session.tabId, text: output.text.slice(0, 65536), redacted: output.redacted, truncated: output.text.length > 65536 };
      });
      session.tail = operation;
      return operation;
    },
    async revokePeer(peerId) { await Promise.all([...sessions.values()].filter(session => session.peerId === peerId).map(async session => { await detach(session); sessions.delete(session.id); })); },
    async close() { closed = true; await Promise.all([...sessions.values()].map(detach)); sessions.clear(); },
  };
}
