import { AsyncButton } from "../ui/AsyncButton";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import { Bot, BookOpen, FileText, Layers, Play, Plus, RefreshCw, Save, Search, X } from "lucide-react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { useStore } from "../state/store";
import { HAS_TAURI } from "../tauriEnv";
import { openUrl } from "../forward";
import { notify } from "../state/notifications";
import { readFile } from "../serverApi";
import { deviceHost } from "../devices";
import { Select } from "../ui/Select";
import { ScrollMore } from "../ui/ScrollMore";
import { FilePicker } from "./FilePicker";
import { fetchHub, saveHub, previewHub, applyHub, importHubSkill, type HubState, type HubProfile, type HubPreview } from "../agentsHubApi";
import { SKILL_CATALOG } from "../agentsHubCatalog";
import "./AgentsHub.css";

type Tab = "instructions" | "skills" | "discover" | "profiles" | "deployments";
const tabs = [{ id: "instructions", label: "Instructions", icon: FileText }, { id: "skills", label: "My skills", icon: BookOpen }, { id: "discover", label: "Discover skills", icon: Search }, { id: "profiles", label: "Agent profiles", icon: Bot }, { id: "deployments", label: "Deployments", icon: Layers }] as const;
const uid = () => crypto.randomUUID();
function MarkdownPreview({ content }: { content: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(content, { async: false }), { USE_PROFILES: { html: true }, FORBID_TAGS: ["img", "iframe", "style", "video", "audio", "source", "form", "input", "button", "select", "textarea", "meta", "link"], FORBID_ATTR: ["style"] }), [content]);
  return <div className="md-preview ah-markdown" onClick={event => {
    const anchor = event.target instanceof Element ? event.target.closest("a") : null;
    if (anchor) { event.preventDefault(); if (anchor.protocol === "https:" || anchor.protocol === "http:") window.open(anchor.href, "_blank", "noopener,noreferrer"); }
  }} dangerouslySetInnerHTML={{ __html: html }} />;
}

