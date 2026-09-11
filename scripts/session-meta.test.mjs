import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const result = await build({
  entryPoints: ["src/sessionMeta.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
});
const { iconColor, sessionIcon, sessionIconTooltip } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);

test("effective provider branding overrides a Claude launcher only with normalized evidence", () => {
  assert.equal(iconColor("claude", "codex"), "#10A37F");
  assert.equal(iconColor("claude", null), "#D97757");
  assert.equal(
    sessionIconTooltip("claude", "gpt-5.1", "codex", "reported"),
    "Effective model: gpt-5.1 (Codex / OpenAI, reported by the foreground process). Launcher: Claude CLI.",
  );
  assert.equal(
    sessionIconTooltip("claude", "gpt-5.1", "codex", "configured"),
    "Effective model: gpt-5.1 (Codex / OpenAI, configured by the foreground process or selected account). Launcher: Claude CLI.",
  );
  assert.equal(sessionIconTooltip("claude", null, null, null), "Launcher: Claude CLI. Effective model unavailable.");
});

test("opencode terminals keep opencode branding", () => {
  assert.equal(sessionIcon("opencode", "claude").name, "OpenCodeIcon");
  assert.equal(sessionIcon("/Users/berke/.opencode/bin/opencode", null).name, "OpenCodeIcon");
  assert.equal(iconColor("opencode", "claude"), "#94A3B8");
  assert.equal(
    sessionIconTooltip("opencode", "claude-sonnet-4-5", "claude", "reported"),
    "Effective model: claude-sonnet-4-5 (Claude, reported by the foreground process). Launcher: OpenCode.",
  );
});
