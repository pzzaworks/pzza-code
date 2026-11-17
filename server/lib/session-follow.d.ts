export const PREVIOUS_NAMES_OPTION: string;
export const PREVIOUS_NAMES_SEPARATOR: string;
export const PREVIOUS_NAMES_KEPT: number;
export const RENAMED_OSC: number;
export interface SessionPreviousNames { name: string; previous: string[] }
export function followRenamedScript(tmux: string, name: string): string;
export function rememberPreviousNameScript(tmux: string, oldName: string, newName: string): string;
export function parsePreviousNames(output: string): SessionPreviousNames[];
export function currentSessionName(sessions: readonly SessionPreviousNames[], name: string): string | null;
