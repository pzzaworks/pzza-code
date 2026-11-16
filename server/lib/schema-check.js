// Checks a value against the bounded JSON-schema subset the app-control
// schemas use (object, array, number, integer, string, boolean). Unknown
// object keys are refused. Shared by server validation, frontend validation
// and theme import, so every entry point enforces the same bounds.
const stableValue = value => Array.isArray(value) ? value.map(stableValue)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])])) : value;

export function checkSchema(schema, value, field) {
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object.`);
    if (Object.keys(value).some(key => !Object.hasOwn(schema.properties, key))) throw new Error(`Unknown ${field} argument.`);
    if (schema.minProperties && Object.keys(value).length < schema.minProperties) throw new Error(`${field} must include a setting.`);
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) throw new Error(`${key} is required.`);
    for (const [key, item] of Object.entries(value)) checkSchema(schema.properties[key], item, key);
  } else if (schema.type === "array") {
    if (!Array.isArray(value) || value.length > schema.maxItems || value.length < (schema.minItems ?? 0)) throw new Error(`Invalid ${field}.`);
    for (const item of value) checkSchema(schema.items, item, field);
    if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(stableValue(item)))).size !== value.length) throw new Error(`${field} must contain unique items.`);
  } else if (schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value) || value < schema.minimum || value > schema.maximum || (schema.multipleOf && !Number.isInteger(value / schema.multipleOf))) throw new Error(`Invalid ${field}.`);
  } else if (schema.type === "string") {
    if (typeof value !== "string" || (schema.minLength && value.trim().length < schema.minLength) || value.length > (schema.maxLength ?? Infinity) || (schema.pattern && !new RegExp(schema.pattern).test(value)) || (schema.enum && !schema.enum.includes(value))) throw new Error(`Invalid ${field}.`);
  } else if (schema.type === "integer") {
    if (!Number.isInteger(value) || value < schema.minimum || value > schema.maximum) throw new Error(`Invalid ${field}.`);
  } else if (schema.type === "boolean" && typeof value !== "boolean") throw new Error(`Invalid ${field}.`);
}
