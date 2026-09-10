// Device identities and signed, narrowly authorized requests over trusted SSH hosts.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { deviceAgentRequest } from "./device-agent.js";
import { createBridgeExecutor, BRIDGE_ACTION_CAPABILITIES, BRIDGE_CAPABILITIES } from "./bridge-executor.js";

import { bridgeError, assertBridgePath, privateBridgePath, validateResources } from "./bridge-safety.js";
import { consentDigest, requireNativeConsent } from "./bridge-consent.js";

const BODY_LIMIT = 2 * 1024 * 1024;
const RESPONSE_LIMIT = 12 * 1024 * 1024;
const REQUEST_LIFETIME = 60_000;
const GRANT_LIFETIME = 30 * 86400_000;
const NONCE_LIMIT = 4096;
const AUDIT_LIMIT = 200;
const CONNECTION_LIMIT = 32;
const CONNECTION_RETENTION = 3600_000;
const CONNECTION_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const AUDIT_OUTCOMES = ["received", "accepted", "denied", "failed"];
const HOST = /^[A-Za-z0-9._][A-Za-z0-9._@-]{0,127}$/;
const ID = /^[a-f0-9]{64}$/;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const fail = bridgeError;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, allowed) => object(value) && Object.keys(value).every((key) => allowed.includes(key));
const configHash = (config) => crypto.createHash("sha256").update(canonicalEnvelope(config)).digest("hex");

const CONTROL_ACTIONS = ["bridge.describe", "jobs.list", "jobs.get", "jobs.cancel", "approvals.list"];
function controlArguments(action, args) {
  if (!CONTROL_ACTIONS.includes(action)) return;
  const allowed = action === "jobs.get" ? ["jobId", "cursor"] : action === "jobs.cancel" ? ["jobId", "requestId"] : [];
  if (!exactKeys(args, allowed)) throw fail("Invalid bridge control arguments");
  if (["jobs.get", "jobs.cancel"].includes(action) && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(args.jobId || "")) throw fail("Invalid bridge job ID");
  if (action === "jobs.cancel" && !CONNECTION_ID.test(args.requestId || "")) throw fail("A requestId UUID is required", 400, "REQUEST_ID_REQUIRED");
  if (args.cursor !== undefined && (!Number.isSafeInteger(args.cursor) || args.cursor < 0)) throw fail("Invalid job log cursor");
}

function publicIdentity(key) {
  const publicKey = crypto.createPublicKey(key).export({ format: "der", type: "spki" });
  return { id: crypto.createHash("sha256").update(publicKey).digest("hex"), publicKey: publicKey.toString("base64") };
}

export function parsePublicIdentity(publicKey) {
  if (typeof publicKey !== "string" || publicKey.length > 128 || !/^[A-Za-z0-9+/]+={0,2}$/.test(publicKey)) throw fail("Invalid device public key");
  let key;
  try { key = crypto.createPublicKey({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki" }); }
  catch { throw fail("Invalid device public key"); }
  if (key.asymmetricKeyType !== "ed25519") throw fail("Device keys must use Ed25519");
  const canonical = key.export({ format: "der", type: "spki" });
  if (canonical.toString("base64") !== publicKey) throw fail("Invalid device public key encoding");
  return { id: crypto.createHash("sha256").update(canonical).digest("hex"), publicKey, key };
}

function secureDirectory(stateDir) {
  const state = path.resolve(stateDir);
  fs.mkdirSync(state, { recursive: true, mode: 0o700 });
  const parent = fs.lstatSync(state);
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o022) || (process.getuid && parent.uid !== process.getuid())) throw fail("Bridge state directory must be owned by this user and not writable by others", 503);
  const directory = path.join(state, "bridge");
  try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
  const info = fs.lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) throw fail("Bridge directory permissions must be 0700", 503);
  return directory;
}

function privateRead(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) || info.size > 4 * 1024 * 1024 || (process.getuid && info.uid !== process.getuid())) throw fail("Unsafe bridge state file", 503);
    return fs.readFileSync(fd, "utf8");
  } finally { fs.closeSync(fd); }
}

function atomicWrite(file, value) {
  const temporary = `${file}.${crypto.randomBytes(8).toString("hex")}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, value);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporary, file);
    const directory = fs.openSync(path.dirname(file), fs.constants.O_RDONLY);
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

export function canonicalEnvelope(value, { byteLimit = BODY_LIMIT - 1024, nodeLimit = 4096 } = {}) {
  let nodes = 0;
  const encode = (entry, depth) => {
    if (++nodes > nodeLimit || depth > 12) throw fail("Bridge request is too complex");
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") return JSON.stringify(entry);
    if (typeof entry === "number" && Number.isFinite(entry)) return JSON.stringify(entry);
    if (Array.isArray(entry)) return `[${entry.map((item) => encode(item, depth + 1)).join(",")}]`;
    if (object(entry)) return `{${Object.keys(entry).sort().map((key) => `${JSON.stringify(key)}:${encode(entry[key], depth + 1)}`).join(",")}}`;
    throw fail("Bridge requests must contain JSON values");
  };
  const encoded = encode(value, 0);
  if (Buffer.byteLength(encoded) > byteLimit) throw fail("Bridge request is too large", 413);
  return encoded;
}

export function bridgeSshArgs(peer) {
  if (!HOST.test(peer.host || "") || !Number.isInteger(peer.port) || peer.port < 1 || peer.port > 65535) throw fail("Configure a valid SSH host and agent port for this peer");
  const command = `curl --silent --show-error --fail-with-body --max-time 20 --noproxy '*' --request POST --header 'Content-Type: application/json' --data-binary @- http://127.0.0.1:${peer.port}/bridge/receive`;
  return ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes", "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ConnectTimeout=5", "-o", "ConnectionAttempts=1", "-o", "PermitLocalCommand=no", "--", peer.host, command];
}

