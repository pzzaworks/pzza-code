import { createHash } from "node:crypto";

const MAX_FILES = 100;
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const SHA = /^[a-f0-9]{40}$/;
const BLOB_CONCURRENCY = 4;
const CACHE_BYTES = 32 * 1024 * 1024;
const caches = new WeakMap();
export const skillImportError = (message, status = 400, code = "INVALID_SKILL_SOURCE") => Object.assign(new Error(message), { status, code });

function blobCache(fetcher) {
  let cache = caches.get(fetcher);
  if (!cache) { cache = { entries: new Map(), bytes: 0 }; caches.set(fetcher, cache); }
  return {
    get(sha) {
      const bytes = cache.entries.get(sha);
      if (bytes) { cache.entries.delete(sha); cache.entries.set(sha, bytes); }
      return bytes;
    },
    set(sha, bytes) {
      if (cache.entries.has(sha)) return;
      while (cache.bytes + bytes.length > CACHE_BYTES || cache.entries.size >= 256) {
        const oldest = cache.entries.keys().next().value;
        cache.bytes -= cache.entries.get(oldest).length;
        cache.entries.delete(oldest);
      }
      cache.entries.set(sha, bytes); cache.bytes += bytes.length;
    },
  };
}
const SENSITIVE = /^(?:\.env(?:\..*)?|\.git|\.ssh|\.aws|\.npmrc|\.netrc|\.pypirc|credentials(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|p12|pfx|key))$/i;

function safePath(value, allowEmpty = false) {
  if (typeof value !== "string" || (!value && !allowEmpty) || value.length > 1024 || /[\\\x00-\x1f\x7f]/.test(value)) throw skillImportError("Skill paths must be relative and contain no control characters.");
  if (!value && allowEmpty) return [];
  const parts = value.split("/");
  if (parts.length > 16 || parts.some(part => !part || part === "." || part === ".." || part.includes(":") || SENSITIVE.test(part))) throw skillImportError("Skill path contains an unsafe or sensitive filename.");
  return parts;
}

function repositoryUrl(value) {
  if (typeof value !== "string") throw skillImportError("Provide a public GitHub repository URL.");
  let url;
  try { url = new URL(value); } catch { throw skillImportError("Provide a public GitHub repository URL."); }
  if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port || url.username || url.password || url.search || url.hash) throw skillImportError("Only public https://github.com/owner/repository URLs are supported.");
  const match = /^\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]{1,100})\/?$/.exec(url.pathname);
  if (!match || match[2] === "." || match[2] === "..") throw skillImportError("Use the repository URL and provide the skill folder separately.");
  const repo = match[2].replace(/\.git$/i, "");
  if (!repo) throw skillImportError("Repository name is required.");
  return { owner: match[1].toLowerCase(), repo: repo.toLowerCase(), canonical: `https://github.com/${match[1].toLowerCase()}/${repo.toLowerCase()}` };
}

export function skillSourceIdentity(sourceUrl, subpath) {
  const { canonical } = repositoryUrl(sourceUrl);
  safePath(subpath, true);
  return { sourceUrl: canonical, subpath };
}

