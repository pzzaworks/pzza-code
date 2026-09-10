import { registerAppControlHandler, registerAppControlState } from "../appControlRuntime";
import { AsyncButton } from "../ui/AsyncButton";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { Bot, BookOpen, FileText, Layers, Play, Plus, RefreshCw, Save, Search, ArrowLeft, ChevronRight, X, Download, Trash2, Check } from "lucide-react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { useStore } from "../state/store";
import { useUnsavedDraft } from "../state/unsavedWork";
import { changeHubDraft, discardNewHubItem, emptyHubDraft, hubChangeId, hubCollection, hubDraftSummary } from "../state/hubDraft";
import { readIncrementally } from "../state/hubReads";
import { HAS_TAURI } from "../tauriEnv";
import { openUrl } from "../forward";
import { notify } from "../state/notifications";
import { deviceHost } from "../devices";
import { confirmAction } from "../ui/ConfirmDialog";
import { Select } from "../ui/Select";
import { ScrollMore } from "../ui/ScrollMore";
import { GlobalInstructions } from "./GlobalInstructions";
import { FilePicker } from "./FilePicker";
import { fetchHub, peekHub, fetchHubItem, fetchHubAsset, updateHub, previewHub, applyHub, importHubSkill, type HubSummary, type HubDocument, type HubSkill, type HubProfile, type HubKind, type HubChange, type HubPreview, type HubAssetPage } from "../agentsHubApi";
import { SKILL_CATALOG, type SkillCatalogEntry } from "../agentsHubCatalog";
import "./AgentsHub.css";

export type AgentsHubSection = "instructions" | "documents" | "skills" | "discover" | "profiles" | "deployments";
export const agentsHubSections = [{ id: "instructions", label: "Global instructions", icon: FileText }, { id: "documents", label: "Project instructions", icon: FileText }, { id: "skills", label: "My skills", icon: BookOpen }, { id: "discover", label: "Discover skills", icon: Search }, { id: "profiles", label: "Agent profiles", icon: Bot }, { id: "deployments", label: "Deployments", icon: Layers }] as const;
type Editor = { kind: "document"; item: HubDocument } | { kind: "skill"; item: HubSkill } | { kind: "profile"; item: HubProfile };
const message = (cause: unknown) => cause instanceof Error ? cause.message : "Agents Hub operation failed. Check the connection and retry.";
const sourceKey = (url: string, subpath: string) => `${url.replace(/\/$/, "").replace(/\.git$/i, "").toLowerCase()}#${subpath}`;
function MarkdownPreview({ content }: { content: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(content, { async: false }), { USE_PROFILES: { html: true }, FORBID_TAGS: ["img", "iframe", "style", "video", "audio", "source", "form", "input", "button", "select", "textarea", "meta", "link"], FORBID_ATTR: ["style"] }), [content]);
  return <div className="md-preview ah-markdown" onClick={event => {
    const anchor = event.target instanceof Element ? event.target.closest("a") : null;
    if (anchor) { event.preventDefault(); if (anchor.protocol === "https:" || anchor.protocol === "http:") window.open(anchor.href, "_blank", "noopener,noreferrer"); }
  }} dangerouslySetInnerHTML={{ __html: html }} />;
}

