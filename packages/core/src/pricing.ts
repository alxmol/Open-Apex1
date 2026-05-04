/**
 * Provider token-price table for cost-telemetry accounting.
 *
 * Prices are per 1M tokens, USD, verified against each provider's public
 * pricing page as of the verification-gate date. NOT used for billing
 * decisions or runtime throttling — Open-Apex is quality-first, not
 * cost-constrained (§1.2). The table exists so `OpenApexResult.usage.total_cost_usd`
 * and `by_provider` are honest rather than always `0`, which helps tuning and
 * post-hoc analysis (§8 mean_cost_per_task_usd).
 *
 * If the modelId isn't in the table the estimator returns `0` and the caller
 * should treat cost as unknown — no crash.
 */

import type { TokenUsage } from "./provider/stream.ts";

/** USD per 1M tokens. */
interface ModelPrice {
  input: number;
  cachedInput?: number;
  output: number;
  /** OpenAI reasoning tokens and Anthropic thinking tokens are billed as output. */
}

const PRICES: Record<string, ModelPrice> = {
  // OpenAI (verified 2026-04-18).
  "gpt-5.4": { input: 1.25, cachedInput: 0.125, output: 10.0 },
  "gpt-5.4-pro": { input: 15.0, cachedInput: 1.5, output: 120.0 },
  "gpt-5.4-mini": { input: 0.25, cachedInput: 0.025, output: 2.0 },
  "gpt-5.4-nano": { input: 0.05, cachedInput: 0.005, output: 0.4 },

  // Anthropic (verified 2026-04-18).
  "claude-sonnet-4-6": { input: 3.0, cachedInput: 0.3, output: 15.0 },
  "claude-opus-4-6": { input: 15.0, cachedInput: 1.5, output: 75.0 },
  "claude-opus-4-7": { input: 15.0, cachedInput: 1.5, output: 75.0 },
};

export interface CostEstimate {
  inputUsd: number;
  outputUsd: number;
  cachedInputUsd: number;
  totalUsd: number;
}

export function estimateCostUsd(modelId: string, usage: TokenUsage): CostEstimate {
  const price = PRICES[modelId];
  if (!price) {
    return { inputUsd: 0, outputUsd: 0, cachedInputUsd: 0, totalUsd: 0 };
  }
  const cached = usage.cachedInputTokens ?? 0;
  const uncachedInput = Math.max(0, usage.inputTokens - cached);
  const inputUsd = (uncachedInput / 1_000_000) * price.input;
  const cachedInputUsd = (cached / 1_000_000) * (price.cachedInput ?? price.input);
  const outputUsd = (usage.outputTokens / 1_000_000) * price.output;
  const totalUsd = inputUsd + cachedInputUsd + outputUsd;
  return { inputUsd, outputUsd, cachedInputUsd, totalUsd };
}

export function isKnownModel(modelId: string): boolean {
  return modelId in PRICES;
}
