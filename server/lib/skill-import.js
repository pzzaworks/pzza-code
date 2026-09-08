import { createHash } from "node:crypto";

const MAX_FILES = 100;
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const SHA = /^[a-f0-9]{40}$/;
const SENSITIVE = /^(?:\.env(?:\..*)?|\.git|\.ssh|\.aws|\.npmrc|\.netrc|\.pypirc|credentials(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|p12|pfx|key))$/i;

function safePath(value, allowEmpty = false) {
  if (typeof value !== "string" || (!value && !allowEmpty) || value.length > 1024 || /[\\\x00-\x1f\x7f]/.test(value)) throw new Error("Skill paths must be relative and contain no control characters.");
  if (!value && allowEmpty) return [];
  const parts = value.split("/");
  if (parts.length > 16 || parts.some(part => !part || part === "." || part === ".." || part.includes(":") || SENSITIVE.test(part))) throw new Error("Skill path contains an unsafe or sensitive filename.");
  return parts;
}

function repositoryUrl(value) {
  if (typeof value !== "string") throw new Error("Provide a public GitHub repository URL.");
  let url;
  try { url = new URL(value); } catch { throw new Error("Provide a public GitHub repository URL."); }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash) throw new Error("Only public https://github.com/owner/repository URLs are supported.");
  const match = /^\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]{1,100})\/?$/.exec(url.pathname);
  if (!match || match[2] === "." || match[2] === "..") throw new Error("Use the repository URL and provide the skill folder separately.");
  const repo = match[2].replace(/\.git$/, "");
  if (!repo) throw new Error("Repository name is required.");
  return { owner: match[1], repo, canonical: `https://github.com/${match[1]}/${repo}` };
}

