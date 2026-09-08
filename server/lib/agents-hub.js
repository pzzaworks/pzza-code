import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { AGENTS_HUB_TARGET } from "./agents-hub-target.js";
import { inspectSkillSource } from "./skill-import.js";

const LIMIT = 64 * 1024 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const HOST = /^[A-Za-z0-9._][A-Za-z0-9._@-]{0,127}$/;
const FRAMEWORKS = Object.freeze([
  { id: "claude", label: "Claude", instructionFile: "CLAUDE.md", skillsDirectory: ".claude/skills", launchSupported: true },
  { id: "codex", label: "Codex", instructionFile: "AGENTS.md", skillsDirectory: ".agents/skills", launchSupported: true },
  { id: "cursor", label: "Cursor", instructionFile: ".cursor/rules/<profile-id>.mdc", skillsDirectory: ".cursor/skills", launchSupported: false },
  { id: "windsurf", label: "Windsurf", instructionFile: ".windsurf/rules/<profile-id>.md", skillsDirectory: ".windsurf/skills", launchSupported: false },
  { id: "zed", label: "Zed", instructionFile: "AGENTS.md", skillsDirectory: ".agents/skills", launchSupported: false },
]);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value, allowed) => object(value) && Object.keys(value).every((key) => allowed.includes(key));
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
const quote = (text) => `'${text.replace(/'/g, `'\\''`)}'`;
const string = (value, label, max, empty = false) => {
  if (typeof value !== "string" || (!empty && !value.trim()) || Buffer.byteLength(value) > max || value.includes("\0")) throw fail(`Invalid ${label}`);
  return value;
};
function identifier(value) { if (typeof value !== "string" || !ID.test(value)) throw fail("Invalid library item ID"); return value; }
function relative(value) {
  string(value, "skill asset path", 2048);
  if (value.startsWith("/") || value.includes("\\") || /[\x00-\x1f\x7f]/.test(value) || value.split("/").some((part) => ["", ".", "..", ".git"].includes(part.toLowerCase()))) throw fail("Skill paths must stay inside the skill directory");
  return value;
}
function base64(value) {
  if (typeof value !== "string" || value.length > 7 * 1024 * 1024 || value.length % 4 !== 0 || /[^A-Za-z0-9+/=]/.test(value)) throw fail("Invalid skill asset encoding");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > 5 * 1024 * 1024 || bytes.toString("base64") !== value) throw fail("Skill asset exceeds the file limit");
  return bytes;
}
function unique(items, label, max) {
  if (!Array.isArray(items) || items.length > max || new Set(items.map((item) => item?.id)).size !== items.length) throw fail(`Invalid ${label} collection`);
}

export function validateHubLibrary(value) {
  if (!keys(value, ["revision", "documents", "skills", "profiles"]) || !Number.isSafeInteger(value.revision) || value.revision < 0) throw fail("A library revision is required");
  unique(value.documents, "instruction", 100);
  unique(value.skills, "skill", 100);
  unique(value.profiles, "profile", 100);
  const framework = (value) => { if (!FRAMEWORKS.some((item) => item.id === value)) throw fail("Unknown agent framework"); return value; };
  const name = (value) => { string(value, "item name", 160); if (/[\x00-\x1f\x7f]/.test(value)) throw fail("Invalid item name"); return value.trim(); };
  const documents = value.documents.map((item) => {
    if (!keys(item, ["id", "name", "framework", "content"])) throw fail("Invalid instruction document");
    return { id: identifier(item.id), name: name(item.name), framework: framework(item.framework), content: string(item.content, "instruction content", 1024 * 1024, true) };
  });
  const skills = value.skills.map((item) => {
    if (!keys(item, ["id", "name", "content", "sourceUrl", "license", "commit", "files"])) throw fail("Invalid skill");
    const skill = { id: identifier(item.id), name: name(item.name), content: string(item.content, "SKILL.md content", 1024 * 1024, true) };
    if (item.sourceUrl !== undefined) {
      const url = new URL(string(item.sourceUrl, "skill source URL", 2048));
      if (url.protocol !== "https:" || url.username || url.password) throw fail("Skill sources must be HTTPS URLs without credentials");
      skill.sourceUrl = url.href;
    }
    if (item.license !== undefined) skill.license = string(item.license, "license declaration", 240, true);
    if (item.commit !== undefined) { if (!/^[a-f0-9]{40}$/.test(item.commit)) throw fail("Invalid source commit"); skill.commit = item.commit; }
    if (item.files !== undefined) {
      if (!Array.isArray(item.files) || item.files.length > 100) throw fail("A skill can contain at most 100 files");
      const paths = new Set();
      let bytes = 0;
      skill.files = item.files.map((file) => {
        if (!keys(file, ["path", "contentBase64", "executable"])) throw fail("Invalid skill asset");
        if (file.executable !== undefined && typeof file.executable !== "boolean") throw fail("Invalid skill asset executable flag");
        const assetPath = relative(file.path);
        const foldedPath = assetPath.normalize("NFD").toLowerCase();
        if (paths.has(foldedPath)) throw fail("Duplicate or case-colliding skill asset path");
        paths.add(foldedPath);
        const content = assetPath === "SKILL.md" ? Buffer.from(skill.content) : base64(file.contentBase64);
        bytes += content.length;
        if (bytes > 20 * 1024 * 1024) throw fail("Skill bundle exceeds 20 MiB");
        return { path: assetPath, contentBase64: content.toString("base64"), executable: assetPath === "SKILL.md" ? false : file.executable === true };
      });
    }
    return skill;
  });
  const profiles = value.profiles.map((item) => {
    if (!keys(item, ["id", "name", "framework", "systemPrompt", "instructionIds", "skillIds"])) throw fail("Invalid agent profile");
    const chosen = framework(item.framework);
    const references = (ids, collection, label) => {
      if (!Array.isArray(ids) || ids.length > 100 || new Set(ids).size !== ids.length || ids.some((id) => !collection.some((entry) => entry.id === id))) throw fail(`Invalid profile ${label}`);
      return [...ids];
    };
    const instructionIds = references(item.instructionIds, documents, "instructions");
    if (instructionIds.some((id) => documents.find((entry) => entry.id === id).framework !== chosen)) throw fail("Profile instructions must use the same framework");
    return { id: identifier(item.id), name: name(item.name), framework: chosen, systemPrompt: string(item.systemPrompt, "profile guidance", 1024 * 1024, true), instructionIds, skillIds: references(item.skillIds, skills, "skills") };
  });
  const normalized = { revision: value.revision, documents, skills, profiles };
  if (Buffer.byteLength(JSON.stringify(normalized)) > LIMIT - 1024 * 1024) throw fail("Agent library exceeds the storage limit", 413);
  return normalized;
}

export function renderHubProfile(library, profile) {
  const framework = FRAMEWORKS.find((item) => item.id === profile.framework);
  const sections = ["# Project instructions", ...(profile.systemPrompt.trim() ? [`## Additional profile guidance\n\n${profile.systemPrompt}`] : []), ...profile.instructionIds.map((id) => {
    const document = library.documents.find((item) => item.id === id);
    return `## ${document.name}\n\n${document.content}`;
  })];
  let instructions = sections.join("\n\n") + "\n";
  if (framework.id === "cursor") instructions = `---\ndescription: ${JSON.stringify(profile.name)}\nalwaysApply: true\n---\n\n${instructions}`;
  if (framework.id === "windsurf") instructions = `---\ntrigger: always_on\n---\n\n${instructions}`;
  const files = [{ path: framework.instructionFile.replace("<profile-id>", profile.id), contentBase64: Buffer.from(instructions).toString("base64") }];
  const skillNames = new Set();
  for (const id of profile.skillIds) {
    const skill = library.skills.find((item) => item.id === id);
    const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(skill.content)?.[1];
    let skillName = header && /^name:[ \t]*(.+)$/m.exec(header)?.[1].trim();
    if (skillName && ["\"", "'"].includes(skillName[0]) && skillName.at(-1) === skillName[0]) skillName = skillName.slice(1, -1);
    const description = header && /^description:[ \t]*(\S.*)$/m.exec(header);
    const duplicateFields = header && ((header.match(/^name:/gm)?.length || 0) !== 1 || (header.match(/^description:/gm)?.length || 0) !== 1);
    const emptyDescription = description && /^["'][ \t]*["']$/.test(description[1]);
    if (!skillName || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName) || skillName.length > 64 || !description || duplicateFields || emptyDescription ||
      (/^[|>][-+]?\s*$/.test(description[1]) && !/\r?\n[ \t]+\S/.test(header.slice(description.index + description[0].length)))) throw fail(`Skill ${skill.name} requires frontmatter with a valid lowercase name and description`);
    if (skillNames.has(skillName)) throw fail("Selected skills must have distinct frontmatter names");
    skillNames.add(skillName);
    const prefix = `${framework.skillsDirectory}/${skillName}`;
    files.push({ path: `${prefix}/SKILL.md`, contentBase64: Buffer.from(skill.content).toString("base64") });
    for (const asset of skill.files || []) if (asset.path !== "SKILL.md") files.push({ path: `${prefix}/${asset.path}`, contentBase64: asset.contentBase64, executable: asset.executable === true });
  }
  return files;
}

