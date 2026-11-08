export type SessionAgentId = "claude" | "codex" | "opencode";

export interface SessionAgentMode {
  id: string;
  label: string;
  description: string;
  args: readonly string[];
}

export interface SessionAgentDefinition {
  id: SessionAgentId;
  label: string;
  command: string;
  resumeArgs: readonly string[];
  promptFlag: string | null;
  modes: readonly SessionAgentMode[];
}

export interface SessionAgentChoice {
  id: SessionAgentId;
  mode: string;
  resume?: boolean;
  prompt?: string;
}

export const SESSION_AGENTS: readonly SessionAgentDefinition[];
export const SESSION_PROMPT_MAX_LENGTH: number;
export function sessionAgent(id: unknown): SessionAgentDefinition | undefined;
export function validSessionPrompt(value: unknown): boolean;
export function sessionAgentCommand(value: unknown): string;