export function sendBridgeRequest(peer, request) {
  const input = JSON.stringify(request);
  if (Buffer.byteLength(input) > BODY_LIMIT) return Promise.reject(fail("Bridge request is too large", 413));
  const args = bridgeSshArgs(peer);
  return new Promise((resolve, reject) => {
    const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"] });
    const chunks = [];
    let bytes = 0;
    let complete = false;
    const finish = (error, value) => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      if (error) { child.kill("SIGKILL"); reject(error); } else resolve(value);
    };
    const timer = setTimeout(() => finish(fail("Device bridge request timed out", 504)), 25_000);
    child.on("error", () => finish(fail("Could not start the trusted SSH connection", 502)));
    child.stdin.on("error", () => {});
    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > RESPONSE_LIMIT) return finish(fail("Device bridge response is too large", 502));
      chunks.push(chunk);
    });
    // Never include remote stderr, which can contain local paths or SSH account details.
    child.stderr.on("data", () => {});
    child.on("close", (code) => {
      if (complete) return;
      let result;
      try { result = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return finish(fail("Device did not return a valid bridge response", 502)); }
      if (code !== 0 || result?.error) return finish(fail(typeof result?.error === "string" ? result.error.slice(0, 240) : "Trusted SSH connection or remote bridge request failed", 502));
      finish(null, result);
    });
    child.stdin.end(input);
  });
}

