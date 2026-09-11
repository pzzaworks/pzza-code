import { confirmAction } from "../ui/ConfirmDialog";
import { useUnsavedDraft } from "../state/unsavedWork";
import { PathField } from "../ui/PathField";
import { useStore } from "../state/store";
import { deviceHost } from "../devices";
import { Select } from "../ui/Select";
import { useDelayedLoading } from "../ui/useDelayedLoading";
import { AsyncButton } from "../ui/AsyncButton";
import { useEffect, useRef, useState } from "react";
import { Copy, Plus, X, RefreshCw, Loader2, Save, Ban } from "lucide-react";
import { BRIDGE_CAPABILITIES, connectBridgeDevice, resumeBridgeConnection, getPendingBridgeConnectionId, dismissPendingBridgeConnection, BridgeConnectionPendingError, testBridgeConnection, fetchBridgePeerIdentity, fetchBridgeState, fetchBridgeJobs, fetchBridgeAudit, saveBridgeConfig, approveBridgeJob, cancelBridgeJob, decideBridgeConfigApproval, type BridgeConfigApproval, type BridgeState, type BridgeConfig, type BridgePeer, type BridgeJob, type BridgeAuditEntry, type BridgeConnectionResult } from "../bridgeApi";
import "./BridgeSettings.css";