export function AgentsHub({ open, onClose }: { open: boolean; onClose(): void }) {
  const [state, setState] = useState<HubState | null>(null);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<Tab>("instructions");
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
  const [importInstructions, setImportInstructions] = useState(false);
  const [adoptExisting, setAdoptExisting] = useState(false);
  const [picker, setPicker] = useState<number | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const refreshing = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const devices = useStore(store => store.devices);
  const currentProfile = state?.profiles.find(profile => profile.id === deployProfile);
  const visitSource = (event: MouseEvent<HTMLAnchorElement>) => {
    if (!HAS_TAURI) return;
    event.preventDefault();
    void openUrl(event.currentTarget.href).catch((cause: unknown) => report(cause));
  };
  const report = (cause: unknown) => setError(cause instanceof Error ? cause.message : "Agents Hub operation failed.");
  const refresh = async () => { if (refreshing.current) return; refreshing.current = true; setPendingAction("refresh"); setBusy(true); setError(""); try { setState(await fetchHub()); setDirty(false); setPreviews([]); } catch (cause) { report(cause); } finally { refreshing.current = false; setBusy(false); setPendingAction(null); } };
  useEffect(() => { if (open && !state) void refresh(); }, [open]);
  useEffect(() => {
    if (!open) { setPicker(null); setImportInstructions(false); return; }
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (document.querySelector(".modal-backdrop:not(.agents-hub-backdrop):not(.settings-hub-backdrop)")) return;
      if (event.target instanceof Element && event.target.closest(".pzza-portal") !== dialog.current?.parentElement) return;
      if (event.key === "Escape") { event.preventDefault(); closeRef.current(); }
      if (event.key === "Tab") {
        const fields = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]') ?? [])].filter(element => element.getClientRects().length);
        const first = fields[0], last = fields.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog.current)) { event.preventDefault(); first?.focus(); }
      }
    };
    window.addEventListener("keydown", keyboard);
    return () => { window.removeEventListener("keydown", keyboard); previous?.focus(); };
  }, [open]);
  const edit = (update: (value: HubState) => HubState) => { if (busy) return; setState(value => value ? update(value) : value); setDirty(true); setPreviews([]); setNote(""); };
  const save = async () => {
    if (!state) return;
    setPendingAction("save"); setBusy(true); setError("");
    try { setState(await saveHub(state)); setDirty(false); setPreviews([]); setNote("Library saved on this device."); }
    catch (cause) { report(cause); } finally { setBusy(false); setPendingAction(null); }
  };
  const switchTab = (next: Tab) => { setTab(next); setSelected(""); setQuery(""); setLimit(12); setRendered(false); };
  const add = () => {
    const id = uid();
    edit(value => tab === "instructions" ? { ...value, documents: [...value.documents, { id, name: "Untitled instructions", framework: value.frameworks[0]?.id ?? "claude", content: "" }] }
      : tab === "skills" ? { ...value, skills: [...value.skills, { id, name: "New skill", content: "" }] }
      : { ...value, profiles: [...value.profiles, { id, name: "New agent", framework: value.frameworks.find(item => item.launchSupported)?.id ?? "claude", systemPrompt: "", instructionIds: [], skillIds: [] }] });
    setSelected(id);
  };
  const selectedDocument = state?.documents.find(item => item.id === selected);
  const selectedSkill = state?.skills.find(item => item.id === selected);
  const selectedProfile = state?.profiles.find(item => item.id === selected);
  const editedDocument = tab === "instructions" ? selectedDocument : tab === "skills" ? selectedSkill : null;
  const patchProfile = (patch: Partial<HubProfile>) => edit(value => ({ ...value, profiles: value.profiles.map(profile => profile.id === selected ? { ...profile, ...patch } : profile) }));
  const startPreview = async () => {
    if (!deployProfile || dirty) return;
    setPendingAction("preview"); setBusy(true); setError(""); setPreviews([]);
    try {
      const plans: HubPreview[] = [];
      for (const target of targets) plans.push(await previewHub(deployProfile, target.host, target.cwd, adoptExisting));
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
      setDeployProfile(null); setTab("deployments");
    } catch (cause) { notify({ category: "app", event: mode === "deploy" ? "agents-deploy" : "agents-sync", title: "Agents Hub needs attention", body: `${completed} destinations completed before an error. Review deployment history before retrying.`, target: { section: "agents-hub" } }); setNote(`${completed} targets completed before the error. Review history before retrying.`); report(cause); }
    finally {
      try { setState(await fetchHub()); } catch { /* Preserve operation result if history refresh is unavailable. */ }
      setPreviews([]); setBusy(false); setPendingAction(null);
    }
  };
  if (!open) return null;
  const list = state ? (tab === "instructions" ? state.documents : tab === "skills" ? state.skills : state.profiles).filter(item => item.name.toLowerCase().includes(query.toLowerCase())) : [];
  const catalog = [...SKILL_CATALOG].sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1)).filter(item => `${item.name} ${item.description}`.toLowerCase().includes(query.toLowerCase()));
  return createPortal(<div className="modal-backdrop pzza-portal agents-hub-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
    <div className="modal agents-hub-modal" role="dialog" aria-modal="true" aria-label="Agents Hub" tabIndex={-1} ref={dialog}>
      <div className="modal-head"><span className="modal-title"><Bot size={17} /> Agents Hub</span><button className="icon-btn" aria-label="Close Agents Hub" onClick={onClose}><X size={16} /></button></div>
      <div className="ah-layout"><nav className="ah-nav" aria-label="Agents Hub sections">{tabs.map(({ id, label, icon: Icon }) => <button key={id} aria-current={tab === id ? "page" : undefined} className={tab === id ? "active" : ""} onClick={() => switchTab(id)}><Icon size={15} />{label}</button>)}<p>Your library is local. Sync and launch only run after you review a destination.</p></nav>
        <main className="ah-main"><header className="ah-header"><div><h2>{tabs.find(item => item.id === tab)?.label}</h2><p>{dirty ? "Unsaved library changes" : `Library revision ${state?.revision ?? "…"}`}</p></div><AsyncButton className="btn btn-sm" loading={busy && refreshing.current && !dirty} disabled={busy || dirty} title="Refresh library" aria-label="Refresh library" icon={RefreshCw} onClick={() => void refresh()} />{dirty ? <AsyncButton className="btn btn-sm" loading={busy && refreshing.current && dirty} disabled={busy} icon={RefreshCw} onClick={() => void refresh()}>Discard draft</AsyncButton> : null}<AsyncButton className="btn btn-sm" loading={pendingAction === "save"} icon={Save} disabled={busy || !dirty} onClick={() => void save()}>Save library</AsyncButton></header>
          {error ? <div className="ah-message error" role="alert">{error}</div> : null}{note ? <div className="ah-message" role="status">{note}</div> : null}
          {!state ? <div className="ah-message">{busy ? "Loading library…" : "The library is unavailable. Use Refresh to retry."}</div> : <div className="ah-scroll settings-hub-content">
            {deployProfile ? <section className="ah-deploy"><div className="notification-actions"><h3>Deploy {currentProfile?.name}</h3><button className="btn btn-sm" disabled={busy} onClick={() => { setDeployProfile(null); setPreviews([]); }}>Cancel</button></div>
              <p className="set-note">Choose devices and existing absolute project folders. Preview checks existing files first. Different profiles need separate folders; the same profile can launch multiple sessions. Sessions in the same folder share its instruction files.</p>
              {targets.map((target, index) => <div key={index} className="ah-target"><Select value={target.host} options={devices.map(device => ({ value: deviceHost(device), label: device.name }))} onChange={host => { if (busy) return; setTargets(value => value.map((row, i) => i === index ? { host, cwd: "" } : row)); setPreviews([]); }} />
                <input className="input" aria-label={`Project folder ${index + 1}`} placeholder="/absolute/project/folder" value={target.cwd} disabled={busy} onChange={event => { setTargets(value => value.map((row, i) => i === index ? { ...row, cwd: event.target.value } : row)); setPreviews([]); }} />
                <button className="btn btn-sm" disabled={busy} onClick={() => setPicker(index)}>Browse</button>
                {targets.length > 1 ? <button className="tile-btn" disabled={busy} aria-label={`Remove target ${index + 1}`} onClick={() => { setTargets(value => value.filter((_, i) => i !== index)); setPreviews([]); }}>×</button> : null}
              </div>)}
              <label className="set-note"><input type="checkbox" checked={adoptExisting} disabled={busy} onChange={event => { setAdoptExisting(event.target.checked); setPreviews([]); }} /> Replace existing instruction and skill files after reviewing a fresh preview. Previous contents are backed up on the destination; files owned by another profile remain protected.</label>
              <div className="notification-actions"><button className="btn btn-sm" disabled={busy || targets.length >= 10} onClick={() => { setTargets(value => [...value, { host: "", cwd: "" }]); setPreviews([]); }}>Add destination</button><AsyncButton className="btn" loading={pendingAction === "preview"} disabled={busy || dirty || targets.some(target => !target.cwd.startsWith("/"))} onClick={() => void startPreview()}>Preview changes</AsyncButton></div>
              {previews.map(plan => <div className="ah-plan" key={plan.previewId}><strong>{plan.host || "This device"} · {plan.cwd}</strong>{plan.conflicts.map(conflict => <p className="ah-message error" key={conflict}>{conflict}</p>)}
                {plan.files.map(file => <details key={file.path}><summary>{file.path} · {file.operation === "delete" ? "remove managed file" : file.baselineSha256 ? "existing file" : "new file"}</summary><pre>{file.previousContent !== undefined ? `Existing content:\n${file.previousEncoding === "base64" ? "Binary asset" : file.previousContent}\n\nProposed content:\n` : ""}{file.operation === "delete" ? "This previously managed file will be removed." : file.encoding === "base64" ? "Binary asset from the imported skill bundle." : file.content}</pre></details>)}
                <p className="set-note">{plan.launch.supported ? `Launch: ${plan.launch.command}` : "Instruction sync is supported; terminal launch is unavailable for this framework."}</p>
              </div>)}
              {previews.length ? <div className="notification-actions"><AsyncButton className="btn" loading={pendingAction === "sync"} disabled={busy || previews.some(plan => plan.conflicts.length > 0)} onClick={() => void apply("sync")}>Apply sync</AsyncButton><AsyncButton className="btn" loading={pendingAction === "deploy"} icon={Play} disabled={busy || previews.some(plan => plan.conflicts.length > 0 || !plan.launch.supported)} onClick={() => void apply("deploy")}>Sync & launch</AsyncButton></div> : null}
            </section> : null}
            {tab === "discover" ? <><input className="input ah-search" aria-label="Search skill catalog" placeholder="Search skills…" value={query} onChange={event => { setQuery(event.target.value); setLimit(12); }} /><p className="set-note">Repository stars indicate popularity, not quality or safety. Review source and license before importing. Imports preserve the complete skill folder and pin its source revision; scripts are never run during import.</p><div className="ah-catalog">{catalog.slice(0, limit).map(item => <article key={item.id}><h3>{item.name}</h3><p>{item.description}</p><small><a onClick={visitSource} href={item.licenseUrl} target="_blank" rel="noopener noreferrer">{item.license}</a> · {item.stars === null ? "Stars unavailable" : `${item.stars.toLocaleString()} repository stars`} · checked {item.checkedAt}</small><a onClick={visitSource} href={`${item.sourceUrl}/tree/HEAD/${item.subpath}`} target="_blank" rel="noopener noreferrer">Source: {item.sourceUrl.replace("https://github.com/", "")}</a><AsyncButton className="btn btn-sm" loading={pendingAction === `import:${item.id}`} disabled={busy || dirty} onClick={() => {
                setPendingAction(`import:${item.id}`); setBusy(true); setError(""); setNote("Downloading the pinned skill bundle…");
                void importHubSkill(state.revision, item.sourceUrl, item.subpath).then(value => { setState(value); setPreviews([]); notify({ category: "app", event: "skill-import", title: "Skill imported", body: `${item.name} is ready to review in your local library.`, target: { section: "agents-hub" } }); setNote(`${item.name} imported to your local library. Review it under My skills.`); }).catch((cause: unknown) => { setNote(""); report(cause); notify({ category: "app", event: "skill-import", title: "Skill import failed", body: "Review the source and error in Agents Hub before retrying.", target: { section: "agents-hub" } }); }).finally(() => { setBusy(false); setPendingAction(null); });
              }}>Import skill</AsyncButton></article>)}</div><ScrollMore hasMore={limit < catalog.length} loadMore={() => setLimit(value => value + 12)} /></> : tab === "deployments" ? <><p className="set-note">Each launch is a separate session. Sync-only operations do not start an agent.</p>{state.deployments.length ? [...state.deployments].reverse().slice(0, limit).map(deployment => <article className="ah-plan" key={deployment.id}><strong>{state.profiles.find(profile => profile.id === deployment.profileId)?.name ?? deployment.profileId} · {deployment.status}</strong><p>{deployment.host || "This device"} · {deployment.cwd}</p><small>{new Date(deployment.createdAt).toLocaleString()} · {deployment.mode}</small>{deployment.backupPath ? <p className="set-note">Previous files backed up on this device: <code>{deployment.backupPath}</code></p> : null}{deployment.error ? <p role="alert">{deployment.error}</p> : null}{deployment.session ? <button className="btn btn-sm" onClick={() => { useStore.getState().openSession(deployment.session!, deployment.cwd, deployment.host); onClose(); }}>Open session</button> : null}</article>) : <p className="set-note">No deployments yet. Create a profile, then choose Deploy.</p>}<ScrollMore hasMore={limit < state.deployments.length} loadMore={() => setLimit(value => value + 12)} /></> : <div className="ah-workbench"><aside><input className="input" aria-label="Search library" placeholder="Search…" value={query} onChange={event => setQuery(event.target.value)} /><button className="btn btn-sm" disabled={busy} onClick={add}><Plus size={14} />{tab === "profiles" ? "New profile" : tab === "skills" ? "New skill" : "New instructions"}</button>{tab === "instructions" ? <AsyncButton className="btn btn-sm" loading={pendingAction === "import-instructions"} disabled={busy} onClick={() => setImportInstructions(true)}>Import from device…</AsyncButton> : null}{list.map(item => <button className={`ah-list-item ${selected === item.id ? "active" : ""}`} key={item.id} onClick={() => { setSelected(item.id); setRendered(false); }}>{item.name}</button>)}</aside><section className="ah-editor">
              {editedDocument ? <><label>Name<input className="input" value={editedDocument.name} disabled={busy} onChange={event => edit(value => tab === "instructions" ? { ...value, documents: value.documents.map(item => item.id === selected ? { ...item, name: event.target.value } : item) } : { ...value, skills: value.skills.map(item => item.id === selected ? { ...item, name: event.target.value } : item) })} /></label>
                {tab === "instructions" && selectedDocument ? <Select value={selectedDocument.framework} options={state.frameworks.map(framework => ({ value: framework.id, label: framework.label, sub: framework.instructionFile }))} onChange={framework => edit(value => ({ ...value, documents: value.documents.map(item => item.id === selected ? { ...item, framework } : item) }))} /> : <p className="set-note">SKILL.md content. Use the skill format expected by your selected framework.{selectedSkill?.files ? ` This imported bundle contains ${selectedSkill.files.length} files.` : ""}</p>}
                <div className="notification-actions"><button className="btn btn-sm" disabled={busy} onClick={() => {
                  edit(value => ({ ...value,
                    documents: tab === "instructions" ? value.documents.filter(item => item.id !== selected) : value.documents,
                    skills: tab === "skills" ? value.skills.filter(item => item.id !== selected) : value.skills,
                    profiles: value.profiles.map(profile => ({ ...profile, instructionIds: tab === "instructions" ? profile.instructionIds.filter(id => id !== selected) : profile.instructionIds, skillIds: tab === "skills" ? profile.skillIds.filter(id => id !== selected) : profile.skillIds })),
                  })); setSelected("");
                }}>Remove from library draft</button><button className={`btn btn-sm ${!rendered ? "btn-on" : ""}`} onClick={() => setRendered(false)}>Edit</button><button className={`btn btn-sm ${rendered ? "btn-on" : ""}`} onClick={() => setRendered(true)}>Preview</button></div>
                {rendered ? <MarkdownPreview content={editedDocument.content} /> : <textarea className="input ah-source" aria-label={tab === "instructions" ? "Instruction content" : "Skill content"} spellCheck={false} value={editedDocument.content} disabled={busy} onChange={event => edit(value => tab === "instructions" ? { ...value, documents: value.documents.map(item => item.id === selected ? { ...item, content: event.target.value } : item) } : { ...value, skills: value.skills.map(item => item.id === selected ? { ...item, content: event.target.value } : item) })} />}
                {selectedSkill?.sourceUrl ? <a onClick={visitSource} href={selectedSkill.sourceUrl} target="_blank" rel="noopener noreferrer">Original skill source{selectedSkill.commit ? ` · ${selectedSkill.commit.slice(0, 12)}` : ""}</a> : null}
              </> : tab === "profiles" && selectedProfile ? <><label>Profile name<input className="input" value={selectedProfile.name} disabled={busy} onChange={event => patchProfile({ name: event.target.value })} /></label><Select value={selectedProfile.framework} options={state.frameworks.map(framework => ({ value: framework.id, label: framework.label, sub: framework.launchSupported ? "Instruction sync and terminal launch" : "Instruction sync" }))} onChange={framework => patchProfile({ framework, instructionIds: [], skillIds: [] })} /><label>Additional instructions<textarea className="input ah-source" aria-label="Agent instructions" value={selectedProfile.systemPrompt} disabled={busy} onChange={event => patchProfile({ systemPrompt: event.target.value })} /></label><p className="set-note">These become project instructions alongside the selected documents. They do not replace the framework’s built-in system rules. The destination device and folder are selected at deployment.</p>
                <fieldset><legend>Instruction documents</legend>{state.documents.filter(item => item.framework === selectedProfile.framework).map(item => <label key={item.id}><input type="checkbox" checked={selectedProfile.instructionIds.includes(item.id)} disabled={busy} onChange={event => patchProfile({ instructionIds: event.target.checked ? [...selectedProfile.instructionIds, item.id] : selectedProfile.instructionIds.filter(id => id !== item.id) })} />{item.name}</label>)}</fieldset>
                <fieldset><legend>Skills</legend>{state.skills.map(item => <label key={item.id}><input type="checkbox" checked={selectedProfile.skillIds.includes(item.id)} disabled={busy || !state.frameworks.find(framework => framework.id === selectedProfile.framework)?.skillsDirectory} onChange={event => patchProfile({ skillIds: event.target.checked ? [...selectedProfile.skillIds, item.id] : selectedProfile.skillIds.filter(id => id !== item.id) })} />{item.name}</label>)}</fieldset>
                <button className="btn" disabled={dirty || busy} onClick={() => { setDeployProfile(selectedProfile.id); setTargets([{ host: "", cwd: "" }]); setAdoptExisting(false); setPreviews([]); }}><Play size={14} />Deploy profile…</button>
              </> : <p className="set-note">Select an item or create one to get started. Edits stay in this draft until you save the library.</p>}
            </section></div>}
          </div>}
        </main></div>
    </div>
    {importInstructions ? <FilePicker open mode="file" title="Import instruction document" hosts={devices.map(device => ({ label: device.name, host: deviceHost(device) }))} onClose={() => setImportInstructions(false)} onPick={(path, host) => {
      if (!/\.mdc?$/i.test(path)) { setError("Choose a Markdown instruction file (.md or .mdc)."); return; }
      setPendingAction("import-instructions"); setBusy(true); setError("");
      void readFile(path, host).then(result => {
        if (result.tooLarge) throw new Error("This instruction document is too large to import.");
        const id = uid();
        const filename = path.split("/").pop() || "Imported instructions";
        const framework = filename.toLowerCase() === "claude.md" ? "claude" : filename.toLowerCase().endsWith(".mdc") ? "cursor" : "codex";
        setState(value => value ? { ...value, documents: [...value.documents, { id, name: filename, framework, content: result.content }] } : value);
        setSelected(id); setRendered(false); setDirty(true); setPreviews([]);
      }).catch(report).finally(() => { setBusy(false); setPendingAction(null); });
    }} /> : null}
    {picker !== null ? <FilePicker open mode="folder" host={targets[picker]?.host} onClose={() => setPicker(null)} onPick={(cwd, host) => { setTargets(value => value.map((row, i) => i === picker ? { host, cwd } : row)); setPreviews([]); setPicker(null); }} /> : null}
  </div>, window.document.body);
}
