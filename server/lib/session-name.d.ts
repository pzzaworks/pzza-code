import type { AppArgumentSchema } from "./app-control-schema.js";

export const SESSION_NAME_MAX_LENGTH: number;
export const SESSION_NAME_PATTERN: string;
export const SESSION_NAME_SCHEMA: AppArgumentSchema;
export function normalizeSessionName(value: unknown): string;
