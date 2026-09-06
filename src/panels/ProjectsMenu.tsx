import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronRight, FolderSync, Loader2, RefreshCw, Settings2 } from "lucide-react";
import { useStore } from "../state/store";
import { THIS_MAC, type Device } from "../devices";
import { PathField } from "../ui/PathField";
import {
  DEFAULT_SYNC_OPTIONS,
  listDir,
  scanProjects,
  syncProjects,
  type SyncOptions,
  type ProjectDeviceRef,
  type ProjectRepo,
  type ProjectScan,
  type EnvSyncResult,
  type ProjectSync,
  type ProjectSyncResult,
} from "../serverApi";

// Project sync dashboard. One card per git repo found under the projects root
// on ANY device; inside it one line per device: what is checked out, how far
// from origin, what is uncommitted, and whether the .env files match across
// devices. "Sync all" clones what is missing, stashes local edits, fast-forwards
// every repo to origin's default branch and copies the newest env files around;
// the outcome lands back on the same lines.

const ROOT_KEY = "pzza.projectsRoot";
const DEFAULT_ROOT = "~/Projects";

function loadRoot(): string {
  try {
    return localStorage.getItem(ROOT_KEY) || DEFAULT_ROOT;
  } catch {
    return DEFAULT_ROOT;
  }
}
function saveRoot(v: string): void {
  try {
    localStorage.setItem(ROOT_KEY, v);
  } catch {
    /* ignore */
  }
}

const OPTS_KEY = "pzza.sync.options";
const DEVICES_OFF_KEY = "pzza.sync.devicesOff";

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...(JSON.parse(raw) as T) } : fallback;
  } catch {
    return fallback;
  }
}
function saveJson(key: string, v: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(v));
  } catch {
    /* ignore */
  }
}

function Switch({ on, onToggle, title, small }: { on: boolean; onToggle: () => void; title: string; small?: boolean }) {
  return (
    <button
      type="button"
      className={`switch ${on ? "switch-on" : ""} ${small ? "switch-sm" : ""}`}
      role="switch"
      aria-checked={on}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      <span className="switch-knob" />
    </button>
  );
}

const toRef = (d: Device): ProjectDeviceRef => ({
  id: d.id,
  name: d.name,
  host: d.id === THIS_MAC.id ? "" : d.user ? `${d.user}@${d.host}` : d.host,
});

type Filter = "all" | "attention";

// synced: same hash everywhere the repo exists. differs: hashes disagree.
// partial: some device with the repo lacks the file. single: only one device
// has the repo, so there is nothing to compare against yet.
type EnvState = "synced" | "differs" | "partial" | "single";

interface EnvStatus {
  name: string;
  state: EnvState;
  hashes: Map<string, string>; // deviceId -> hash
}