export function runHubTarget(host, payload, { env = process.env } = {}) {
  if (typeof host !== "string" || (host && !HOST.test(host))) return Promise.reject(fail("An explicit valid device host is required"));
  const input = JSON.stringify(payload);
  if (Buffer.byteLength(input) > LIMIT) return Promise.reject(fail("Deployment exceeds the transfer limit", 413));
  const args = host ? ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes", "-o", "ControlMaster=no", "-o", "ControlPath=none", "-o", "ConnectTimeout=5", "-o", "PermitLocalCommand=no", "--", host, `python3 -c ${quote(AGENTS_HUB_TARGET)}`] : ["-c", AGENTS_HUB_TARGET];
  return new Promise((resolve, reject) => {
    const child = execFile(host ? "ssh" : "python3", args, { timeout: 30_000, maxBuffer: LIMIT, env }, (error, stdout) => {
      if (error) return reject(fail("Could not run target operations. Python 3 and trusted SSH access are required; no tools are installed automatically", 503));
      try { resolve(JSON.parse(stdout)); } catch { reject(fail("Target returned an invalid deployment response", 502)); }
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

export function createAgentsHub({ stateDir, target = runHubTarget, inspectSkill = inspectSkillSource, now = Date.now } = {}) {
  let stored;
  const previews = new Map();
  const file = path.join(stateDir, "agents-hub.json");
  const checkDirectory = () => {
    const directory = fs.lstatSync(stateDir);
    if (!directory.isDirectory() || directory.isSymbolicLink() || (directory.mode & 0o022) || (process.getuid && directory.uid !== process.getuid())) throw fail("Agent library needs a private, user-owned state directory", 503);
  };
  const persist = (value) => {
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded) > LIMIT) throw fail("Agent library exceeds the storage limit", 413);
    fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
    checkDirectory();
    const temporary = path.join(stateDir, `.agents-hub-${crypto.randomUUID()}.tmp`);
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    try { fs.writeFileSync(fd, encoded); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { fs.renameSync(temporary, file); } finally { try { fs.unlinkSync(temporary); } catch {} }
    stored = value;
  };
  const load = () => {
    if (stored) return stored;
    let value;
    try {
      checkDirectory();
      const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const meta = fs.fstatSync(fd);
        if (!meta.isFile() || meta.nlink !== 1 || meta.size > LIMIT || (meta.mode & 0o077) || (process.getuid && meta.uid !== process.getuid())) throw fail("Unsafe agent library state file", 503);
        value = JSON.parse(fs.readFileSync(fd, "utf8"));
      } finally { fs.closeSync(fd); }
    } catch (error) {
      if (error.code !== "ENOENT") throw fail("Could not load the private agent library", 503);
      stored = { revision: 0, documents: [], skills: [], profiles: [], deployments: [] };
      return stored;
    }
    const { deployments, ...library } = value;
    stored = { ...validateHubLibrary(library), deployments: Array.isArray(deployments) ? deployments.slice(-200).map((entry) => entry.status === "applying" ? { ...entry, status: "interrupted", error: "Agent restarted during deployment. Inspect the target before previewing again." } : entry) : [] };
    return stored;
  };
  const state = () => ({ ...structuredClone(load()), frameworks: structuredClone(FRAMEWORKS) });
  const save = (input) => {
    const current = load();
    const candidate = object(input) && Array.isArray(input.skills) ? { ...input, skills: input.skills.map((skill) => {
      const existing = current.skills.find((item) => item.id === skill?.id);
      return object(skill) && skill.files === undefined && existing?.files ? { ...skill, files: existing.files } : skill;
    }) } : input;
    const library = validateHubLibrary(candidate);
    if (current.revision !== library.revision) throw fail("Agent library changed. Reload before saving", 409);
    persist({ ...library, revision: current.revision + 1, deployments: current.deployments });
    return state();
  };
  const collectionFor = (kind) => {
    if (!["document", "skill", "profile"].includes(kind)) throw fail("Unknown library item kind");
    return { document: "documents", skill: "skills", profile: "profiles" }[kind];
  };
  const assetMetadata = (skill) => ({ ...skill, ...(skill.files ? { files: skill.files.map((asset) => ({ path: asset.path, executable: asset.executable === true, bytes: Buffer.byteLength(asset.contentBase64, "base64") })) } : {}) });
  const summary = () => {
    const current = load();
    return { revision: current.revision, frameworks: structuredClone(FRAMEWORKS), deployments: structuredClone(current.deployments),
      documents: current.documents.map(({ content, ...metadata }) => ({ ...metadata, contentBytes: Buffer.byteLength(content) })),
      skills: current.skills.map((skill) => { const { content, ...metadata } = assetMetadata(skill); return { ...metadata, contentBytes: Buffer.byteLength(content) }; }),
      profiles: current.profiles.map(({ systemPrompt, ...metadata }) => ({ ...metadata, systemPromptBytes: Buffer.byteLength(systemPrompt) })),
    };
  };
  const item = (input) => {
    if (!keys(input, ["kind", "id"])) throw fail("Invalid library item request");
    const found = load()[collectionFor(input.kind)].find((entry) => entry.id === input.id);
    if (!found) throw fail("Library item not found", 404);
    return { revision: load().revision, item: structuredClone(input.kind === "skill" ? assetMetadata(found) : found) };
  };
  const update = (input) => {
    if (!keys(input, ["revision", "kind", "item"]) || !object(input.item) || input.revision !== load().revision) throw fail("Agent library changed or update is invalid", 409);
    const collection = collectionFor(input.kind);
    const current = load();
    const found = current[collection].find((entry) => entry.id === input.item.id);
    const replacement = { ...found, ...input.item };
    const { deployments, ...library } = current;
    save({ ...library, [collection]: found ? current[collection].map((entry) => entry.id === found.id ? replacement : entry) : [...current[collection], replacement] });
    return summary();
  };
  const discover = async (input) => {
    if (!keys(input, ["devices"]) || !Array.isArray(input.devices) || !input.devices.length || input.devices.length > 20) throw fail("Choose configured devices");
    const seen = new Set();
    const devices = input.devices.map(device => {
      if (!keys(device, ["host", "name"]) || typeof device.host !== "string" || (device.host && !HOST.test(device.host)) || typeof device.name !== "string") throw fail("Invalid discovery device");
      if (seen.has(device.host)) throw fail("Choose each device once");
      seen.add(device.host);
      return device;
    });
    const discovered = await Promise.all(devices.map(async device => {
      try {
        const result = await target(device.host, { operation: "discover" });
        if (!result.ok) throw fail(result.error, result.status);
        return { ...device, root: result.root, files: result.files, error: result.error };
      } catch (error) { return { ...device, files: [], error: error.status ? error.message : "Device discovery failed" }; }
    }));
    const current = load();
    const documents = [...current.documents];
    for (const device of discovered) {
      for (const file of device.files) {
        const id = `global-${hash(JSON.stringify([device.host, file.path])).slice(0, 32)}`;
        if (documents.some(document => document.id === id)) continue;
        if (documents.length >= 100) { device.error = "Instruction library is full."; break; }
        documents.push({ id, name: `${device.name} · ~/${file.path}`.slice(0, 120), framework: file.framework, content: file.content });
      }
    }
    if (documents.length !== current.documents.length) {
      const { deployments, ...library } = current;
      save({ ...library, documents });
    }
    return { devices: discovered.map(device => ({ ...device, files: device.files.map(({ content, ...file }) => file) })), state: state() };
  };
  const readInstruction = async input => {
    if (!keys(input, ["host", "root", "path", "sha256"]) || typeof input.host !== "string" || (input.host && !HOST.test(input.host)) || typeof input.root !== "string" || typeof input.path !== "string" || !/^[a-f0-9]{64}$/.test(input.sha256)) throw fail("Invalid discovered instruction");
    const result = await target(input.host, { operation: "read-instruction", root: input.root, path: input.path, sha256: input.sha256 });
    if (!result.ok) throw fail(result.error, result.status);
    return { name: result.name, framework: result.framework, content: result.content };
  };
  const preview = async (input) => {
    if (!keys(input, ["profileId", "documentId", "host", "cwd", "adoptExisting"]) || typeof input.host !== "string" || (input.host && !HOST.test(input.host)) || typeof input.cwd !== "string" || !path.isAbsolute(input.cwd) || input.cwd.length > 4096 || /[\x00-\x1f\x7f]/.test(input.cwd) || (input.adoptExisting !== undefined && typeof input.adoptExisting !== "boolean")) throw fail("Choose an explicit device and absolute project directory");
    const current = load();
    if (input.documentId && input.profileId) throw fail("Choose one instruction or profile");
    const document = current.documents.find(item => item.id === input.documentId);
    const profile = input.documentId ? document && { id: `instruction-${document.id}`, framework: document.framework } : current.profiles.find((item) => item.id === input.profileId);
    if (!profile) throw fail("Instruction or agent profile not found", 404);
    const files = document ? [{ path: FRAMEWORKS.find(item => item.id === document.framework).instructionFile.replace("<profile-id>", document.id), contentBase64: Buffer.from(document.content).toString("base64") }] : renderHubProfile(current, profile);
    const blockers = profile.framework === "codex" ? ["AGENTS.override.md"] : profile.framework === "zed" ? [".rules", ".cursorrules", ".windsurfrules", ".clinerules", ".github/copilot-instructions.md", "AGENT.md"] : profile.framework === "windsurf" ? [".devin/rules"] : [];
    const payload = { operation: "preview", profileId: profile.id, framework: profile.framework, revision: current.revision, cwd: input.cwd, files, blockers, instructionOnly: Boolean(document), adoptExisting: input.adoptExisting === true };
    const observed = await target(input.host, payload);
    if (observed.ok === false) throw fail(observed.error, observed.status || 409);
    const previewId = crypto.randomUUID();
    for (const [id, entry] of previews) if (entry.expiresAt <= now()) previews.delete(id);
    if (previews.size >= 64) previews.delete(previews.keys().next().value);
    const plan = { ...payload, previewId, host: input.host, cwd: observed.cwd, baselines: observed.baselines, markerSha256: observed.markerSha256, baselineModes: observed.baselineModes, projectIdentity: observed.projectIdentity, conflicts: observed.conflicts, expiresAt: now() + 10 * 60_000 };
    previews.set(previewId, plan);
    const previousContent = (name) => {
      const previous = observed.previous?.[name];
      if (!previous) return {};
      const bytes = Buffer.from(previous.contentBase64, "base64");
      const text = bytes.toString("utf8");
      const encoding = Buffer.from(text).equals(bytes) && !text.includes("\0") ? "utf8" : "base64";
      return { previousContent: encoding === "utf8" ? text : previous.contentBase64, previousEncoding: encoding };
    };
    const publicFiles = files.map((item) => {
      const bytes = Buffer.from(item.contentBase64, "base64");
      const decoded = bytes.toString("utf8");
      const text = Buffer.from(decoded).equals(bytes) && !decoded.includes("\0");
      return { path: item.path, contentSha256: hash(bytes), bytes: bytes.length, ...previousContent(item.path), executable: item.executable === true, baselineExecutable: observed.baselineModes[item.path] === null ? null : Boolean(observed.baselineModes[item.path] & 0o111), operation: "write", encoding: text ? "utf8" : "base64", content: text ? decoded : item.contentBase64, baselineSha256: observed.baselines[item.path] ?? null };
    });
    for (const previous of Object.keys(observed.baselines)) if (!files.some((item) => item.path === previous)) publicFiles.push({ path: previous, ...previousContent(previous), operation: "delete", encoding: "utf8", content: null, baselineSha256: observed.baselines[previous] });
    return { previewId, revision: plan.revision, profileId: profile.id, host: plan.host, cwd: plan.cwd, files: publicFiles, launch: { supported: !document && FRAMEWORKS.find((item) => item.id === profile.framework).launchSupported, command: ["claude", "codex"].includes(profile.framework) ? profile.framework : null }, conflicts: plan.conflicts };
  };
  const apply = async (previewId, mode) => {
    if (!["sync", "deploy"].includes(mode)) throw fail("Unknown deployment mode");
    const current = load();
    const previous = current.deployments.find((item) => item.previewId === previewId);
    if (previous) {
      if (previous.mode !== mode) throw fail("This preview was already applied in a different mode. Create a new preview", 409);
      return structuredClone(previous);
    }
    const plan = previews.get(previewId);
    if (!plan || plan.expiresAt <= now() || plan.revision !== current.revision) throw fail("Deployment preview expired or the library changed. Preview again", 409);
    if (plan.instructionOnly && mode !== "sync") throw fail("Instruction previews only support sync");
    if (plan.conflicts.length) throw fail("Resolve preview conflicts before applying", 409);
    if (mode === "deploy" && !["claude", "codex"].includes(plan.framework)) throw fail("This framework supports synchronization only");
    previews.delete(previewId);
    const deployment = { id: crypto.randomUUID(), previewId, profileId: plan.profileId, host: plan.host, cwd: plan.cwd, mode, status: "applying", createdAt: now(), revision: plan.revision };
    persist({ ...current, deployments: [...current.deployments, deployment].slice(-200) });
    try {
      const result = await target(plan.host, { ...plan, operation: mode, command: plan.framework, session: `pzza-agent-${crypto.randomUUID()}` });
      if (result.backupPath) deployment.backupPath = result.backupPath;
      if (result.ok === false) throw fail(result.error, result.status || 500);
      deployment.status = mode === "deploy" ? "launched" : "synced";
      if (result.session) deployment.session = result.session;
    } catch (error) {
      deployment.status = "failed";
      deployment.error = error.status ? error.message : "Target deployment failed. Check files before retrying";
    }
    const latest = load();
    persist({ ...latest, deployments: latest.deployments.map((item) => item.id === deployment.id ? deployment : item) });
    return structuredClone(deployment);
  };
  const importSkill = async (input) => {
    if (!keys(input, ["revision", "sourceUrl", "subpath", "ref"]) || input.revision !== load().revision) throw fail("Agent library changed. Reload before importing", 409);
    const imported = await inspectSkill({ sourceUrl: input.sourceUrl, subpath: input.subpath, ...(input.ref ? { ref: input.ref } : {}) });
    if (load().revision !== input.revision) throw fail("Agent library changed during import. Retry from the new revision", 409);
    const { deployments, ...library } = load();
    return save({ ...library, skills: [...library.skills, { id: crypto.randomUUID(), ...imported }] });
  };
  return { state, summary, item, update, save, preview, apply, importSkill, discover, readInstruction };
}

async function body(req) {
  if (!String(req.headers["content-type"] || "").startsWith("application/json")) throw fail("JSON content type is required", 415);
  if (Number(req.headers["content-length"] || 0) > LIMIT) { req.resume(); throw fail("Agent library request exceeds the size limit", 413); }
  const chunks = [];
  let bytes = 0;
  const timer = setTimeout(() => req.destroy(), 10_000);
  try {
    for await (const chunk of req) { bytes += chunk.length; if (bytes > LIMIT) throw fail("Agent library request exceeds the size limit", 413); chunks.push(chunk); }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw fail("Invalid agent library JSON"); }
  } finally { clearTimeout(timer); }
}
export function createAgentsHubRouter(hub, respond) {
  return async (req, res, url) => {
    if (!url.pathname.startsWith("/agents-hub/")) return false;
    try {
      if (url.pathname === "/agents-hub/state" && req.method === "GET") respond(res, 200, hub.state());
      else if (url.pathname === "/agents-hub/summary" && req.method === "GET") respond(res, 200, hub.summary());
      else if (req.method === "POST") {
        const input = await body(req);
        if (url.pathname === "/agents-hub/item") respond(res, 200, hub.item(input));
        else if (url.pathname === "/agents-hub/update") respond(res, 200, hub.update(input));
        else if (url.pathname === "/agents-hub/save") respond(res, 200, hub.save(input));
        else if (url.pathname === "/agents-hub/discover") respond(res, 200, await hub.discover(input));
        else if (url.pathname === "/agents-hub/read-instruction") respond(res, 200, await hub.readInstruction(input));
        else if (url.pathname === "/agents-hub/preview") respond(res, 200, await hub.preview(input));
        else if (url.pathname === "/agents-hub/import-skill") respond(res, 200, await hub.importSkill(input));
        else if (["/agents-hub/sync", "/agents-hub/deploy"].includes(url.pathname) && keys(input, ["previewId"]) && typeof input.previewId === "string") respond(res, 200, await hub.apply(input.previewId, url.pathname.endsWith("/sync") ? "sync" : "deploy"));
        else throw fail("Unknown agent library endpoint", 404);
      } else throw fail("Unknown agent library endpoint", 404);
    } catch (error) { respond(res, error.status || 500, { error: error.status ? error.message : "Agent library operation failed" }); }
    return true;
  };
}
