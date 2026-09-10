import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, RefreshCw } from "lucide-react";
import { useStore } from "../state/store";
import { deviceHost } from "../devices";
import { cachedGlobalInstructions, discoverGlobalInstructions, previewGlobalInstructions, syncGlobalInstructions, type GlobalInstructionDiscovery, type GlobalInstructionFile, type GlobalInstructionPreview, type GlobalInstructionResult } from "../agentsHubApi";
import { useUnsavedDraft } from "../state/unsavedWork";
import "./GlobalInstructions.css";

type Version = GlobalInstructionFile & { host: string; deviceName: string };
const versionId = (file: { host: string; path: string }) => JSON.stringify([file.host, file.path]);
const modified = (timestamp: number) => Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toLocaleString() : "Modification time unavailable";

export function GlobalInstructions({ active }: { active: boolean }) {
  const devices = useStore(state => state.devices);
  const [data, setData] = useState<GlobalInstructionDiscovery | null>(null);
  const [framework, setFramework] = useState("claude");
  const [selected, setSelected] = useState("");
  const [targetHosts, setTargetHosts] = useState<string[] | null>(null);
  const [plan, setPlan] = useState<GlobalInstructionPreview | null>(null);
  const [results, setResults] = useState<GlobalInstructionResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const discoveryGeneration = useRef(0);
  const [loadingHosts, setLoadingHosts] = useState<string[]>([]);
  useUnsavedDraft("global-instructions", { label: "Global instruction sync", dirty: false, saving: busy, revision: plan?.previewId });
  const refresh = useCallback(async (fresh = false) => {
    const request = ++discoveryGeneration.current;
    const destinations = devices.map(device => ({ host: deviceHost(device), name: device.name }));
    setLoadingHosts(destinations.map(device => device.host));
    setError("");
    setData({ devices: cachedGlobalInstructions(destinations) });
    try {
      await discoverGlobalInstructions(destinations, found => {
        if (request !== discoveryGeneration.current) return;
        setData(current => ({ devices: [...(current?.devices ?? []).filter(device => device.host !== found.host), found] }));
        setLoadingHosts(hosts => hosts.filter(host => host !== found.host));
      }, fresh);
    } catch (cause) {
      if (request === discoveryGeneration.current) setError(cause instanceof Error ? cause.message : "Could not load device instructions.");
    } finally { if (request === discoveryGeneration.current) setLoadingHosts([]); }
  }, [devices]);
  useEffect(() => {
    if (active) void refresh();
    return () => { discoveryGeneration.current++; };
  }, [active, refresh]);

  const versions = useMemo(() => (data?.devices ?? []).flatMap(device => device.files
    .filter(file => file.framework === framework)
    .map(file => ({ ...file, host: device.host, deviceName: device.name })))
    .sort((a, b) => b.modifiedAt - a.modifiedAt || versionId(a).localeCompare(versionId(b))), [data, framework]);
  const source = versions.find(file => versionId(file) === selected) ?? versions[0];
  useEffect(() => { if (!selected && source) setSelected(versionId(source)); }, [selected, source]);
  const destinations = (data?.devices ?? []).filter(device => device.host !== source?.host);
  const targets = source ? destinations.filter(device => !device.error && (targetHosts === null || targetHosts.includes(device.host)))
    .map(device => ({ host: device.host, path: source.path })) : [];
  const nameFor = (host: string) => data?.devices.find(device => device.host === host)?.name ?? (host || "This Device");
  const choose = (version: Version) => { setSelected(versionId(version)); setTargetHosts(null); setPlan(null); setResults([]); setError(""); };
  const preview = async () => {
    if (!source || !targets.length || busy) return;
    const request = ++generation.current;
    setBusy(true); setError(""); setResults([]);
    try {
      const preview = await previewGlobalInstructions({ host: source.host, path: source.path, sha256: source.sha256 }, targets);
      if (request === generation.current) setPlan(preview);
    } catch (cause) {
      if (request === generation.current) setError(cause instanceof Error ? cause.message : "Could not preview instruction sync.");
    } finally { if (request === generation.current) setBusy(false); }
  };
  const apply = async () => {
    if (!plan || busy) return;
    setBusy(true); setError("");
    try {
      const result = await syncGlobalInstructions(plan.previewId);
      setResults(result.results);
      setPlan(null);
      void refresh(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Instruction sync failed."); }
    finally { setBusy(false); }
  };
  return <div className="global-instructions" aria-busy={busy}>
    <div className="global-instructions-toolbar">
      <div className="settings-segment" role="group" aria-label="Instruction framework">
        {[{ id: "claude", label: "CLAUDE.md" }, { id: "codex", label: "AGENTS.md" }].map(item => <button key={item.id} aria-pressed={framework === item.id} disabled={busy} onClick={() => { setFramework(item.id); setSelected(""); setTargetHosts(null); setPlan(null); setResults([]); }}>{item.label}</button>)}
      </div>
      <button className="icon-btn" aria-label="Refresh instruction versions" disabled={busy} onClick={() => { setPlan(null); void refresh(true); }}><RefreshCw size={16} /></button>
    </div>
    {error && <p className="global-instructions-error" role="alert">{error}</p>}
    {loadingHosts.length > 0 && <p className="set-note" role="status">Checking {loadingHosts.map(host => devices.find(device => deviceHost(device) === host)?.name ?? (host || "This Device")).join(", ")}… Available versions can be reviewed now.</p>}
    {results.length > 0 && <div className="global-sync-results" role="status">{results.map(result => <div key={versionId(result)}>
      <strong>{nameFor(result.host)}: {result.status === "synced" ? "Synced" : result.status === "unchanged" ? "Already identical" : "Not synced"}</strong>
      {result.error && <span className="global-instructions-error">{result.error}</span>}
      {result.backupPath && <small>Previous version saved at {result.backupPath}</small>}
    </div>)}</div>}
    {plan ? <>
      <button className="global-instructions-back" disabled={busy} onClick={() => setPlan(null)}><ArrowLeft size={14} />Choose another version</button>
      <div className="global-sync-source"><strong>{nameFor(plan.source.host)}</strong><span>~/{plan.source.path}</span><small>{modified(plan.source.modifiedAt)}</small></div>
      <p className="set-note">These copies will match the selected source exactly. Existing changed files receive a backup.</p>
      <div className="global-sync-preview">{plan.targets.map(target => <div className="global-sync-target" key={versionId(target)}>
        <div><strong>{nameFor(target.host)}</strong><span>~/{target.path}</span></div>
        <span>{target.status === "unchanged" ? "Identical" : target.status === "failed" ? "Unavailable" : target.previousContent === null ? "Create file" : "Replace with backup"}</span>
        {target.error && <p role="alert" className="global-instructions-error">{target.error}</p>}
        {target.status === "ready" && <details><summary>Review content</summary><div className="global-sync-comparison"><div><small>Current destination</small><pre>{target.previousContent ?? "File does not exist."}</pre></div><div><small>Selected source</small><pre>{plan.source.content}</pre></div></div></details>}
      </div>)}</div>
      <div className="global-instructions-footer"><button className="btn" disabled={busy} onClick={() => setPlan(null)}>Cancel</button><button className="btn btn-accent" disabled={busy || !plan.targets.some(target => target.status === "ready")} onClick={() => void apply()}>{busy ? "Syncing…" : "Confirm sync"}</button></div>
    </> : data && <>
      <div className="global-version-heading"><strong>Choose the source version</strong><span>Last modified</span></div>
      <div className="global-version-list" role="radiogroup" aria-label="Source instruction version">{versions.map((version, index) => <label className={`global-version ${source && versionId(version) === versionId(source) ? "selected" : ""}`} key={versionId(version)}>
        <input type="radio" name="global-instruction-source" checked={source && versionId(version) === versionId(source)} disabled={busy} onChange={() => choose(version)} />
        <span className="global-version-copy"><strong>{version.deviceName}</strong><small>~/{version.path}</small></span>
        <span className="global-version-time">{modified(version.modifiedAt)}{index === 0 && version.modifiedAt > 0 && <small>Latest timestamp</small>}</span>
      </label>)}</div>
      {!versions.length && <p className="set-note">No {framework === "claude" ? "CLAUDE.md" : "AGENTS.md"} files found in the device home folders.</p>}
      {data.devices.filter(device => device.error).map(device => <p className="global-instructions-error" role="alert" key={device.host}>{device.name}: {device.error}</p>)}
      {source && <>
        <details className="global-source-content"><summary>Review selected content</summary><pre>{source.content}</pre></details>
        <div className="global-destinations"><strong>Sync to other devices</strong>{destinations.map(device => {
          const current = device.files.find(file => file.path === source.path);
          const identical = current?.sha256 === source.sha256;
          return <label key={device.host}><input type="checkbox" checked={!device.error && (targetHosts === null || targetHosts.includes(device.host))} disabled={busy || Boolean(device.error)} onChange={event => setTargetHosts(event.target.checked ? [...targets.map(target => target.host), device.host] : targets.map(target => target.host).filter(host => host !== device.host))} /><span>{device.name}<small>~/{source.path}</small></span><small>{device.error ? "Unavailable" : identical ? <><Check size={12} />Identical</> : current ? "Different" : "Missing"}</small></label>;
        })}{!destinations.length && <p className="set-note">Add another device in Settings to sync instructions.</p>}</div>
        <p className="set-note">Timestamps depend on each device’s clock. Review the content before choosing your source.</p>
        <div className="global-instructions-footer"><button className="btn btn-accent" disabled={busy || !targets.length} onClick={() => void preview()}>{busy ? "Checking…" : "Preview sync"}<ArrowRight size={14} /></button></div>
      </>}
    </>}
  </div>;
}