// Suggest a project ID from a folder path so the user rarely types one.
function baseProjectId(path: string): string {
  const base = path.replace(/\/$/, "").split("/").pop() ?? "";
  return base.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

export function BridgeSettings({ active = true, page = "access" }: { active?: boolean; page?: "access" | "activity" }) {
  const devices = useStore(store => store.devices);
  const [state, setState] = useState<BridgeState | null>(null);
  const [draft, setDraft] = useState<BridgeConfig | null>(null);
  const [jobs, setJobs] = useState<BridgeJob[]>([]);
  const [approvals, setApprovals] = useState<BridgeConfigApproval[]>([]);
  const [audit, setAudit] = useState<BridgeAuditEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const toggleSpinner = useDelayedLoading(pendingAction === "toggle");
  const [note, setNote] = useState("");
  const [pairing, setPairing] = useState("");
  const [label, setLabel] = useState("");
  const [host, setHost] = useState("");
  const [projectId, setProjectId] = useState("");
  const [root, setRoot] = useState("");
  const [remoteProjectId, setRemoteProjectId] = useState("");
  const [remoteRoot, setRemoteRoot] = useState("");
  const [verifiedIdentity, setVerifiedIdentity] = useState<{ host: string; id: string } | null>(null);
  const [connectionId, setConnectionId] = useState(getPendingBridgeConnectionId);
  const [connectionMissing, setConnectionMissing] = useState(false);
  const cleanConfig = useRef<{ json: string; hash: string } | null>(null);
  const dirty = !!state && !!draft && JSON.stringify(draft) !== JSON.stringify(state.config);
  useUnsavedDraft("device-bridge", { label: "Device bridge settings", dirty, saving: busy, revision: JSON.stringify(draft) });
  const report = (e: unknown) => setError(e instanceof Error ? e.message : "Bridge request failed.");
  const acceptSavedState = (value: BridgeState) => {
    cleanConfig.current = { json: JSON.stringify(value.config), hash: value.configHash };
    setState(value); setDraft(value.config); setJobs(value.jobs); setAudit(value.audit ?? []); setApprovals(value.approvals ?? []);
  };
  useEffect(() => {
    if (!active) return;
    let alive = true;
    void fetchBridgeState().then(value => {
      if (!alive) return;
      const previousClean = cleanConfig.current;
      setState(value);
      setDraft(current => {
        if (current && JSON.stringify(current) !== previousClean?.json) return current;
        cleanConfig.current = { json: JSON.stringify(value.config), hash: value.configHash };
        return value.config;
      });
      setJobs(value.jobs); setAudit(value.audit ?? []); setApprovals(value.approvals ?? []); setError(null);
    }).catch(e => { if (alive) report(e); });
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      if (document.visibilityState !== "hidden") setNow(Date.now());
      if (page === "activity" && document.visibilityState !== "hidden") {
        try {
          const [jobState, auditState, live] = await Promise.all([fetchBridgeJobs(), fetchBridgeAudit(), fetchBridgeState()]);
          if (alive) { setJobs(jobState.jobs); setAudit(auditState.audit); setApprovals(live.approvals ?? []); }
        } catch (e) { if (alive) report(e); }
      }
      if (alive) timer = setTimeout(() => void poll(), 5000);
    };
    timer = setTimeout(() => void poll(), 5000);
    return () => { alive = false; clearTimeout(timer); };
  }, [active, page]);
  const save = async (config: BridgeConfig, action = "save") => {
    if (!await confirmAction({ title: action.startsWith("revoke:") ? "Revoke device access?" : "Apply device access settings?", message: "Confirm the exact projects, permissions, resource scopes and expiry shown here. Disabling access cancels jobs and detaches browser connections. Terminal, build and test access runs as your OS user, not in a sandbox. Expired grants are not renewed unless you explicitly changed their expiry.", confirmLabel: action.startsWith("revoke:") ? "Revoke access" : "Apply settings", danger: true })) return;
    setPendingAction(action); setBusy(true); setError(null); setNote("");
    try {
      if (!cleanConfig.current) throw new Error("Reload bridge settings before saving.");
      const normalized = { ...config, peers: config.peers.map(peer => ({ ...peer, ...(peer.resources ? { resources: { simulatorIds: peer.resources.simulatorIds.map(value => value.trim()).filter(Boolean), bundleIds: peer.resources.bundleIds.map(value => value.trim()).filter(Boolean), browserOrigins: peer.resources.browserOrigins.map(value => value.trim()).filter(Boolean) } } : {}) })) };
      const value = await saveBridgeConfig(normalized, cleanConfig.current.hash);
      acceptSavedState(value); setNote("Bridge settings saved on this device.");
    } catch (e) { report(e); } finally { setBusy(false); setPendingAction(null); }
  };
  const reload = async () => {
    if (dirty && !await confirmAction({ title: "Discard bridge edits?", message: "Reloading replaces all unsaved permission and project changes with the saved settings.", confirmLabel: "Discard edits", danger: true })) return;
    setPendingAction("reload"); setBusy(true); setError(null); setNote("");
    try {
      acceptSavedState(await fetchBridgeState());
      setNote("Loaded current bridge settings. Unsaved edits were discarded.");
    } catch (e) { report(e); } finally { setBusy(false); setPendingAction(null); }
  };
  const updatePeer = (id: string, changes: Partial<BridgePeer>) => setDraft(current => current && ({ ...current, peers: current.peers.map(peer => peer.id === id ? { ...peer, ...changes } : peer) }));
  const acceptConnection = (result: BridgeConnectionResult) => {
    acceptSavedState(result.state);
    setPairing(""); setVerifiedIdentity(null);
    setNote(`Connection verified. Remote projects: ${result.connection.projects.map(project => project.id).join(", ")}. Permissions: ${result.connection.capabilities.join(", ")}. Expires ${new Date(result.connection.expiresAt).toLocaleString()}. This device grants no incoming project permissions.`);
  };
  const connect = async () => {
    if (!verifiedIdentity || verifiedIdentity.host !== host.trim() || connectionId) return;
    if (!await confirmAction({ title: "Request device pairing?", message: `Request eight hours of file and terminal read access to ${remoteRoot} on ${host}? A person must also approve in the receiving desktop app. No incoming rights are granted here.`, confirmLabel: "Request pairing" })) return;
    setPendingAction("pair"); setBusy(true); setError(null); setNote("");
    try {
      acceptConnection(await connectBridgeDevice({ host: host.trim(), identityId: verifiedIdentity.id, label: label.trim(), localLabel: devices.find(device => !deviceHost(device))?.name ?? "This Device", project: { id: remoteProjectId.trim(), root: remoteRoot.trim() }, capabilities: ["files.read", "terminal.read"], expiresAt: Date.now() + 8 * 3600000 }));
    } catch (e) { report(e); } finally { setConnectionId(getPendingBridgeConnectionId()); setBusy(false); setPendingAction(null); }
  };
  const checkConnection = async () => {
    if (!connectionId) return;
    setPendingAction("pair-status"); setBusy(true); setError(null); setNote("");
    try { acceptConnection(await resumeBridgeConnection(connectionId)); setConnectionMissing(false); }
    catch (e) { setConnectionMissing(e instanceof BridgeConnectionPendingError && e.noLongerRetained); report(e); }
    finally { setConnectionId(getPendingBridgeConnectionId()); setBusy(false); setPendingAction(null); }
  };
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
    const job = jobs.find(item => item.id === jobId);
    if (!job || !await confirmAction({ title: `${action === "approve" ? "Approve" : action === "reject" ? "Reject" : "Cancel"} ${job.action}?`, message: `${JSON.stringify(job.approval ?? { project: job.projectId }, null, 2)}\nThis decision is bound to this exact pending action. External operations already accepted may continue after cancellation.`, confirmLabel: action === "approve" ? "Approve exact action" : action === "reject" ? "Reject action" : "Cancel job", danger: true })) return;
    setPendingAction(`${action}:${jobId}`); setBusy(true); setError(null);
    try {
      if (action === "cancel") await cancelBridgeJob(jobId);
      else { if (!job.approvalDigest) throw new Error("Reload the exact pending approval before deciding."); await approveBridgeJob(jobId, job.approvalDigest, action === "approve"); }
      setJobs((await fetchBridgeJobs()).jobs);
    } catch (e) { report(e); } finally { setBusy(false); setPendingAction(null); }
  };
  const configApprovalAction = async (approval: BridgeConfigApproval, approved: boolean) => {
    if (!await confirmAction({ title: approved ? "Grant requested device access?" : "Reject requested access?", message: JSON.stringify(approval.config, null, 2) + "\nOnly the exact reviewed configuration will apply. Terminal/build/test execution is not an OS sandbox.", confirmLabel: approved ? "Grant exact access" : "Reject request", danger: true })) return;
    setBusy(true); setPendingAction(`config:${approval.id}`); setError(null);
    try { await decideBridgeConfigApproval(approval.id, approval.digest, approved); const live = await fetchBridgeState(); setApprovals(live.approvals ?? []); if (!dirty) acceptSavedState(live); }
    catch (e) { report(e); } finally { setBusy(false); setPendingAction(null); }
  };
  return <section className="settings-page bridge-settings">
    <div hidden={page !== "access"}>
    <div className="settings-row"><div className="settings-row-copy"><span>Enable device bridge</span><small>Allow paired devices to use approved projects.</small></div>
      <button type="button" className={`switch ${state?.config.enabled ? "switch-on" : ""}`} role="switch" aria-label="Enable device bridge" aria-checked={state?.config.enabled ?? false} disabled={!state || busy || dirty} aria-busy={pendingAction === "toggle"} onClick={() => state && void save({ ...state.config, enabled: !state.config.enabled }, "toggle")}><span className="switch-knob async-switch-knob">{toggleSpinner ? <Loader2 size={12} className="async-spinner" aria-hidden="true" /> : null}</span></button>
    </div>
    {state && !state.nativeConsentAvailable && <p className="bridge-notice" role="status">Native confirmation is unavailable on this agent. Open the updated receiving desktop app before granting access or approving jobs. Ordinary MCP credentials cannot approve.</p>}
    <p className="bridge-notice">Turning it off revokes access and cancels bridge jobs. Save project and permission edits before changing the bridge switch.</p>
    <details className="bridge-disclosure"><summary>Execution and access scope</summary><p>Builds, terminal control, and UI tests execute code as this device’s user. Use a dedicated OS account for stronger isolation; these grants do not restrict SSH login itself.</p></details>
    </div>
    {error && <p className="bridge-error" role="alert">{error}</p>}
    {note && <p className="bridge-note" role="status">{note}</p>}
    {connectionId && <div className="bridge-card"><p role="status">Pairing outcome is pending confirmation. Checking does not repeat grants.</p><code className="bridge-fingerprint">{connectionId}</code><AsyncButton className="btn btn-sm" icon={RefreshCw} loading={pendingAction === "pair-status"} disabled={busy || dirty} onClick={() => void checkConnection()}>Check pairing status</AsyncButton>{dirty && <p>Save or reload current edits before checking pairing status.</p>}{connectionMissing && <><p>The operation is no longer retained. Review both devices' bridge settings and revoke any unwanted grants before dismissing tracking.</p><button className="btn btn-sm" disabled={busy} onClick={() => { dismissPendingBridgeConnection(connectionId); setConnectionId(null); setConnectionMissing(false); setError(null); setNote("Pending tracking dismissed. No device grants were changed."); }}>I reviewed both devices - dismiss tracking</button></>}</div>}
    {!state || !draft ? <AsyncButton className="btn" loading={busy || (!state && !error)} icon={RefreshCw} onClick={() => void reload()}>{error ? "Retry connection" : "Connect to device agent"}</AsyncButton> : <>
      <div hidden={page !== "access"}>
      <div className="settings-section bridge-card">
        <div className="settings-row"><div className="settings-row-copy"><span>Pairing identity</span><small>Copy this device’s public identity to its peer.</small></div><AsyncButton className="btn btn-sm" loading={pendingAction === "copy"} disabled={busy} icon={Copy} iconSize={13} onClick={() => { setPendingAction("copy"); setBusy(true); void navigator.clipboard.writeText(JSON.stringify(state.identity)).then(() => setNote("Public device identity copied.")).catch(report).finally(() => { setBusy(false); setPendingAction(null); }); }}>Copy identity</AsyncButton></div>
        <details className="bridge-disclosure"><summary>Verify fingerprint</summary><code className="bridge-fingerprint">{state.identity.id}</code><p>Compare the full fingerprint through a trusted channel. No private key is shared.</p></details>
      </div>
      <div className="settings-section bridge-card"><h4>Approved projects <span className="bridge-count">{draft.projects.length}</span></h4>
        {draft.projects.map(project => <div className="bridge-project" key={project.id}><div><strong>{project.id}</strong><code>{project.root}</code></div><button className="btn btn-sm" aria-label={`Remove project ${project.id}`} disabled={busy} onClick={() => void confirmAction({ title: "Remove project access?", message: `Remove ${project.id} from every device grant when these edits are saved?`, confirmLabel: "Remove project", danger: true }).then(confirmed => { if (confirmed) setDraft({ ...draft, projects: draft.projects.filter(item => item.id !== project.id), peers: draft.peers.map(peer => ({ ...peer, projectIds: peer.projectIds.filter(id => id !== project.id) })) }); })}><X size={13} /></button></div>)}
        <div className="settings-form bridge-form"><label>Project ID<input value={projectId} onChange={e => setProjectId(e.target.value)} placeholder="my-app" /></label><label>Project folder on this device<PathField value={root} onChange={value => { setRoot(value); setProjectId(current => current.trim() ? current : baseProjectId(value)); }} host="" fixedHost disabled={busy} placeholder="Choose local project folder" /></label></div>
        <button className="btn btn-sm" disabled={!projectId.trim() || !root.trim() || busy} onClick={() => {
          if (draft.projects.some(project => project.id === projectId.trim())) { setError("Project ID already exists."); return; }
          setDraft({ ...draft, projects: [...draft.projects, { id: projectId.trim(), root: root.trim() }] }); setProjectId(""); setRoot("");
        }}><Plus size={13} /> Add project</button>
      </div>
      <div className="settings-section bridge-card"><h4>Connect to a device project</h4><p>Pick one of your connected devices, verify it, then choose the exact project you want to read. Setup pairs both agents and tests their signed connection.</p>
        {devices.some(device => deviceHost(device)) ? <div className="settings-form bridge-form"><label>Connected device<Select value={host} options={[{ value: "", label: "Choose a device" }, ...devices.filter(device => deviceHost(device)).map(device => ({ value: deviceHost(device), label: device.name }))]} onChange={value => { setHost(value); setRemoteRoot(""); setLabel(devices.find(device => deviceHost(device) === value)?.name ?? ""); setPairing(""); setVerifiedIdentity(null); }} /></label><AsyncButton className="btn btn-sm" disabled={busy || !host.trim()} loading={pendingAction === "identity"} icon={RefreshCw} onClick={() => { setPendingAction("identity"); setBusy(true); setError(null); void fetchBridgePeerIdentity(host.trim()).then(value => { setPairing(JSON.stringify(value.identity)); setVerifiedIdentity({ host: host.trim(), id: value.identity.id }); setNote("Device identity verified through trusted SSH. Choose its project folder below to connect with read-only access."); }).catch(report).finally(() => { setBusy(false); setPendingAction(null); }); }}>Read pairing identity</AsyncButton></div> : null}
        <div className="settings-form bridge-form"><label>Device name<input value={label} onChange={e => setLabel(e.target.value)} placeholder="MacBook" /></label>{devices.some(device => deviceHost(device)) ? null : <label>SSH alias<input value={host} onChange={e => { setHost(e.target.value); setRemoteRoot(""); setVerifiedIdentity(null); }} placeholder="macbook" /><small>No configured devices - type a trusted SSH alias instead.</small></label>}</div>
        {verifiedIdentity?.host === host.trim() && <div className="bridge-card">
          <div className="settings-form bridge-form"><label>Project ID on device<input value={remoteProjectId} onChange={e => setRemoteProjectId(e.target.value)} placeholder="my-app" /></label><label>Project folder on device<PathField value={remoteRoot} onChange={(value, pickedHost) => { if (pickedHost === host.trim()) { setRemoteRoot(value); setRemoteProjectId(current => current.trim() ? current : baseProjectId(value)); } }} host={host.trim()} fixedHost disabled={busy || !verifiedIdentity} placeholder="Choose folder on verified device" /></label></div>
          <p>The receiving person must approve this request in their desktop app. Read project files and project terminal output for 8 hours. No file edits, terminal commands, builds, or submissions. No incoming project permissions are granted to this device.</p>
          {dirty && <p>Save your current bridge edits before connecting.</p>}
          <AsyncButton className="btn btn-accent" loading={pendingAction === "pair"} disabled={busy || dirty || !!connectionId || !remoteProjectId.trim() || !remoteRoot.trim() || !label.trim()} onClick={() => void connect()}>Request read-only pairing</AsyncButton>
        </div>}
        <details className="bridge-disclosure"><summary>Manual incoming pairing</summary><p>For incoming access, add this identity here and add this device identity in the other device’s bridge settings. Choose local project grants below.</p>
        <label className="settings-field bridge-field">Public pairing identity<textarea value={pairing} onChange={e => setPairing(e.target.value)} rows={3} spellCheck={false} /></label>
        <p>SSH host keys must already be verified. Leave the alias blank for incoming access only. Pairing does not connect until an action is requested.</p>
        <button className="btn btn-sm" disabled={!pairing.trim() || !label.trim() || busy} onClick={pair}><Plus size={13} /> Add paired device</button></details>
      </div>
      {draft.peers.map(peer => <details className="settings-section bridge-card bridge-peer" key={peer.id}>
        <summary><span>{peer.label}</span><span className="bridge-peer-status">{dirty ? "Unsaved access changes" : !state.config.enabled ? "Bridge disabled" : !peer.enabled ? "Access disabled" : !peer.expiresAt || peer.expiresAt <= now ? "Access expired" : peer.capabilities.length && peer.projectIds.length ? "Project access enabled" : "Connected without local project access"}</span></summary>
        <div className="settings-row"><div className="settings-row-copy"><span>Device pairing</span><small>Incoming project access is limited to the selections below.</small></div><label className="bridge-check"><input type="checkbox" disabled={busy} checked={peer.enabled} onChange={e => updatePeer(peer.id, { enabled: e.target.checked })} /> Enable pairing</label></div>
        <code className="bridge-fingerprint">{peer.id}</code>
        {peer.host && <AsyncButton className="btn btn-sm" loading={pendingAction === `test:${peer.id}`} disabled={busy || dirty || !state.config.enabled || !peer.enabled} icon={RefreshCw} onClick={() => {
          setPendingAction(`test:${peer.id}`); setBusy(true); setError(null);
          void testBridgeConnection(peer.id).then(connection => setNote(`Verified ${peer.label}: ${connection.projects.map(project => project.id).join(", ") || "no project grants"}. Permissions: ${connection.capabilities.join(", ") || "none"}. Expires ${new Date(connection.expiresAt).toLocaleString()}.`)).catch(report).finally(() => { setBusy(false); setPendingAction(null); });
        }}>Test connection</AsyncButton>}
        <div className="settings-form bridge-form"><label>SSH alias<input value={peer.host} onChange={e => updatePeer(peer.id, { host: e.target.value })} /></label><label>Agent port<input type="number" min={1024} max={65535} value={peer.port} onChange={e => updatePeer(peer.id, { port: Number(e.target.value) })} /></label></div>
        <div className="bridge-expiry"><span>{peer.expiresAt ? `Access expires ${new Date(peer.expiresAt).toLocaleString()}` : "No access expiry set"}</span><select aria-label={`Extend access for ${peer.label}`} value="" onChange={e => updatePeer(peer.id, { expiresAt: Date.now() + Number(e.target.value) * 3600000 })}><option value="" disabled>Set expiry…</option><option value="1">In 1 hour</option><option value="8">In 8 hours</option><option value="24">In 1 day</option><option value="168">In 7 days</option></select></div>
        <fieldset><legend>Projects</legend>{draft.projects.length === 0 && <p>Add a project first.</p>}{draft.projects.map(project => <label className="bridge-check" key={project.id}><input type="checkbox" disabled={busy} checked={peer.projectIds.includes(project.id)} onChange={e => updatePeer(peer.id, { projectIds: e.target.checked ? [...peer.projectIds, project.id] : peer.projectIds.filter(id => id !== project.id) })} />{project.id}</label>)}</fieldset>
        <fieldset><legend>Permissions</legend><div className="bridge-permissions">{BRIDGE_CAPABILITIES.map(([capability, title]) => <label className="bridge-check" key={capability}><input type="checkbox" disabled={busy} checked={peer.capabilities.includes(capability)} onChange={e => updatePeer(peer.id, { capabilities: e.target.checked ? [...peer.capabilities, capability] : peer.capabilities.filter(item => item !== capability) })} />{title}</label>)}</div></fieldset>
        <fieldset><legend>Explicit resource scopes</legend><p>Empty scopes deny simulator and browser resources. Browser grants start off. Only one human-selected tab on a listed origin can attach; extension side panels are not supported.</p><div className="settings-form bridge-form">{(["simulatorIds", "bundleIds", "browserOrigins"] as const).map(key => <label key={key}>{key === "simulatorIds" ? "Simulator UUIDs" : key === "bundleIds" ? "App bundle identifiers" : "Browser origins (https://example.com)"}<textarea rows={2} disabled={busy} value={(peer.resources?.[key] ?? []).join("\n")} onChange={event => updatePeer(peer.id, { resources: { simulatorIds: [], bundleIds: [], browserOrigins: [], ...peer.resources, [key]: event.target.value.split("\n") } })} spellCheck={false} /></label>)}</div><p>Use account-authorized resource discovery for simulator IDs before granting them. Build scripts and test flows can execute other code as your account; these lists are not OS isolation.</p></fieldset>
        <AsyncButton className="btn btn-danger btn-sm" loading={pendingAction === `revoke:${peer.id}`} icon={Ban} disabled={busy || dirty} onClick={() => void save({ ...state.config, peers: state.config.peers.filter(item => item.id !== peer.id) }, `revoke:${peer.id}`)}>Revoke device now</AsyncButton>
      </details>)}
      <div className="settings-actions bridge-save"><span>Project and permission edits apply when saved. Reloading discards unsaved edits.</span><AsyncButton className="btn" loading={pendingAction === "reload"} icon={RefreshCw} disabled={busy} onClick={() => void reload()}>Reload saved settings</AsyncButton><AsyncButton className="btn btn-accent" loading={pendingAction === "save"} icon={Save} disabled={busy || JSON.stringify(draft) === JSON.stringify(state.config)} onClick={() => void save(draft)}>Save bridge settings</AsyncButton></div>
      </div>
      <div hidden={page !== "activity"}>
      <div className="settings-section bridge-card"><h4>Receiving-device access requests</h4>{approvals.filter(item => item.status === "waiting_approval").length === 0 ? <p>No pending access requests.</p> : approvals.filter(item => item.status === "waiting_approval").map(approval => <div className="bridge-job" key={approval.id}><strong>Requested project and permission changes</strong><code>{approval.id}</code><p>Expires {new Date(approval.expiresAt).toLocaleString()}. Compare the device fingerprint and project paths before granting.</p><pre className="bridge-config-preview">{JSON.stringify(approval.config, null, 2)}</pre><div className="settings-actions"><AsyncButton className="btn btn-accent" loading={pendingAction === `config:${approval.id}`} disabled={busy || !state.nativeConsentAvailable} onClick={() => void configApprovalAction(approval, true)}>Review and grant</AsyncButton><button className="btn" disabled={busy || !state.nativeConsentAvailable} onClick={() => void configApprovalAction(approval, false)}>Reject</button></div></div>)}</div>
      <div className="settings-section bridge-card"><h4>Jobs and approvals <span className="bridge-count">{jobs.length}</span></h4><p>Closing this panel keeps jobs running. Approvals are only available here, never through remote MCP.</p>
        {jobs.length === 0 ? <p>No bridge jobs yet.</p> : jobs.slice(-20).reverse().map(job => <div className="bridge-job" key={job.id}><div><strong>{job.action}</strong><span>{job.status.replaceAll("_", " ")}</span></div><code>{job.id}</code>{job.projectId && <p>Project: {job.projectId}</p>}{job.approval?.kind === "browser" && <pre className="bridge-config-preview">{JSON.stringify(job.approval, null, 2)}</pre>}{job.approval && job.approval.kind !== "browser" && <div className="bridge-approval"><p>Artifact: {job.approval.artifact}<br />App Store destination: {job.approval.destination}<br />Submission project: {job.approval.serviceProjectId}</p><code className="bridge-fingerprint">SHA-256: {job.approval.sha256}</code></div>}{job.error && <p className="bridge-error">{job.error}</p>}{job.logs && job.logs.length > 0 && <details className="bridge-job-log"><summary>Activity log</summary><ol>{job.logs.map(entry => <li key={entry.cursor}><time>{new Date(entry.at).toLocaleTimeString()}</time> {entry.message}</li>)}</ol></details>}
          {job.status === "waiting_approval" ? <div className="settings-actions bridge-actions"><AsyncButton className="btn btn-accent" loading={pendingAction === `approve:${job.id}`} disabled={busy || !state.config.enabled || !state.nativeConsentAvailable} onClick={() => void jobAction(job.id, "approve")}>Approve exact action</AsyncButton><AsyncButton className="btn" loading={pendingAction === `reject:${job.id}`} disabled={busy || !state.nativeConsentAvailable} onClick={() => void jobAction(job.id, "reject")}>Reject</AsyncButton></div> : ["queued", "running"].includes(job.status) ? <AsyncButton className="btn btn-sm" loading={pendingAction === `cancel:${job.id}`} disabled={busy} onClick={() => void jobAction(job.id, "cancel")}>Cancel job</AsyncButton> : null}
        </div>)}
      </div>
      <div className="settings-section bridge-card"><h4>Recent activity</h4><p>Action metadata only. Terminal text, file contents, keys, and command output are not recorded here.</p>
        {audit.length === 0 ? <p>No authenticated bridge requests yet.</p> : <ol className="bridge-audit">{audit.slice(-20).reverse().map((entry, index) => <li key={`${entry.time}-${index}`}><div><strong>{entry.action}</strong><span>{entry.outcome}</span></div><small>{new Date(entry.time).toLocaleString()} · {state.config.peers.find(peer => peer.id === entry.peerId)?.label ?? entry.peerId.slice(0, 12)}{entry.projectId ? ` · ${entry.projectId}` : ""}</small></li>)}</ol>}
      </div>
      </div>
    </>}
  </section>;
}
