import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const output = await build({
  entryPoints: [new URL("../src/panels/UsageSpend.tsx", import.meta.url).pathname],
  bundle: true, platform: "node", format: "esm", write: false,
});
const { UsageSpend } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`);
const complete = (cost, tokens) => ({ cost, pricedCost: cost, tokens, unpricedTokens: 0, unpricedModels: [] });
const render = (today, yesterday = today, window = today) => renderToStaticMarkup(createElement(UsageSpend, {
  color: "#10A37F",
  spend: {
    provider: "codex", label: "Codex", pricingBasis: "standard-api-short-context",
    today, yesterday, window,
    days: [{ day: "2026-09-09", ...yesterday }, { day: "2026-09-10", ...today }],
  },
}));

test("renders API-equivalent estimates and tokens without implying billed subscription spend", () => {
  const html = render(complete(222.769916, 154378410), complete(1102.314810, 864548365));
  assert.match(html, /API estimate \(short context\), not billed spend/);
  assert.match(html, /Long-context and service-tier adjustments are not included/);
  assert.match(html, /\$223<\/b> · 154.4M tokens/);
  assert.match(html, /\$1.1K<\/b> · 864.5M tokens/);
  assert.doesNotMatch(html, /Unavailable|\(partial\)|NaN/);
});

test("unpriced totals remain unavailable in labels and trend tooltips, never zero dollars", () => {
  const html = render({ cost: null, pricedCost: 0, tokens: 154378410, unpricedTokens: 154378410, unpricedModels: ["unlisted-model"] });
  assert.match(html, /Unavailable<\/b> · 154.4M tokens/);
  assert.match(html, /154.4M tokens have no verified rate \(unlisted-model\)/);
  assert.match(html, /border:1px dashed/);
  assert.doesNotMatch(html, /\$0|NaN|height:2%/);
});

test("a known subtotal is visibly partial while true empty usage stays zero", () => {
  const html = render({ cost: null, pricedCost: 8.25, tokens: 2200000, unpricedTokens: 1100000, unpricedModels: ["unlisted-model"] }, complete(0, 0));
  assert.match(html, /\$8.25\+ \(partial\)<\/b> · 2.2M tokens/);
  assert.match(html, /1.1M tokens have no verified rate \(unlisted-model\)/);
  assert.match(html, /\$0.00<\/b> · 0 tokens/);
  assert.match(html, /2026-09-09 · \$0.00/);
  assert.match(html, /2026-09-10 · \$8.25\+ \(partial\)/);
  assert.doesNotMatch(html, /NaN/);
});
