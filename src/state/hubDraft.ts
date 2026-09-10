import type { HubChange, HubKind, HubSummary } from "../agentsHubApi";

export interface HubDraft { revision: number | null; changes: HubChange[]; version: number }
export const emptyHubDraft = (): HubDraft => ({ revision: null, changes: [], version: 0 });
export const hubChangeId = (change: HubChange) => `${change.kind}:${change.op === "update" ? change.item.id : change.id}`;
export const hubCollection = (kind: HubKind) => ({ document: "documents", skill: "skills", profile: "profiles" } as const)[kind];
export function changeHubDraft(draft: HubDraft, revision: number, change: HubChange): HubDraft {
  const previous = draft.changes.find(item => hubChangeId(item) === hubChangeId(change));
  const merged = change.op === "update" && previous?.op === "update" && previous.kind === change.kind
    ? { ...previous, ...change, item: { ...previous.item, ...change.item } } as HubChange : change;
  return { revision: draft.revision ?? revision, version: draft.version + 1, changes: [...draft.changes.filter(item => hubChangeId(item) !== hubChangeId(change)), merged] };
}

export function discardNewHubItem(draft: HubDraft, kind: HubKind, id: string): HubDraft {
  const changes = draft.changes.filter(change => hubChangeId(change) !== `${kind}:${id}`).map(change => {
    if (change.op !== "update" || change.kind !== "profile" || kind === "profile") return change;
    const field = kind === "document" ? "instructionIds" : "skillIds";
    const ids = change.item[field];
    return ids ? { ...change, item: { ...change.item, [field]: ids.filter(value => value !== id) } } : change;
  });
  return { ...draft, changes, version: draft.version + 1 };
}

export function hubDraftSummary(summary: HubSummary, draft: HubDraft): HubSummary {
  const result = { ...summary, documents: [...summary.documents], skills: [...summary.skills], profiles: [...summary.profiles] };
  for (const change of draft.changes) {
    if (change.op === "remove") {
      if (change.kind === "document") result.documents = result.documents.filter(item => item.id !== change.id);
      if (change.kind === "skill") result.skills = result.skills.filter(item => item.id !== change.id);
      if (change.kind === "profile") result.profiles = result.profiles.filter(item => item.id !== change.id);
    } else if (change.kind === "document") {
      const { content, ...metadata } = change.item;
      const existing = result.documents.find(item => item.id === metadata.id);
      if (existing) result.documents = result.documents.map(item => item.id === metadata.id ? { ...item, ...metadata } : item);
      else if (metadata.name && metadata.framework) result.documents.push({ id: metadata.id, name: metadata.name, framework: metadata.framework, contentBytes: new TextEncoder().encode(content).length });
    } else if (change.kind === "skill") {
      const { content, ...metadata } = change.item;
      const existing = result.skills.find(item => item.id === metadata.id);
      if (existing) result.skills = result.skills.map(item => item.id === metadata.id ? { ...item, ...metadata } : item);
      else if (metadata.name) result.skills.push({ ...metadata, name: metadata.name, contentBytes: new TextEncoder().encode(content).length });
    } else {
      const { systemPrompt, ...metadata } = change.item;
      const existing = result.profiles.find(item => item.id === metadata.id);
      if (existing) result.profiles = result.profiles.map(item => item.id === metadata.id ? { ...item, ...metadata } : item);
      else if (metadata.name && metadata.framework && metadata.instructionIds && metadata.skillIds) result.profiles.push({ id: metadata.id, name: metadata.name, framework: metadata.framework, instructionIds: metadata.instructionIds, skillIds: metadata.skillIds, systemPromptBytes: new TextEncoder().encode(systemPrompt).length });
    }
  }
  for (const change of draft.changes) {
    if (!change.detachReferences || change.kind === "profile") continue;
    const id = change.op === "remove" ? change.id : change.item.id;
    result.profiles = result.profiles.map(profile => change.kind === "skill"
      ? { ...profile, skillIds: profile.skillIds.filter(value => change.op !== "remove" || value !== id) }
      : { ...profile, instructionIds: profile.instructionIds.filter(value => value !== id || (change.op !== "remove" && result.documents.find(document => document.id === id)?.framework === profile.framework)) });
  }
  return result;
}
