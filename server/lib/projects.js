// Project sync across devices. A "project" is a git repository under the
// projects root (the same $HOME-relative folder on every device, e.g.
// ~/Projects). Sync takes the union of every device's repos: a repo missing on
// a device is cloned there from the origin URL seen elsewhere; a repo that is
// present switches to origin's default branch and fast-forwards it. Modified
// tracked files are stashed first (git stash pop brings them back); untracked
// files stay where they are. Afterwards every .env / .env.* file is copied from
// the device holding the newest copy to every device where it is missing or
// differs, so secrets follow the project without ever passing through git.
//
// Every device is driven with ONE shell script per phase (scan, then sync) so
// a sync costs two ssh round-trips per device plus one per env file moved.
import { execFile, spawn } from "node:child_process";
import { DEVBOX, IS_CLIENT } from "./config.js";
import { SSH_TOKEN, shQuote } from "./shell.js";

// How deep below the root we look for repos (root/Org/Group/repo is depth 3).
const SCAN_DEPTH = 4;
const SCAN_TIMEOUT_MS = 60_000;
const SYNC_TIMEOUT_MS = 15 * 60_000;
const MAX_OUTPUT = 8 * 1024 * 1024;

// Where clones may come from: ssh scp-style, ssh://, https:// and git://. The
// URL is quoted before it hits the shell anyway; this guards against a URL that
// git would parse as an option ("-oProxyCommand=...") or a local path.
const REMOTE_URL = /^(?:[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^\s'"]+|(?:ssh|https?|git):\/\/[^\s'"]+)$/;

// Identity of a repo across devices: its origin, normalized so that
// git@github.com:org/repo.git, ssh://git@github.com/org/repo and
// https://github.com/org/repo.git all collapse to "github.com/org/repo".
export function originKey(url) {
  if (!url) return null;
  let u = String(url).trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  const scp = u.match(/^(?:[^@\s]+@)?([^:/\s]+):(.+)$/);
  if (scp && !/^\w+:\/\//.test(u)) u = `${scp[1]}/${scp[2]}`;
  else u = u.replace(/^\w+:\/\/(?:[^@/]+@)?/, "");
  return u.toLowerCase();
}

// Group every device's repos into projects. Two repos are the same project
// when they share an origin (normalized) OR the same path below the root:
// the path rule catches a remote that moved (berkekiran/x -> pzzaworks/x)
// while the origin rule catches the same repo kept at different paths.
// Returns [{ rel, origin, members: Map(deviceId -> repo) }], rel/origin being
// the first clonable ones seen (device order = client order).
export function groupProjects(scan) {
  const groups = []; // { keys: Set, members: Map }
  const byKey = new Map(); // key -> group
  for (const d of scan.devices) {
    for (const r of d.repos) {
      const keys = [`path:${r.rel}`];
      const ok = originKey(r.origin);
      if (ok) keys.push(`origin:${ok}`);
      const hits = [...new Set(keys.map((k) => byKey.get(k)).filter(Boolean))];
      let g = hits[0];
      if (!g) groups.push((g = { keys: new Set(), members: new Map() }));
      // Merge any other groups these keys touch into g.
      for (const other of hits.slice(1)) {
        for (const [id, rep] of other.members) if (!g.members.has(id)) g.members.set(id, rep);
        for (const k of other.keys) g.keys.add(k);
        groups.splice(groups.indexOf(other), 1);
      }
      for (const k of keys) {
        g.keys.add(k);
        byKey.set(k, g);
      }
      if (!g.members.has(d.id)) g.members.set(d.id, r);
    }
  }
  return groups.map((g) => {
    const members = [...g.members.values()];
    const first = members.find((r) => r.origin && REMOTE_URL.test(r.origin));
    return { rel: (first ?? members[0]).rel, origin: first ? first.origin : null, members: g.members };
  });
}

// Turn git's failure text into one line that says what to do about it; the
// raw tail follows for anything the table does not know.
const GIT_HINTS = [
  [/Not possible to fast-forward/i, "diverged from origin: local commits are not on origin, push or rebase first"],
  [/refusing to merge unrelated histories/i, "origin has an unrelated history: a different repo answers behind this remote"],
  [/Repository not found|Could not read from remote|does not appear to be a git repository/i, "origin not found: deleted, renamed or no access from this device"],
  [/needs merge|not uptodate\. Cannot merge|You have unmerged paths|unmerged files/i, "an unfinished merge or rebase is in progress, finish or abort it first"],
  [/would be overwritten by checkout/i, "untracked files here would be overwritten by the checkout"],
  [/Permission denied \(publickey\)|Authentication failed/i, "no git access from this device: ssh key or token missing"],
  [/Could not resolve host|Network is unreachable|Connection timed out/i, "no network access to the remote from this device"],
];
export function explainGit(detail) {
  const text = String(detail || "");
  for (const [re, hint] of GIT_HINTS) if (re.test(text)) return `${hint} (${text.trim()})`;
  return text;
}

// Strip embedded credentials ("https://user:token@host/...") from anything that
// leaves the agent: origin URLs in the scan and git output quoted in results.
export function redact(text) {
  // Any http(s) userinfo is a token; for other schemes only user:password is.
  return String(text ?? "")
    .replace(/(https?:\/\/)[^\s/@]+@/g, "$1***@")
    .replace(/(\w+:\/\/)[^\s/@:]+:[^\s/@]*@/g, "$1***@");
}

// The root must stay inside $HOME: "~", "~/x" or an absolute path, no ".." and
// no shell or glob metacharacters. Returns the shell call that resolves it on
// the device: `pz_root BASE SEG...`, where each segment is matched exactly
// first and case-insensitively second, so ~/Projects on the Mac finds
// ~/projects on a Linux box.
export function rootExpr(root) {
  const r = String(root || "").trim().replace(/\/+$/, "");
  if (!r || r.split("/").includes("..") || /['"\\$`*?[\]]/.test(r)) return null;
  let base;
  let rest;
  if (r === "~" || r.startsWith("~/")) {
    base = '"$h"';
    rest = r.slice(1);
  } else if (r.startsWith("/")) {
    base = "/";
    rest = r;
  } else return null;
  const segs = rest.split("/").filter(Boolean).map(shQuote);
  return `pz_root ${base}${segs.length ? " " + segs.join(" ") : ""}`;
}

// Shell function behind rootExpr: walks BASE/SEG/SEG..., taking an exact
// directory match when there is one and otherwise the first case-insensitive
// match, and prints the resolved path (fails if a segment matches nothing).
const ROOT_FUNC =
  `pz_root() { cur=$1; shift; for seg in "$@"; do ` +
  `if [ -d "$cur/$seg" ]; then cur="$cur/$seg"; ` +
  `else m=$(find "$cur" -mindepth 1 -maxdepth 1 -type d -iname "$seg" 2>/dev/null | head -n 1); [ -n "$m" ] || return 1; cur=$m; fi; done; ` +
  `printf '%s\\n' "$cur"; }; `;

// Run a script on a device: locally for "" (or via the configured devbox when
// this agent is a receiver), else over ssh.
function runOn(host, script, timeout) {
  return new Promise((resolve) => {
    const cb = (err, stdout, stderr) =>
      resolve({
        ok: !err,
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
        error: err ? err.message : null,
      });
    const opts = { timeout, maxBuffer: MAX_OUTPUT };
    if (host || IS_CLIENT) {
      const target = host || DEVBOX;
      execFile(
        "ssh",
        ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new", target, script],
        opts,
        cb,
      );
    } else {
      execFile("sh", ["-c", script], opts, cb);
    }
  });
}

// Shell prelude shared by both phases: bounds the root to $HOME and cds into it.
function prelude(rootE) {
  return (
    `h=$(cd ~ && pwd -P); ` +
    ROOT_FUNC +
    `root=$(r=$(${rootE}) && cd "$r" 2>/dev/null && pwd -P) || { echo PZZA_NOROOT; exit 0; }; ` +
    `case "$root" in "$h"|"$h"/*) ;; *) echo PZZA_DENIED; exit 3;; esac; ` +
    `command -v git >/dev/null 2>&1 || { echo PZZA_NOGIT; exit 0; }; `
  );
}

// One line per repo, tab-separated:
//   rel  origin  default  branch  head  modified  untracked  ahead  behind  stash  lastCommitTs  envs
// "-" marks an unknown value. envs is "name:sha256prefix:mtime" triples joined
// by "," for every .env / .env.* file at the repo root: the hash tells whether
// two devices hold the same content, the mtime decides which copy wins.
function scanScript(rootE) {
  return (
    prelude(rootE) +
    `printf 'PZZA_ROOT\\t%s\\n' "$root"; ` +
    `cd "$root" && find . -mindepth 1 -maxdepth ${SCAN_DEPTH} \\( -name node_modules -o -name .git \\) -prune -o -type d -print 2>/dev/null | ` +
    `while IFS= read -r d; do [ -d "$d/.git" ] || continue; ` +
    `rel="\${d#./}"; ` +
    `origin=$(git -C "$d" remote get-url origin 2>/dev/null || echo -); ` +
    `def=$(git -C "$d" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null); def="\${def#origin/}"; [ -n "$def" ] || def=-; ` +
    `br=$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null); [ -n "$br" ] || br=-; ` +
    `head=$(git -C "$d" rev-parse --short HEAD 2>/dev/null); [ -n "$head" ] || head=-; ` +
    `st=$(git -C "$d" status --porcelain 2>/dev/null); ` +
    `mod=$(printf '%s\\n' "$st" | grep -c '^[^?]' 2>/dev/null); unt=$(printf '%s\\n' "$st" | grep -c '^??' 2>/dev/null); ` +
    `ab=$(git -C "$d" rev-list --left-right --count 'HEAD...@{u}' 2>/dev/null | tr '\\t' ' '); [ -n "$ab" ] || ab='- -'; ` +
    `stash=$(git -C "$d" stash list 2>/dev/null | wc -l | tr -d ' '); ` +
    `ts=$(git -C "$d" log -1 --format=%ct 2>/dev/null); [ -n "$ts" ] || ts=0; ` +
    `envs=; for f in "$d"/.env "$d"/.env.*; do [ -f "$f" ] || continue; case "$f" in *.example|*.sample|*.template) continue;; esac; ` +
    `sum=$( (sha256sum "$f" 2>/dev/null || shasum -a 256 "$f" 2>/dev/null) | cut -c1-12); mt=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || echo 0); envs="$envs\${envs:+,}\${f##*/}:$sum:$mt"; done; ` +
    `printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$rel" "$origin" "$def" "$br" "$head" "$mod" "$unt" "$ab" "$stash" "$ts" "$envs"; done`
  );
}

// Every step reports "PZZA_R\t<rel>\t<status>\t<detail>". Statuses: cloned,
// updated, stashed, current, dirty, skipped, failed. The work is two shell functions
// defined once per script so each repo is a one-line call.
const SYNC_FUNCS =
  `pz_r() { printf 'PZZA_R\\t%s\\t%s\\t%s\\n' "$1" "$2" "$3"; }; ` +
  `pz_tail() { printf '%s' "$1" | grep -v '^hint:' | tail -n 3 | tr '\\n' ' '; }; ` +
  `pz_clone() { if mkdir -p "$(dirname "$2")" && out=$(git clone --quiet "$1" "$2" 2>&1); then pz_r "$2" cloned ""; else pz_r "$2" failed "$(pz_tail "$out")"; fi; }; ` +
  // pz_update REL STASH SWITCH: STASH=1 stashes modified tracked files (else a
  // dirty tree is reported and left alone); SWITCH=1 moves to origin's default
  // branch (else the current branch is fast-forwarded in place).
  `pz_update() { d=$1; do_stash=$2; do_switch=$3; ` +
  `if ! out=$(git -C "$d" fetch --quiet --prune origin 2>&1); then pz_r "$d" failed "fetch: $(pz_tail "$out")"; return; fi; ` +
  `git -C "$d" remote set-head origin -a >/dev/null 2>&1; ` +
  `was=$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null); before=$(git -C "$d" rev-parse HEAD 2>/dev/null); stashed=; ` +
  `if [ "$do_switch" = 1 ]; then def=$(git -C "$d" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null); def="\${def#origin/}"; ` +
  `if [ -z "$def" ]; then pz_r "$d" skipped "no default branch on origin"; return; fi; ` +
  `else def=$was; if [ "$def" = HEAD ]; then pz_r "$d" skipped "detached HEAD"; return; fi; ` +
  `git -C "$d" rev-parse --verify --quiet "origin/$def" >/dev/null || { pz_r "$d" skipped "$def has no origin branch"; return; }; fi; ` +
  // Modified tracked files: park them in a stash so the checkout can proceed,
  // or report the tree as dirty and leave it alone when stashing is off.
  `if [ -n "$(git -C "$d" status --porcelain --untracked-files=no 2>/dev/null)" ]; then ` +
  `n=$(git -C "$d" status --porcelain --untracked-files=no 2>/dev/null | wc -l | tr -d ' '); ` +
  `if [ "$do_stash" != 1 ]; then pz_r "$d" dirty "$n uncommitted change(s) on $was, left alone (stash is off)"; return; fi; ` +
  `if out=$(git -C "$d" stash push --quiet -m "pzza-sync $was $(date +%Y-%m-%d_%H:%M)" 2>&1); then stashed="stashed $n change(s) from $was"; ` +
  `else pz_r "$d" failed "stash: $(pz_tail "$out")"; return; fi; fi; ` +
  `if ! out=$(git -C "$d" checkout --quiet "$def" 2>&1 && git -C "$d" merge --ff-only --quiet "origin/$def" 2>&1); then pz_r "$d" failed "$(pz_tail "$out")"; return; fi; ` +
  `after=$(git -C "$d" rev-parse HEAD 2>/dev/null); pulled=; ` +
  `if [ "$before" != "$after" ]; then pulled="+$(git -C "$d" rev-list --count "$before..$after" 2>/dev/null) commits"; fi; ` +
  `if [ -n "$stashed" ]; then pz_r "$d" stashed "$stashed, now on $def\${pulled:+ $pulled} (git stash pop to restore)"; ` +
  `elif [ "$was" != "$def" ]; then pz_r "$d" updated "switched $was -> $def\${pulled:+, $pulled}"; ` +
  `elif [ -n "$pulled" ]; then pz_r "$d" updated "$def $pulled"; ` +
  `else pz_r "$d" current "$def"; fi; }; `;

function syncScript(rootE, plan, opts) {
  const flags = `${opts.stashDirty ? 1 : 0} ${opts.switchToDefault ? 1 : 0}`;
  const steps = plan.map(({ rel, action, origin }) =>
    action === "clone" ? `pz_clone ${shQuote(origin)} ${shQuote(rel)}` : `pz_update ${shQuote(rel)} ${flags}`,
  );
  return prelude(rootE) + `cd "$root"; ` + SYNC_FUNCS + steps.join("; ");
}

// Copy one env file between devices through this agent: read it from the
// source, stream it into the target. Content lives in memory only for the
// duration of the copy and is never logged or persisted here.
async function copyEnv(rootE, src, dst, srcRel, rel, name) {
  const file = `${shQuote(rel)}/${shQuote(name)}`;
  const srcFile = `${shQuote(srcRel)}/${shQuote(name)}`;
  const read = await runOn(src, prelude(rootE) + `cd "$root" && cat ${srcFile}`, SCAN_TIMEOUT_MS);
  if (!read.ok || deviceError(read)) return deviceError(read) || read.stderr.trim() || "read failed";
  // A newest-but-empty file must not wipe a populated copy elsewhere.
  if (read.stdout.trim() === "") return "source file is empty, not copied";
  const script = prelude(rootE) + `cd "$root" && [ -d ${shQuote(rel)} ] && umask 077 && cat > ${file}.pzza-tmp && mv -f ${file}.pzza-tmp ${file}`;
  return new Promise((resolve) => {
    const useSsh = dst || IS_CLIENT;
    const child = useSsh
      ? spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new", dst || DEVBOX, script])
      : spawn("sh", ["-c", script]);
    let err = "";
    child.stderr.on("data", (c) => (err += c));
    child.on("error", (e) => resolve(e.message));
    child.on("close", (code) => resolve(code === 0 ? null : err.trim() || `exit ${code}`));
    child.stdin.end(read.stdout);
  });
}

// For every env file, the device with the newest copy is the source; every
// other device that has (or just got) the repo and lacks that content is a
// target. Returns { deviceId: [{ rel, name, from, status, detail }] }.
export function planEnvSync(scan, gitResults, opts = normalizeOptions()) {
  if (!opts.syncEnvs) return [];
  const ok = new Set(scan.devices.filter((d) => !d.error).map((d) => d.id));
  const jobs = [];
  for (const p of groupProjects(scan)) {
    if (!repoOn(opts, p.rel) || !repoEnvOn(opts, p.rel)) continue;
    // Where the project lives on each device: its member repo, or the path it
    // was just cloned to.
    const where = new Map();
    for (const d of scan.devices) {
      if (!ok.has(d.id)) continue;
      const m = p.members.get(d.id);
      if (m) where.set(d.id, { rel: m.rel, envs: m.envs, device: d });
      else if ((gitResults.get(d.id) || []).some((x) => x.rel === p.rel && x.status === "cloned")) where.set(d.id, { rel: p.rel, envs: [], device: d });
    }
    const names = new Set();
    for (const w of where.values()) for (const e of w.envs) names.add(e.name);
    for (const name of names) {
      if (envExcluded(opts, name)) continue;
      let best = null;
      for (const w of where.values()) {
        const e = w.envs.find((x) => x.name === name);
        if (e && (!best || e.mtime > best.env.mtime)) best = { ...w, env: e };
      }
      if (!best) continue;
      for (const w of where.values()) {
        if (w.device.id === best.device.id) continue;
        const e = w.envs.find((x) => x.name === name);
        if (e && e.hash === best.env.hash) continue;
        jobs.push({ target: w.device, rel: w.rel, srcRel: best.rel, name, from: best.device });
      }
    }
  }
  return jobs;
}

function deviceError(res) {
  const out = res.stdout.trim();
  if (out.startsWith("PZZA_NOROOT")) return "projects root does not exist";
  if (out.startsWith("PZZA_DENIED")) return "projects root is outside home";
  if (out.startsWith("PZZA_NOGIT")) return "git is not installed";
  if (!res.ok) return (res.stderr.trim() || res.error || "command failed").split("\n").slice(-2).join(" ");
  return null;
}

const num = (v) => (v === undefined || v === "-" || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

function parseScan(stdout) {
  const repos = [];
  let root = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("PZZA_ROOT\t")) {
      root = line.slice("PZZA_ROOT\t".length);
      continue;
    }
    if (!line.includes("\t")) continue;
    const [rel, origin, def, branch, head, mod, unt, ab, stash, ts, envs] = line.split("\t");
    if (!rel) continue;
    const [ahead, behind] = String(ab || "- -").split(" ");
    repos.push({
      rel,
      origin: origin && origin !== "-" ? origin : null,
      defaultBranch: def && def !== "-" ? def : null,
      branch: branch && branch !== "-" ? branch : null,
      head: head && head !== "-" ? head : null,
      modified: num(mod) ?? 0,
      untracked: num(unt) ?? 0,
      ahead: num(ahead),
      behind: num(behind),
      stashes: num(stash) ?? 0,
      lastCommitTs: num(ts) ?? 0,
      envs: (envs || "")
        .split(",")
        .filter(Boolean)
        .map((triple) => {
          const j = triple.lastIndexOf(":");
          const i = triple.lastIndexOf(":", j - 1);
          return { name: triple.slice(0, i), hash: triple.slice(i + 1, j), mtime: num(triple.slice(j + 1)) ?? 0 };
        }),
    });
  }
  return { root, repos };
}

// Sync options from the client, with safe defaults. `repos` holds per-repo
// overrides keyed by rel: { enabled, env }. envExclude are glob-ish patterns
// (* wildcard) matched against the env file name.
export function normalizeOptions(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  const bool = (v, d) => (typeof v === "boolean" ? v : d);
  const repos = {};
  if (o.repos && typeof o.repos === "object") {
    for (const [rel, v] of Object.entries(o.repos)) {
      if (typeof rel !== "string" || rel.split("/").includes("..")) continue;
      repos[rel] = { enabled: bool(v?.enabled, true), env: bool(v?.env, true) };
    }
  }
  const envExclude = Array.isArray(o.envExclude)
    ? o.envExclude.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()).slice(0, 50)
    : [];
  return {
    cloneMissing: bool(o.cloneMissing, true),
    switchToDefault: bool(o.switchToDefault, true),
    stashDirty: bool(o.stashDirty, true),
    syncEnvs: bool(o.syncEnvs, true),
    envExclude,
    repos,
  };
}

const repoOn = (opts, rel) => opts.repos[rel]?.enabled !== false;
const repoEnvOn = (opts, rel) => opts.repos[rel]?.env !== false;
const globToRe = (g) => new RegExp("^" + g.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
const envExcluded = (opts, name) => opts.envExclude.some((g) => globToRe(g).test(name));

// Normalize the client's device list: [{ id, name, host }] with host "" = local.
function normalizeDevices(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const d of list) {
    const host = String(d?.host || "");
    if (host && !SSH_TOKEN.test(host)) continue;
    if (seen.has(host)) continue;
    seen.add(host);
    out.push({ id: String(d?.id || host || "local"), name: String(d?.name || host || "This device"), host });
  }
  return out;
}

// Scan every device in parallel: { root, devices: [{ id, name, host, error, root, repos }] }
// where the device root is the path the requested root resolved to there.
// The HTTP route passes `redact` so credentials in origin URLs never reach the
// app; the sync keeps the raw URL because the clone needs it.
export async function scanProjects(body, { redact: strip = false } = {}) {
  const rootE = rootExpr(body.root);
  if (!rootE) return { error: "invalid projects root" };
  const devices = normalizeDevices(body.devices);
  if (devices.length === 0) return { error: "no devices" };
  const results = await Promise.all(
    devices.map(async (d) => {
      const res = await runOn(d.host, scanScript(rootE), SCAN_TIMEOUT_MS);
      const error = deviceError(res);
      const parsed = error ? { root: null, repos: [] } : parseScan(res.stdout);
      if (strip) for (const r of parsed.repos) if (r.origin) r.origin = redact(r.origin);
      return { ...d, error, root: parsed.root, repos: parsed.repos };
    }),
  );
  return { root: String(body.root), devices: results };
}

// Decide what each device has to do for every repo in the union. A repo only
// travels between devices when some device knows its origin URL.
export function planSync(scan, opts = normalizeOptions()) {
  const projects = groupProjects(scan);
  return scan.devices.map((d) => {
    if (d.error) return { ...d, plan: [], skipped: [] };
    const plan = [];
    const skipped = [];
    for (const p of projects) {
      const local = p.members.get(d.id);
      if (!p.origin) {
        if (local) skipped.push({ rel: local.rel, status: "skipped", detail: local.origin ? "unsupported origin url" : "no origin remote" });
        continue;
      }
      const on = repoOn(opts, p.rel) && (!local || repoOn(opts, local.rel));
      if (!on) {
        if (local) skipped.push({ rel: local.rel, status: "skipped", detail: "sync is off for this project" });
      } else if (!local) {
        if (opts.cloneMissing) plan.push({ rel: p.rel, action: "clone", origin: p.origin });
        else skipped.push({ rel: p.rel, status: "skipped", detail: "missing here, cloning is off" });
      } else plan.push({ rel: local.rel, action: "update", origin: p.origin });
    }
    // Stable order so the report reads top-down the same way on every device.
    plan.sort((a, b) => a.rel.localeCompare(b.rel));
    return { ...d, plan, skipped };
  });
}

// Scan, plan and run the sync on every device in parallel: git first (clone /
// stash / checkout / fast-forward), then the env files. Returns
// { root, devices: [{ id, name, host, error, results: [...], envs: [...] }] }.
export async function syncProjects(body) {
  const rootE = rootExpr(body.root);
  if (!rootE) return { error: "invalid projects root" };
  const scan = await scanProjects(body);
  if (scan.error) return scan;
  const opts = normalizeOptions(body.options);
  const planned = planSync(scan, opts);
  const devices = await Promise.all(
    planned.map(async (d) => {
      const base = { id: d.id, name: d.name, host: d.host, envs: [] };
      if (d.error) return { ...base, error: d.error, results: [] };
      if (d.plan.length === 0) return { ...base, error: null, results: d.skipped };
      const res = await runOn(d.host, syncScript(rootE, d.plan, opts), SYNC_TIMEOUT_MS);
      const error = deviceError(res);
      const results = [];
      for (const line of res.stdout.split("\n")) {
        if (!line.startsWith("PZZA_R\t")) continue;
        const [, rel, status, detail] = line.split("\t");
        results.push({ rel, status, detail: status === "failed" ? explainGit(redact(detail || "")) : redact(detail || "") });
      }
      // A step that produced no report line (killed by the timeout, ssh dropped)
      // must not silently vanish from the summary.
      const seen = new Set(results.map((r) => r.rel));
      for (const p of d.plan) if (!seen.has(p.rel)) results.push({ rel: p.rel, status: "failed", detail: error || "no result (timed out?)" });
      results.push(...d.skipped);
      results.sort((a, b) => a.rel.localeCompare(b.rel));
      return { ...base, error: results.length ? null : error, results };
    }),
  );

  const gitResults = new Map(devices.map((d) => [d.id, d.results]));
  const jobs = planEnvSync(scan, gitResults, opts);
  // Copies are sequential: they are few, small, and each holds an ssh session.
  for (const job of jobs) {
    const target = devices.find((d) => d.id === job.target.id);
    if (!target) continue;
    const err = await copyEnv(rootE, job.from.host, job.target.host, job.srcRel, job.rel, job.name);
    target.envs.push({ rel: job.rel, name: job.name, from: job.from.name, status: err ? "failed" : "copied", detail: redact(err || "") });
  }
  return { root: scan.root, devices };
}
