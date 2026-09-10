import { registerAppControlHandler, registerAppControlState } from "../appControlRuntime";
import { AsyncButton } from "../ui/AsyncButton";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Bot, BookOpen, FileText, Layers, Play, Plus, RefreshCw, Save, Search, ArrowLeft, ChevronRight, X } from "lucide-react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { useStore } from "../state/store";
import { HAS_TAURI } from "../tauriEnv";
import { openUrl } from "../forward";
import { notify } from "../state/notifications";
import { deviceHost } from "../devices";
import { Select } from "../ui/Select";
import { ScrollMore } from "../ui/ScrollMore";
import { GlobalInstructions } from "./GlobalInstructions";
import { FilePicker } from "./FilePicker";
import { fetchHub, saveHub, previewHub, applyHub, importHubSkill, type HubState, type HubProfile, type HubPreview } from "../agentsHubApi";
import { SKILL_CATALOG } from "../agentsHubCatalog";
import "./AgentsHub.css";

export type AgentsHubSection = "instructions" | "documents" | "skills" | "discover" | "profiles" | "deployments";
export const agentsHubSections = [{ id: "instructions", label: "Global instructions", icon: FileText }, { id: "documents", label: "Project instructions", icon: FileText }, { id: "skills", label: "My skills", icon: BookOpen }, { id: "discover", label: "Discover skills", icon: Search }, { id: "profiles", label: "Agent profiles", icon: Bot }, { id: "deployments", label: "Deployments", icon: Layers }] as const;
const uid = () => crypto.randomUUID();
function MarkdownPreview({ content }: { content: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(content, { async: false }), { USE_PROFILES: { html: true }, FORBID_TAGS: ["img", "iframe", "style", "video", "audio", "source", "form", "input", "button", "select", "textarea", "meta", "link"], FORBID_ATTR: ["style"] }), [content]);
  return <div className="md-preview ah-markdown" onClick={event => {
    const anchor = event.target instanceof Element ? event.target.closest("a") : null;
    if (anchor) { event.preventDefault(); if (anchor.protocol === "https:" || anchor.protocol === "http:") window.open(anchor.href, "_blank", "noopener,noreferrer"); }
  }} dangerouslySetInnerHTML={{ __html: html }} />;
}

interface AgentsHubProps {
  active: boolean;
  section: AgentsHubSection;
  onSectionChange(section: AgentsHubSection): void;
  onOpenSession(): void;
}
export function AgentsHubContent({ active, section, onSectionChange, onOpenSession }: AgentsHubProps) {
  const librarySection = useRef<Exclude<AgentsHubSection, "instructions">>("skills");
  if (section !== "instructions") librarySection.current = section;
  return <>
    <div hidden={section !== "instructions"}><GlobalInstructions active={active && section === "instructions"} /></div>
    <AgentsHubLibrary active={active && section !== "instructions"} section={librarySection.current} onSectionChange={onSectionChange} onOpenSession={onOpenSession} />
  </>;
}

