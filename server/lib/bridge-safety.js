import path from "node:path";
import os from "node:os";
import { sensitivePath } from "./paths.js";

export const BRIDGE_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export function bridgeError(message, status = 400, code = ({ 400: "INVALID_ARGUMENT", 401: "UNAUTHENTICATED", 403: "DENIED", 404: "NOT_FOUND", 409: "CONFLICT", 429: "CAPACITY", 503: "UNAVAILABLE", 504: "TIMEOUT" })[status] || "ACTION_FAILED", details) {
  return Object.assign(new Error(message), { status, code, ...(details ? { details } : {}) });
}
const privatePart = /^(?:\.env(?:\..*)?|\.git|\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.npmrc|\.netrc|\.pypirc|\.credentials\.json|auth\.json|credentials(?:\..*)?|agent-token|identity\.pem|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|key|p12|pfx|keystore))$/i;
export function privateBridgePath(target) {
  const resolved = path.resolve(target);
  const relative = path.relative(os.homedir(), resolved);
  const parts = resolved.split(path.sep).filter(Boolean);
  return sensitivePath(relative) || parts.some(part => privatePart.test(part)) ||
    /(?:^|\/)(?:Library\/(?:Keychains|Cookies|Application Support\/(?:Google|Microsoft Edge|Chromium|Firefox|pzzacode))|\.config\/(?:pzzacode|google-chrome|chromium|microsoft-edge)|\.mozilla)(?:\/|$)/i.test(resolved);
}
export function assertBridgePath(target) {
  if (privateBridgePath(target)) throw bridgeError("Credential, environment, browser profile and private state paths are not available through the bridge", 403, "SENSITIVE_PATH");
}
export function browserOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw bridgeError("Choose an explicit HTTP or HTTPS origin"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.origin === "null" || url.hostname === "tauri.localhost") throw bridgeError("Browser access requires a web origin without credentials", 403, "ORIGIN_DENIED");
  return url.origin;
}
export function validateResources(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["simulatorIds", "bundleIds", "browserOrigins"].includes(key))) throw bridgeError("Invalid device resource scopes");
  const result = {};
  for (const key of ["simulatorIds", "bundleIds", "browserOrigins"]) {
    const list = value[key] ?? [];
    if (!Array.isArray(list) || list.length > 64 || new Set(list).size !== list.length || list.some(entry => typeof entry !== "string")) throw bridgeError("Invalid device resource scope list");
    if (key === "simulatorIds" && list.some(id => !BRIDGE_UUID.test(id.toLowerCase()))) throw bridgeError("Simulator scopes must be explicit UUIDs");
    if (key === "bundleIds" && list.some(id => !/^[A-Za-z0-9][A-Za-z0-9.-]{1,200}$/.test(id))) throw bridgeError("Bundle scopes must be explicit bundle identifiers");
    if (key === "browserOrigins" && list.some(origin => browserOrigin(origin) !== origin)) throw bridgeError("Browser scopes must be origins without paths");
    result[key] = key === "simulatorIds" ? list.map(id => id.toLowerCase()) : [...list];
  }
  return result;
}
