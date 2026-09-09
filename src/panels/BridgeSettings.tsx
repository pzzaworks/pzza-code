import { useStore } from "../state/store";
import { deviceHost } from "../devices";
import { Select } from "../ui/Select";
import { useDelayedLoading } from "../ui/useDelayedLoading";
import { AsyncButton } from "../ui/AsyncButton";
import { useEffect, useState } from "react";
import { Copy, Plus, X, RefreshCw, Loader2, Save, Ban } from "lucide-react";
import { BRIDGE_CAPABILITIES, fetchBridgePeerIdentity, fetchBridgeState, fetchBridgeJobs, fetchBridgeAudit, saveBridgeConfig, approveBridgeJob, cancelBridgeJob, type BridgeState, type BridgeConfig, type BridgePeer, type BridgeJob, type BridgeAuditEntry } from "../bridgeApi";
import "./BridgeSettings.css";

export function BridgeSettings({ active = true, page = "access" }: { active?: boolean; page?: "access" | "activity" }) {
  const devices = useStore(store => store.devices);
  const [state, setState] = useState<BridgeState | null>(null);
  const [draft, setDraft] = useState<BridgeConfig | null>(null);
  const [jobs, setJobs] = useState<BridgeJob[]>([]);
  const [audit, setAudit] = useState<BridgeAuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const toggleSpinner = useDelayedLoading(pendingAction === "toggle");
  const [note, setNote] = useState("");
  const [pairing, setPairing] = useState("");
  const [label, setLabel] = useState("");
  const [host, setHost] = useState("");
  const [projectId, setProjectId] = useState("");
  const [root, setRoot] = useState("");
  const report = (e: unknown) => setError(e instanceof Error ? e.message : "Bridge request failed.");
  useEffect(() => {
    if (!active) return;
    let alive = true;
    void fetchBridgeState().then(value => {
      if (!alive) return;
      setState(value); setDraft(current => current ?? value.config); setJobs(value.jobs); setAudit(value.audit ?? []); setError(null);
    }).catch(e => { if (alive) report(e); });
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (page === "activity" && document.visibilityState !== "hidden") {
        try {
          const [jobState, auditState] = await Promise.all([fetchBridgeJobs(), fetchBridgeAudit()]);
          if (alive) { setJobs(jobState.jobs); setAudit(auditState.audit); }
        } catch (e) { if (alive) report(e); }
      }
      if (alive) timer = setTimeout(() => void poll(), 5000);
    };
    timer = setTimeout(() => void poll(), 5000);
    return () => { alive = false; clearTimeout(timer); };
  }, [active, page]);
  const save = async (config: BridgeConfig, action = "save") => {
    setPendingAction(action); setBusy(true); setError(null); setNote("");
    try {
      const value = await saveBridgeConfig(config);
      setState(value); setDraft(value.config); setJobs(value.jobs); setAudit(value.audit ?? []); setNote("Bridge settings saved on this device.");
    } catch (e) { report(e); } finally { setBusy(false); setPendingAction(null); }
  };
  const updatePeer = (id: string, changes: Partial<BridgePeer>) => setDraft(current => current && ({ ...current, peers: current.peers.map(peer => peer.id === id ? { ...peer, ...changes } : peer) }));
  const pair = () => {
    if (!draft || !state) return;
    try {
      const value: unknown = JSON.parse(pairing);
      if (!value || typeof value !== "object" || !("id" in value) || !("publicKey" in value) || typeof value.id !== "string" || typeof value.publicKey !== "string") throw new Error("Paste a device identity copied from its bridge settings.");
      if (!label.trim()) throw new Error("Give the device a name.");
      if (value.id === state.identity.id || draft.peers.some(peer => peer.id === value.id)) throw new Error("This device is already listed or is your own device.");
      setDraft({ ...draft, peers: [...draft.peers, { id: value.id, publicKey: value.publicKey, label: label.trim(), host: host.trim(), port: 5190, enabled: false, expiresAt: Date.now() + 3600000, projectIds: [], capabilities: [] }] });
      setPairing(""); setLabel(""); setHost(""); setError(null); setNote("Device added to your draft. Select its projects and permissions, then save bridge settings. Add this device’s identity on its peer as well.");
    } catch (e) { report(e); }
  };
  const jobAction = async (jobId: string, action: "approve" | "reject" | "cancel") => {
    setPendingAction(`${action}:${jobId}`); setBusy(true); setError(null);
    try {
      if (action === "cancel") await cancelBridgeJob(jobId);
      else await approveBridgeJob(jobId, action === "approve");
      setJobs((await fetchBridgeJobs()).jobs);
    } catch (e) { report(e); } finally { setBusy(false); setPendingAction(null); }
  };
  return <section className="settings-page bridge-settings">
    <div hidden={page !== "access"}>
    <div className="settings-row"><div className="settings-row-copy"><span>Enable device bridge</span><small>Allow paired devices to use approved projects.</small></div>
      <button type="button" className={`switch ${state?.config.enabled ? "switch-on" : ""}`} role="switch" aria-label="Enable device bridge" aria-checked={state?.config.enabled ?? false} disabled={!state || busy} aria-busy={pendingAction === "toggle"} onClick={() => state && void save({ ...state.config, enabled: !state.config.enabled }, "toggle")}><span className="switch-knob async-switch-knob">{toggleSpinner ? <Loader2 size={12} className="async-spinner" aria-hidden="true" /> : null}</span></button>
    </div>
    <p className="bridge-notice">Disabled by default. Turning it off revokes access and cancels bridge jobs.</p>
    <details className="bridge-disclosure"><summary>Execution and access scope</summary><p>Builds, terminal control, and UI tests execute code as this device’s user. Use a dedicated OS account for stronger isolation; these grants do not restrict SSH login itself.</p></details>
    </div>
    {error && <p className="bridge-error" role="alert">{error}</p>}
    {note && <p className="bridge-note" role="status">{note}</p>}
    {!state || !draft ? <AsyncButton className="btn" loading={busy || (!state && !error)} icon={RefreshCw} onClick={() => { setPendingAction("connect"); setBusy(true); void fetchBridgeState().then(value => { setState(value); setDraft(value.config); setJobs(value.jobs); setAudit(value.audit ?? []); setError(null); }).catch(report).finally(() => { setBusy(false); setPendingAction(null); }); }}>{error ? "Retry connection" : "Connect to device agent"}</AsyncButton> : <>
      <div hidden={page !== "access"}>
      <div className="settings-section bridge-card">
        <div className="settings-row"><div className="settings-row-copy"><span>Pairing identity</span><small>Copy this device’s public identity to its peer.</small></div><AsyncButton className="btn btn-sm" loading={pendingAction === "copy"} disabled={busy} icon={Copy} iconSize={13} onClick={() => { setPendingAction("copy"); setBusy(true); void navigator.clipboard.writeText(JSON.stringify(state.identity)).then(() => setNote("Public device identity copied.")).catch(report).finally(() => { setBusy(false); setPendingAction(null); }); }}>Copy identity</AsyncButton></div>
        <details className="bridge-disclosure"><summary>Verify fingerprint</summary><code className="bridge-fingerprint">{state.identity.id}</code><p>Compare the full fingerprint through a trusted channel. No private key is shared.</p></details>
      </div>
      <div className="settings-section bridge-card"><h4>Approved projects <span className="bridge-count">{draft.projects.length}</span></h4>
        {draft.projects.map(project => <div className="bridge-project" key={project.id}><div><strong>{project.id}</strong><code>{project.root}</code></div><button className="btn btn-sm" aria-label={`Remove project ${project.id}`} disabled={busy} onClick={() => setDraft({ ...draft, projects: draft.projects.filter(item => item.id !== project.id), peers: draft.peers.map(peer => ({ ...peer, projectIds: peer.projectIds.filter(id => id !== project.id) })) })}><X size={13} /></button></div>)}
        <div className="settings-form bridge-form"><label>Project ID<input value={projectId} onChange={e => setProjectId(e.target.value)} placeholder="my-app" /></label><label>Absolute project folder<input value={root} onChange={e => setRoot(e.target.value)} placeholder="/Users/berke/projects/my-app" /></label></div>
        <button className="btn btn-sm" disabled={!projectId.trim() || !root.trim() || busy} onClick={() => {
          if (draft.projects.some(project => project.id === projectId.trim())) { setError("Project ID already exists."); return; }
          setDraft({ ...draft, projects: [...draft.projects, { id: projectId.trim(), root: root.trim() }] }); setProjectId(""); setRoot("");
        }}><Plus size={13} /> Add project</button>
      </div>
      <div className="settings-section bridge-card"><h4>Pair a device</h4><p>Add identities on both devices. Permissions below grant incoming access to this device; the other device controls its own grants.</p>
        {devices.some(device => deviceHost(device)) ? <div className="settings-form bridge-form"><label>Connected device<Select value={host} options={[{ value: "", label: "Choose a device" }, ...devices.filter(device => deviceHost(device)).map(device => ({ value: deviceHost(device), label: device.name }))]} onChange={value => { setHost(value); setLabel(devices.find(device => deviceHost(device) === value)?.name ?? ""); setPairing(""); }} /></label><AsyncButton className="btn btn-sm" disabled={busy || !host.trim()} loading={pendingAction === "identity"} icon={RefreshCw} onClick={() => { setPendingAction("identity"); setBusy(true); setError(null); void fetchBridgePeerIdentity(host.trim()).then(value => { setPairing(JSON.stringify(value.identity)); setNote("Verified this identity through the device's trusted SSH connection. Add it below and choose its access permissions."); }).catch(report).finally(() => { setBusy(false); setPendingAction(null); }); }}>Read pairing identity</AsyncButton></div> : null}
        <div className="settings-form bridge-form"><label>Device name<input value={label} onChange={e => setLabel(e.target.value)} placeholder="MacBook" /></label><label>Verified SSH alias<input value={host} onChange={e => setHost(e.target.value)} placeholder="macbook" /></label></div>
        <label className="settings-field bridge-field">Public pairing identity<textarea value={pairing} onChange={e => setPairing(e.target.value)} rows={3} spellCheck={false} /></label>
        <p>SSH host keys must already be verified. Leave the alias blank for incoming access only. Pairing does not connect until an action is requested.</p>
        <button className="btn btn-sm" disabled={!pairing.trim() || !label.trim() || busy} onClick={pair}><Plus size={13} /> Add paired device</button>
      </div>
      {draft.peers.map(peer => <details className="settings-section bridge-card bridge-peer" key={peer.id}>
        <summary><span>{peer.label}</span><span className="bridge-peer-status">{peer.enabled ? "Access enabled" : "Access disabled"}</span></summary>
        <div className="settings-row"><div className="settings-row-copy"><span>Incoming access</span><small>Applies to the projects and permissions below.</small></div><label className="bridge-check"><input type="checkbox" checked={peer.enabled} onChange={e => updatePeer(peer.id, { enabled: e.target.checked })} /> Allow bridge access</label></div>
        <code className="bridge-fingerprint">{peer.id}</code>
        <div className="settings-form bridge-form"><label>SSH alias<input value={peer.host} onChange={e => updatePeer(peer.id, { host: e.target.value })} /></label><label>Agent port<input type="number" min={1024} max={65535} value={peer.port} onChange={e => updatePeer(peer.id, { port: Number(e.target.value) })} /></label></div>
        <div className="bridge-expiry"><span>{peer.expiresAt ? `Access expires ${new Date(peer.expiresAt).toLocaleString()}` : "No access expiry set"}</span><select aria-label={`Extend access for ${peer.label}`} value="" onChange={e => updatePeer(peer.id, { expiresAt: Date.now() + Number(e.target.value) * 3600000 })}><option value="" disabled>Set expiry…</option><option value="1">In 1 hour</option><option value="8">In 8 hours</option><option value="24">In 1 day</option><option value="168">In 7 days</option></select></div>
        <fieldset><legend>Projects</legend>{draft.projects.length === 0 && <p>Add a project first.</p>}{draft.projects.map(project => <label className="bridge-check" key={project.id}><input type="checkbox" checked={peer.projectIds.includes(project.id)} onChange={e => updatePeer(peer.id, { projectIds: e.target.checked ? [...peer.projectIds, project.id] : peer.projectIds.filter(id => id !== project.id) })} />{project.id}</label>)}</fieldset>
        <fieldset><legend>Permissions</legend><div className="bridge-permissions">{BRIDGE_CAPABILITIES.map(([capability, title]) => <label className="bridge-check" key={capability}><input type="checkbox" checked={peer.capabilities.includes(capability)} onChange={e => updatePeer(peer.id, { capabilities: e.target.checked ? [...peer.capabilities, capability] : peer.capabilities.filter(item => item !== capability) })} />{title}</label>)}</div></fieldset>
        <AsyncButton className="btn btn-danger btn-sm" loading={pendingAction === `revoke:${peer.id}`} icon={Ban} disabled={busy} onClick={() => void save({ ...state.config, peers: state.config.peers.filter(item => item.id !== peer.id) }, `revoke:${peer.id}`)}>Revoke device now</AsyncButton>
      </details>)}
      <div className="settings-actions bridge-save"><span>Project and permission edits apply when saved.</span><AsyncButton className="btn btn-accent" loading={pendingAction === "save"} icon={Save} disabled={busy || JSON.stringify(draft) === JSON.stringify(state.config)} onClick={() => void save(draft)}>Save bridge settings</AsyncButton></div>
      </div>
      <div hidden={page !== "activity"}>
      <div className="settings-section bridge-card"><h4>Jobs and approvals <span className="bridge-count">{jobs.length}</span></h4><p>Closing this panel keeps jobs running. Approvals are only available here, never through remote MCP.</p>
        {jobs.length === 0 ? <p>No bridge jobs yet.</p> : jobs.slice(-20).reverse().map(job => <div className="bridge-job" key={job.id}><div><strong>{job.action}</strong><span>{job.status.replaceAll("_", " ")}</span></div><code>{job.id}</code>{job.projectId && <p>Project: {job.projectId}</p>}{job.approval && <div className="bridge-approval"><p>Artifact: {job.approval.artifact}<br />App Store destination: {job.approval.destination}<br />Submission project: {job.approval.serviceProjectId}</p><code className="bridge-fingerprint">SHA-256: {job.approval.sha256}</code></div>}{job.error && <p className="bridge-error">{job.error}</p>}{job.logs && job.logs.length > 0 && <details className="bridge-job-log"><summary>Activity log</summary><ol>{job.logs.map(entry => <li key={entry.cursor}><time>{new Date(entry.at).toLocaleTimeString()}</time> {entry.message}</li>)}</ol></details>}
          {job.status === "waiting_approval" ? <div className="settings-actions bridge-actions"><AsyncButton className="btn btn-accent" loading={pendingAction === `approve:${job.id}`} disabled={busy || !state.config.enabled} onClick={() => void jobAction(job.id, "approve")}>Approve this submission</AsyncButton><AsyncButton className="btn" loading={pendingAction === `reject:${job.id}`} disabled={busy} onClick={() => void jobAction(job.id, "reject")}>Reject</AsyncButton></div> : ["queued", "running"].includes(job.status) ? <AsyncButton className="btn btn-sm" loading={pendingAction === `cancel:${job.id}`} disabled={busy} onClick={() => void jobAction(job.id, "cancel")}>Cancel job</AsyncButton> : null}
        </div>)}
      </div>
      <div className="settings-section bridge-card"><h4>Recent activity</h4><p>Action metadata only. Terminal text, file contents, keys, and command output are not recorded here.</p>
        {audit.length === 0 ? <p>No authenticated bridge requests yet.</p> : <ol className="bridge-audit">{audit.slice(-20).reverse().map((entry, index) => <li key={`${entry.time}-${index}`}><div><strong>{entry.action}</strong><span>{entry.outcome}</span></div><small>{new Date(entry.time).toLocaleString()} · {state.config.peers.find(peer => peer.id === entry.peerId)?.label ?? entry.peerId.slice(0, 12)}{entry.projectId ? ` · ${entry.projectId}` : ""}</small></li>)}</ol>}
      </div>
      </div>
    </>}
  </section>;
}