export function createBridge({ stateDir, executor: suppliedExecutor, transport = sendBridgeRequest, agentRequest = deviceAgentRequest, now = Date.now, appControl, nativeConsentKey } = {}) {
  let initialized;
  let expiryTimer;
  let executor;
  let updating = false;
  let closing = false;
  let closePromise;
  let pairing = false;
  let connectionWork;
  const connections = new Map();
  const approvals = new Map();
  const approvalView = approval => ({ id: approval.id, digest: approval.digest, status: approval.status, kind: "configuration", createdAt: approval.createdAt, expiresAt: approval.expiresAt, config: approval.config, ...(approval.error ? { error: approval.error } : {}) });
  const requestConfiguration = (request) => {
    if (!nativeConsentKey) throw fail("Open the updated receiving desktop app before requesting access. This agent has no native confirmation channel.", 503, "LOCAL_CONSENT_UNAVAILABLE");
    const current = initialize();
    if (!exactKeys(request, ["config", "expectedConfigHash"]) || request.expectedConfigHash !== configHash(current.config)) throw fail("Bridge settings changed. Read their current state before saving.", 409);
    const config = validateConfig(request.config, current.identity.id);
    const digest = consentDigest({ config, expectedConfigHash: request.expectedConfigHash });
    const existing = [...approvals.values()].find(item => item.digest === digest && item.expiresAt > now());
    if (existing) return { status: existing.status, approval: approvalView(existing) };
    for (const [id, item] of approvals) if (item.expiresAt <= now()) approvals.delete(id);
    if (approvals.size >= 32) throw fail("Too many pending receiving-device confirmations", 429);
    const approval = { id: crypto.randomUUID(), digest, config, expectedConfigHash: request.expectedConfigHash, status: "waiting_approval", createdAt: now(), expiresAt: now() + 10 * 60000 };
    approvals.set(approval.id, approval);
    return { status: "waiting_approval", approval: approvalView(approval) };
  };
  const configurationStatus = (request) => {
    if (!exactKeys(request, ["approvalId"]) || !CONNECTION_ID.test(request.approvalId || "")) throw fail("Invalid configuration approval ID");
    const approval = approvals.get(request.approvalId);
    if (!approval) throw fail("Configuration approval not found or agent restarted", 404);
    if (approval.expiresAt <= now() && approval.status === "waiting_approval") approval.status = "expired";
    return approvalView(approval);
  };
  const pruneConnections = () => {
    for (const [id, { operation }] of connections) {
      if (operation.status !== "pending" && operation.updatedAt + CONNECTION_RETENTION <= now()) connections.delete(id);
    }
  };
  const initialize = () => {
    if (initialized) return initialized;
    if (!stateDir) throw fail("Bridge state directory is missing", 503);
    const directory = secureDirectory(stateDir);
    const keyFile = path.join(directory, "identity.pem");
    let privateKey;
    try { privateKey = crypto.createPrivateKey(privateRead(keyFile)); }
    catch (error) {
      if (error.code !== "ENOENT") throw fail("Could not load the device bridge identity", 503);
      privateKey = crypto.generateKeyPairSync("ed25519").privateKey;
      const fd = fs.openSync(keyFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.writeFileSync(fd, privateKey.export({ format: "pem", type: "pkcs8" })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    }
    if (privateKey.asymmetricKeyType !== "ed25519") throw fail("Invalid device bridge identity", 503);
    const identity = publicIdentity(privateKey);
    const configFile = path.join(directory, "config.json");
    const nonceFile = path.join(directory, "nonces.json");
    const auditFile = path.join(directory, "audit.json");
    let config = { enabled: false, peers: [], projects: [] };
    try { config = validateConfig(JSON.parse(privateRead(configFile)), identity.id, true); }
    catch (error) { if (error.code !== "ENOENT") throw fail("Could not load device bridge configuration", 503); }
    let nonces = new Map();
    try {
      const rows = JSON.parse(privateRead(nonceFile));
      if (!Array.isArray(rows) || rows.length > NONCE_LIMIT || rows.some((row) => !Array.isArray(row) || row.length !== 2 || typeof row[0] !== "string" || !Number.isFinite(row[1]))) throw fail("Invalid replay state", 503);
      nonces = new Map(rows.filter(([, expiresAt]) => expiresAt > now()));
    } catch (error) { if (error.code !== "ENOENT") throw fail("Could not load device bridge replay protection", 503); }
    let audit = [];
    try {
      const records = JSON.parse(privateRead(auditFile));
      if (!Array.isArray(records) || records.length > AUDIT_LIMIT || records.some((entry) =>
        !exactKeys(entry, ["peerId", "action", "projectId", "time", "outcome"]) || !ID.test(entry.peerId || "") ||
        (!Object.hasOwn(BRIDGE_ACTION_CAPABILITIES, entry.action) && !CONTROL_ACTIONS.includes(entry.action) && entry.action !== "unknown") ||
        (entry.projectId !== null && (typeof entry.projectId !== "string" || !PROJECT_ID.test(entry.projectId))) ||
        !Number.isSafeInteger(entry.time) || !AUDIT_OUTCOMES.includes(entry.outcome))) throw fail("Invalid activity record", 503);
      audit = records;
    } catch (error) { if (error.code !== "ENOENT") throw fail("Could not load device bridge activity", 503); }
    initialized = { directory, privateKey, identity, config, configFile, nonceFile, nonces, auditFile, audit };
    try { executor = suppliedExecutor || createBridgeExecutor({ stateDir: directory, appControl, authorize }); }
    catch (error) { initialized = undefined; throw error; }
    scheduleExpiry();
    return initialized;
  };

  function validateConfig(value, identityId, loading = false) {
    if (!exactKeys(value, ["enabled", "peers", "projects"]) || typeof value.enabled !== "boolean" || !Array.isArray(value.peers) || value.peers.length > 32 || !Array.isArray(value.projects) || value.projects.length > 64) throw fail("Invalid bridge configuration");
    const projectIds = new Set();
    const projects = value.projects.map((project) => {
      if (!exactKeys(project, ["id", "root"]) || !PROJECT_ID.test(project.id || "") || projectIds.has(project.id) || typeof project.root !== "string" || !path.isAbsolute(project.root) || project.root.length > 4096) throw fail("Invalid bridge project");
      let root;
      try { root = fs.realpathSync(project.root); if (!fs.statSync(root).isDirectory()) throw new Error(); }
      catch { if (!loading && value.enabled) throw fail("Bridge project roots must be existing directories"); root = path.resolve(project.root); }
      let home = path.resolve(os.homedir());
      try { home = fs.realpathSync(home); } catch { /* A missing home cannot be granted as an existing project. */ }
      assertBridgePath(root);
      if (root === path.parse(root).root || root === home || home.startsWith(root + path.sep)) throw fail("Choose a project directory, not the filesystem root or your home directory");
      projectIds.add(project.id);
      return { id: project.id, root };
    });
    const peerIds = new Set();
    const peers = value.peers.map((peer) => {
      if (!exactKeys(peer, ["id", "label", "publicKey", "host", "port", "enabled", "expiresAt", "projectIds", "capabilities", "resources"])) throw fail("Invalid paired device");
      const publicKey = parsePublicIdentity(peer.publicKey);
      if (!ID.test(peer.id || "") || peer.id !== publicKey.id || peer.id === identityId || peerIds.has(peer.id)) throw fail("Device identity does not match its public key");
      if (typeof peer.label !== "string" || !peer.label.trim() || peer.label.length > 80 || /[\x00-\x1f\x7f]/.test(peer.label)) throw fail("Invalid device label");
      if (typeof peer.enabled !== "boolean" || typeof peer.host !== "string" || (peer.host && !HOST.test(peer.host))) throw fail("Invalid device SSH host or enabled state");
      const port = peer.port ?? 5190;
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw fail("Invalid device agent port");
      const expiresAt = peer.expiresAt;
      if (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt <= 0)) throw fail("Invalid device grant expiry");
      const existing = initialized?.config.peers.find((candidate) => candidate.id === peer.id);
      // An expired grant remains unusable, but must not block revoking another device.
      const unchangedExpired = initialized?.config.enabled && existing?.enabled && expiresAt <= now() && existing.expiresAt === expiresAt &&
        JSON.stringify(existing.resources) === JSON.stringify(validateResources(peer.resources)) && existing.publicKey === peer.publicKey && existing.label === peer.label.trim() && existing.host === peer.host && existing.port === port &&
        JSON.stringify(existing.projectIds) === JSON.stringify(peer.projectIds) && JSON.stringify(existing.capabilities) === JSON.stringify(peer.capabilities);
      if (peer.enabled && (expiresAt === null || (!loading && value.enabled && ((!unchangedExpired && expiresAt <= now()) || expiresAt > now() + GRANT_LIFETIME)))) throw fail("Enabled device grants must expire within 30 days");
      if (!Array.isArray(peer.projectIds) || peer.projectIds.length > 64 || peer.projectIds.some((id) => !projectIds.has(id)) || new Set(peer.projectIds).size !== peer.projectIds.length) throw fail("Invalid device project grants");
      if (!Array.isArray(peer.capabilities) || peer.capabilities.length > BRIDGE_CAPABILITIES.length || peer.capabilities.some((capability) => !BRIDGE_CAPABILITIES.includes(capability)) || new Set(peer.capabilities).size !== peer.capabilities.length) throw fail("Invalid device capabilities");
      const resources = validateResources(peer.resources);
      peerIds.add(peer.id);
      return { id: peer.id, label: peer.label.trim(), publicKey: peer.publicKey, host: peer.host, port, enabled: peer.enabled, expiresAt, projectIds: [...peer.projectIds], capabilities: [...peer.capabilities], resources };
    });
    return { enabled: value.enabled, peers, projects };
  }

  function activePeer(peerId) {
    const { config } = initialize();
    const peer = config.peers.find((candidate) => candidate.id === peerId);
    if (closing || updating || !config.enabled || !peer?.enabled || !peer.expiresAt || peer.expiresAt <= now()) throw fail("Device bridge grant is disabled or expired", 403);
    return peer;
  }

  function authorize(peerId, action, projectId) {
    const peer = activePeer(peerId);
    const capability = BRIDGE_ACTION_CAPABILITIES[action];
    if (!capability || !peer.capabilities.includes(capability)) throw fail("Device is not allowed to perform this action", 403);
    if (projectId !== undefined && !peer.projectIds.includes(projectId)) throw fail("Device is not allowed to access this project", 403);
    const roots = Object.fromEntries(initialize().config.projects.filter((project) => peer.projectIds.includes(project.id)).map((project) => [project.id, project.root]));
    return { peerId, projectRoots: roots, capabilities: [...peer.capabilities], resources: structuredClone(peer.resources) };
  }

  function scheduleExpiry() {
    clearTimeout(expiryTimer);
    const { config } = initialized;
    for (const peer of config.peers) {
      if (!config.enabled || !peer.enabled || !peer.expiresAt || peer.expiresAt <= now()) void Promise.resolve(executor.revokePeer(peer.id)).catch(() => {});
    }
    const next = Math.min(...config.peers.filter((peer) => config.enabled && peer.enabled && peer.expiresAt > now()).map((peer) => peer.expiresAt));
    if (Number.isFinite(next)) {
      expiryTimer = setTimeout(scheduleExpiry, Math.min(2_147_483_647, Math.max(1, next - now())));
      expiryTimer.unref?.();
    }
  }

  const state = async () => {
    const { identity, config } = initialize();
    return { identity: { ...identity }, config: structuredClone(config), configHash: configHash(config), nativeConsentAvailable: !!nativeConsentKey, approvals: [...approvals.values()].filter(item => item.expiresAt > now()).map(approvalView), jobs: await executor.listJobs(), audit: structuredClone(initialize().audit) };
  };
  const configure = async (value) => {
    const current = initialize();
    const config = validateConfig(value, current.identity.id);
    if (updating) throw fail("Bridge configuration update is already running", 409);
    updating = true;
    try {
      atomicWrite(current.configFile, JSON.stringify(config));
      const previous = current.config;
      current.config = config;
      await Promise.all(previous.peers.filter((peer) => {
        const replacement = config.peers.find((candidate) => candidate.id === peer.id);
        return !config.enabled || !replacement || JSON.stringify(replacement) !== JSON.stringify(peer) || JSON.stringify(config.projects) !== JSON.stringify(previous.projects);
      }).map((peer) => executor.revokePeer(peer.id)));
      scheduleExpiry();
    } finally { updating = false; }
    return state();
  };
  const receive = async (request) => {
    const current = initialize();
    if (!exactKeys(request, ["envelope", "signature"]) || typeof request.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(request.signature)) throw fail("Invalid signed device request", 401);
    const envelope = request.envelope;
    if (!exactKeys(envelope, ["version", "source", "target", "nonce", "expiresAt", "action", "args"]) || envelope.version !== 1 || !ID.test(envelope.source || "") || envelope.target !== current.identity.id || !/^[A-Za-z0-9_-]{32}$/.test(envelope.nonce || "") || !Number.isSafeInteger(envelope.expiresAt) || envelope.expiresAt <= now() || envelope.expiresAt > now() + REQUEST_LIFETIME || typeof envelope.action !== "string" || !object(envelope.args)) throw fail("Invalid or expired signed device request", 401);
    const peer = activePeer(envelope.source);
    const serialized = canonicalEnvelope(envelope);
    const key = parsePublicIdentity(peer.publicKey).key;
    if (!crypto.verify(null, Buffer.from(serialized), key, Buffer.from(request.signature, "base64"))) throw fail("Invalid device signature", 401);
    const entry = {
      peerId: peer.id,
      action: Object.hasOwn(BRIDGE_ACTION_CAPABILITIES, envelope.action) || CONTROL_ACTIONS.includes(envelope.action) ? envelope.action : "unknown",
      projectId: typeof envelope.args.projectId === "string" && PROJECT_ID.test(envelope.args.projectId) && current.config.projects.some((project) => project.id === envelope.args.projectId) ? envelope.args.projectId : null,
      time: now(), outcome: "received",
    };
    current.audit.push(entry);
    if (current.audit.length > AUDIT_LIMIT) current.audit.splice(0, current.audit.length - AUDIT_LIMIT);
    try { atomicWrite(current.auditFile, JSON.stringify(current.audit)); }
    catch { throw fail("Could not record device activity; action was not started", 503); }
    try {
      const result = await (async () => {
        for (const [nonce, expiry] of current.nonces) if (expiry <= now()) current.nonces.delete(nonce);
        const nonce = `${peer.id}:${envelope.nonce}`;
        if (current.nonces.has(nonce)) throw fail("Device request has already been received", 409);
        if (current.nonces.size >= NONCE_LIMIT) throw fail("Device bridge replay window is full; retry later", 429);
        current.nonces.set(nonce, envelope.expiresAt);
        try { atomicWrite(current.nonceFile, JSON.stringify([...current.nonces])); }
        catch { current.nonces.delete(nonce); throw fail("Could not persist device replay protection", 503); }
        controlArguments(envelope.action, envelope.args);
        if (envelope.action === "bridge.describe") return {
          identity: { ...current.identity },
          projects: current.config.projects.filter((project) => peer.projectIds.includes(project.id)).map((project) => ({ id: project.id, name: path.basename(project.root) })),
          nativeConsentAvailable: !!nativeConsentKey, resources: structuredClone(peer.resources), capabilities: [...peer.capabilities], expiresAt: peer.expiresAt, platform: process.platform,
        };
        if (["jobs.list", "approvals.list"].includes(envelope.action)) return { jobs: (await executor.listJobs(peer.id)).filter(job => peer.projectIds.includes(job.projectId) && peer.capabilities.includes(BRIDGE_ACTION_CAPABILITIES[job.action]) && (envelope.action !== "approvals.list" || job.status === "waiting_approval")) };
        if (["jobs.get", "jobs.cancel"].includes(envelope.action)) {
          const job = await executor.getJob(envelope.args.jobId, peer.id, envelope.args.cursor ?? 0);
          authorize(peer.id, job.action, job.projectId);
          return envelope.action === "jobs.cancel" ? executor.cancel(envelope.args.jobId, peer.id) : job;
        }
        if (["ios.submit", "browser.request_attach", "browser.navigate", "browser.click", "browser.type", "browser.keys"].includes(envelope.action) && !nativeConsentKey) throw fail("This action requires an open receiving desktop app with native consent support", 503, "LOCAL_CONSENT_UNAVAILABLE");
        const context = authorize(peer.id, envelope.action, envelope.args.projectId);
        return executor.execute(envelope.action, envelope.args, context);
      })();
      entry.outcome = "accepted";
      try { atomicWrite(current.auditFile, JSON.stringify(current.audit)); }
      catch { throw fail("Device action was handled, but activity recording failed. Check the result before retrying", 503); }
      return result;
    } catch (error) {
      if (entry.outcome !== "accepted") {
        entry.outcome = [400, 401, 403, 404, 409, 429].includes(error.status) ? "denied" : "failed";
        try { atomicWrite(current.auditFile, JSON.stringify(current.audit)); }
        catch { throw fail("Device action failed and its activity outcome could not be recorded", 503); }
      }
      throw error;
    }
  };
  const receiveSigned = async (request) => {
    let result;
    try { result = await receive(request); }
    catch (error) {
      // Only an authenticated sender with an active grant receives signed error details.
      const envelope = request?.envelope;
      const peer = initialize().config.peers.find(candidate => candidate.id === envelope?.source);
      if (!peer || !envelope || envelope.target !== initialize().identity.id || typeof request.signature !== "string" || !crypto.verify(null, Buffer.from(canonicalEnvelope(envelope)), parsePublicIdentity(peer.publicKey).key, Buffer.from(request.signature, "base64"))) throw error;
      result = { bridgeError: { code: error.code || "ACTION_FAILED", status: error.status || 500, message: error.status ? error.message : "Device bridge operation failed", ...(envelope.args?.requestId ? { requestId: envelope.args.requestId } : {}) } };
    }
    const current = initialize();
    const envelope = { version: 1, source: current.identity.id, target: request.envelope.source, requestNonce: request.envelope.nonce, expiresAt: now() + 30_000, result };
    const signature = crypto.sign(null, Buffer.from(canonicalEnvelope(envelope, { byteLimit: RESPONSE_LIMIT - 1024, nodeLimit: 100_000 })), current.privateKey).toString("base64");
    return { envelope, signature };
  };
  const dispatch = async (request) => {
    if (!exactKeys(request, ["peerId", "action", "args"]) || typeof request.action !== "string" || (!Object.hasOwn(BRIDGE_ACTION_CAPABILITIES, request.action) && !CONTROL_ACTIONS.includes(request.action)) || !object(request.args)) throw fail("Invalid device bridge action");
    controlArguments(request.action, request.args);
    const peer = activePeer(request.peerId);
    const current = initialize();
    const envelope = { version: 1, source: current.identity.id, target: peer.id, nonce: crypto.randomBytes(24).toString("base64url"), expiresAt: now() + 30_000, action: request.action, args: request.args };
    const signature = crypto.sign(null, Buffer.from(canonicalEnvelope(envelope)), current.privateKey).toString("base64");
    const response = await transport(peer, { envelope, signature });
    activePeer(request.peerId);
    const result = response?.envelope;
    if (!exactKeys(response, ["envelope", "signature"]) || typeof response.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(response.signature) ||
      !exactKeys(result, ["version", "source", "target", "requestNonce", "expiresAt", "result"]) || result.version !== 1 || result.source !== peer.id || result.target !== current.identity.id || result.requestNonce !== envelope.nonce || !Number.isSafeInteger(result.expiresAt) || result.expiresAt <= now() || result.expiresAt > now() + REQUEST_LIFETIME) throw fail("Device returned an invalid signed response", 502);
    const responseBytes = canonicalEnvelope(result, { byteLimit: RESPONSE_LIMIT - 1024, nodeLimit: 100_000 });
    if (!crypto.verify(null, Buffer.from(responseBytes), parsePublicIdentity(peer.publicKey).key, Buffer.from(response.signature, "base64"))) throw fail("Device response signature is invalid", 502);
    if (result.result?.bridgeError) {
      const error = result.result.bridgeError;
      throw Object.assign(fail(error.message, error.status, error.code), error.requestId ? { requestId: error.requestId } : {});
    }
    return result.result;
  };
  const peerIdentity = async (host) => {
    if (!HOST.test(host || "")) throw fail("Choose a valid trusted SSH device");
    const remote = await agentRequest(host, "/bridge/state");
    const parsed = parsePublicIdentity(remote?.identity?.publicKey);
    if (parsed.id !== remote.identity.id || parsed.id === initialize().identity.id) throw fail("The device returned an invalid or local identity");
    return { identity: { id: parsed.id, publicKey: parsed.publicKey }, config: remote.config };
  };
  const pairGrant = async (request) => {
    if (!exactKeys(request, ["operation", "expectedIdentityId", "expectedConfigHash", "peer", "project", "peerId", "projectId", "restoreEnabled"])) throw fail("Invalid pairing grant");
    const current = initialize();
    if (request.expectedIdentityId !== current.identity.id || request.expectedConfigHash !== configHash(current.config)) throw fail("Device identity or bridge settings changed. Read the device identity again.", 409);
    if (request.operation === "remove") {
      if (!ID.test(request.peerId || "") || typeof request.restoreEnabled !== "boolean" || (request.projectId !== null && !PROJECT_ID.test(request.projectId || ""))) throw fail("Invalid pairing rollback");
      if (!current.config.peers.some(peer => peer.id === request.peerId)) throw fail("Pairing grant no longer exists", 409);
      const peers = current.config.peers.filter(peer => peer.id !== request.peerId);
      if (request.projectId && peers.some(peer => peer.projectIds.includes(request.projectId))) throw fail("The project is now used by another paired device", 409);
      return configure({ enabled: request.restoreEnabled, peers, projects: current.config.projects.filter(project => project.id !== request.projectId) });
    }
    if (request.operation !== "add" || !object(request.peer) || !object(request.project)) throw fail("Invalid pairing grant");
    if (current.config.peers.some(peer => peer.id === request.peer.id)) throw fail("This device is already paired. Edit its existing access settings.", 409);
    if (!current.config.enabled && current.config.peers.some(peer => peer.enabled)) throw fail("Enable or revoke existing device grants before pairing another device", 409);
    const existing = current.config.projects.find(project => project.id === request.project.id);
    if (existing && existing.root !== request.project.root) throw fail("Project ID already refers to another folder", 409);
    // Pairing adds exactly one named project and never changes other device grants.
    if (request.peer.host !== "" || request.peer.enabled !== true || JSON.stringify(request.peer.projectIds) !== JSON.stringify([request.project.id])) throw fail("Invalid incoming pairing scope");
    const config = { enabled: true, peers: [...current.config.peers, request.peer], projects: existing ? current.config.projects : [...current.config.projects, request.project] };
    return requestConfiguration({ config, expectedConfigHash: request.expectedConfigHash });
  };
  const performConnection = async (request) => {
    if (closing) throw fail("Device bridge is shutting down", 503);
    if (!exactKeys(request, ["host", "identityId", "label", "localLabel", "project", "capabilities", "resources", "expiresAt"]) || !HOST.test(request.host || "") || !ID.test(request.identityId || "") || !object(request.project)) throw fail("Choose a trusted device and an explicit project");
    if (pairing) throw fail("Device pairing is already running", 409);
    pairing = true;
    let original;
    let localSaved;
    let remote;
    let remoteSaved;
    let incoming;
    let remoteAttempted = false;
    let pendingRemoteApproval;
    let next;
    try {
      original = structuredClone(initialize().config);
      if (!original.enabled && original.peers.some(peer => peer.enabled)) throw fail("Enable or revoke existing device grants before pairing another device", 409);
      remote = await peerIdentity(request.host);
      if (remote.identity.id !== request.identityId) throw fail("The device identity changed. Read its identity again.", 409);
      if (original.peers.some(peer => peer.id === remote.identity.id)) throw fail("This device is already paired. Edit its existing access settings.", 409);
      const outgoing = { ...remote.identity, label: request.label, host: request.host, port: 5190, enabled: true, expiresAt: request.expiresAt, projectIds: [], capabilities: [] };
      next = validateConfig({ ...original, enabled: true, peers: [...original.peers, outgoing] }, initialize().identity.id);
      if (!PROJECT_ID.test(request.project.id || "") || typeof request.project.root !== "string" || !path.isAbsolute(request.project.root) || !Array.isArray(request.capabilities) || !request.capabilities.length || request.capabilities.some(capability => !BRIDGE_CAPABILITIES.includes(capability)) || new Set(request.capabilities).size !== request.capabilities.length) throw fail("Choose an absolute project folder and its permissions");
      if (typeof request.localLabel !== "string" || !request.localLabel.trim() || request.localLabel.length > 80 || /[\x00-\x1f\x7f]/.test(request.localLabel)) throw fail("Give this device a valid name");
      incoming = { ...initialize().identity, label: request.localLabel.trim(), host: "", port: 5190, enabled: true, expiresAt: request.expiresAt, projectIds: [request.project.id], capabilities: request.capabilities, resources: validateResources(request.resources) };
      remoteAttempted = true;
      remoteSaved = await agentRequest(request.host, "/bridge/pair-grant", { operation: "add", expectedIdentityId: remote.identity.id, expectedConfigHash: configHash(remote.config), peer: incoming, project: request.project });
      if (remoteSaved.status === "waiting_approval") {
        const approvalId = remoteSaved.approval.id;
        pendingRemoteApproval = approvalId;
        remoteSaved = undefined;
        const deadline = now() + 10 * 60000;
        let accepted = false;
        while (!closing && now() < deadline) {
          const approval = await agentRequest(request.host, "/bridge/approval-status", { approvalId });
          if (approval.status === "approved") { accepted = true; break; }
          if (approval.status !== "waiting_approval") throw fail("Receiving device declined or expired the pairing confirmation", 403, "LOCAL_CONSENT_DECLINED");
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        if (!accepted) throw fail("Receiving device confirmation timed out; no outgoing access was enabled", 504, "LOCAL_CONSENT_PENDING");
        remoteSaved = await agentRequest(request.host, "/bridge/state");
      }
      if (configHash(initialize().config) !== configHash(original)) throw fail("Local bridge settings changed during pairing", 409);
      localSaved = await configure(next);
      const connection = await dispatch({ peerId: remote.identity.id, action: "bridge.describe", args: {} });
      return { state: await state(), connection };
    } catch (error) {
      let rollbackFailed = false;
      if (pendingRemoteApproval && !remoteSaved) {
        try { await agentRequest(request.host, "/bridge/approval-cancel", { approvalId: pendingRemoteApproval }); }
        catch { rollbackFailed = true; }
      }
      // A dropped SSH response may follow a successful remote write. Recover its
      // exact new grant before rollback; never mistake an existing grant for ours.
      if (remoteAttempted && !remoteSaved && !remote.config.peers.some(peer => peer.id === incoming.id)) {
        try {
          const recovered = await agentRequest(request.host, "/bridge/state");
          const added = recovered.config.peers.find(peer => peer.id === incoming.id);
          if (added) {
            const project = recovered.config.projects.find(project => project.id === request.project.id);
            const expected = { ...remote.config, enabled: true, peers: [...remote.config.peers, incoming], projects: remote.config.projects.some(project => project.id === request.project.id) ? remote.config.projects : [...remote.config.projects, project] };
            if (!project || configHash(expected) !== configHash(recovered.config)) throw fail("Remote settings changed");
            remoteSaved = recovered;
          }
        } catch { rollbackFailed = true; }
      }
      if (!localSaved && next && configHash(initialize().config) === configHash(next)) localSaved = { config: next };
      if (localSaved) {
        try {
          if (configHash(initialize().config) !== configHash(localSaved.config)) throw fail("Local settings changed");
          await configure(original);
        } catch { rollbackFailed = true; }
      }
      if (remoteSaved) {
        try { await agentRequest(request.host, "/bridge/pair-grant", { operation: "remove", expectedIdentityId: remote.identity.id, expectedConfigHash: configHash(remoteSaved.config), peerId: initialize().identity.id, projectId: remote.config.projects.some(project => project.id === request.project.id) ? null : request.project.id, restoreEnabled: remote.config.enabled }); }
        catch { rollbackFailed = true; }
      }
      if (rollbackFailed) throw fail("Pairing could not be verified and its grant could not be fully removed. Revoke this device in bridge settings on both devices before retrying.", 502);
      throw error;
    } finally { pairing = false; }
  };
  const connect = (request) => {
    if (!exactKeys(request, ["operationId", "host", "identityId", "label", "localLabel", "project", "capabilities", "resources", "expiresAt"]) || typeof request.operationId !== "string" || !CONNECTION_ID.test(request.operationId)) throw fail("Choose a unique pairing operation ID");
    const { operationId, ...input } = structuredClone(request);
    const fingerprint = crypto.createHash("sha256").update(canonicalEnvelope(input, { byteLimit: 16_384 })).digest("hex");
    pruneConnections();
    const existing = connections.get(operationId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw fail("Pairing operation ID already belongs to a different request", 409);
      return structuredClone(existing.operation);
    }
    if (closing) throw fail("Device bridge is shutting down", 503);
    if (connectionWork || pairing) throw fail("Device pairing is already running. Check its operation status before starting another.", 409);
    // Never evict a recoverable result to make room, or replay an accepted request
    // when its HTTP response is lost. Terminal results remain available for an hour.
    if (connections.size >= CONNECTION_LIMIT) throw fail("Pairing operation history is full; try again after older results expire", 429);
    const operation = { id: operationId, status: "pending", createdAt: now(), updatedAt: now() };
    connections.set(operationId, { fingerprint, operation });
    connectionWork = Promise.resolve().then(() => performConnection(input)).then(
      result => { Object.assign(operation, { status: "completed", result, updatedAt: now() }); },
      error => { Object.assign(operation, { status: "failed", error: error.status ? error.message : "Device pairing failed", updatedAt: now() }); },
    ).finally(() => { connectionWork = undefined; });
    return structuredClone(operation);
  };
  const connectionStatus = (request) => {
    if (!exactKeys(request, ["operationId"]) || typeof request.operationId !== "string" || !CONNECTION_ID.test(request.operationId)) throw fail("Choose a valid pairing operation ID");
    pruneConnections();
    const found = connections.get(request.operationId);
    if (!found) throw fail("Pairing operation not found or no longer retained. Check both devices' settings before starting another pairing.", 404);
    return structuredClone(found.operation);
  };
  return { state, configure, receive, receiveSigned, dispatch,
    peerIdentity: async (host) => ({ identity: (await peerIdentity(host)).identity }),
    pairGrant, connect, connectionStatus, requestConfiguration, configurationStatus,
    resources: async () => { initialize(); return executor.discoverResources(); },
    cancelConfiguration(request) {
      const current = configurationStatus(request);
      const approval = approvals.get(current.id);
      if (approval.status === "waiting_approval") approval.status = "cancelled";
      return approvalView(approval);
    },
    async setupPaths(request) {
      if (!exactKeys(request, ["path", "cursor", "limit"])) throw fail("Invalid setup path arguments");
      const offset = request.cursor ?? 0; const limit = request.limit ?? 100;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) throw fail("Invalid setup path pagination");
      const home = fs.realpathSync(os.homedir());
      if (request.path !== undefined && (typeof request.path !== "string" || !path.isAbsolute(request.path) || request.path.length > 4096 || /[\x00-\x1f\x7f]/.test(request.path))) throw fail("Choose an absolute account setup path");
      let target;
      try { target = fs.realpathSync(request.path || home); } catch { throw fail("Setup directory not found", 404); }
      if (target !== home && !target.startsWith(home + path.sep)) throw fail("Setup browsing is limited to this account's home", 403);
      assertBridgePath(target);
      const entries = fs.readdirSync(target, { withFileTypes: true }).filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && !privateBridgePath(path.join(target, entry.name))).sort((a, b) => a.name.localeCompare(b.name));
      return { path: target, entries: entries.slice(offset, offset + limit).map(entry => ({ name: entry.name, path: path.join(target, entry.name) })), nextCursor: offset + limit < entries.length ? offset + limit : null, total: entries.length };
    },
    async localDecision(request, req) {
      requireNativeConsent(nativeConsentKey, req);
      if (request.kind === "config" && exactKeys(request, ["kind", "config", "expectedConfigHash"])) {
        if (request.expectedConfigHash !== configHash(initialize().config)) throw fail("Bridge settings changed before local confirmation", 409);
        return configure(request.config);
      }
      if (request.kind === "job" && exactKeys(request, ["kind", "jobId", "digest", "approved"])) {
        const job = await executor.getJob(request.jobId);
        if (request.digest !== job.approvalDigest) throw fail("Pending action changed before local confirmation", 409);
        return executor.approve(request.jobId, request.approved);
      }
      if (request.kind === "approval" && exactKeys(request, ["kind", "approvalId", "digest", "approved"]) && typeof request.approved === "boolean") {
        const proposal = approvals.get(request.approvalId);
        if (!proposal || proposal.status !== "waiting_approval" || proposal.expiresAt <= now() || proposal.digest !== request.digest) throw fail("Configuration approval changed, expired or was already consumed", 409);
        proposal.status = request.approved ? "applying" : "rejected";
        if (request.approved) {
          try {
            if (proposal.expectedConfigHash !== configHash(initialize().config)) throw fail("Settings changed before confirmation", 409);
            await configure(proposal.config); proposal.status = "approved";
          } catch (error) { proposal.status = "failed"; proposal.error = error.status ? error.message : "Could not apply configuration"; throw error; }
        }
        return approvalView(proposal);
      }
      throw fail("Invalid native consent decision");
    },
    configureChecked: (request) => {
      if (!exactKeys(request, ["config", "expectedConfigHash"]) || request.expectedConfigHash !== configHash(initialize().config)) throw fail("Bridge settings changed. Read their current state before saving.", 409);
      return configure(request.config);
    },
    revoke: (request) => {
      if (!exactKeys(request, ["peerId", "expectedConfigHash"]) || !ID.test(request.peerId || "")) throw fail("Choose the exact paired device to revoke");
      const config = initialize().config;
      if (request.expectedConfigHash !== configHash(config)) throw fail("Bridge settings changed. Read their current state before revoking.", 409);
      if (!config.peers.some(peer => peer.id === request.peerId)) throw fail("Paired device not found", 404);
      return configure({ ...config, peers: config.peers.filter(peer => peer.id !== request.peerId) });
    },
    audit: () => ({ audit: structuredClone(initialize().audit) }),
    jobs: async () => { initialize(); return { jobs: await executor.listJobs() }; },
    approve: (jobId, approved) => { initialize(); if (typeof approved !== "boolean") throw fail("Approval decision is required"); return executor.approve(jobId, approved); },
    cancel: (jobId) => { initialize(); return executor.cancel(jobId); },
    close: () => {
      if (closePromise) return closePromise;
      closing = true;
      clearTimeout(expiryTimer);
      closePromise = (async () => {
        await connectionWork;
        clearTimeout(expiryTimer);
        if (initialized) await (executor.close ? executor.close() : Promise.all(initialized.config.peers.map((peer) => executor.revokePeer(peer.id))));
      })();
      return closePromise;
    },
  };
}

