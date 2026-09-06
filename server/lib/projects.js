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

// Strip embedded credentials ("https://user:token@host/...") from anything that
// leaves the agent: origin URLs in the scan and git output quoted in results.
export function redact(text) {
  // Any http(s) userinfo is a token; for other schemes only user:password is.
  return String(text ?? "")
    .replace(/(https?:\/\/)[^\s/@]+@/g, "$1***@")
    .replace(/(\w+:\/\/)[^\s/@:]+:[^\s/@]*@/g, "$1***@");
}

// The root must stay inside $HOME: "~", "~/x" or an absolute path, no "..".
// Returns the POSIX shell expression that evaluates to the root on the device.
export function rootExpr(root) {
  const r = String(root || "").trim().replace(/\/+$/, "");
  if (!r || r.split("/").includes("..") || /['"\\$`]/.test(r)) return null;
  if (r === "~") return '"$HOME"';
  if (r.startsWith("~/")) return `"$HOME"/${shQuote(r.slice(2))}`;
  if (r.startsWith("/")) return shQuote(r);
  return null;
}

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
    `h=$(cd ~ && pwd -P); root=$(cd ${rootE} 2>/dev/null && pwd -P) || { echo PZZA_NOROOT; exit 0; }; ` +
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
  `pz_tail() { printf '%s' "$1" | tail -n 3 | tr '\\n' ' '; }; ` +
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
async function copyEnv(rootE, src, dst, rel, name) {
  const file = `${shQuote(rel)}/${shQuote(name)}`;
  const read = await runOn(src, prelude(rootE) + `cd "$root" && cat ${file}`, SCAN_TIMEOUT_MS);
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
  const ok = scan.devices.filter((d) => !d.error);
  const hasRepo = (d, rel) =>
    d.repos.some((r) => r.rel === rel) ||
    (gitResults.get(d.id) || []).some((r) => r.rel === rel && r.status === "cloned");
  const jobs = [];
  const seen = new Set();
  for (const d of ok) {
    for (const r of d.repos) {
      if (!repoOn(opts, r.rel) || !repoEnvOn(opts, r.rel)) continue;
      for (const e of r.envs) {
        const key = `${r.rel}\0${e.name}`;
        if (seen.has(key) || envExcluded(opts, e.name)) continue;
        seen.add(key);
        let best = null;
        for (const o of ok) {
          const oe = o.repos.find((x) => x.rel === r.rel)?.envs.find((x) => x.name === e.name);
          if (oe && (!best || oe.mtime > best.env.mtime)) best = { device: o, env: oe };
        }
        if (!best) continue;
        for (const o of ok) {
          if (o.id === best.device.id || !hasRepo(o, r.rel)) continue;
          const oe = o.repos.find((x) => x.rel === r.rel)?.envs.find((x) => x.name === e.name);
          if (oe && oe.hash === best.env.hash) continue;
          jobs.push({ target: o, rel: r.rel, name: e.name, from: best.device });
        }
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
  for (const line of stdout.split("\n")) {
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
  return repos;
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

// Scan every device in parallel: { root, devices: [{ id, name, host, error, repos }] }.
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
      const repos = error ? [] : parseScan(res.stdout);
      if (strip) for (const r of repos) if (r.origin) r.origin = redact(r.origin);
      return { ...d, error, repos };
    }),
  );
  return { root: String(body.root), devices: results };
}

// Decide what each device has to do for every repo in the union. A repo only
// travels between devices when some device knows its origin URL.
export function planSync(scan, opts = normalizeOptions()) {
  const origins = new Map(); // rel -> origin url
  for (const d of scan.devices) {
    for (const r of d.repos) if (r.origin && REMOTE_URL.test(r.origin) && !origins.has(r.rel)) origins.set(r.rel, r.origin);
  }
  return scan.devices.map((d) => {
    if (d.error) return { ...d, plan: [], skipped: [] };
    const have = new Map(d.repos.map((r) => [r.rel, r]));
    const plan = [];
    const skipped = [];
    for (const [rel, origin] of origins) {
      const local = have.get(rel);
      if (!repoOn(opts, rel)) {
        if (local) skipped.push({ rel, status: "skipped", detail: "sync is off for this project" });
      } else if (!local) {
        if (opts.cloneMissing) plan.push({ rel, action: "clone", origin });
        else skipped.push({ rel, status: "skipped", detail: "missing here, cloning is off" });
      } else plan.push({ rel, action: "update", origin });
    }
    for (const r of d.repos) {
      if (!origins.has(r.rel)) skipped.push({ rel: r.rel, status: "skipped", detail: r.origin ? "unsupported origin url" : "no origin remote" });
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
        results.push({ rel, status, detail: redact(detail || "") });
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
    const err = await copyEnv(rootE, job.from.host, job.target.host, job.rel, job.name);
    target.envs.push({ rel: job.rel, name: job.name, from: job.from.name, status: err ? "failed" : "copied", detail: redact(err || "") });
  }
  return { root: scan.root, devices };
}
