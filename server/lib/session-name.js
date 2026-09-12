export const SESSION_NAME_MAX_LENGTH = 128;
export const SESSION_NAME_PATTERN = "^[A-Za-z0-9_ -]+$";
export const SESSION_NAME_SCHEMA = {
  type: "string", minLength: 1, maxLength: SESSION_NAME_MAX_LENGTH, pattern: SESSION_NAME_PATTERN,
};

export function normalizeSessionName(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("Enter a session name.");
  if (value.length > SESSION_NAME_MAX_LENGTH) throw new Error(`Session names can contain at most ${SESSION_NAME_MAX_LENGTH} characters.`);
  if (/[^A-Za-z0-9_ -]/.test(value)) throw new Error("Use letters, numbers, spaces, hyphens or underscores for the session name.");
  return value.trim();
}