export async function readBridgeBody(req) {
  if (!String(req.headers["content-type"] || "").toLowerCase().startsWith("application/json")) throw fail("Bridge requests require application/json", 415);
  if (Number(req.headers["content-length"] || 0) > BODY_LIMIT) { req.resume(); throw fail("Bridge request is too large", 413); }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    const timer = setTimeout(() => { reject(fail("Bridge request body timed out", 408)); req.destroy(); }, 5000);
    req.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > BODY_LIMIT) { reject(fail("Bridge request is too large", 413)); }
      else chunks.push(chunk);
    });
    req.on("end", () => {
      clearTimeout(timer);
      if (bytes > BODY_LIMIT) return;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); } catch { reject(fail("Invalid bridge JSON")); }
    });
    req.on("error", () => { clearTimeout(timer); reject(fail("Bridge request body could not be read")); });
    req.on("aborted", () => { clearTimeout(timer); reject(fail("Bridge request was interrupted")); });
  });
}

export function createBridgeRouter(bridge, json) {
  return async (req, res, url, signedOnly = false) => {
    if (!url.pathname.startsWith("/bridge/")) return false;
    if (signedOnly && url.pathname !== "/bridge/receive") return false;
    try {
      if (url.pathname === "/bridge/receive") {
        if (req.method !== "POST") throw fail("Method not allowed", 405);
        if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress)) throw fail("Bridge receiver only accepts loopback requests", 403);
        json(res, 200, await bridge.receiveSigned(await readBridgeBody(req)));
      } else if (url.pathname === "/bridge/state" && req.method === "GET") json(res, 200, await bridge.state());
      else if (url.pathname === "/bridge/resources" && req.method === "GET") json(res, 200, await bridge.resources());
      else if (url.pathname === "/bridge/audit" && req.method === "GET") json(res, 200, bridge.audit());
      else if (url.pathname === "/bridge/jobs" && req.method === "GET") json(res, 200, await bridge.jobs());
      else if (req.method === "POST") {
        const body = await readBridgeBody(req);
        if (url.pathname === "/bridge/configure") json(res, 202, await bridge.requestConfiguration(body));
        else if (url.pathname === "/bridge/local-decision") json(res, 200, await bridge.localDecision(body, req));
        else if (url.pathname === "/bridge/approval-cancel") json(res, 200, bridge.cancelConfiguration(body));
        else if (url.pathname === "/bridge/approval-status") json(res, 200, bridge.configurationStatus(body));
        else if (url.pathname === "/bridge/setup-paths") json(res, 200, await bridge.setupPaths(body));
        else if (url.pathname === "/bridge/revoke") json(res, 200, await bridge.revoke(body));
        else if (url.pathname === "/bridge/peer-identity" && exactKeys(body, ["host"])) json(res, 200, await bridge.peerIdentity(body.host));
        else if (url.pathname === "/bridge/pair-grant") json(res, 200, await bridge.pairGrant(body));
        else if (url.pathname === "/bridge/connect") {
          const operation = bridge.connect(body);
          json(res, operation.status === "pending" ? 202 : 200, operation);
        }
        else if (url.pathname === "/bridge/connect-status") json(res, 200, bridge.connectionStatus(body));
        else if (url.pathname === "/bridge/dispatch") json(res, 200, await bridge.dispatch(body));
        else if (url.pathname === "/bridge/approve") throw fail("Approve only from the receiving native app", 403, "LOCAL_CONSENT_REQUIRED");
        else if (url.pathname === "/bridge/cancel" && exactKeys(body, ["jobId"])) json(res, 200, await bridge.cancel(body.jobId));
        else throw fail("Unknown bridge endpoint", 404);
      } else throw fail("Unknown bridge endpoint", 404);
    } catch (error) {
      json(res, Number.isInteger(error.status) ? error.status : 500, { error: error.status ? error.message : "Device bridge operation failed", code: error.code || "ACTION_FAILED", status: error.status || 500, ...(error.requestId ? { requestId: error.requestId } : {}) });
    }
    return true;
  };
}