function SkillAssets({ skill, revision }: { skill: HubSkill; revision: number }) {
  const [path, setPath] = useState("");
  const [offsets, setOffsets] = useState([0]);
  const [page, setPage] = useState<HubAssetPage | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const offset = offsets[offsets.length - 1];
  useEffect(() => {
    if (!path) return;
    let current = true;
    setPage(null); setError(""); setLoading(true);
    void fetchHubAsset(revision, skill.id, path, offset).then(result => { if (current) setPage(result); }).catch(cause => { if (current) setError(message(cause)); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [skill.id, revision, path, offset]);
  return <section className="ah-assets" aria-label="Skill bundle assets">
    <h4>Review source files and licenses</h4><p className="set-note">Files are inert text previews, never executed. Review scripts, licenses and prerequisites before attaching this skill. Pages show at most 16 KiB of the saved source.</p>
    <Select value={path} options={[{ value: "", label: "Choose a source file" }, ...(skill.files ?? []).map(file => ({ value: file.path, label: file.path, sub: `${file.bytes.toLocaleString()} bytes${file.executable ? " · executable script" : ""}` }))]} onChange={value => { setPath(value); setOffsets([0]); }} />
    {loading && <p role="status">Loading file…</p>}{error && <p role="alert" className="ah-message error">{error}</p>}
    {page && <><small>{page.path} · {page.bytes.toLocaleString()} bytes · SHA-256 {page.sha256}</small>{page.encoding === "binary" ? <p className="set-note">Binary content is not rendered or executed. Inspect the pinned source externally before use.</p> : <pre>{page.content}</pre>}
      <div className="ah-actions"><button className="btn btn-sm" disabled={loading || offsets.length < 2} onClick={() => setOffsets(values => values.slice(0, -1))}>Previous page</button><span>{offset.toLocaleString()}-{page.nextOffset.toLocaleString()} bytes</span><button className="btn btn-sm" disabled={loading || !page.hasMore || page.encoding === "binary"} onClick={() => setOffsets(values => [...values, page.nextOffset])}>Next page</button></div></>}
  </section>;
}

interface AgentsHubProps { active: boolean; section: AgentsHubSection; onSectionChange(section: AgentsHubSection): void; onOpenSession(): void }
export function AgentsHubContent({ active, section, onSectionChange, onOpenSession }: AgentsHubProps) {
  const librarySection = useRef<Exclude<AgentsHubSection, "instructions">>("skills");
  if (section !== "instructions") librarySection.current = section;
  return <><div hidden={section !== "instructions"}><GlobalInstructions active={active && section === "instructions"} /></div><AgentsHubLibrary active={active && section !== "instructions"} section={librarySection.current} onSectionChange={onSectionChange} onOpenSession={onOpenSession} /></>;
}

function AgentsHubLibrary({ active, section: tab, onSectionChange, onOpenSession }: Omit<AgentsHubProps, "section"> & { section: Exclude<AgentsHubSection, "instructions"> }) {
  const [summary, setSummary] = useState<HubSummary | null>(() => peekHub() ?? null);
  const [draft, setDraft] = useState(emptyHubDraft);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [selected, setSelected] = useState("");
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState("");
  const [note, setNote] = useState("");
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(12);
  const [rendered, setRendered] = useState(false);
  const [deployProfile, setDeployProfile] = useState<string | null>(null);
  const [targets, setTargets] = useState<{ host: string; cwd: string }[]>([{ host: "", cwd: "" }]);
  const [previews, setPreviews] = useState<HubPreview[]>([]);
  const [adoptExisting, setAdoptExisting] = useState(false);
  const [picker, setPicker] = useState<number | null>(null);
  const actionRef = useRef(false);
  const pendingSelection = useRef("");
  const importController = useRef<AbortController | null>(null);
  const devices = useStore(store => store.devices);
  const dirty = draft.changes.length > 0;
  const busy = pendingAction !== null;
  const state = useMemo(() => summary ? hubDraftSummary(summary, draft) : null, [summary, draft]);
  const kind: HubKind | null = tab === "documents" ? "document" : tab === "skills" ? "skill" : tab === "profiles" ? "profile" : null;
  const deploying = Boolean(deployProfile);
  const currentProfile = state?.profiles.find(profile => profile.id === deployProfile);
  const draftRef = useRef(draft); draftRef.current = draft;
  useUnsavedDraft("agents-hub", { label: "Agents Hub", dirty, saving: busy && pendingAction !== "refresh", revision: `${draft.revision}:${draft.version}` });
  const report = (cause: unknown) => setError(message(cause));
  const run = async (action: string, operation: () => Promise<void>) => {
    if (actionRef.current) return;
    actionRef.current = true; setPendingAction(action); setError("");
    try { await operation(); } catch (cause) { report(cause); } finally { actionRef.current = false; setPendingAction(null); }
  };
  const refresh = (fresh = true) => run("refresh", async () => { setSummary(await fetchHub(fresh)); setPreviews([]); });
  useEffect(() => { if (active && !dirty) void refresh(false); }, [active]);
  useEffect(() => { if (!active) setPicker(null); }, [active]);
  useEffect(() => {
    setSelected(pendingSelection.current); pendingSelection.current = ""; setEditor(null); setQuery(""); setLimit(12); setRendered(false); setPicker(null);
  }, [tab]);
  useEffect(() => {
    if (!selected || !kind || !summary) { setEditor(null); return; }
    let current = true;
    setEditor(null); setDetailLoading(true); setError("");
    const revision = draftRef.current.revision ?? summary.revision;
    const changes = draftRef.current.changes;
    const pending = changes.find(change => hubChangeId(change) === `${kind}:${selected}`);
    const exists = summary[hubCollection(kind)].some(item => item.id === selected);
    const open = async () => {
      if (!exists && pending?.op === "update") return { kind, item: pending.item } as Editor;
      const found = await fetchHubItem(kind, selected, revision);
      if (found.revision !== revision && draftRef.current.changes.length) throw new Error("The library changed while you were editing. Your draft is retained. Save against its original revision or discard and reload before editing another item.");
      if (found.revision !== summary.revision) { if (current) setSummary(await fetchHub(true)); return null; }
      const profileMetadata = kind === "profile" ? hubDraftSummary(summary, draftRef.current).profiles.find(item => item.id === selected) : undefined;
      return { kind, item: { ...found.item, ...(pending?.op === "update" ? pending.item : {}), ...(profileMetadata ? { instructionIds: profileMetadata.instructionIds, skillIds: profileMetadata.skillIds } : {}) } } as Editor;
    };
    void open().then(value => { if (current) setEditor(value); }).catch(cause => { if (current) report(cause); }).finally(() => { if (current) setDetailLoading(false); });
    return () => { current = false; };
  }, [selected, kind, summary]);
  const edit = (change: HubChange) => {
    if (busy || !summary) return;
    setDraft(value => changeHubDraft(value, summary.revision, change));
    if (change.op === "update") setEditor(value => value && value.kind === change.kind && value.item.id === change.item.id ? { ...value, item: { ...value.item, ...change.item } } as Editor : value);
    setPreviews([]); setNote("");
  };
  const add = () => {
    if (!kind || !state || busy) return;
    const id = crypto.randomUUID();
    const framework = state.frameworks.find(item => item.launchSupported)?.id ?? "claude";
    if (kind === "document") edit({ op: "update", kind, item: { id, name: "New instructions", framework, content: "" } });
    else if (kind === "skill") edit({ op: "update", kind, item: { id, name: "New skill", content: "" } });
    else edit({ op: "update", kind, item: { id, name: "New agent", framework, systemPrompt: "", instructionIds: [], skillIds: [] } });
    setSelected(id); setRendered(false);
  };
  const save = () => run("save", async () => {
    if (!dirty || draft.revision === null) return;
    const result = await updateHub(draft.revision, draft.changes);
    setDraft(value => ({ ...emptyHubDraft(), version: value.version + 1 })); setSummary(result); setPreviews([]); setNote("Library changes saved on this device. Existing deployments are unchanged until you sync again.");
  });
  const discard = async () => {
    if (!await confirmAction({ title: "Discard library changes?", message: "All unsaved library edits and newly created items will be lost. Saved source bundles and deployed files are not changed.", confirmLabel: "Discard changes", danger: true })) return;
    void run("discard", async () => {
      const result = await fetchHub(true);
      setDraft(value => ({ ...emptyHubDraft(), version: value.version + 1 })); setSelected(""); setSummary(result); setPreviews([]); setNote("Unsaved changes discarded.");
    });
  };
  const removeItem = async () => {
    if (!editor || !summary || !state || busy) return;
    const { kind, item } = editor;
    const attached = kind === "profile" ? [] : state.profiles.filter(profile => (kind === "document" ? profile.instructionIds : profile.skillIds).includes(item.id));
    if (!await confirmAction({ title: `Remove ${item.name}?`, message: `This removes the item${attached.length ? ` and its attachments from ${attached.map(profile => profile.name).join(", ")}` : ""} when you save. Unsaved edits to it will be lost. Existing deployments stay on disk until a reviewed sync removes managed files.`, confirmLabel: "Remove item", danger: true })) return;
    if (!summary[hubCollection(kind)].some(entry => entry.id === item.id)) setDraft(value => discardNewHubItem(value, kind, item.id));
    else edit({ op: "remove", kind, id: item.id, detachReferences: true });
    setSelected(""); setEditor(null);
  };
  const editedDocument = editor?.kind === "document" ? editor.item : null;
  const editedSkill = editor?.kind === "skill" ? editor.item : null;
  const selectedProfile = editor?.kind === "profile" ? editor.item : null;
  const patchProfile = (patch: Partial<HubProfile>) => { if (selectedProfile) edit({ op: "update", kind: "profile", item: { id: selectedProfile.id, ...patch } }); };
  const changeFramework = async (framework: string) => {
    if (!state || busy) return;
    if (editedDocument) {
      const attached = state.profiles.filter(profile => profile.framework !== framework && profile.instructionIds.includes(editedDocument.id));
      if (attached.length && !await confirmAction({ title: "Detach incompatible instructions?", message: `Changing framework removes this document from ${attached.map(profile => profile.name).join(", ")} when saved. Existing deployments will not change until reviewed sync.`, confirmLabel: "Change framework", danger: true })) return;
      edit({ op: "update", kind: "document", item: { id: editedDocument.id, framework }, detachReferences: true });
    } else if (selectedProfile) {
      if ((selectedProfile.instructionIds.length || selectedProfile.skillIds.length) && !await confirmAction({ title: "Clear profile attachments?", message: "Changing this profile's framework clears its attached documents and skills. Saved deployments are unaffected until you sync again.", confirmLabel: "Change framework", danger: true })) return;
      patchProfile({ framework, instructionIds: [], skillIds: [] });
    }
  };
  const toggleAttachment = async (field: "instructionIds" | "skillIds", id: string, checked: boolean) => {
    if (!selectedProfile || busy) return;
    if (!checked && !await confirmAction({ title: "Remove profile attachment?", message: "The attachment will be removed when you save. A later reviewed sync can remove its managed files from the destination.", confirmLabel: "Detach", danger: true })) return;
    patchProfile({ [field]: checked ? [...selectedProfile[field], id] : selectedProfile[field].filter(value => value !== id) });
  };
  const startPreview = () => run("preview", async () => {
    if (!deployProfile || dirty) return;
    setPreviews([]);
    if (new Set(targets.map(target => JSON.stringify(target))).size !== targets.length) throw new Error("Choose each device and project folder only once.");
    const plans: HubPreview[] = [];
    await readIncrementally(targets, target => previewHub(deployProfile, target.host, target.cwd, adoptExisting), plan => { plans.push(plan); });
    if (new Set(plans.map(plan => JSON.stringify([plan.host, plan.cwd]))).size !== plans.length) throw new Error("Choose each device and project folder only once.");
    setPreviews(plans);
  });
  const apply = async (mode: "sync" | "deploy") => {
    if (!previews.length || busy) return;
    if (!await confirmAction({ title: mode === "deploy" ? "Sync files and launch sessions?" : "Apply reviewed file changes?", message: `${previews.length} destination(s): ${previews.map(plan => `${plan.host || "This device"}: ${plan.cwd}`).join("; ")}. This writes and removes the files shown in the preview, retaining backups.${mode === "deploy" ? " It also starts installed agents as the destination user. Imported scripts can be run by those agents; review all attached skills first." : " Existing sessions may read the updated instructions."}`, confirmLabel: mode === "deploy" ? "Sync and launch" : "Apply sync", danger: true })) return;
    void run(mode, async () => {
      let completed = 0;
      try {
        for (const plan of previews) {
          const result = await applyHub(plan.previewId, mode);
          if (result.status === "failed") throw new Error(result.error || "Deployment failed. Review deployment history.");
          completed++;
          if (mode === "deploy" && result.session) useStore.getState().openSession(result.session, result.cwd, result.host);
        }
        setNote(`${completed} destinations ${mode === "deploy" ? "deployed" : "synced"}.`);
        setDeployProfile(null); onSectionChange("deployments");
        notify({ category: "app", event: mode === "deploy" ? "agents-deploy" : "agents-sync", title: "Agents Hub operation completed", body: `${completed} destinations completed.`, target: { section: "agents-hub" } });
      } catch (cause) { setNote(`${completed} destinations completed before the error. Review history before retrying.`); throw cause; }
      finally { setPreviews([]); try { setSummary(await fetchHub(true)); } catch { /* Retain the operation result when history is temporarily unavailable. */ } }
    });
  };
  const importSkill = async (entry: SkillCatalogEntry, updateId?: string) => {
    if (!summary || dirty || busy) return;
    if (updateId && !await confirmAction({ title: `Update ${entry.name}?`, message: "Replace this skill's saved instructions and complete asset bundle with the current public source. Local skill edits will be replaced. Its ID and profile attachments are preserved; review the new scripts and license before deploying.", confirmLabel: "Download update", danger: true })) return;
    void run(`import:${entry.id}`, async () => {
      const controller = new AbortController(); importController.current = controller;
      setNote("Downloading the complete pinned bundle. Nothing is executed.");
      try {
        const result = await importHubSkill(summary.revision, entry.sourceUrl, entry.subpath, updateId, controller.signal);
        setSummary(result); setPreviews([]); setNote(`${entry.name} ${result.imported.status === "existing" ? "is already imported" : result.imported.status}. View it to review source files and licenses.`);
      } catch (cause) {
        setNote("");
        if (controller.signal.aborted) { setNote("Import cancelled. Refresh the library to check whether it finished before cancellation."); return; }
        throw cause;
      } finally { importController.current = null; }
    });
  };
  const viewSkill = (id: string) => { pendingSelection.current = id; onSectionChange("skills"); };
  const visitSource = (event: MouseEvent<HTMLAnchorElement>) => { if (HAS_TAURI) { event.preventDefault(); void openUrl(event.currentTarget.href).catch(report); } };
  const list = state && kind ? state[hubCollection(kind)].filter(item => item.name.toLowerCase().includes(query.toLowerCase())) : [];
  const catalog = [...SKILL_CATALOG].sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1)).filter(item => `${item.name} ${item.description}`.toLowerCase().includes(query.toLowerCase()));
  const viewRef = useRef({ active, tab, state, busy, query, selected, rendered, limit }); viewRef.current = { active, tab, state, busy, query, selected, rendered, limit };
  useEffect(() => {
    const snapshot = () => { const current = viewRef.current; return { available: current.active, page: current.tab, query: current.query, selectedId: current.selected, preview: current.rendered, limit: current.limit }; };
    const cleanups = [registerAppControlState("agentsHubView", snapshot), registerAppControlHandler("get_agents_hub_view", snapshot), registerAppControlHandler("set_agents_hub_view", args => {
      const current = viewRef.current;
      if (!current.active) throw new Error("Open an Agents Hub library page first.");
      if (current.busy && current.tab !== "discover") throw new Error("Wait for the current library operation.");
      const collection = current.tab === "documents" ? current.state?.documents : current.tab === "skills" ? current.state?.skills : current.tab === "profiles" ? current.state?.profiles : [];
      if (args.selectedId && !collection?.some(item => item.id === args.selectedId)) throw new Error("Choose an item from the current library page.");
      const selectedId = typeof args.selectedId === "string" ? args.selectedId : current.selected;
      if (args.preview !== undefined && (!selectedId || (current.tab !== "documents" && current.tab !== "skills"))) throw new Error("Select a document or skill before changing preview mode.");
      if (args.limit !== undefined && current.tab !== "discover" && current.tab !== "deployments") throw new Error("This page displays all search results without pagination.");
      if (args.query !== undefined && current.tab === "deployments") throw new Error("Deployment history does not support search.");
      if (typeof args.query === "string") { setQuery(args.query); setLimit(12); }
      if (typeof args.selectedId === "string") { setSelected(args.selectedId); setRendered(false); }
      if (typeof args.preview === "boolean") setRendered(args.preview);
      if (typeof args.limit === "number") setLimit(args.limit);
      return { configured: true };
    })];
    return () => cleanups.forEach(cleanup => cleanup());
  }, []);
  return <div className="agents-hub-content" hidden={!active}><div className="ah-layout"><main className="ah-main">
    <div className="ah-toolbar"><span className="ah-save-status" role="status">{dirty ? `${draft.changes.length} unsaved item changes` : busy ? "Working…" : "Local library"}</span><AsyncButton className="btn btn-sm" loading={pendingAction === "refresh"} disabled={busy || dirty} title="Refresh library" aria-label="Refresh library" icon={RefreshCw} onClick={() => void refresh()} />{dirty && <AsyncButton className="btn btn-sm" loading={pendingAction === "discard"} disabled={busy} icon={Trash2} onClick={() => void discard()}>Discard</AsyncButton>}<AsyncButton className="btn btn-sm" loading={pendingAction === "save"} icon={Save} disabled={busy || !dirty} onClick={() => void save()}>Save changes</AsyncButton>{pendingAction?.startsWith("import:") && <button className="btn btn-sm" onClick={() => importController.current?.abort()}>Cancel import</button>}</div>
    {error && <div className="ah-message error" role="alert">{error}</div>}{note && <div className="ah-message" role="status">{note}</div>}
    {tab === "discover" && !deploying ? <div className="ah-scroll"><input className="input ah-search" aria-label="Search skill catalog" placeholder="Search skills…" value={query} onChange={event => { setQuery(event.target.value); setLimit(12); }} /><div className="ah-catalog">{catalog.slice(0, limit).map(entry => {
      const imported = state?.skills.find(skill => skill.sourceUrl && skill.subpath !== undefined && sourceKey(skill.sourceUrl, skill.subpath) === sourceKey(entry.sourceUrl, entry.subpath));
      return <article key={entry.id}><div className="ah-catalog-copy"><h3>{entry.name}</h3><p>{entry.description}</p><small><a onClick={visitSource} href={entry.licenseUrl} target="_blank" rel="noopener noreferrer">{entry.license}</a> · {entry.stars === null ? "Stars unavailable" : `${entry.stars.toLocaleString()} repository stars`} · checked {entry.checkedAt}</small><a onClick={visitSource} href={`${entry.sourceUrl}/tree/HEAD/${entry.subpath}`} target="_blank" rel="noopener noreferrer">Source: {entry.sourceUrl.replace("https://github.com/", "")}</a></div><div className="ah-catalog-actions">{imported ? <><span className="ah-imported"><Check size={12} />Imported</span><button className="btn btn-sm" onClick={() => viewSkill(imported.id)}>View skill</button><AsyncButton className="btn btn-sm" icon={Download} loading={pendingAction === `import:${entry.id}`} disabled={busy || dirty} onClick={() => void importSkill(entry, imported.id)}>Update</AsyncButton></> : <AsyncButton className="btn btn-sm" icon={Download} loading={pendingAction === `import:${entry.id}`} disabled={!summary || busy || dirty} onClick={() => void importSkill(entry)}>Import</AsyncButton>}</div></article>;
    })}</div><ScrollMore hasMore={limit < catalog.length} loadMore={() => setLimit(value => value + 12)} /></div> : !state ? <div className="ah-message">{busy ? "Loading library metadata…" : "The library is unavailable. Use Refresh to retry."}</div> : <div className="ah-scroll">
      {deploying ? <section className="ah-deploy"><div className="ah-actions"><h3>Deploy {currentProfile?.name}</h3><button className="btn btn-sm" disabled={busy} onClick={() => { setDeployProfile(null); setPreviews([]); }}>Cancel</button></div><p className="set-note">Choose devices and existing absolute project folders. Separate profiles need separate folders. Preview checks ownership and file changes before applying.</p>
        {targets.map((target, index) => <div key={index} className="ah-target"><label className="ah-target-device">Device<Select value={target.host} options={devices.map(device => ({ value: deviceHost(device), label: device.name }))} onChange={host => { if (busy) return; setTargets(value => value.map((row, i) => i === index ? { host, cwd: "" } : row)); setPreviews([]); }} /></label><label className="ah-target-folder">Project folder<input className="input" aria-label={`Project folder ${index + 1}`} placeholder="/absolute/project/folder" value={target.cwd} disabled={busy} onChange={event => { setTargets(value => value.map((row, i) => i === index ? { ...row, cwd: event.target.value } : row)); setPreviews([]); }} /></label><button className="btn btn-sm" disabled={busy} onClick={() => setPicker(index)}>Browse</button>{targets.length > 1 && <button className="ah-remove-target" disabled={busy} aria-label={`Remove target ${index + 1}`} onClick={() => { setTargets(value => value.filter((_, i) => i !== index)); setPreviews([]); }}><X size={14} /></button>}</div>)}
        <label className="set-note ah-adopt"><input type="checkbox" checked={adoptExisting} disabled={busy} onChange={event => { setAdoptExisting(event.target.checked); setPreviews([]); }} />Replace existing instruction and skill files after reviewing a fresh preview. Prior contents receive private backups; other profiles remain protected.</label>
        <div className="ah-actions"><button className="btn btn-sm" disabled={busy || targets.length >= 20} onClick={() => { setTargets(value => [...value, { host: "", cwd: "" }]); setPreviews([]); }}>Add destination</button><button className="btn btn-sm" disabled={busy || devices.length > 20} onClick={() => { setTargets(devices.map(device => { const host = deviceHost(device); return targets.find(target => target.host === host) ?? { host, cwd: "" }; })); setPreviews([]); }}>All devices</button><AsyncButton className="btn" loading={pendingAction === "preview"} disabled={busy || dirty || !targets.length || targets.some(target => !target.cwd.startsWith("/"))} onClick={() => void startPreview()}>Preview changes</AsyncButton></div>
        {previews.map(plan => <div className="ah-plan" key={plan.previewId}><strong>{plan.host || "This device"} · {plan.cwd}</strong>{plan.conflicts.map(conflict => <p className="ah-message error" key={conflict}>{conflict}</p>)}{plan.files.map(file => <details key={file.path}><summary>{file.path} · {file.operation === "delete" ? "remove managed file" : file.baselineSha256 ? "existing file" : "new file"}</summary><pre>{file.previousContent !== undefined ? `Existing content:\n${file.previousEncoding === "base64" ? "Binary asset" : file.previousContent}\n\nProposed content:\n` : ""}{file.operation === "delete" ? "This previously managed file will be removed." : file.encoding === "base64" ? "Binary asset from the imported bundle." : file.content}</pre></details>)}<p className="set-note">{plan.launch.supported ? `Launch: ${plan.launch.command}` : "Instruction sync only; terminal launch is unavailable."}</p></div>)}
        {previews.length > 0 && <div className="ah-actions"><AsyncButton className="btn" loading={pendingAction === "sync"} disabled={busy || previews.some(plan => plan.conflicts.length > 0)} onClick={() => void apply("sync")}>Apply sync</AsyncButton><AsyncButton className="btn" loading={pendingAction === "deploy"} icon={Play} disabled={busy || previews.some(plan => plan.conflicts.length > 0 || !plan.launch.supported)} onClick={() => void apply("deploy")}>Sync & launch</AsyncButton></div>}
      </section> : tab === "deployments" ? <>{state.deployments.length ? [...state.deployments].reverse().slice(0, limit).map(deployment => <article className="ah-history" key={deployment.id}><div className="ah-history-head"><strong>{state.profiles.find(profile => profile.id === deployment.profileId)?.name ?? deployment.profileId}</strong><span className="ah-status">{deployment.status}</span></div><p className="ah-history-path">{deployment.cwd}</p><small>{deployment.host || "This device"}</small><small>{new Date(deployment.createdAt).toLocaleString()} · {deployment.mode}</small>{deployment.backupPath && <p className="set-note">Previous files backed up: <code>{deployment.backupPath}</code></p>}{deployment.error && <p role="alert">{deployment.error}</p>}{deployment.session && <button className="btn btn-sm" onClick={() => { if (deployment.session) useStore.getState().openSession(deployment.session, deployment.cwd, deployment.host); onOpenSession(); }}>Open session</button>}</article>) : <p className="set-note">No deployments yet. Create a profile, then choose Deploy.</p>}<ScrollMore hasMore={limit < state.deployments.length} loadMore={() => setLimit(value => value + 12)} /></> : <div className="ah-workbench">
        <div className="ah-library" hidden={Boolean(selected)}><div className="ah-library-toolbar"><input className="input" aria-label="Search library" placeholder="Search…" value={query} onChange={event => setQuery(event.target.value)} /><button className="btn btn-sm" disabled={busy} onClick={add}><Plus size={14} />{tab === "documents" ? "New instructions" : tab === "profiles" ? "New profile" : "New skill"}</button></div><div className="ah-library-list">{list.map(item => <button className="ah-list-item" key={item.id} onClick={() => { setSelected(item.id); setRendered(false); }}><span className="ah-item-copy"><strong>{item.name}</strong><small>{"framework" in item ? state.frameworks.find(framework => framework.id === item.framework)?.label ?? item.framework : "files" in item && item.files ? `${item.files.length} files · Imported` : "Local skill"}</small></span><ChevronRight size={14} /></button>)}</div>{!list.length && <p className="ah-empty">{query ? "No matching items." : "Your library is empty. Create an item to get started."}</p>}</div>
        <section className="ah-editor" hidden={!selected}><button className="ah-back" onClick={() => setSelected("")}><ArrowLeft size={14} />All {agentsHubSections.find(item => item.id === tab)?.label.toLowerCase()}</button>{detailLoading && <p role="status">Loading selected item…</p>}
          {editedDocument ? <><div className="ah-fields"><label>Name<input className="input" value={editedDocument.name} disabled={busy} onChange={event => edit({ op: "update", kind: "document", item: { id: selected, name: event.target.value } })} /></label><label>Framework<Select value={editedDocument.framework} options={state.frameworks.map(framework => ({ value: framework.id, label: framework.label }))} onChange={framework => void changeFramework(framework)} /></label></div><p className="set-note">Reusable project guidance. Attach it to a profile before previewing deployment.</p></> : editedSkill ? <><div className="ah-fields"><label>Name<input className="input" value={editedSkill.name} disabled={busy} onChange={event => edit({ op: "update", kind: "skill", item: { id: selected, name: event.target.value } })} /></label><p className="set-note">SKILL.md instructions. Asset bundles remain intact when you edit this text.</p></div></> : null}
          {editedDocument || editedSkill ? <><div className="ah-actions ah-editor-actions"><button className="btn btn-sm" disabled={busy} onClick={() => void removeItem()}><Trash2 size={14} />Remove</button><span className="ah-view-switch"><button className={`btn btn-sm ${!rendered ? "btn-on" : ""}`} onClick={() => setRendered(false)}>Edit</button><button className={`btn btn-sm ${rendered ? "btn-on" : ""}`} onClick={() => setRendered(true)}>Preview</button></span></div>{rendered ? <MarkdownPreview content={(editedDocument ?? editedSkill)!.content} /> : <textarea className="input ah-source" aria-label={editedDocument ? "Project instruction content" : "Skill content"} spellCheck={false} value={(editedDocument ?? editedSkill)!.content} disabled={busy} onChange={event => edit({ op: "update", kind: editedDocument ? "document" : "skill", item: { id: selected, content: event.target.value } })} />}</> : null}
          {editedSkill?.sourceUrl && <a onClick={visitSource} href={`${editedSkill.sourceUrl}${editedSkill.subpath !== undefined && editedSkill.commit ? `/tree/${editedSkill.commit}/${editedSkill.subpath}` : ""}`} target="_blank" rel="noopener noreferrer">Pinned skill source{editedSkill.commit ? ` · ${editedSkill.commit.slice(0, 12)}` : ""}</a>}{editedSkill?.files?.length && summary ? <SkillAssets key={`${editedSkill.id}:${summary.revision}`} skill={editedSkill} revision={summary.revision} /> : null}
          {selectedProfile && <><div className="ah-fields"><label>Profile name<input className="input" value={selectedProfile.name} disabled={busy} onChange={event => patchProfile({ name: event.target.value })} /></label><label>Framework<Select value={selectedProfile.framework} options={state.frameworks.map(framework => ({ value: framework.id, label: framework.label, sub: framework.launchSupported ? "Instruction sync and terminal launch" : "Instruction sync" }))} onChange={framework => void changeFramework(framework)} /></label></div><label>Additional instructions<textarea className="input ah-source" aria-label="Agent instructions" value={selectedProfile.systemPrompt} disabled={busy} onChange={event => patchProfile({ systemPrompt: event.target.value })} /></label><p className="set-note">These become project guidance, not a replacement for the framework's built-in rules. The destination device and folder are chosen at deployment.</p><div className="ah-attachments"><fieldset><legend>Instruction documents</legend>{state.documents.filter(item => item.framework === selectedProfile.framework).map(item => <label key={item.id}><input type="checkbox" checked={selectedProfile.instructionIds.includes(item.id)} disabled={busy} onChange={event => void toggleAttachment("instructionIds", item.id, event.target.checked)} />{item.name}</label>)}</fieldset><fieldset><legend>Skills</legend>{state.skills.map(item => <label key={item.id}><input type="checkbox" checked={selectedProfile.skillIds.includes(item.id)} disabled={busy || !state.frameworks.find(framework => framework.id === selectedProfile.framework)?.skillsDirectory} onChange={event => void toggleAttachment("skillIds", item.id, event.target.checked)} />{item.name}</label>)}</fieldset></div><button className="btn btn-sm" disabled={busy} onClick={() => void removeItem()}><Trash2 size={14} />Remove profile</button><button className="btn" disabled={dirty || busy} onClick={() => { setDeployProfile(selectedProfile.id); setTargets([{ host: "", cwd: "" }]); setAdoptExisting(false); setPreviews([]); }}><Play size={14} />Deploy profile…</button></>}
          {!editor && !detailLoading && <p className="set-note">Select an item or create one. Your edits stay in this draft until you save.</p>}
        </section></div>}
    </div>}
  </main></div>{picker !== null ? <FilePicker open mode="folder" host={targets[picker]?.host} onClose={() => setPicker(null)} onPick={(cwd, host) => { setTargets(value => value.map((row, i) => i === picker ? { host, cwd } : row)); setPreviews([]); setPicker(null); }} /> : null}</div>;
}
