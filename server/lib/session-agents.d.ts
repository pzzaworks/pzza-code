export type SessionAgentId =
  | "claude" | "codex" | "opencode" | "gemini" | "cursor" | "copilot" | "pi" | "cline" | "goose" | "antigravity"
  | "qwen" | "crush" | "kilo" | "grok" | "amp" | "droid" | "kiro" | "codebuddy" | "kimi" | "devin"
  | "vibe" | "aider" | "warp" | "auggie" | "letta" | "qoder" | "forgecode" | "rovodev" | "junie";

/** What a mode lets through without asking. */
export type SessionAgentApproval = "ask" | "restricted" | "auto" | "bypass";

export interface SessionAgentMode {
  id: string;
  label: string;
  description: string;
  args: readonly string[];
  /** Fixed environment variables the mode is launched with. */
  env?: Readonly<Record<string, string>>;
  approval: SessionAgentApproval;
}

export interface SessionAgentResume {
  /** continue-last: a flag or subcommand continues the newest conversation; by-id: only with an id the app does not track. */
  kind: "none" | "continue-last" | "by-id";
  /** How far "newest" reaches. Only directory scope is resumed automatically. */
  scope: "directory" | "global" | "account";
  args: readonly string[];
}

export interface SessionAgentPrompt {
  style: "arg" | "flag" | "none";
  /** The flag before the prompt, for style "flag". */
  flag?: string;
  /** Written before a positional prompt, for style "arg". */
  separator?: string;
  /** Replaces the agent's baseArgs when a prompt is given. */
  baseArgs?: readonly string[];
}

export interface SessionAgentInstall {
  method: "brew" | "npm" | "curl" | "uv";
  command: string;
}

export interface SessionAgentDetect {
  /** Executable or argv[0] basenames that identify the agent. */
  names: readonly string[];
  /** Regular expressions on an executable path that identify it. */
  paths?: readonly string[];
  /** When the executable is a path, it must match one of these. */
  requirePaths?: readonly string[];
  /** Executable paths that are never this agent. */
  excludePaths?: readonly string[];
  /** Regular expressions on the script an interpreter runs. */
  entries?: readonly string[];
  /** Titles a retitled interpreter reports. */
  titles?: readonly string[];
  /** Per executable name: a regular expression the first argument must match ("" when none). */
  requireArgs?: Readonly<Record<string, string>>;
  /** First arguments that mean a non-interactive run. */
  excludeSubcommands?: readonly string[];
  /** Arguments that mean a non-interactive run anywhere on the command line. */
  excludeFlags?: readonly string[];
  /** Unambiguous names tmux shows as the pane command while the agent runs. */
  programs: readonly string[];
  /** The installed binary is named after its version (Claude Code). */
  versionProgram?: boolean;
}

export interface SessionAgentStorage {
  /** Where transcripts or session data live; `~` is the home folder. */
  paths: readonly string[];
  format: "jsonl" | "json" | "sqlite" | "markdown" | "remote" | "unknown";
  /** Token counts can be read from these files. */
  tokens: boolean;
  cost: "computed" | "stored" | "cli" | "none";
  /** Where subscription limits come from, if anywhere. */
  limits: "api" | "files" | "cli" | null;
}

export interface SessionAgentDefinition {
  id: SessionAgentId;
  label: string;
  vendor: string;
  tier: 1 | 2;
  homepage: string;
  command: string;
  /** Binary names to look for when checking what is installed. */
  binaries: readonly string[];
  /** Per-user install folders relative to the home folder. */
  installDirs: readonly string[];
  baseArgs: readonly string[];
  /** Added only when starting a new conversation. */
  freshArgs: readonly string[];
  defaultMode: string;
  modes: readonly SessionAgentMode[];
  resume: SessionAgentResume;
  prompt: SessionAgentPrompt;
  install: readonly SessionAgentInstall[];
  detect: SessionAgentDetect;
  storage: SessionAgentStorage;
}

export interface SessionAgentChoice {
  id: SessionAgentId;
  mode: string;
  resume?: boolean;
  prompt?: string;
}

export interface SessionAgentLaunch {
  env: [string, string][];
  argv: string[];
}

export interface SessionAgentResumeEntry {
  agent: SessionAgentId;
  command: string;
  programs: string[];
  versionProgram: boolean;
}

export interface AgentProcessRule {
  id: SessionAgentId;
  names: string[];
  paths: string[];
  requirePaths: string[];
  excludePaths: string[];
  entries: string[];
  titles: string[];
  requireArgs: Record<string, string>;
  excludeSubcommands: string[];
  excludeFlags: string[];
}

/** A plain path fragment; `end` anchors it at the end of the path. */
export interface AgentPathFragment {
  text: string;
  end: boolean;
}

/** Where an installed binary of the agent may live (see agentBinaryPathRules). */
export interface AgentBinaryPathRules {
  exclude: AgentPathFragment[];
  require: AgentPathFragment[];
}

export interface AgentProcess {
  command?: string;
  executable?: string;
  entrypoint?: string;
  title?: string;
  args?: readonly string[];
}

export const SESSION_AGENTS: readonly SessionAgentDefinition[];
export const SESSION_AGENT_IDS: readonly SessionAgentId[];
export const SESSION_PROMPT_MAX_LENGTH: number;
export function sessionAgent(id: unknown): SessionAgentDefinition | undefined;
export function defaultSessionAgentMode(agent: SessionAgentDefinition): SessionAgentMode;
export function sessionAgentMode(agent: SessionAgentDefinition, modeId: unknown): SessionAgentMode;
export function agentCanContinue(agent: SessionAgentDefinition | undefined): boolean;
export function agentCanAutoResume(agent: SessionAgentDefinition | undefined): boolean;
export function agentTakesPrompt(agent: SessionAgentDefinition | undefined): boolean;
export function sessionPromptError(value: unknown): string | null;
export function validSessionPrompt(value: unknown): boolean;
export function sessionAgentLaunch(value: unknown): SessionAgentLaunch;
export function sessionAgentCommand(value: unknown): string;
export function sessionAgentResumeCommand(id: unknown, recorded?: Pick<SessionAgentChoice, "id" | "mode">): string | null;
export function sessionAgentResumeAllowlist(): SessionAgentResumeEntry[];
export function agentForProgram(value: unknown): SessionAgentId | undefined;
export function agentProcessRules(): AgentProcessRule[];
export function agentBinaryPathRules(agent: SessionAgentDefinition): AgentBinaryPathRules;
export function agentBinaryAllowed(agent: SessionAgentDefinition, paths: readonly string[]): boolean;
export function matchAgentProcess(process: AgentProcess, rules: readonly AgentProcessRule[]): SessionAgentId | "";
