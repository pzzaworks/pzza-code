// Per-model token rates for agents whose transcripts carry tokens but no cost.
// Every rate comes from the model maker's public pricing page (cited per
// block); a model without a verified rate stays unpriced rather than guessed.

// USD per million (input, output[, cache read]) tokens. The optional third
// rate overrides the default 10%-of-input cache-read price for models that
// publish their own cache-read rate.
export const PRICING = {
  "claude-fable-5-1": [10.0, 50.0, 0.25],
  "claude-mythos-5-1": [10.0, 50.0, 0.25],
  "claude-fable-5": [10.0, 50.0],
  "claude-mythos-5": [10.0, 50.0],
  "claude-opus-5-5": [4.0, 20.0, 0.2],
  "claude-opus-5": [5.0, 25.0],
  "claude-opus-4-8": [5.0, 25.0],
  "claude-opus-4-7": [5.0, 25.0],
  "claude-opus-4-6": [5.0, 25.0],
  "claude-opus-4-5": [5.0, 25.0],
  "claude-sonnet-5-5": [2.0, 10.0, 0.2],
  "claude-sonnet-5": [3.0, 15.0],
  "claude-sonnet-4-6": [3.0, 15.0],
  "claude-sonnet-4-5": [3.0, 15.0],
  "claude-haiku-5-5": [0.1, 0.5],
  "claude-haiku-4-5": [1.0, 5.0],
  // Standard short-context API rates, verified 2026-09-10:
  // https://developers.openai.com/api/docs/pricing
  "gpt-6-astra": [10.0, 50.0],
  "gpt-5.6-sol": [4.0, 20.0],
  "gpt-5.6-terra": [2.0, 12.0],
  "gpt-5.6-luna": [0.2, 1.2],
  "gpt-5.5": [5.0, 30.0],
  "gpt-5.4": [2.5, 15.0],
  "gpt-5.4-mini": [0.75, 4.5],
  "gpt-5.4-nano": [0.2, 1.25],
  "gpt-5.3-codex": [1.75, 14.0],
  "gpt-5.2-codex": [1.75, 14.0],
  "gpt-5.2": [1.75, 14.0],
  "gpt-5.1-codex": [1.25, 10.0],
  "gpt-5.1-codex-mini": [0.25, 2.0],
  "gpt-5.1": [1.25, 10.0],
  "gpt-5-codex": [1.25, 10.0],
  "gpt-5": [1.25, 10.0],
  "gpt-5-mini": [0.25, 2.0],
  "gpt-5-nano": [0.05, 0.4],
  // Paid tier, standard (not batch), prompts up to 200k tokens, verified
  // 2026-11-11: https://ai.google.dev/gemini-api/docs/pricing (served from
  // aistudio.google.com/docs/pricing). Thinking tokens are billed as output.
  "gemini-3.1-pro-preview": [2.0, 12.0, 0.2],
  "gemini-3.1-pro-preview-customtools": [2.0, 12.0, 0.2],
  "gemini-3.8-flash": [1.5, 7.5, 0.15],
  "gemini-3.6-flash": [1.5, 7.5, 0.15],
  "gemini-3-flash-preview": [0.5, 3.0, 0.05],
  "gemini-3.5-flash-lite": [0.3, 2.5, 0.03],
  "gemini-3.1-flash-lite": [0.25, 1.5, 0.025],
  "gemini-2.5-pro": [1.25, 10.0, 0.125],
  "gemini-2.5-flash": [0.3, 2.5, 0.03],
  "gemini-2.5-flash-lite": [0.1, 0.4, 0.01],
  // International (Singapore) region, lowest input tier, which covers prompts
  // up to 256k tokens for these models (models whose lowest tier is narrower
  // stay unpriced), verified 2026-11-11 against the page updated 2026-11-07:
  // https://www.alibabacloud.com/help/en/model-studio/model-pricing. Implicit
  // cache hits cost 20% of input
  // (https://www.alibabacloud.com/help/en/model-studio/context-cache); null
  // marks a model without a published cache rate.
  "qwen3.7-plus": [0.4, 1.6, 0.08],
  "qwen3.6-plus": [0.5, 3.0, 0.1],
  "qwen3.5-plus": [0.4, 2.4, 0.08],
  "qwen3.8-max": [2.0, 6.0, null],
  "qwen3.7-max": [2.5, 7.5, 0.5],
  "qwen3.8-flash": [0.15, 0.47, null],
  "qwen3.6-flash": [0.25, 1.5, 0.05],
  "qwen3.5-flash": [0.1, 0.4, 0.02],
  // Per-token API rates (cache miss, output, cache hit), verified 2026-11-11:
  // https://platform.kimi.ai/docs/pricing/chat. Cache writes cost the input rate.
  "kimi-k3.1-pro": [2.0, 10.0, 0.2],
  "kimi-k3.1-pro-highspeed": [4.0, 20.0, 0.2],
  "kimi-k3": [3.0, 15.0, 0.3],
  "kimi-k2.7-code": [0.95, 4.0, 0.19],
  "kimi-k2.7-code-highspeed": [1.9, 8.0, 0.38],
  "kimi-k2.6": [0.95, 4.0, 0.16],
};
// Rates that hold until a published date (inclusive) before the list rate
// above applies.
const PROMO_PRICING = {
  "claude-sonnet-5": [[2.0, 10.0], "2026-08-31"],
  "gemini-3.8-flash": [[0.75, 3.75, 0.075], "2026-12-31"],
  "gemini-3.6-flash": [[0.75, 3.75, 0.075], "2026-12-31"],
};
const CACHE_READ_RATE = 0.1;
const CACHE_WRITE_5M_RATE = 1.25;
const CACHE_WRITE_1H_RATE = 2.0;

// Agents that run models from many providers record ids such as
// "anthropic/claude-sonnet-4-5" or "models/gemini-2.5-pro"; the rate table is
// keyed by the bare model id.
function bareModel(model) {
  const name = String(model || "").split("[")[0].trim().toLowerCase();
  const slash = name.lastIndexOf("/");
  return slash === -1 ? name : name.slice(slash + 1);
}

export function modelRates(model, day) {
  const name = bareModel(model);
  const candidates = [name];
  const parts = name.split("-");
  if (parts.length >= 2 && /^\d{8}$/.test(parts[parts.length - 1])) {
    candidates.push(parts.slice(0, -1).join("-"));
  }
  for (const c of candidates) {
    const promo = PROMO_PRICING[c];
    if (promo && day <= promo[1]) return promo[0];
    if (Object.hasOwn(PRICING, c)) return PRICING[c];
  }
  return null;
}

// Cost of one token bucket ([input, output, cacheRead, cacheWrite5m,
// cacheWrite1h]) at the model's rates, or null when the model has no rate.
export function bucketCost(b, model, day) {
  const rates = modelRates(model, day);
  if (!rates) return null;
  const [ri, wo, cacheRate] = rates;
  // Cached tokens of a model without a published cache rate cannot be priced.
  if (cacheRate === null && b[2] > 0) return null;
  const cacheRead = cacheRate ?? ri * CACHE_READ_RATE;
  return (
    (b[0] * ri +
      b[1] * wo +
      b[2] * cacheRead +
      b[3] * ri * CACHE_WRITE_5M_RATE +
      b[4] * ri * CACHE_WRITE_1H_RATE) /
    1_000_000
  );
}
