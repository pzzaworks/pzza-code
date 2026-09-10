import test from "node:test";
import assert from "node:assert/strict";
import { AGENTS_HUB_TOOLS } from "../lib/agents-hub-tools.js";

const tool = name => { const found = AGENTS_HUB_TOOLS.find(item => item.name === name); assert.ok(found, name); return found; };
test("Hub tools expose bounded inert asset inspection and explicit relation-aware removal", () => {
  const asset = tool("agents_hub_asset");
  assert.equal(asset.annotations.readOnlyHint, true);
  assert.equal(asset.inputSchema.additionalProperties, false);
  assert.equal(asset.inputSchema.properties.length.maximum, 65536);
  assert.deepEqual(asset.inputSchema.required, ["revision", "id", "path"]);
  const remove = tool("agents_hub_remove");
  assert.equal(remove.annotations.destructiveHint, true);
  assert.equal(remove.inputSchema.properties.detachReferences.default, false);
  assert.deepEqual(remove.inputSchema.required, ["revision", "kind", "id"]);
});
test("imports retain source-folder provenance and updates require an explicit stable identity", () => {
  const importer = tool("agents_hub_import_skill");
  assert.equal(importer.inputSchema.properties.updateId.type, "string");
  assert.equal(importer.inputSchema.required.includes("updateId"), false);
  assert.ok(importer.inputSchema.required.includes("subpath"));
  const update = tool("agents_hub_update");
  assert.equal(update.inputSchema.properties.item.properties.subpath.type, "string");
  assert.equal(update.inputSchema.properties.detachReferences.type, "boolean");
  assert.equal(update.inputSchema.properties.item.properties.files.items.properties.contentBase64.type, "string");
  assert.equal(update.inputSchema.properties.item.properties.files.items.properties.bytes, undefined);
});
