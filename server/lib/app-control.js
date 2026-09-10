import { randomUUID } from "node:crypto";

import { validateAppCommand } from "./app-control-schema.js";

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const identifier = (value) => typeof value === "string" && /^[\w.-]{1,128}$/.test(value);

export function validateCommand(action, args) {
  try { return validateAppCommand(action, args); }
  catch (error) { throw fail(error.message); }
}

export function createAppControl({ pollMs = 15000, commandMs = 20000, staleMs = 45000 } = {}) {
  const clients = new Map();
  function remove(clientId, reason = "App client disconnected") {
    const client = clients.get(clientId);
    if (!client) return;
    client.poll?.(null);
    for (const pending of client.commands.values()) { clearTimeout(pending.timer); pending.reject(fail(reason, 503)); }
    clients.delete(clientId);
  }
  function cleanup() {
    for (const [id, client] of clients) if (Date.now() - client.seen > staleMs) remove(id, "App client is offline");
  }
  function requireClient(clientId) {
    cleanup();
    if (!identifier(clientId)) throw fail("An explicit valid clientId is required");
    const client = clients.get(clientId);
    if (!client) throw fail("App client is offline", 503);
    return client;
  }
  return {
    register(clientId, label) {
      cleanup();
      if (!identifier(clientId) || typeof label !== "string" || !label.trim() || label.length > 160 || /[\x00-\x1f]/.test(label)) throw fail("Invalid app client");
      const existing = clients.get(clientId);
      if (existing) { existing.seen = Date.now(); existing.label = label; return { ok: true }; }
      if (clients.size >= 16) throw fail("Too many app clients", 429);
      clients.set(clientId, { label, seen: Date.now(), commands: new Map(), poll: null });
      return { ok: true };
    },
    list() { cleanup(); return [...clients].map(([clientId, client]) => ({ clientId, label: client.label })); },
    remove,
    poll(clientId, signal) {
      const client = requireClient(clientId);
      client.seen = Date.now();
      if (client.poll) throw fail("A poll is already active for this client", 409);
      const next = [...client.commands.values()].find((entry) => !entry.delivered);
      if (next) { next.delivered = true; return Promise.resolve({ command: next.command }); }
      return new Promise((resolve) => {
        const finish = (command) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          client.poll = null;
          resolve({ command });
        };
        const abort = () => finish(null);
        const timer = setTimeout(() => finish(null), pollMs);
        client.poll = finish;
        signal?.addEventListener("abort", abort, { once: true });
        if (signal?.aborted) abort();
      });
    },
    command(clientId, action, args = {}) {
      const cleanArgs = validateCommand(action, args);
      const client = requireClient(clientId);
      if (client.commands.size >= 32) throw fail("App command queue is full", 429);
      const command = { id: randomUUID(), action, args: cleanArgs, expiresAt: Date.now() + commandMs };
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          client.commands.delete(command.id);
          reject(fail("App did not acknowledge the command; it will not be replayed", 504));
        }, commandMs);
        const entry = { command, resolve, reject, timer, delivered: Boolean(client.poll) };
        client.commands.set(command.id, entry);
        client.poll?.(command);
      });
    },
    result(clientId, id, result, error) {
      const client = requireClient(clientId);
      const pending = client.commands.get(id);
      if (!pending || !pending.delivered) throw fail("Unknown, expired or unowned command", 409);
      if (Date.now() >= pending.command.expiresAt) {
        client.commands.delete(id);
        clearTimeout(pending.timer);
        pending.reject(fail("App did not acknowledge the command; it will not be replayed", 504));
        throw fail("Unknown, expired or unowned command", 409);
      }
      if (error !== undefined && (typeof error !== "string" || error.length > 4096)) throw fail("Invalid command error");
      client.commands.delete(id);
      client.seen = Date.now();
      clearTimeout(pending.timer);
      if (error !== undefined) pending.reject(fail(error || "App command failed", 422));
      else pending.resolve(result ?? null);
      return { ok: true };
    },
  };
}

async function body(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) throw fail("App control request too large", 413);
    chunks.push(chunk);
  }
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { throw fail("Invalid JSON"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw fail("Invalid request body");
  return value;
}

// Mounted only after the server's host and bearer-token checks.
export function createAppControlRouter(broker = createAppControl(), respond = (res, status, value) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}) {
return async function appControlRouter(req, res, url) {
  if (!url.pathname.startsWith("/app/control/")) return false;
  try {
    const route = `${req.method} ${url.pathname}`;
    let result;
    if (route === "GET /app/control/clients") result = broker.list();
    else if (route === "POST /app/control/register") { const data = await body(req); result = broker.register(data.clientId, data.label); }
    else if (route === "GET /app/control/poll") {
      const controller = new AbortController();
      const abort = () => controller.abort();
      res.once("close", abort);
      try { result = await broker.poll(url.searchParams.get("clientId"), controller.signal); }
      finally { res.off("close", abort); }
    } else if (route === "POST /app/control/command") { const data = await body(req); result = await broker.command(data.clientId, data.action, data.args); }
    else if (route === "POST /app/control/result") { const data = await body(req); result = broker.result(data.clientId, data.id, data.result, data.error); }
    else if (route === "DELETE /app/control/client") { const id = url.searchParams.get("clientId"); if (!identifier(id)) throw fail("Invalid clientId"); broker.remove(id); result = { ok: true }; }
    else throw fail("Unknown app control route", 404);
    if (!res.destroyed) respond(res, 200, result);
  } catch (error) { if (!res.destroyed) respond(res, error.status || 500, { error: error.status ? error.message : "App control failed" }); }
  return true;
};
}
