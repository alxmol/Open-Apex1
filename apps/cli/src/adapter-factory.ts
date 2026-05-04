/**
 * Adapter factory — preset → real ProviderAdapter.
 *
 * Maps:
 *   preset.provider === "openai"    → OpenAiAdapter
 *   preset.provider === "anthropic" → AnthropicAdapter
 *
 * Respects preset.providerBetaHeaders for Anthropic (context-management,
 * compact).
 */

import type { LoadedPreset } from "@open-apex/config";
import type { ProviderAdapter, RequestOptions } from "@open-apex/core";

import { AnthropicAdapter } from "@open-apex/provider-anthropic";
import { OpenAiAdapter } from "@open-apex/provider-openai";

export interface MakeAdapterOptions {
  /** Optional API key override (testing). */
  apiKey?: string;
}

export function makeAdapter(preset: LoadedPreset, opts: MakeAdapterOptions = {}): ProviderAdapter {
  if (preset.provider === "openai") {
    const openai: OpenAiAdapter = opts.apiKey
      ? new OpenAiAdapter({ modelId: preset.modelId, apiKey: opts.apiKey })
      : new OpenAiAdapter({ modelId: preset.modelId });
    return openai;
  }
  const anthropicOpts: {
    modelId: string;
    apiKey?: string;
    alwaysOnBetaHeaders?: string[];
  } = { modelId: preset.modelId };
  if (opts.apiKey) anthropicOpts.apiKey = opts.apiKey;
  if (preset.providerBetaHeaders && preset.providerBetaHeaders.length > 0) {
    anthropicOpts.alwaysOnBetaHeaders = preset.providerBetaHeaders;
  }
  return new AnthropicAdapter(anthropicOpts);
}

/**
 * Map preset fields to adapter-level RequestOptions. Copies effort,
 * verbosity, thinkingDisplay, and computes cache breakpoints.
 */
export function presetToRequestOptions(preset: LoadedPreset): RequestOptions {
  const out: RequestOptions = {};
  if (preset.effort) out.effort = preset.effort;
  if (preset.verbosity) out.verbosity = preset.verbosity;
  if (preset.thinkingDisplay) out.thinkingDisplay = preset.thinkingDisplay;
  if (preset.contextManagement) {
    const cm: RequestOptions["contextManagement"] = {};
    const src = preset.contextManagement;
    if (src.triggerInputTokens !== undefined) cm.triggerInputTokens = src.triggerInputTokens;
    if (src.keepToolUses !== undefined) cm.keepToolUses = src.keepToolUses;
    if (src.clearAtLeastTokens !== undefined) cm.clearAtLeastTokens = src.clearAtLeastTokens;
    if (src.excludeTools !== undefined) cm.excludeTools = src.excludeTools;
    if (src.compactThreshold !== undefined) cm.compactThreshold = src.compactThreshold;
    out.contextManagement = cm;
  }
  return out;
}
