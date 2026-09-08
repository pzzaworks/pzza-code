import { AsyncButton } from "../ui/AsyncButton";
import { notify } from "../state/notifications";
import { Modal } from "../ui/Modal";
import { deviceExclusions, projectSettings } from "../projectSettings";
import { confirmEditorDiscard } from "../editorChanges";
import { DeviceIcon } from "../ui/DeviceIcon";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronRight, Folder, FolderSync, Loader2, RefreshCw, Settings2 } from "lucide-react";
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
  type ProjectScanProgress,
  type EnvSyncResult,
  type ProjectSync,
  type ProjectSyncResult,
} from "../serverApi";

function ScanProgress({ progress }: { progress: ProjectScanProgress | null }) {
  const [started] = useState(() => Date.now());
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [started]);
  const failed = progress?.finished.filter((device) => device.error).length ?? 0;
  return (
    <div className="pj-scan-status" role="status">
      <Loader2 size={14} className="sw-spin" />
      <span>Scanning{progress ? ` · ${progress.completed}/${progress.total} devices · ${progress.repos} repos` : " · connecting…"}{failed ? ` · ${failed} failed` : ""}</span>
      <span className="pj-scan-time">{elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`}</span>
    </div>
  );
}

// Project sync dashboard. One card per git repo found under the projects root
// on ANY device; inside it one line per device: what is checked out, how far
// from origin, what is uncommitted, and whether the .env files match across
// devices. "Sync all" clones what is missing, stashes local edits, updates
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

function loadJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
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

interface Row {
  projectId: string;
  rel: string;
  origin: string | null;
  origins: string[];
  defaultBranch: string | null;
  byDevice: Map<string, ProjectRepo>;
  duplicates: Map<string, ProjectRepo[]>;
  canClone: boolean;
  cloneBlocks: Map<string, string>;
  envs: EnvStatus[];
  attention: boolean;
}

interface ProjectFolder {
  name: string;
  path: string;
  folders: Map<string, ProjectFolder>;
  rows: Row[];
  count: number;
}

function projectTree(rows: Row[]): ProjectFolder {
  const root: ProjectFolder = { name: "", path: "", folders: new Map(), rows: [], count: rows.length };
  for (const row of rows) {
    const segments = row.rel.split("/").slice(0, -1);
    let parent = root;
    for (const name of segments) {
      let folder = parent.folders.get(name);
      if (!folder) {
        folder = { name, path: `${parent.path}/${name}`, folders: new Map(), rows: [], count: 0 };
        parent.folders.set(name, folder);
      }
      folder.count++;
      parent = folder;
    }
    parent.rows.push(row);
  }
  return root;
}

function ProjectTree({ folder, renderRow }: { folder: ProjectFolder; renderRow: (row: Row) => ReactNode }) {
  return <>
    {[...folder.folders.values()].sort((a, b) => a.name.localeCompare(b.name)).map((child) => (
      <details className="pj-folder" key={child.path} open>
        <summary><ChevronRight size={13} className="pj-chev" /><Folder size={14} /><span>{child.name}</span><small>{child.count}</small></summary>
        <div className="pj-folder-content"><ProjectTree folder={child} renderRow={renderRow} /></div>
      </details>
    ))}
    {folder.rows.map(renderRow)}
  </>;
}

function groupProjects(scan: ProjectScan): Map<string, Map<string, ProjectRepo[]>> {
  const groups = new Map<string, Map<string, ProjectRepo[]>>();
  for (const device of scan.devices) {
    for (const repo of device.repos) {
      let group = groups.get(repo.projectId);
      if (!group) groups.set(repo.projectId, (group = new Map()));
      const copies = group.get(device.id) ?? [];
      copies.push(repo);
      group.set(device.id, copies);
    }
  }
  return groups;
}

// Migrate stored path overrides once their repositories have been identified.
// Restrictions from every copy survive, including paths shared by distinct projects.
function migrateRepoOptions(options: SyncOptions, scan: ProjectScan): SyncOptions {
  const repos = { ...options.repos };
  const consumed = new Set<string>();
  const groups = groupProjects(scan);
  for (const [projectId, members] of groups) {
    const paths = new Set([...members.values()].flat().map((repo) => repo.rel));
    for (const repo of [...members.values()].flat()) {
      if (repo.originalProjectId) paths.add(repo.originalProjectId);
    }
    const overrides = [options.repos[projectId]];
    for (const path of paths) {
      if (path === projectId || groups.has(path) || !Object.hasOwn(options.repos, path)) continue;
      overrides.push(options.repos[path]);
      consumed.add(path);
    }
    const present = overrides.filter((value) => value !== undefined);
    if (present.length) {
      repos[projectId] = {
        enabled: present.every((value) => value.enabled !== false),
        env: present.every((value) => value.env !== false),
      };
    }
  }
  if (consumed.size === 0) return options;
  for (const path of consumed) delete repos[path];
  return { ...options, repos };
}

function buildRows(scan: ProjectScan, options: SyncOptions, excludedDevices: string[]): Row[] {
  const okDevices = scan.devices.filter((d) => !d.error);
  const rows: Row[] = [];
  for (const [projectId, members] of groupProjects(scan)) {
    const byDevice = new Map([...members].map(([id, copies]) => [id, copies[0]]));
    const duplicates = new Map([...members].filter(([, copies]) => copies.length > 1));
    const present = [...members.values()].flat();
    const source = [...members].find(([id, copies]) => copies.length === 1 &&
      !excludedDevices.includes(id) && okDevices.some((device) => device.id === id),
    )?.[1][0];
    const rel = (source ?? present[0]).rel;
    const origin = source?.canonicalOrigin ?? source?.origin ?? present.find((repo) => repo.origin)?.origin ?? null;
    const canClone = Boolean(source && projectId.startsWith("origin:"));
    const origins = [...new Set(present.map((r) => r.origin).filter((o): o is string => Boolean(o)))];
    const defaultBranch = present.find((r) => r.defaultBranch)?.defaultBranch ?? null;

    const envNames = new Set<string>();
    for (const r of present) for (const e of r.envs) envNames.add(e.name);
    const envs: EnvStatus[] = [...envNames].sort().map((name) => {
      const hashes = new Map<string, string>();
      for (const [id, r] of byDevice) {
        if (duplicates.has(id)) continue;
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
      projectId,
      rel,
      origin,
      origins,
      defaultBranch,
      byDevice,
      duplicates,
      canClone,
      cloneBlocks: new Map(),
      envs,
      attention: duplicates.size > 0 || missingSomewhere || offDefault || dirty || behind || envDrift,
    });
  }
  for (const device of okDevices) {
    if (excludedDevices.includes(device.id)) continue;
    const targets = new Map<string, Row[]>();
    for (const row of rows) {
      if (!options.cloneMissing || !row.canClone || row.byDevice.has(device.id) ||
        options.repos[row.projectId]?.enabled === false) continue;
      const conflict = device.repos.find((repo) => repo.rel === row.rel && repo.projectId !== row.projectId);
      if (conflict) {
        row.cloneBlocks.set(device.id, `clone blocked: ${row.rel} belongs to another project`);
        row.attention = true;
        continue;
      }
      const planned = targets.get(row.rel) ?? [];
      planned.push(row);
      targets.set(row.rel, planned);
    }
    for (const [path, planned] of targets) {
      if (planned.length < 2) continue;
      for (const row of planned) {
        row.cloneBlocks.set(device.id, `clone blocked: multiple projects need ${path}`);
        row.attention = true;
      }
    }
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
  duplicates,
  canClone,
  cloneBlock,
}: {
  device: ProjectDeviceRef;
  repo: ProjectRepo | undefined;
  displayRel: string;
  defaultBranch: string | null;
  result: ProjectSyncResult | undefined;
  envResults: EnvSyncResult[];
  deviceError: string | null;
  duplicates: ProjectRepo[] | undefined;
  canClone: boolean;
  cloneBlock: string | undefined;
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
  } else if (duplicates) {
    body = (
      <span className="pj-bad" title="Sync skips this device until only one copy of this project remains under the root">
        duplicate copies: {duplicates.map((copy) => copy.rel).join(", ")} · sync blocked
      </span>
    );
  } else if (!repo && cloneBlock) {
    body = <span className="pj-bad">{cloneBlock}</span>;
  } else if (!repo) {
    body = (
      <span className="pj-missing">
        missing<span className="pj-missing-hint">{canClone ? "sync will clone it" : "no unambiguous source to clone"}</span>
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
      <span className="pj-line-device"><DeviceIcon host={device.host} />{device.name}</span>
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
            <span className="pj-k"><DeviceIcon host={d.host} />{d.name}</span>
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
  resultFor: (deviceId: string, projectId: string) => ProjectSyncResult | undefined;
  envsFor: (deviceId: string, projectId: string) => EnvSyncResult[];
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
        <span className="pj-rel" title={row.rel}>
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
            result={resultFor(d.id, row.projectId)}
            envResults={envsFor(d.id, row.projectId)}
            deviceError={errorOf(d.id)}
            duplicates={row.duplicates.get(d.id)}
            canClone={row.canClone}
            cloneBlock={row.cloneBlocks.get(d.id)}
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
  const [scanProgress, setScanProgress] = useState<ProjectScanProgress | null>(null);
  const scanController = useRef<AbortController | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [confirmSync, setConfirmSync] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const [opts, setOpts] = useState<SyncOptions>(() => projectSettings(loadJson(OPTS_KEY), DEFAULT_SYNC_OPTIONS));
  const [devicesOff, setDevicesOff] = useState<string[]>(() => deviceExclusions(loadJson(DEVICES_OFF_KEY)));
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [excludeText, setExcludeText] = useState(() => opts.envExclude.join(", "));

  const patchOpts = (patch: Partial<SyncOptions>) =>
    setOpts((o) => {
      const next = { ...o, ...patch };
      saveJson(OPTS_KEY, next);
      return next;
    });
  const setRepo = (projectId: string, patch: { enabled?: boolean; env?: boolean }) =>
    patchOpts({ repos: { ...opts.repos, [projectId]: { ...(opts.repos[projectId] ?? { enabled: true, env: true }), ...patch } } });
  const toggleDevice = (id: string) =>
    setDevicesOff((list) => {
      const next = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
      saveJson(DEVICES_OFF_KEY, next);
      return next;
    });
  const syncRefs = refs.filter((r) => !devicesOff.includes(r.id));

  const runScan = useCallback(async () => {
    scanController.current?.abort();
    const controller = new AbortController();
    scanController.current = controller;
    setScanning(true);
    setScanProgress(null);
    setError(null);
    try {
      const result = await scanProjects(root, refs, (progress) => {
        if (!controller.signal.aborted) setScanProgress(progress);
      }, controller.signal);
      if (!controller.signal.aborted) setScan(result);
    } catch (e) {
      if (!controller.signal.aborted) setError(explainError(String((e as Error)?.message || e)));
    } finally {
      if (!controller.signal.aborted) setScanning(false);
    }
  }, [root, refs]);

  // The sync panel stays mounted after its first open, retaining the operation
  // and results while hidden. Only root/device changes start another scan.
  useEffect(() => {
    void runScan();
    return () => scanController.current?.abort();
  }, [runScan]);

  useEffect(() => {
    if (!scan) return;
    setOpts((current) => {
      const next = migrateRepoOptions(current, scan);
      if (next !== current) saveJson(OPTS_KEY, next);
      return next;
    });
  }, [scan]);

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
      if (!await confirmEditorDiscard()) return;
      setConfirmSync(false);
      const migrated = scan ? migrateRepoOptions(opts, scan) : opts;
      const result = await syncProjects(root, syncRefs, migrated);
      setSync(result);
      const failures = result.devices.reduce((count, device) => count + (device.error ? 1 : 0) + device.results.filter(item => item.status === "failed").length + device.envs.filter(item => item.status === "failed").length, 0);
      notify({ category: "sync", event: failures ? "sync-error" : "sync-completed", title: failures ? "Sync needs attention" : "Sync completed", body: failures ? `${failures} errors across ${result.devices.length} devices. Open Sync to review.` : `Finished syncing ${result.devices.length} devices.`, target: { section: "sync" } });
      // Refresh so branches/behind counts reflect the new state.
      await runScan();
    } catch (e) {
      notify({ category: "sync", event: "sync-error", title: "Sync failed", body: "Open Sync to review the error and retry.", target: { section: "sync" } });
      setError(explainError(String((e as Error)?.message || e)));
    } finally {
      setSyncing(false);
    }
  };

  const rows = useMemo(() => scan
    ? buildRows(scan, migrateRepoOptions(opts, scan), devicesOff)
    : [], [scan, opts, devicesOff]);
  const resultFor = (deviceId: string, projectId: string) =>
    sync?.devices.find((d) => d.id === deviceId)?.results.find((r) => r.projectId === projectId);
  const envsFor = (deviceId: string, projectId: string) =>
    sync?.devices.find((d) => d.id === deviceId)?.envs.filter((e) => e.projectId === projectId) ?? [];
  // After a sync, anything that failed on any device needs attention too.
  const failedRow = (r: Row) =>
    refs.some(
      (d) => resultFor(d.id, r.projectId)?.status === "failed" || envsFor(d.id, r.projectId).some((e) => e.status === "failed"),
    );
  const needsAttention = (r: Row) => r.attention || failedRow(r);
  const shown = filter === "attention" ? rows.filter(needsAttention) : rows;
  const tree = projectTree(shown);
  const attention = rows.filter(needsAttention).length;

  const busy = scanning || syncing;
  const toggle = (projectId: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(projectId)) n.delete(projectId);
      else n.add(projectId);
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
            <fieldset className="pj-root-field" disabled={busy}>
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
            </fieldset>
          </div>
        </div>
        <div className="pj-actions">
          <AsyncButton className="btn btn-sm" onClick={() => void runScan()} loading={scanning} icon={RefreshCw} iconSize={13} disabled={busy} title="Rescan every device">
            Rescan
          </AsyncButton>
          <AsyncButton className="btn btn-sm btn-accent" onClick={() => setConfirmSync(true)} loading={syncing} icon={FolderSync} iconSize={13} disabled={busy || !scan || syncRefs.length < 1} title="Run the sync with the settings below">
            Sync all
          </AsyncButton>
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
                    <DeviceIcon host={r.host} />
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
                <small>Off: upstream commits are integrated into the current branch</small>
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
            <span className="pj-device-name"><DeviceIcon host={d.host} />{d.name}</span>
            <span className="pj-device-n">
              {scanning
                ? scanProgress?.finished.find((device) => device.id === d.id)?.error
                  ? "scan failed"
                  : scanProgress?.finished.some((device) => device.id === d.id) ? "checked" : "scanning…"
                : d.error ? d.error : scan ? `${d.repos.length} repos` : "not scanned"}
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
                <b><DeviceIcon host={refs.find((ref) => ref.id === d.id)?.host} />{d.name}</b>
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
        {scanning ? <ScanProgress key={root} progress={scanProgress} /> : null}
        {!scan ? null : shown.length === 0 && !scanning ? (
          <p className="muted small pad pj-empty">
            {rows.length === 0 ? `No git repos under ${root} on any device.` : "Everything is in sync."}
          </p>
        ) : (
          <ProjectTree folder={tree} renderRow={(row) => (
            <ProjectCard
              key={row.projectId}
              row={row}
              devices={refs}
              scan={scan}
              open={open.has(row.projectId)}
              onToggle={() => toggle(row.projectId)}
              resultFor={resultFor}
              envsFor={envsFor}
              enabled={opts.repos[row.projectId]?.enabled !== false}
              envOn={opts.repos[row.projectId]?.env !== false}
              envsGlobal={opts.syncEnvs}
              onSetRepo={(patch) => setRepo(row.projectId, patch)}
            />
          )} />
        )}
      </div>
      <p className="set-note pj-note">
        What a sync does is up to the settings: clone missing repos, stash local edits (git stash pop brings them
        back), switch to the default branch and integrate upstream commits, then copy the newest env files around. Diverged
        branches are merged while preserving local commits; conflicting merges are aborted. Every project
        can opt out on its card.
      </p>
      <Modal open={confirmSync} onClose={() => { if (!syncing) setConfirmSync(false); }} title="Sync projects" size="sm">
        <p className="move-q">Sync enabled projects under <b>{root}</b> on {syncRefs.map((device) => device.name).join(", ")}?</p>
        <p className="set-note">
          This updates Git working files{opts.cloneMissing ? ", clones missing projects" : ""}
          {opts.switchToDefault ? ", switches to the default branch" : ""}
          {opts.stashDirty ? ", and stashes tracked local changes" : "; dirty projects are skipped"}.
          {opts.syncEnvs ? " Environment files can be overwritten by newer copies from other devices. These copies cannot be undone through the app." : " Environment file copying is disabled."}
        </p>
        <div className="modal-actions">
          <button className="btn" disabled={syncing} onClick={() => setConfirmSync(false)}>Cancel</button>
          <AsyncButton className="btn btn-danger" loading={syncing} icon={FolderSync} onClick={() => void runSync()}>Sync projects</AsyncButton>
        </div>
      </Modal>
    </div>
  );
}
