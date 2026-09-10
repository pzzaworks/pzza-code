import { timingSafeEqual, createHash } from "node:crypto";
import { bridgeError } from "./bridge-safety.js";

// Read once at startup and remove before any user-controlled child can inherit it.
export function takeNativeConsentKey() {
  const key = process.env.PZZA_BRIDGE_CONSENT_KEY;
  delete process.env.PZZA_BRIDGE_CONSENT_KEY;
  return typeof key === "string" && /^[a-f0-9]{64}$/.test(key) ? key : null;
}
export function requireNativeConsent(key, req) {
  const supplied = req.headers["x-pzza-native-consent"];
  if (!key || typeof supplied !== "string" || !/^[a-f0-9]{64}$/.test(supplied) || supplied.length !== key.length ||
      !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress) ||
      !timingSafeEqual(Buffer.from(key), Buffer.from(supplied))) {
    throw bridgeError("This decision requires confirmation in the receiving desktop app. Ordinary agent credentials cannot approve it.", 403, "LOCAL_CONSENT_REQUIRED");
  }
}
export function consentDigest(value) {
  const canonical = entry => Array.isArray(entry) ? entry.map(canonical) : entry && typeof entry === "object" ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, canonical(entry[key])])) : entry;
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}
