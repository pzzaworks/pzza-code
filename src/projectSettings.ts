import type { SyncOptions } from "./serverApi";

export function deviceExclusions(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function projectSettings(value: unknown, fallback: SyncOptions): SyncOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fallback;
  const input = value as Record<string, unknown>;
  const repos: SyncOptions["repos"] = {};
  if (input.repos && typeof input.repos === "object" && !Array.isArray(input.repos)) {
    for (const [id, settings] of Object.entries(input.repos)) {
      if (!settings || typeof settings !== "object" || Array.isArray(settings) || id === "__proto__") continue;
      const item = settings as Record<string, unknown>;
      repos[id] = { enabled: typeof item.enabled === "boolean" ? item.enabled : true, env: typeof item.env === "boolean" ? item.env : true };
    }
  }
  const boolean = (key: "cloneMissing" | "switchToDefault" | "stashDirty" | "syncEnvs") =>
    typeof input[key] === "boolean" ? input[key] : fallback[key];
  return { cloneMissing: boolean("cloneMissing"), switchToDefault: boolean("switchToDefault"),
    stashDirty: boolean("stashDirty"), syncEnvs: boolean("syncEnvs"), envExclude: deviceExclusions(input.envExclude), repos };
}