function AgentsHubLibrary({ active, section: tab, onSectionChange, onOpenSession }: Omit<AgentsHubProps, "section"> & { section: Exclude<AgentsHubSection, "instructions"> }) {
  const [state, setState] = useState<HubState | null>(null);
  const [dirty, setDirty] = useState(false);
  const [selected, setSelected] = useState("");
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(12);
  const [rendered, setRendered] = useState(false);
  const [deployProfile, setDeployProfile] = useState<string | null>(null);
  const [targets, setTargets] = useState<{ host: string; cwd: string }[]>([{ host: "", cwd: "" }]);
  const [previews, setPreviews] = useState<HubPreview[]>([]);
  const [adoptExisting, setAdoptExisting] = useState(false);
  const [picker, setPicker] = useState<number | null>(null);
  const refreshing = useRef(false);
  const devices = useStore(store => store.devices);
  const deploying = Boolean(deployProfile);
  const currentProfile = state?.profiles.find(profile => profile.id === deployProfile);
  const addAllDevices = () => {
    setTargets(devices.map(device => {
      const host = deviceHost(device);
      return targets.find(target => target.host === host) ?? { host, cwd: "" };
    }));
    setPreviews([]);
  };
  const visitSource = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!HAS_TAURI) return;
    event.preventDefault();
    void openUrl(event.currentTarget.href).catch((cause: unknown) => report(cause));
  };
  const report = (cause: unknown) => setError(cause instanceof Error ? cause.message : "Agents Hub operation failed.");
  const refresh = async () => { if (refreshing.current) return; refreshing.current = true; setPendingAction("refresh"); setBusy(true); setError(""); try {
    setState(await fetchHub());
    setDirty(false); setPreviews([]); } catch (cause) { report(cause); } finally { refreshing.current = false; setBusy(false); setPendingAction(null); } };
  useEffect(() => { if (active && !dirty) void refresh(); }, [active]);
  useEffect(() => {
    if (!active) setPicker(null);
  }, [active]);
  const edit = (update: (value: HubState) => HubState) => { if (busy) return; setState(value => value ? update(value) : value); setDirty(true); setPreviews([]); setNote(""); };
  const save = async () => {
    if (!state) return;
    setPendingAction("save"); setBusy(true); setError("");
    try { setState(await saveHub(state)); setDirty(false); setPreviews([]); setNote("Library saved on this device."); }
    catch (cause) { report(cause); } finally { setBusy(false); setPendingAction(null); }
  };
  useEffect(() => {
    setSelected(""); setQuery(""); setLimit(12); setRendered(false);
    setDeployProfile(null); setPreviews([]); setPicker(null);
  }, [tab]);
  const add = () => {
    const id = uid();
    edit(value => tab === "documents" ? { ...value, documents: [...value.documents, { id, name: "New instructions", framework: value.frameworks.find(item => item.launchSupported)?.id ?? "claude", content: "" }] } : tab === "skills" ? { ...value, skills: [...value.skills, { id, name: "New skill", content: "" }] }
      : { ...value, profiles: [...value.profiles, { id, name: "New agent", framework: value.frameworks.find(item => item.launchSupported)?.id ?? "claude", systemPrompt: "", instructionIds: [], skillIds: [] }] });
    setSelected(id);
  };
  const editedDocument = tab === "documents" ? state?.documents.find(item => item.id === selected) : null;
  const selectedSkill = state?.skills.find(item => item.id === selected);
  const selectedProfile = state?.profiles.find(item => item.id === selected);
  const editedSkill = tab === "skills" ? selectedSkill : null;
  const patchProfile = (patch: Partial<HubProfile>) => edit(value => ({ ...value, profiles: value.profiles.map(profile => profile.id === selected ? { ...profile, ...patch } : profile) }));
  const startPreview = async () => {
    if (!deployProfile || dirty) return;
    setPendingAction("preview"); setBusy(true); setError(""); setPreviews([]);
    try {
      const plans = await Promise.all(targets.map(target => previewHub(deployProfile, target.host, target.cwd, adoptExisting)));
      if (new Set(plans.map(plan => `${plan.host}::${plan.cwd}`)).size !== plans.length) throw new Error("Choose each device and project folder only once.");
      setPreviews(plans);
    } catch (cause) { report(cause); } finally { setBusy(false); setPendingAction(null); }
  };
  const apply = async (mode: "sync" | "deploy") => {
    setPendingAction(mode); setBusy(true); setError(""); setNote("");
    const plans = previews;
    let completed = 0;
    try {
      for (const plan of plans) {
        const result = await applyHub(plan.previewId, mode);
        if (result.status === "failed") throw new Error(result.error || "Deployment failed. Review deployment history.");
        completed++;
        if (mode === "deploy" && result.session) useStore.getState().openSession(result.session, result.cwd, result.host);
      }
      notify({ category: "app", event: mode === "deploy" ? "agents-deploy" : "agents-sync", title: mode === "deploy" ? "Agent deployment completed" : "Agent instructions synced", body: `${completed} destinations completed. Open Agents Hub for details.`, target: { section: "agents-hub" } });
      setNote(`${completed} target${completed === 1 ? "" : "s"} ${mode === "deploy" ? "deployed" : "synced"}.`);
      setDeployProfile(null); onSectionChange("deployments");
    } catch (cause) { notify({ category: "app", event: mode === "deploy" ? "agents-deploy" : "agents-sync", title: "Agents Hub needs attention", body: `${completed} destinations completed before an error. Review deployment history before retrying.`, target: { section: "agents-hub" } }); setNote(`${completed} targets completed before the error. Review history before retrying.`); report(cause); }
    finally {
      try { setState(await fetchHub()); } catch { /* Preserve operation result if history refresh is unavailable. */ }
      setPreviews([]); setBusy(false); setPendingAction(null);
    }
  };
  const list = state ? (tab === "documents" ? state.documents : tab === "skills" ? state.skills : state.profiles).filter(item => item.name.toLowerCase().includes(query.toLowerCase())) : [];
  const catalog = [...SKILL_CATALOG].sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1)).filter(item => `${item.name} ${item.description}`.toLowerCase().includes(query.toLowerCase()));
  const viewRef = useRef({ active, tab, state, busy, query, selected, rendered, limit });
  viewRef.current = { active, tab, state, busy, query, selected, rendered, limit };
  useEffect(() => {
    const snapshot = () => {
      const current = viewRef.current;
      return { available: current.active, page: current.tab, query: current.query, selectedId: current.selected, preview: current.rendered, limit: current.limit };
    };
    const cleanups = [registerAppControlState("agentsHubView", snapshot), registerAppControlHandler("get_agents_hub_view", snapshot),
      registerAppControlHandler("set_agents_hub_view", args => {
        const current = viewRef.current;
        if (!current.active || !current.state) throw new Error("Open and load an Agents Hub library page first.");
        if (current.busy) throw new Error("Wait for the current library operation.");
        const collection = current.tab === "documents" ? current.state.documents : current.tab === "skills" ? current.state.skills : current.tab === "profiles" ? current.state.profiles : [];
        if (args.selectedId && !collection.some(item => item.id === args.selectedId)) throw new Error("Choose an item from the current library page.");
        const selectedId = args.selectedId as string | undefined ?? current.selected;
        if (args.preview !== undefined && (!selectedId || (current.tab !== "documents" && current.tab !== "skills"))) throw new Error("Select a document or skill before changing preview mode.");
        if (args.limit !== undefined && current.tab !== "discover" && current.tab !== "deployments") throw new Error("This library page displays all search results without pagination.");
        if (args.query !== undefined && current.tab === "deployments") throw new Error("Deployment history does not support search. Open a library or discovery page to search.");
        if (typeof args.query === "string") { setQuery(args.query); setLimit(12); }
        if (typeof args.selectedId === "string") { setSelected(args.selectedId); setRendered(false); }
        if (typeof args.preview === "boolean") setRendered(args.preview);
        if (typeof args.limit === "number") setLimit(args.limit);
        return { configured: true };
      })];
    return () => cleanups.forEach(cleanup => cleanup());
  }, []);
  const itemDetail = (id: string) => {
    const document = state?.documents.find(item => item.id === id);
    if (tab === "documents" && document) return state?.frameworks.find(item => item.id === document.framework)?.label ?? document.framework;
    const skill = state?.skills.find(item => item.id === id);
    if (tab === "skills" && skill) return skill.files ? `${skill.files.length} files · Imported` : "Local skill";
    const profile = state?.profiles.find(item => item.id === id);
    return profile ? `${state?.frameworks.find(item => item.id === profile.framework)?.label ?? profile.framework} · ${profile.instructionIds.length} documents · ${profile.skillIds.length} skills` : "";
  };
  return <div className="agents-hub-content" hidden={!active}>
      <div className="ah-layout">
        <main className="ah-main"><div className="ah-toolbar"><span className="ah-save-status" role="status">{dirty ? "Unsaved changes" : busy ? "Working…" : "Local library"}</span><AsyncButton className="btn btn-sm" loading={busy && refreshing.current && !dirty} disabled={busy || dirty} title="Refresh library" aria-label="Refresh library" icon={RefreshCw} onClick={() => void refresh()} />{dirty ? <AsyncButton className="btn btn-sm" loading={busy && refreshing.current && dirty} disabled={busy} icon={RefreshCw} onClick={() => void refresh()}>Discard</AsyncButton> : null}<AsyncButton className="btn btn-sm" loading={pendingAction === "save"} icon={Save} disabled={busy || !dirty} onClick={() => void save()}>Save changes</AsyncButton></div>
          {error ? <div className="ah-message error" role="alert">{error}</div> : null}{note ? <div className="ah-message" role="status">{note}</div> : null}
          {!state ? <div className="ah-message">{busy ? "Loading library…" : "The library is unavailable. Use Refresh to retry."}</div> : <div className="ah-scroll">
            {deploying ? <section className="ah-deploy"><div className="ah-actions"><h3>Deploy {currentProfile?.name}</h3><button className="btn btn-sm" disabled={busy} onClick={() => { setDeployProfile(null); setPreviews([]); }}>Cancel</button></div>
              <p className="set-note">Choose devices and existing absolute project folders. Preview checks existing files first. Different profiles need separate folders; the same profile can launch multiple sessions. Sessions in the same folder share its instruction files.</p>
              {targets.map((target, index) => <div key={index} className="ah-target"><label className="ah-target-device">Device<Select value={target.host} options={devices.map(device => ({ value: deviceHost(device), label: device.name }))} onChange={host => { if (busy) return; setTargets(value => value.map((row, i) => i === index ? { host, cwd: "" } : row)); setPreviews([]); }} /></label>
                <label className="ah-target-folder">Project folder<input className="input" aria-label={`Project folder ${index + 1}`} placeholder="/absolute/project/folder" value={target.cwd} disabled={busy} onChange={event => { setTargets(value => value.map((row, i) => i === index ? { ...row, cwd: event.target.value } : row)); setPreviews([]); }} /></label>
                <button className="btn btn-sm" disabled={busy} onClick={() => setPicker(index)}>Browse</button>
                {targets.length > 1 ? <button className="ah-remove-target" disabled={busy} aria-label={`Remove target ${index + 1}`} onClick={() => { setTargets(value => value.filter((_, i) => i !== index)); setPreviews([]); }}><X size={14} /></button> : null}
              </div>)}
              <label className="set-note ah-adopt"><input type="checkbox" checked={adoptExisting} disabled={busy} onChange={event => { setAdoptExisting(event.target.checked); setPreviews([]); }} /> Replace existing instruction and skill files after reviewing a fresh preview. Previous contents are backed up on the destination; files owned by another profile remain protected.</label>
              <div className="ah-actions"><button className="btn btn-sm" disabled={busy || targets.length >= 20} onClick={() => { setTargets(value => [...value, { host: "", cwd: "" }]); setPreviews([]); }}>Add destination</button><button className="btn btn-sm" disabled={busy || devices.length > 20} onClick={addAllDevices}>All devices</button><AsyncButton className="btn" loading={pendingAction === "preview"} disabled={busy || dirty || targets.some(target => !target.cwd.startsWith("/"))} onClick={() => void startPreview()}>Preview changes</AsyncButton></div>
              {previews.map(plan => <div className="ah-plan" key={plan.previewId}><strong>{plan.host || "This device"} · {plan.cwd}</strong>{plan.conflicts.map(conflict => <p className="ah-message error" key={conflict}>{conflict}</p>)}
                {plan.files.map(file => <details key={file.path}><summary>{file.path} · {file.operation === "delete" ? "remove managed file" : file.baselineSha256 ? "existing file" : "new file"}</summary><pre>{file.previousContent !== undefined ? `Existing content:\n${file.previousEncoding === "base64" ? "Binary asset" : file.previousContent}\n\nProposed content:\n` : ""}{file.operation === "delete" ? "This previously managed file will be removed." : file.encoding === "base64" ? "Binary asset from the imported skill bundle." : file.content}</pre></details>)}
                <p className="set-note">{plan.launch.supported ? `Launch: ${plan.launch.command}` : "Instruction sync is supported; terminal launch is unavailable for this framework."}</p>
              </div>)}
              {previews.length ? <div className="ah-actions"><AsyncButton className="btn" loading={pendingAction === "sync"} disabled={busy || previews.some(plan => plan.conflicts.length > 0)} onClick={() => void apply("sync")}>Apply sync</AsyncButton><AsyncButton className="btn" loading={pendingAction === "deploy"} icon={Play} disabled={busy || previews.some(plan => plan.conflicts.length > 0 || !plan.launch.supported)} onClick={() => void apply("deploy")}>Sync & launch</AsyncButton></div> : null}
            </section> : null}
            <div hidden={deploying}>{tab === "discover" ? <><input className="input ah-search" aria-label="Search skill catalog" placeholder="Search skills…" value={query} onChange={event => { setQuery(event.target.value); setLimit(12); }} /><div className="ah-catalog">{catalog.slice(0, limit).map(item => <article key={item.id}><div className="ah-catalog-copy"><h3>{item.name}</h3><p>{item.description}</p><small><a onClick={visitSource} href={item.licenseUrl} target="_blank" rel="noopener noreferrer">{item.license}</a> · {item.stars === null ? "Stars unavailable" : `${item.stars.toLocaleString()} repository stars`} · checked {item.checkedAt}</small><a onClick={visitSource} href={`${item.sourceUrl}/tree/HEAD/${item.subpath}`} target="_blank" rel="noopener noreferrer">Source: {item.sourceUrl.replace("https://github.com/", "")}</a></div><AsyncButton className="btn btn-sm" loading={pendingAction === `import:${item.id}`} disabled={busy || dirty} onClick={() => {
                setPendingAction(`import:${item.id}`); setBusy(true); setError(""); setNote("Downloading the pinned skill bundle…");
                void importHubSkill(state.revision, item.sourceUrl, item.subpath).then(value => { setState(value); setPreviews([]); notify({ category: "app", event: "skill-import", title: "Skill imported", body: `${item.name} is ready to review in your local library.`, target: { section: "agents-hub" } }); setNote(`${item.name} imported to your local library. Review it under My skills.`); }).catch((cause: unknown) => { setNote(""); report(cause); notify({ category: "app", event: "skill-import", title: "Skill import failed", body: "Review the source and error in Agents Hub before retrying.", target: { section: "agents-hub" } }); }).finally(() => { setBusy(false); setPendingAction(null); });
              }}>Import</AsyncButton></article>)}</div><ScrollMore hasMore={limit < catalog.length} loadMore={() => setLimit(value => value + 12)} /></> : tab === "deployments" ? <>{state.deployments.length ? [...state.deployments].reverse().slice(0, limit).map(deployment => <article className="ah-history" key={deployment.id}><div className="ah-history-head"><strong>{state.profiles.find(profile => profile.id === deployment.profileId)?.name ?? deployment.profileId}</strong><span className="ah-status">{deployment.status}</span></div><p className="ah-history-path">{deployment.cwd}</p><small>{deployment.host || "This device"}</small><small>{new Date(deployment.createdAt).toLocaleString()} · {deployment.mode}</small>{deployment.backupPath ? <p className="set-note">Previous files backed up on this device: <code>{deployment.backupPath}</code></p> : null}{deployment.error ? <p role="alert">{deployment.error}</p> : null}{deployment.session ? <button className="btn btn-sm" onClick={() => { useStore.getState().openSession(deployment.session!, deployment.cwd, deployment.host); onOpenSession(); }}>Open session</button> : null}</article>) : <p className="set-note">No deployments yet. Create a profile, then choose Deploy.</p>}<ScrollMore hasMore={limit < state.deployments.length} loadMore={() => setLimit(value => value + 12)} /></> : <div className="ah-workbench"><div className="ah-library" hidden={Boolean(selected)}><div className="ah-library-toolbar"><input className="input" aria-label="Search library" placeholder="Search…" value={query} onChange={event => setQuery(event.target.value)} /><button className="btn btn-sm" disabled={busy} onClick={add}><Plus size={14} />{tab === "documents" ? "New instructions" : tab === "profiles" ? "New profile" : "New skill"}</button></div><div className="ah-library-list">{list.map(item => <button className={`ah-list-item ${selected === item.id ? "active" : ""}`} key={item.id} onClick={() => { setSelected(item.id); setRendered(false); }}><span className="ah-item-copy"><strong>{item.name}</strong><small>{itemDetail(item.id)}</small></span><ChevronRight size={14} /></button>)}</div>{!list.length ? <p className="ah-empty">{query ? "No matching items." : "Your library is empty. Create an item to get started."}</p> : null}</div><section className="ah-editor" hidden={!selected}><button className="ah-back" onClick={() => setSelected("")}><ArrowLeft size={14} />All {agentsHubSections.find(item => item.id === tab)?.label.toLowerCase()}</button>
              {editedDocument ? <><div className="ah-fields"><label>Name<input className="input" value={editedDocument.name} disabled={busy} onChange={event => edit(value => ({ ...value, documents: value.documents.map(item => item.id === selected ? { ...item, name: event.target.value } : item) }))} /></label><label>Framework<Select value={editedDocument.framework} options={state.frameworks.map(framework => ({ value: framework.id, label: framework.label }))} onChange={framework => edit(value => ({ ...value, documents: value.documents.map(item => item.id === selected ? { ...item, framework } : item), profiles: value.profiles.map(profile => profile.framework === framework ? profile : { ...profile, instructionIds: profile.instructionIds.filter(id => id !== selected) }) }))} /></label></div>
                <p className="set-note">Write reusable project guidance, then attach it to an agent profile for preview and deployment.</p>
                <div className="ah-actions ah-editor-actions"><button className="btn btn-sm" disabled={busy} onClick={() => { edit(value => ({ ...value, documents: value.documents.filter(item => item.id !== selected), profiles: value.profiles.map(profile => ({ ...profile, instructionIds: profile.instructionIds.filter(id => id !== selected) })) })); setSelected(""); }}>Remove</button><span className="ah-view-switch"><button className={`btn btn-sm ${!rendered ? "btn-on" : ""}`} onClick={() => setRendered(false)}>Edit</button><button className={`btn btn-sm ${rendered ? "btn-on" : ""}`} onClick={() => setRendered(true)}>Preview</button></span></div>
                {rendered ? <MarkdownPreview content={editedDocument.content} /> : <textarea className="input ah-source" aria-label="Project instruction content" spellCheck={false} value={editedDocument.content} disabled={busy} onChange={event => edit(value => ({ ...value, documents: value.documents.map(item => item.id === selected ? { ...item, content: event.target.value } : item) }))} />}
              </> : editedSkill ? <><div className="ah-fields"><label>Name<input className="input" value={editedSkill.name} disabled={busy} onChange={event => edit(value => ({ ...value, skills: value.skills.map(item => item.id === selected ? { ...item, name: event.target.value } : item) }))} /></label>
                <p className="set-note">SKILL.md content. Use the skill format expected by your selected framework.{editedSkill.files ? ` This imported bundle contains ${editedSkill.files.length} files.` : ""}</p></div>
                <div className="ah-actions ah-editor-actions"><button className="btn btn-sm" disabled={busy} onClick={() => {
                  edit(value => ({ ...value, skills: value.skills.filter(item => item.id !== selected), profiles: value.profiles.map(profile => ({ ...profile, skillIds: profile.skillIds.filter(id => id !== selected) })) })); setSelected("");
                }} title="Remove from library draft">Remove</button><span className="ah-view-switch"><button className={`btn btn-sm ${!rendered ? "btn-on" : ""}`} onClick={() => setRendered(false)}>Edit</button><button className={`btn btn-sm ${rendered ? "btn-on" : ""}`} onClick={() => setRendered(true)}>Preview</button></span></div>
                {rendered ? <MarkdownPreview content={editedSkill.content} /> : <textarea className="input ah-source" aria-label="Skill content" spellCheck={false} value={editedSkill.content} disabled={busy} onChange={event => edit(value => ({ ...value, skills: value.skills.map(item => item.id === selected ? { ...item, content: event.target.value } : item) }))} />}
                {editedSkill.sourceUrl ? <a onClick={visitSource} href={editedSkill.sourceUrl} target="_blank" rel="noopener noreferrer">Original skill source{editedSkill.commit ? ` · ${editedSkill.commit.slice(0, 12)}` : ""}</a> : null}
              </> : tab === "profiles" && selectedProfile ? <><div className="ah-fields"><label>Profile name<input className="input" value={selectedProfile.name} disabled={busy} onChange={event => patchProfile({ name: event.target.value })} /></label><label>Framework<Select value={selectedProfile.framework} options={state.frameworks.map(framework => ({ value: framework.id, label: framework.label, sub: framework.launchSupported ? "Instruction sync and terminal launch" : "Instruction sync" }))} onChange={framework => patchProfile({ framework, instructionIds: [], skillIds: [] })} /></label></div><label>Additional instructions<textarea className="input ah-source" aria-label="Agent instructions" value={selectedProfile.systemPrompt} disabled={busy} onChange={event => patchProfile({ systemPrompt: event.target.value })} /></label><p className="set-note">These become project instructions alongside the selected documents. They do not replace the framework’s built-in system rules. The destination device and folder are selected at deployment.</p>
                <div className="ah-attachments"><fieldset><legend>Instruction documents</legend>{!state.documents.some(item => item.framework === selectedProfile.framework) ? <p className="set-note">No documents for this framework.</p> : null}{state.documents.filter(item => item.framework === selectedProfile.framework).map(item => <label key={item.id}><input type="checkbox" checked={selectedProfile.instructionIds.includes(item.id)} disabled={busy} onChange={event => patchProfile({ instructionIds: event.target.checked ? [...selectedProfile.instructionIds, item.id] : selectedProfile.instructionIds.filter(id => id !== item.id) })} />{item.name}</label>)}</fieldset>
                <fieldset><legend>Skills</legend>{!state.skills.length ? <p className="set-note">No skills in your library.</p> : null}{state.skills.map(item => <label key={item.id}><input type="checkbox" checked={selectedProfile.skillIds.includes(item.id)} disabled={busy || !state.frameworks.find(framework => framework.id === selectedProfile.framework)?.skillsDirectory} onChange={event => patchProfile({ skillIds: event.target.checked ? [...selectedProfile.skillIds, item.id] : selectedProfile.skillIds.filter(id => id !== item.id) })} />{item.name}</label>)}</fieldset></div>
                <button className="btn btn-sm" disabled={busy} onClick={() => { edit(value => ({ ...value, profiles: value.profiles.filter(profile => profile.id !== selectedProfile.id) })); setSelected(""); }}>Remove profile</button>
                <button className="btn" disabled={dirty || busy} onClick={() => { setDeployProfile(selectedProfile.id); setTargets([{ host: "", cwd: "" }]); setAdoptExisting(false); setPreviews([]); }}><Play size={14} />Deploy profile…</button>
              </> : <p className="set-note">Select an item or create one to get started. Edits stay in this draft until you save the library.</p>}
            </section></div>}</div>
          </div>}
        </main></div>
    {picker !== null ? <FilePicker open mode="folder" host={targets[picker]?.host} onClose={() => setPicker(null)} onPick={(cwd, host) => { setTargets(value => value.map((row, i) => i === picker ? { host, cwd } : row)); setPreviews([]); setPicker(null); }} /> : null}
  </div>;
}