async function boundedBytes(response, limit) {
  const declared = Number(response.headers.get("content-length"));
  if (declared > limit) throw skillImportError("GitHub response exceeds the import size limit.");
  if (!response.body) throw skillImportError("GitHub returned an empty response.");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw skillImportError("GitHub response exceeds the import size limit.");
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Download an inert, complete skill directory pinned to one public repository commit. */
export async function inspectSkillSource({ sourceUrl, subpath = "", ref } = {}, deps = {}) {
  const { owner, repo, canonical } = repositoryUrl(sourceUrl);
  const directory = safePath(subpath, true);
  if (ref !== undefined && (typeof ref !== "string" || !ref || ref.length > 255 || /[\x00-\x20\x7f]/.test(ref))) throw skillImportError("Provide a valid branch, tag or commit reference.");
  const fetcher = deps.fetch ?? globalThis.fetch;
  const cache = blobCache(fetcher);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(skillImportError("Skill import timed out. Retry when GitHub is reachable.", 504, "IMPORT_TIMEOUT")), 55000);
  timer.unref();
  const request = async (suffix, limit = 4 * 1024 * 1024) => {
    const signal = AbortSignal.any([deadline.signal, AbortSignal.timeout(15000), ...(deps.signal ? [deps.signal] : [])]);
    const response = await fetcher(`https://api.github.com/repos/${owner}/${repo}${suffix ? `/${suffix}` : ""}`, {
      redirect: "error", signal,
      headers: { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "PzzaCode-Skill-Import" },
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status === 403 || response.status === 429) throw skillImportError("GitHub denied the request or its rate limit was reached. Wait before retrying and check the public source.", 429, "SOURCE_RATE_LIMIT");
      if (response.status === 404) throw skillImportError("The public repository or reference was not found. Check the source URL and branch.", 404, "SOURCE_NOT_FOUND");
      throw skillImportError("GitHub could not provide the public skill source. Retry later.", 502, "SOURCE_UNAVAILABLE");
    }
    return JSON.parse((await boundedBytes(response, limit)).toString("utf8"));
  };
  const tree = async (sha, recursive = false) => {
    if (!SHA.test(sha)) throw skillImportError("GitHub returned an invalid tree identity.");
    const value = await request(`git/trees/${sha}${recursive ? "?recursive=1" : ""}`);
    if (value.truncated || !Array.isArray(value.tree)) throw skillImportError("GitHub returned an incomplete skill directory. Choose a smaller directory.");
    return value.tree;
  };
  try {
    const metadata = await request("");
    if (metadata.private !== false) throw skillImportError("Only public repositories can be imported.");
    const revision = ref ?? metadata.default_branch;
    if (typeof revision !== "string" || !revision) throw skillImportError("The repository has no default branch.");
    const resolved = await request(`commits/${encodeURIComponent(revision)}`);
    if (!SHA.test(resolved.sha) || !SHA.test(resolved.commit?.tree?.sha)) throw skillImportError("GitHub could not resolve an immutable commit.");
    let selectedTree = resolved.commit.tree.sha;
    const notices = [];
    const ancestors = [];
    for (const part of directory) {
      const entries = await tree(selectedTree);
      for (const notice of entries) {
        if (/^(?:licen[cs]e|notice|copying)(?:[._-].*)?$/i.test(notice.path)) {
          notices.push({ ...notice, sourcePath: [...ancestors, notice.path].join("/"), path: ["_source-notices", ...ancestors, notice.path].join("/") });
        }
      }
      const entry = entries.find(item => item.path === part);
      if (!entry || entry.type !== "tree" || entry.mode !== "040000") throw skillImportError("The selected skill folder does not exist at this commit.");
      selectedTree = entry.sha;
      ancestors.push(part);
    }
    const entries = [...(await tree(selectedTree, true)).map(entry => ({ ...entry, sourcePath: [...directory, entry.path].join("/") })), ...notices];
    const files = [];
    const paths = new Set();
    let total = 0;
    for (const entry of entries) {
      safePath(entry.path);
      safePath(entry.sourcePath);
      const normalized = entry.path.normalize("NFC").toLowerCase();
      if (paths.has(normalized)) throw skillImportError("Skill paths collide on a case-insensitive filesystem.");
      paths.add(normalized);
      if (entry.type === "tree" && entry.mode === "040000") continue;
      if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) throw skillImportError("Skills containing symlinks or submodules cannot be imported.");
      if (!SHA.test(entry.sha) || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_FILE_BYTES) throw skillImportError("A skill file exceeds the 5 MiB limit or has invalid metadata.");
      total += entry.size;
      if (files.length >= MAX_FILES || total > MAX_BYTES) throw skillImportError("A skill bundle may contain at most 100 files and 20 MiB.");
      files.push(entry);
    }
    const skill = files.find(entry => entry.path === "SKILL.md");
    if (!skill || skill.size > 1024 * 1024) throw skillImportError("The selected directory needs a SKILL.md file no larger than 1 MiB.");
    const pending = new Map();
    const readBlob = (entry) => {
      if (pending.has(entry.sha)) return pending.get(entry.sha);
      const operation = (async () => {
        deadline.signal.throwIfAborted(); deps.signal?.throwIfAborted();
        const cached = cache.get(entry.sha);
        if (cached) {
          if (cached.length !== entry.size) throw skillImportError("GitHub returned inconsistent skill file metadata.");
          return cached;
        }
        // Raw immutable paths avoid one API quota charge per asset. The tree's Git SHA,
        // not the CDN response, is still the authority for every downloaded byte.
        const rawPath = [owner, repo, resolved.sha, ...entry.sourcePath.split("/")].map(encodeURIComponent).join("/");
        const signal = AbortSignal.any([deadline.signal, AbortSignal.timeout(15000), ...(deps.signal ? [deps.signal] : [])]);
        const response = await fetcher(`https://raw.githubusercontent.com/${rawPath}`, { redirect: "error", signal, headers: { Accept: "application/octet-stream", "User-Agent": "PzzaCode-Skill-Import" } });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          throw skillImportError(response.status === 404 ? "A file is unavailable at the pinned source commit. Check the source and retry." : "Could not download an immutable source file. Check the connection and retry.", response.status === 404 ? 404 : 502, response.status === 404 ? "SOURCE_NOT_FOUND" : "SOURCE_UNAVAILABLE");
        }
        const bytes = await boundedBytes(response, entry.size);
        const hash = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
        if (bytes.length !== entry.size || hash !== entry.sha) throw skillImportError("Skill file content does not match its pinned Git identity.");
        cache.set(entry.sha, bytes);
        return bytes;
      })();
      pending.set(entry.sha, operation);
      return operation;
    };
    // Only verified immutable blobs enter the bounded LRU. Branch metadata is always fetched afresh.
    const bundle = new Array(files.length);
    let cursor = 0;
    let content;
    await Promise.all(Array.from({ length: Math.min(BLOB_CONCURRENCY, files.length) }, async () => {
      for (;;) {
        const index = cursor++;
        if (index >= files.length) return;
        const entry = files[index];
        const bytes = await readBlob(entry);
        if (bytes.length !== entry.size) throw skillImportError("GitHub returned inconsistent skill file metadata.");
        if (entry.path === "SKILL.md") {
          try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw skillImportError("SKILL.md must contain UTF-8 text."); }
          if (!content.trim() || content.includes("\0")) throw skillImportError("SKILL.md must contain non-empty text.");
        }
        bundle[index] = { path: entry.path, contentBase64: bytes.toString("base64"), executable: entry.mode === "100755" };
      }
    }));
    const declared = metadata.license;
    const license = declared && typeof declared.name === "string"
      ? `Repository declared: ${(typeof declared.spdx_id === "string" && declared.spdx_id !== "NOASSERTION" ? declared.spdx_id : declared.name).slice(0, 200)}`
      : undefined;
    deadline.signal.throwIfAborted(); deps.signal?.throwIfAborted();
    return { name: directory.at(-1) ?? repo, content, files: bundle, sourceUrl: canonical, subpath, commit: resolved.sha, ...(license ? { license } : {}) };
  } catch (error) {
    if (deps.signal?.aborted) throw skillImportError("Skill import was cancelled. No library changes were saved.", 499, "IMPORT_CANCELLED");
    if (error?.status) throw error;
    if (deadline.signal.aborted || error?.name === "TimeoutError") throw skillImportError("Skill import timed out. Retry when GitHub is reachable.", 504, "IMPORT_TIMEOUT");
    throw skillImportError("Could not download the public skill source. Check your connection and retry.", 502, "SOURCE_UNAVAILABLE");
  } finally {
    deadline.abort();
    clearTimeout(timer);
  }
}