// Identity of a repo across devices: its origin, normalized so that scp-style,
// ssh:// and https:// spellings of the same remote collapse to one key. Mirrors
// originKey in the agent.
function originKey(url: string | null): string | null {
  if (!url) return null;
  let u = url.trim().replace(/\/+$/, "").replace(/\.git$/i, "");
  const scp = u.match(/^(?:[^@\s]+@)?([^:/\s]+):(.+)$/);
  if (scp && !/^\w+:\/\//.test(u)) u = `${scp[1]}/${scp[2]}`;
  else u = u.replace(/^\w+:\/\/(?:[^@/]+@)?/, "");
  return u.toLowerCase();
}

interface Row {
  rel: string; // display path: where the first device that has it keeps it
  rels: Set<string>; // every path it lives at across devices (for result lookup)
  origin: string | null;
  origins: string[]; // every distinct origin seen (a moved remote shows two)
  defaultBranch: string | null; // best guess across devices
  byDevice: Map<string, ProjectRepo>;
  envs: EnvStatus[];
  attention: boolean;
}

// Merge the per-device scans into one row per repo, with cross-device env state.
// Same grouping as the agent: one project per origin OR path. The path rule
// catches a remote that moved (berkekiran/x -> pzzaworks/x), the origin rule
// catches the same repo kept at different paths.
function groupProjects(scan: ProjectScan): Map<string, ProjectRepo>[] {
  interface Group {
    keys: Set<string>;
    members: Map<string, ProjectRepo>;
  }
  const groups: Group[] = [];
  const byKey = new Map<string, Group>();
  for (const d of scan.devices) {
    for (const r of d.repos) {
      const keys = [`path:${r.rel}`];
      const ok = originKey(r.origin);
      if (ok) keys.push(`origin:${ok}`);
      const hits = [...new Set(keys.map((k) => byKey.get(k)).filter((g): g is Group => Boolean(g)))];
      let g = hits[0];
      if (!g) groups.push((g = { keys: new Set(), members: new Map() }));
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
  return groups.map((g) => g.members);
}

function buildRows(scan: ProjectScan): Row[] {
  const okDevices = scan.devices.filter((d) => !d.error);
  const rows: Row[] = [];
  for (const byDevice of groupProjects(scan)) {
    const present = [...byDevice.values()];
    const rel = present[0].rel;
    const rels = new Set(present.map((r) => r.rel));
    const origin = present.find((r) => r.origin)?.origin ?? null;
    const origins = [...new Set(present.map((r) => r.origin).filter((o): o is string => Boolean(o)))];
    const defaultBranch = present.find((r) => r.defaultBranch)?.defaultBranch ?? null;

    const envNames = new Set<string>();
    for (const r of present) for (const e of r.envs) envNames.add(e.name);
    const envs: EnvStatus[] = [...envNames].sort().map((name) => {
      const hashes = new Map<string, string>();
      for (const [id, r] of byDevice) {
        const e = r.envs.find((x) => x.name === name);
        if (e) hashes.set(id, e.hash);
      }
      const distinct = new Set(hashes.values());
      const state: EnvState =
        byDevice.size < 2
          ? "single"
          : hashes.size < byDevice.size
            ? "partial"
            : distinct.size > 1
              ? "differs"
              : "synced";
      return { name, state, hashes };
    });

    const missingSomewhere = okDevices.some((d) => !byDevice.has(d.id));
    const offDefault = present.some((r) => defaultBranch && r.branch && r.branch !== defaultBranch);
    const dirty = present.some((r) => r.modified > 0); // untracked files never block a sync
    const behind = present.some((r) => (r.behind ?? 0) > 0);
    const envDrift = envs.some((e) => e.state === "differs" || e.state === "partial");
    rows.push({
      rel,
      rels,
      origin,
      origins,
      defaultBranch,
      byDevice,
      envs,
      attention: missingSomewhere || offDefault || dirty || behind || envDrift,
    });
  }
  return rows.sort((a, b) => a.rel.localeCompare(b.rel));
}

function ago(ts: number): string {
  if (!ts) return "";
  const s = Math.max(0, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

type Tone = "ok" | "warn" | "bad" | "dim" | "acc";

function Badge({ tone, title, children }: { tone: Tone; title: string; children: string }) {
  return (
    <span className={`pj-badge pj-${tone}`} title={title}>
      {children}
    </span>
  );
}

const ENV_LABEL: Record<EnvState, string> = {
  synced: "in sync",
  differs: "differs",
  partial: "partial",
  single: "only here",
};

function EnvChips({ envs, devices }: { envs: EnvStatus[]; devices: ProjectDeviceRef[] }) {
  if (envs.length === 0) return null;
  const nameOf = (id: string) => devices.find((d) => d.id === id)?.name ?? id;
  return (
    <span className="pj-envs">
      {envs.map((e) => {
        const missingOn = devices.filter((d) => !e.hashes.has(d.id)).map((d) => nameOf(d.id));
        const title =
          e.state === "synced"
            ? "same content on every device"
            : e.state === "differs"
              ? "content differs between devices"
              : e.state === "partial"
                ? `missing on ${missingOn.join(", ")}`
                : "the repo exists on one device only";
        return (
          <span key={e.name} className={`pj-env pj-env-${e.state}`} title={title}>
            {e.name}
            <span className="pj-env-state">{ENV_LABEL[e.state]}</span>
          </span>
        );
      })}
    </span>
  );
}

// One device's line inside a project card.
function DeviceLine({
  device,
  repo,
  displayRel,
  defaultBranch,
  result,
  envResults,
  deviceError,
}: {
  device: ProjectDeviceRef;
  repo: ProjectRepo | undefined;
  displayRel: string;
  defaultBranch: string | null;
  result: ProjectSyncResult | undefined;
  envResults: EnvSyncResult[];
  deviceError: string | null;
}) {
  const outcome =
    result || envResults.length ? (
      <span className="pj-outcomes">
        {result ? (
          <span className={`pj-outcome pj-out-${result.status}`} title={result.detail || result.status}>
            {result.status}
            {result.detail ? <span className="pj-outcome-detail">{result.detail}</span> : null}
          </span>
        ) : null}
        {envResults.map((e) => (
          <span
            key={e.name}
            className={`pj-outcome pj-out-${e.status === "copied" ? "updated" : "failed"}`}
            title={e.status === "copied" ? `${e.name} copied from ${e.from}` : `${e.name}: ${e.detail}`}
          >
            {e.name}
            <span className="pj-outcome-detail">{e.status === "copied" ? `← ${e.from}` : e.detail}</span>
          </span>
        ))}
      </span>
    ) : null;

  let body: ReactNode;
  if (deviceError) {
    body = (
      <span className="pj-missing" title={deviceError}>
        unreachable
      </span>
    );
  } else if (!repo) {
    body = (
      <span className="pj-missing">
        missing<span className="pj-missing-hint">sync will clone it</span>
      </span>
    );
  } else {
    const detached = repo.branch === "HEAD";
    const off = !detached && defaultBranch !== null && repo.branch !== null && repo.branch !== defaultBranch;
    const level = repo.ahead !== null && !repo.ahead && !repo.behind;
    body = (
      <>
        <span
          className={`pj-branch ${detached ? "pj-dim" : off ? "pj-warn" : "pj-acc"}`}
          title={detached ? "detached HEAD" : off ? `not on default branch (${defaultBranch})` : "on default branch"}
        >
          {detached ? "detached" : (repo.branch ?? "?")}
        </span>
        {repo.head ? <span className="pj-sha">{repo.head}</span> : null}
        <span className="pj-badges">
          {repo.modified > 0 ? <Badge tone="warn" title="tracked files with uncommitted changes">{`${repo.modified} modified`}</Badge> : null}
          {repo.untracked > 0 ? <Badge tone="dim" title="files git does not track yet (not committed, not ignored)">{`${repo.untracked} untracked`}</Badge> : null}
          {repo.ahead !== null && repo.ahead > 0 ? <Badge tone="acc" title="commits ahead of upstream">{`↑${repo.ahead} ahead`}</Badge> : null}
          {repo.behind !== null && repo.behind > 0 ? <Badge tone="bad" title="commits behind upstream">{`↓${repo.behind} behind`}</Badge> : null}
          {repo.ahead === null && !detached ? <Badge tone="dim" title="no upstream branch">no upstream</Badge> : null}
          {repo.stashes > 0 ? <Badge tone="dim" title="stash entries">{`stash ${repo.stashes}`}</Badge> : null}
          {repo.modified === 0 && repo.untracked === 0 && level ? (
            <Badge tone="ok" title="clean and level with upstream">clean</Badge>
          ) : null}
        </span>
      </>
    );
  }

  return (
    <div className="pj-line">
      <span className="pj-line-device">{device.name}</span>
      <span className="pj-line-body">
        {repo && repo.rel !== displayRel ? (
          <span className="pj-line-path" title={`On this device the repo lives at ${repo.rel}`}>
            {repo.rel}
          </span>
        ) : null}
        {body}
      </span>
      {outcome}
    </div>
  );
}

function RowDetails({ row, devices }: { row: Row; devices: ProjectDeviceRef[] }) {
  return (
    <div className="pj-details">
      <div className="pj-detail-line">
        <span className="pj-k">origin</span>
        <span className="pj-v">
          {row.origins.length === 0
            ? "no origin remote (cannot be cloned elsewhere)"
            : row.origins.length === 1
              ? row.origin
              : `${row.origins.join("  ·  ")}  (remote differs between devices, clones use the first)`}
        </span>
      </div>
      <div className="pj-detail-line">
        <span className="pj-k">default</span>
        <span className="pj-v">{row.defaultBranch ?? "unknown until first sync (origin/HEAD not set)"}</span>
      </div>
      {devices.map((d) => {
        const r = row.byDevice.get(d.id);
        if (!r) return null;
        return (
          <div key={d.id} className="pj-detail-line">
            <span className="pj-k">{d.name}</span>
            <span className="pj-v">
              {r.lastCommitTs ? `last commit ${ago(r.lastCommitTs)}` : "no commits"}
              {r.envs.length ? ` · ${r.envs.map((e) => `${e.name} ${e.hash.slice(0, 7)}`).join(", ")}` : " · no env files"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function ProjectCard({
  row,
  devices,
  scan,
  open,
  onToggle,
  resultFor,
  envsFor,
  enabled,
  envOn,
  envsGlobal,
  onSetRepo,
}: {
  row: Row;
  devices: ProjectDeviceRef[];
  scan: ProjectScan | null;
  open: boolean;
  onToggle: () => void;
  resultFor: (deviceId: string, rels: Set<string>) => ProjectSyncResult | undefined;
  envsFor: (deviceId: string, rels: Set<string>) => EnvSyncResult[];
  enabled: boolean;
  envOn: boolean;
  envsGlobal: boolean;
  onSetRepo: (patch: { enabled?: boolean; env?: boolean }) => void;
}) {
  const errorOf = (id: string) => scan?.devices.find((d) => d.id === id)?.error ?? null;
  const slash = row.rel.lastIndexOf("/");
  return (
    <div className={`pj-card ${enabled ? "" : "pj-card-off"}`}>
      <div className="pj-card-head" role="button" tabIndex={0} onClick={onToggle} onKeyDown={(e) => e.key === "Enter" && onToggle()}>
        <ChevronRight size={13} className={`muted-icon pj-chev ${open ? "flip" : ""}`} />
        <span className="pj-rel">
          {slash >= 0 ? <span className="pj-rel-dir">{row.rel.slice(0, slash + 1)}</span> : null}
          {row.rel.slice(slash + 1)}
        </span>
        <EnvChips envs={row.envs} devices={devices.filter((d) => row.byDevice.has(d.id))} />
        <span className="pj-card-switches">
          {row.envs.length > 0 && envsGlobal ? (
            <span className="pj-switch-wrap" title={envOn ? "Env files sync for this project" : "Env files are left alone for this project"}>
              <span className="pj-switch-label">env</span>
              <Switch small on={envOn && enabled} onToggle={() => onSetRepo({ env: !envOn })} title="Sync env files for this project" />
            </span>
          ) : null}
          <span className="pj-switch-wrap" title={enabled ? "Included in sync" : "Excluded from sync"}>
            <span className="pj-switch-label">sync</span>
            <Switch small on={enabled} onToggle={() => onSetRepo({ enabled: !enabled })} title="Include this project in sync" />
          </span>
        </span>
      </div>
      <div className="pj-lines">
        {devices.map((d) => (
          <DeviceLine
            key={d.id}
            device={d}
            repo={row.byDevice.get(d.id)}
            displayRel={row.rel}
            defaultBranch={row.defaultBranch}
            result={resultFor(d.id, row.rels)}
            envResults={envsFor(d.id, row.rels)}
            deviceError={errorOf(d.id)}
          />
        ))}
      </div>
      {open ? <RowDetails row={row} devices={devices} /> : null}
    </div>
  );
}

// Turn an agent/network failure into something a person can act on.
function explainError(msg: string): string {
  if (/unauthorized/i.test(msg)) {
    return "The agent rejected the request (token mismatch). Reload the app to pick up the agent's current token.";
  }
  if (/not found/i.test(msg)) {
    return "The running agent is older than the app and has no project sync yet. Restart the agent.";
  }
  if (/failed to fetch|networkerror|load failed/i.test(msg)) return "Cannot reach the agent. Is it running?";
  return msg;
}

export function ProjectsMenu() {
  const devices = useStore((s) => s.devices);
  const refs = useMemo(() => devices.map(toRef), [devices]);

  const [root, setRoot] = useState(loadRoot);
  const [scan, setScan] = useState<ProjectScan | null>(null);
  const [sync, setSync] = useState<ProjectSync | null>(null);
  const [scanning, setScanning] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [opts, setOpts] = useState<SyncOptions>(() => loadJson(OPTS_KEY, DEFAULT_SYNC_OPTIONS));
  const [devicesOff, setDevicesOff] = useState<string[]>(() => loadJson(DEVICES_OFF_KEY, [] as string[]));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [excludeText, setExcludeText] = useState(() => opts.envExclude.join(", "));

  const patchOpts = (patch: Partial<SyncOptions>) =>
    setOpts((o) => {
      const next = { ...o, ...patch };
      saveJson(OPTS_KEY, next);
      return next;
    });
  const setRepo = (rel: string, patch: { enabled?: boolean; env?: boolean }) =>
    patchOpts({ repos: { ...opts.repos, [rel]: { ...(opts.repos[rel] ?? { enabled: true, env: true }), ...patch } } });
  const toggleDevice = (id: string) =>
    setDevicesOff((list) => {
      const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
      saveJson(DEVICES_OFF_KEY, next);
      return next;
    });
  const syncRefs = refs.filter((r) => !devicesOff.includes(r.id));

  const runScan = useCallback(async () => {
    setScanning(true);
    setError(null);
    try {
      setScan(await scanProjects(root, refs));
    } catch (e) {
      setError(explainError(String((e as Error)?.message || e)));
    } finally {
      setScanning(false);
    }
  }, [root, refs]);

  // The dropdown mounts on open, so this is "scan when opened".
  useEffect(() => {
    void runScan();
  }, [runScan]);

  // The root is the same folder relative to home on every device, so a picked
  // absolute path is stored as ~/... using the browsed device's home.
  const pickRoot = async (path: string, host: string) => {
    let next = path;
    try {
      const home = (await listDir(undefined, host)).path.replace(/\/+$/, "");
      if (home && (path === home || path.startsWith(home + "/"))) next = "~" + path.slice(home.length);
    } catch {
      /* keep the absolute path */
    }
    if (!next.startsWith("~")) {
      setError("Pick a folder inside your home directory so the same path exists on every device.");
      return;
    }
    setRoot(next);
    saveRoot(next);
  };

  const runSync = async () => {
    setSyncing(true);
    setError(null);
    setSync(null);
    try {
      setSync(await syncProjects(root, syncRefs, opts));
      // Refresh so branches/behind counts reflect the new state.
      setScan(await scanProjects(root, refs));
    } catch (e) {
      setError(explainError(String((e as Error)?.message || e)));
    } finally {
      setSyncing(false);
    }
  };

  const rows = useMemo(() => (scan ? buildRows(scan) : []), [scan]);
  const resultFor = (deviceId: string, rels: Set<string>) =>
    sync?.devices.find((d) => d.id === deviceId)?.results.find((r) => rels.has(r.rel));
  const envsFor = (deviceId: string, rels: Set<string>) =>
    sync?.devices.find((d) => d.id === deviceId)?.envs.filter((e) => rels.has(e.rel)) ?? [];
  // After a sync, anything that failed on any device needs attention too.
  const failedRow = (r: Row) =>
    refs.some(
      (d) => resultFor(d.id, r.rels)?.status === "failed" || envsFor(d.id, r.rels).some((e) => e.status === "failed"),
    );
  const needsAttention = (r: Row) => r.attention || failedRow(r);
  const shown = filter === "attention" ? rows.filter(needsAttention) : rows;
  const attention = rows.filter(needsAttention).length;

  const busy = scanning || syncing;
  const toggle = (rel: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(rel)) n.delete(rel);
      else n.add(rel);
      return n;
    });

  const deviceStrip = scan?.devices ?? refs.map((r) => ({ ...r, error: null, root: null, repos: [] }));

  return (
    <div className="menu-body pj">
      <div className="pj-head">
        <div className="pj-title">
          <div className="menu-title" style={{ margin: 0 }}>
            Projects
          </div>
          <div className="pj-subtitle">
            <span className="muted">root</span>
            <PathField
              value={root}
              mode="folder"
              hosts={refs.map((r) => ({ label: r.name, host: r.host }))}
              placeholder={DEFAULT_ROOT}
              title="Projects root: the same folder, relative to home, on every device"
              pickerTitle="Projects root"
              className="pj-root"
              onChange={(path, host) => void pickRoot(path, host)}
            />
          </div>
        </div>
        <div className="pj-actions">
          <button className="btn btn-sm" onClick={() => void runScan()} disabled={busy} title="Rescan every device">
            {scanning ? <Loader2 size={13} className="sw-spin" /> : <RefreshCw size={13} strokeWidth={2} />}
            Rescan
          </button>
          <button
            className="btn btn-sm btn-accent"
            onClick={() => void runSync()}
            disabled={busy || !scan || syncRefs.length < 1}
            title="Run the sync with the settings below"
          >
            {syncing ? <Loader2 size={13} className="sw-spin" /> : <FolderSync size={13} strokeWidth={2} />}
            {syncing ? "Syncing…" : "Sync all"}
          </button>
          <button
            type="button"
            className={`btn btn-sm btn-icon ${settingsOpen ? "btn-on" : ""}`}
            onClick={() => setSettingsOpen((v) => !v)}
            title="Sync settings"
          >
            <Settings2 size={14} />
          </button>
        </div>
      </div>

      {settingsOpen ? (
        <div className="pj-settings">
          <div className="pj-set-group">
            <div className="pj-set-title">Devices in sync</div>
            <div className="pj-set-chips">
              {refs.map((r) => {
                const on = !devicesOff.includes(r.id);
                return (
                  <button
                    key={r.id}
                    type="button"
                    className={`pj-set-chip ${on ? "on" : ""}`}
                    onClick={() => toggleDevice(r.id)}
                    title={on ? "Click to exclude from sync (still scanned)" : "Click to include in sync"}
                  >
                    <span className={`dot ${on ? "dot-up" : ""}`} />
                    {r.name}
                  </button>
                );
              })}
            </div>
          </div>
          <div className="pj-set-group">
            <div className="pj-set-title">Repositories</div>
            <label className="pj-set-row">
              <span>
                Clone missing projects
                <small>A repo found on one device is cloned onto the others</small>
              </span>
              <Switch on={opts.cloneMissing} onToggle={() => patchOpts({ cloneMissing: !opts.cloneMissing })} title="Clone missing projects" />
            </label>
            <label className="pj-set-row">
              <span>
                Switch to the default branch
                <small>Off: the current branch is fast-forwarded in place</small>
              </span>
              <Switch on={opts.switchToDefault} onToggle={() => patchOpts({ switchToDefault: !opts.switchToDefault })} title="Switch to default branch" />
            </label>
            <label className="pj-set-row">
              <span>
                Stash uncommitted changes
                <small>Off: a dirty repo is reported and left alone</small>
              </span>
              <Switch on={opts.stashDirty} onToggle={() => patchOpts({ stashDirty: !opts.stashDirty })} title="Stash uncommitted changes" />
            </label>
          </div>
          <div className="pj-set-group">
            <div className="pj-set-title">Env files</div>
            <label className="pj-set-row">
              <span>
                Sync env files
                <small>The newest copy of each .env / .env.* wins</small>
              </span>
              <Switch on={opts.syncEnvs} onToggle={() => patchOpts({ syncEnvs: !opts.syncEnvs })} title="Sync env files" />
            </label>
            <label className={`pj-set-row ${opts.syncEnvs ? "" : "pj-set-row-off"}`}>
              <span>
                Never copy
                <small>File name patterns, comma separated, * matches anything</small>
              </span>
              <input
                className="pj-set-input"
                value={excludeText}
                placeholder=".env.local, *.test"
                spellCheck={false}
                disabled={!opts.syncEnvs}
                onChange={(e) => setExcludeText(e.target.value)}
                onBlur={() =>
                  patchOpts({ envExclude: excludeText.split(",").map((x) => x.trim()).filter(Boolean) })
                }
              />
            </label>
          </div>
          <p className="set-note" style={{ margin: 0 }}>
            Each project card also has its own sync and env switches. Settings are saved on this device.
          </p>
        </div>
      ) : null}

      <div className="pj-devices">
        {deviceStrip.map((d) => (
          <div
            key={d.id}
            className={`pj-device ${d.error ? "pj-device-err" : ""}`}
            title={d.error ?? `${d.host || "local"}${d.root ? ` · ${d.root}` : ""}`}
          >
            <span className={`dot ${d.error ? "dot-down" : "dot-up"}`} />
            <span className="pj-device-name">{d.name}</span>
            <span className="pj-device-n">
              {d.error ? d.error : scan ? `${d.repos.length} repos` : "scanning…"}
              {devicesOff.includes(d.id) ? " · sync off" : ""}
            </span>
          </div>
        ))}
        <div className="ports-status-spacer" />
        <div className="pj-filter">
          <button className={`pj-filter-btn ${filter === "all" ? "on" : ""}`} onClick={() => setFilter("all")}>
            all <b>{rows.length}</b>
          </button>
          <button
            className={`pj-filter-btn ${filter === "attention" ? "on" : ""} ${attention ? "pj-filter-warn" : ""}`}
            onClick={() => setFilter("attention")}
          >
            attention <b>{attention}</b>
          </button>
        </div>
      </div>

      {error ? <div className="pj-error">{error}</div> : null}
      {sync ? (
        <div className="pj-summary">
          {sync.devices.map((d) => {
            const n = (s: string) => d.results.filter((r) => r.status === s).length;
            const envCopied = d.envs.filter((e) => e.status === "copied").length;
            const envFailed = d.envs.filter((e) => e.status === "failed").length;
            const parts = [
              ...(["cloned", "updated", "stashed", "current", "dirty", "failed"] as const).map((label) => ({
                label,
                count: n(label) + (label === "failed" ? envFailed : 0),
              })),
              { label: "env copied", count: envCopied },
            ].filter((p) => p.count > 0);
            return (
              <span key={d.id} className="pj-summary-dev">
                <b>{d.name}</b>
                {d.error ? (
                  <span className="pj-bad">{d.error}</span>
                ) : parts.length === 0 ? (
                  <span className="muted">nothing to do</span>
                ) : (
                  parts.map((p) => (
                    <span key={p.label} className={`pj-sum pj-out-${p.label.split(" ")[0]}`}>
                      {p.count} {p.label}
                    </span>
                  ))
                )}
              </span>
            );
          })}
        </div>
      ) : null}

      <div className="pj-list">
        {!scan && scanning ? (
          <p className="muted small pad pj-empty">
            <Loader2 size={14} className="sw-spin" /> Scanning {refs.length} device{refs.length === 1 ? "" : "s"}…
          </p>
        ) : !scan ? null : shown.length === 0 ? (
          <p className="muted small pad pj-empty">
            {rows.length === 0 ? `No git repos under ${root} on any device.` : "Everything is in sync."}
          </p>
        ) : (
          shown.map((row) => (
            <ProjectCard
              key={row.rel}
              row={row}
              devices={refs}
              scan={scan}
              open={open.has(row.rel)}
              onToggle={() => toggle(row.rel)}
              resultFor={resultFor}
              envsFor={envsFor}
              enabled={opts.repos[row.rel]?.enabled !== false}
              envOn={opts.repos[row.rel]?.env !== false}
              envsGlobal={opts.syncEnvs}
              onSetRepo={(patch) => setRepo(row.rel, patch)}
            />
          ))
        )}
      </div>
      <p className="set-note pj-note">
        What a sync does is up to the settings: clone missing repos, stash local edits (git stash pop brings them
        back), switch to the default branch and fast-forward, then copy the newest env files around. Every project
        can opt out on its card.
      </p>
    </div>
  );
}
