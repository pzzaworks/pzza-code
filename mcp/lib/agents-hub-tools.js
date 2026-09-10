import { localGet, localPost } from "./agent.js";

const text = { type: "string" };
const id = { type: "string", pattern: "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$" };
const framework = { type: "string", enum: ["claude", "codex", "cursor", "windsurf", "zed"] };
const document = { type: "object", additionalProperties: false, required: ["id", "name", "framework", "content"], properties: { id, name: text, framework, content: text } };
const asset = { type: "object", additionalProperties: false, required: ["path", "contentBase64"], properties: { path: text, contentBase64: text, executable: { type: "boolean" } } };
const skill = { type: "object", additionalProperties: false, required: ["id", "name", "content"], properties: { id, name: text, content: text, sourceUrl: text, subpath: text, license: text, commit: text, files: { type: "array", maxItems: 100, items: asset } } };
const profile = { type: "object", additionalProperties: false, required: ["id", "name", "framework", "systemPrompt", "instructionIds", "skillIds"], properties: { id, name: text, framework, systemPrompt: { type: "string", description: "Additional project guidance; does not override the agent's actual system policy" }, instructionIds: { type: "array", uniqueItems: true, items: id }, skillIds: { type: "array", uniqueItems: true, items: id } } };
const tool = (name, description, endpoint, properties, required, readOnly = false) => ({
  name, description,
  inputSchema: { type: "object", properties, required, additionalProperties: false },
  annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: true },
  run: async (args) => {
    if (endpoint === "state") return localGet("/agents-hub/summary");
    const result = await localPost(`/agents-hub/${endpoint}`, args);
    if (endpoint === "save") return localGet("/agents-hub/summary");
    if (endpoint === "preview") return { ...result, files: result.files.map((file) => {
      const { content, previousContent, ...metadata } = file;
      return { ...metadata, ...(file.encoding === "utf8" ? { content } : {}), ...(file.previousEncoding === "utf8" ? { previousContent } : {}) };
    }) };
    return result;
  },
});
export const AGENTS_HUB_TOOLS = [
  tool("agents_hub_state", "Read bounded metadata for this device's revisioned agent library, including skill asset names and sizes. Use agents_hub_get for one item's content and agents_hub_update to edit without resending bundles.", "state", {}, [], true),
  tool("agents_hub_get", "Read one instruction, skill or profile. Skill assets are listed as metadata; use agents_hub_update to preserve their full stored contents when editing SKILL.md.", "item", { kind: { type: "string", enum: ["document", "skill", "profile"] }, id }, ["kind", "id"], true),
  tool("agents_hub_update", "Merge one library item against the current revision. Omitted skill files remain intact; an explicit files array replaces the bundle. Pass only fields being edited, not the asset metadata returned by agents_hub_get.", "update", {
    revision: { type: "integer", minimum: 0 }, kind: { type: "string", enum: ["document", "skill", "profile"] }, detachReferences: { type: "boolean", description: "Explicitly detach incompatible profile references after reviewing the impact of a document framework change" },
    item: { type: "object", additionalProperties: false, required: ["id"], properties: { id, name: text, framework, content: text, systemPrompt: text, instructionIds: { type: "array", items: id }, skillIds: { type: "array", items: id }, sourceUrl: text, subpath: text, license: text, commit: text, files: { type: "array", maxItems: 100, items: asset } } },
  }, ["revision", "kind", "item"]),
  tool("agents_hub_remove", "Atomically remove one saved library item against its current revision. Referenced documents and skills require explicit detachReferences after reviewing affected profiles. Existing deployed files are unchanged until a fresh reviewed sync.", "remove", { revision: { type: "integer", minimum: 0 }, kind: { type: "string", enum: ["document", "skill", "profile"] }, id, detachReferences: { type: "boolean", default: false } }, ["revision", "kind", "id"]),
  tool("agents_hub_asset", "Read one bounded page of an imported source file for script, reference or license review. Binary assets stay metadata-only. Nothing executes; pass the returned nextOffset for the next page and keep the revision fixed.", "asset", { revision: { type: "integer", minimum: 0 }, id, path: text, offset: { type: "integer", minimum: 0 }, length: { type: "integer", minimum: 4, maximum: 65536, default: 16384 } }, ["revision", "id", "path"], true),
  tool("agents_hub_save", "Save the whole local agent library only against its current revision. Preserve existing entries and full skill assets unless explicitly changing them. Never include secrets. Conflicts require reloading, not blind overwrites.", "save", {
    revision: { type: "integer", minimum: 0 }, documents: { type: "array", maxItems: 100, items: document }, skills: { type: "array", maxItems: 100, items: skill }, profiles: { type: "array", maxItems: 100, items: profile },
  }, ["revision", "documents", "skills", "profiles"]),
  tool("agents_hub_preview", "Preview exact profile files for an explicit device and project directory. Empty host means this device. Does not write target files or launch an agent. Resolve ownership or existing-file conflicts before applying.", "preview", { profileId: id, host: { type: "string", description: "Explicit trusted SSH alias, or empty string for this device" }, cwd: { type: "string", description: "Absolute existing project directory below the target user's home" }, adoptExisting: { type: "boolean", default: false, description: "Explicitly preview replacement of existing instruction and skill files, retaining private backups. Review previous and new contents before apply. Does not override another profile's ownership." } }, ["profileId", "host", "cwd"], true),
  tool("agents_hub_sync", "Apply a reviewed preview without launching an agent. Fails if target files or library revision changed. A project directory belongs to one profile to prevent instruction contamination.", "sync", { previewId: text }, ["previewId"]),
  tool("agents_hub_deploy", "Apply a reviewed preview and launch a unique tmux session using an already installed Claude or Codex CLI. This executes the selected agent as the target user. Other frameworks support synchronization only. Never installs tools or bypasses permission prompts.", "deploy", { previewId: text }, ["previewId"]),
  tool("agents_hub_import_skill", "Import a complete public GitHub skill directory and its assets pinned to a verified commit. Repeated repository/folder imports return the existing item without overwriting it. After reviewing replacement impact, pass updateId to replace that exact skill while keeping its ID and profile links. Source is never executed; review scripts and license before deployment.", "import-skill", { revision: { type: "integer", minimum: 0 }, sourceUrl: text, subpath: { type: "string", description: "Repository-relative directory containing SKILL.md" }, updateId: { ...id, description: "Explicit existing skill ID to update from this same repository and folder" }, ref: { type: "string", description: "Optional branch, tag or commit to resolve to an immutable commit" } }, ["revision", "sourceUrl", "subpath"]),
];
