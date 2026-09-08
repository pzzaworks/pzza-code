import { agentsHubRequest } from "./serverApi";
export interface HubFramework { id: string; label: string; instructionFile: string; skillsDirectory: string | null; launchSupported: boolean }
export interface HubDocument { id: string; name: string; framework: string; content: string }
export interface HubSkill { id: string; name: string; content: string; sourceUrl?: string; license?: string; commit?: string; files?: { path: string; contentBase64: string; executable?: boolean }[] }
export interface HubProfile { id: string; name: string; framework: string; systemPrompt: string; instructionIds: string[]; skillIds: string[] }
export interface HubDeployment { id: string; profileId: string; host: string; cwd: string; mode: string; status: string; session?: string; backupPath?: string; error?: string; createdAt: number; revision: number }
export interface HubState { revision: number; documents: HubDocument[]; skills: HubSkill[]; profiles: HubProfile[]; deployments: HubDeployment[]; frameworks: HubFramework[] }
export interface HubPreview { previewId: string; revision: number; profileId: string; host: string; cwd: string; files: { path: string; content: string | null; encoding?: "utf8" | "base64"; operation?: "write" | "delete"; previousContent?: string; previousEncoding?: "utf8" | "base64"; baselineSha256: string | null; contentBase64?: string }[]; launch: { supported: boolean; command: string | null }; conflicts: string[] }
export const fetchHub = () => agentsHubRequest<HubState>("state");
export const saveHub = ({ revision, documents, skills, profiles }: HubState) => agentsHubRequest<HubState>("save", { revision, documents, skills, profiles });
export const previewHub = (profileId: string, host: string, cwd: string, adoptExisting = false) => agentsHubRequest<HubPreview>("preview", { profileId, host, cwd, adoptExisting });
export const applyHub = (previewId: string, mode: "sync" | "deploy") => agentsHubRequest<HubDeployment>(mode, { previewId });
export const importHubSkill = (revision: number, sourceUrl: string, subpath: string) => agentsHubRequest<HubState>("import-skill", { revision, sourceUrl, subpath });

export interface HubDiscoveredFile { path: string; cwd: string; framework: string; bytes: number; sha256: string }
export interface HubDiscoveryDevice { host: string; name: string; root?: string; files: HubDiscoveredFile[]; truncated?: boolean; error?: string }
export interface HubDiscovery { devices: HubDiscoveryDevice[]; state: HubState }
export const discoverHubInstructions = (devices: { host: string; name: string }[]) => agentsHubRequest<HubDiscovery>("discover", { devices });
export const readHubInstruction = (host: string, root: string, file: HubDiscoveredFile) => agentsHubRequest<Omit<HubDocument, "id">>("read-instruction", { host, root, path: file.path, sha256: file.sha256 });
export const previewHubInstruction = (documentId: string, host: string, cwd: string, adoptExisting: boolean) => agentsHubRequest<HubPreview>("preview", { documentId, host, cwd, adoptExisting });