async function boundedJson(response, limit) {
  const declared = Number(response.headers.get("content-length"));
  if (declared > limit) throw new Error("GitHub response exceeds the import size limit.");
  if (!response.body) throw new Error("GitHub returned an empty response.");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error("GitHub response exceeds the import size limit.");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Download an inert, complete skill directory pinned to one public repository commit. */
export async function inspectSkillSource({ sourceUrl, subpath = "", ref } = {}, deps = {}) {
  const { owner, repo, canonical } = repositoryUrl(sourceUrl);
  const directory = safePath(subpath, true);
  if (ref !== undefined && (typeof ref !== "string" || !ref || ref.length > 255 || /[\x00-\x20\x7f]/.test(ref))) throw new Error("Provide a valid branch, tag or commit reference.");
  const fetcher = deps.fetch ?? globalThis.fetch;
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new Error("Skill import exceeded its one-minute deadline.")), 60000);
  timer.unref();
  const request = async (suffix, limit = 4 * 1024 * 1024) => {
    const signal = AbortSignal.any([deadline.signal, AbortSignal.timeout(15000), ...(deps.signal ? [deps.signal] : [])]);
    const response = await fetcher(`https://api.github.com/repos/${owner}/${repo}${suffix ? `/${suffix}` : ""}`, {
      redirect: "error", signal,
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "PzzaCode-Skill-Import" },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new Error(response.status === 403 || response.status === 429 ? "GitHub rate limit reached. Try importing later." : `GitHub could not provide the public skill source (${response.status}).`);
    }
    return boundedJson(response, limit);
  };
  const tree = async (sha, recursive = false) => {
    if (!SHA.test(sha)) throw new Error("GitHub returned an invalid tree identity.");
    const value = await request(`git/trees/${sha}${recursive ? "?recursive=1" : ""}`);
    if (value.truncated || !Array.isArray(value.tree)) throw new Error("GitHub returned an incomplete skill directory. Choose a smaller directory.");
    return value.tree;
  };
  try {
    const metadata = await request("");
    if (metadata.private !== false) throw new Error("Only public repositories can be imported.");
    const revision = ref ?? metadata.default_branch;
    if (typeof revision !== "string" || !revision) throw new Error("The repository has no default branch.");
    const resolved = await request(`commits/${encodeURIComponent(revision)}`);
    if (!SHA.test(resolved.sha) || !SHA.test(resolved.commit?.tree?.sha)) throw new Error("GitHub could not resolve an immutable commit.");
    let selectedTree = resolved.commit.tree.sha;
    const notices = [];
    const ancestors = [];
    for (const part of directory) {
      const entries = await tree(selectedTree);
      for (const notice of entries) {
        if (/^(?:licen[cs]e|notice|copying)(?:[._-].*)?$/i.test(notice.path)) {
          notices.push({ ...notice, path: ["_source-notices", ...ancestors, notice.path].join("/") });
        }
      }
      const entry = entries.find(item => item.path === part);
      if (!entry || entry.type !== "tree" || entry.mode !== "040000") throw new Error("The selected skill folder does not exist at this commit.");
      selectedTree = entry.sha;
      ancestors.push(part);
    }
    const entries = [...await tree(selectedTree, true), ...notices];
    const files = [];
    const paths = new Set();
    let total = 0;
    for (const entry of entries) {
      safePath(entry.path);
      const normalized = entry.path.normalize("NFC").toLowerCase();
      if (paths.has(normalized)) throw new Error("Skill paths collide on a case-insensitive filesystem.");
      paths.add(normalized);
      if (entry.type === "tree" && entry.mode === "040000") continue;
      if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) throw new Error("Skills containing symlinks or submodules cannot be imported.");
      if (!SHA.test(entry.sha) || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_FILE_BYTES) throw new Error("A skill file exceeds the 5 MiB limit or has invalid metadata.");
      total += entry.size;
      if (files.length >= MAX_FILES || total > MAX_BYTES) throw new Error("A skill bundle may contain at most 100 files and 20 MiB.");
      files.push(entry);
    }
    const skill = files.find(entry => entry.path === "SKILL.md");
    if (!skill || skill.size > 1024 * 1024) throw new Error("The selected directory needs a SKILL.md file no larger than 1 MiB.");
    // Download sequentially: memory and request concurrency remain bounded even for asset-heavy skills.
    const bundle = [];
    let content;
    for (const entry of files) {
      const blob = await request(`git/blobs/${entry.sha}`, Math.ceil(MAX_FILE_BYTES * 4 / 3) + 1024 * 1024);
      if (blob.encoding !== "base64" || typeof blob.content !== "string" || blob.size !== entry.size || blob.sha !== entry.sha) throw new Error("GitHub returned inconsistent skill file metadata.");
      const encoded = blob.content.replace(/[\r\n]/g, "");
      if (/[^A-Za-z0-9+/=]/.test(encoded) || encoded.length % 4 !== 0) throw new Error("GitHub returned malformed file content.");
      const bytes = Buffer.from(encoded, "base64");
      const hash = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
      if (bytes.toString("base64") !== encoded || bytes.length !== entry.size || hash !== entry.sha) throw new Error("Skill file content does not match its pinned Git identity.");
      if (entry.path === "SKILL.md") {
        try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new Error("SKILL.md must contain UTF-8 text."); }
        if (!content.trim() || content.includes("\0")) throw new Error("SKILL.md must contain non-empty text.");
      }
      bundle.push({ path: entry.path, contentBase64: bytes.toString("base64"), executable: entry.mode === "100755" });
    }
    const declared = metadata.license;
    const license = declared && typeof declared.name === "string"
      ? `Repository declared: ${(typeof declared.spdx_id === "string" && declared.spdx_id !== "NOASSERTION" ? declared.spdx_id : declared.name).slice(0, 200)}`
      : undefined;
    return { name: directory.at(-1) ?? repo, content, files: bundle, sourceUrl: canonical, commit: resolved.sha, ...(license ? { license } : {}) };
  } finally {
    clearTimeout(timer);
  }
}
