/**
 * OpenAI capability matrix.
 * Sources the §3.6 OpenAI rows into a concrete ProviderCapabilities.
 *
 * This is the table the orchestrator branches on. When the §0 verification
 * gate or M1 live canaries surface a capability regression, this matrix is
 * flipped via a config override (preset.enabled) — NOT via inline code change.
 */

import type { ProviderCapabilities } from "@open-apex/core";

export function openAiCapabilities(modelId: string): ProviderCapabilities {
  // Base GPT-5.4 capabilities — verified 2026-04-19 (§0 gate).
  // Mini/nano variants set `supportsNativeCompaction` differently; that's
  // handled by gating the adapter implementation to the specific model alias.
  return {
    providerId: "openai",
    modelId,
    supportsPreviousResponseId: true,
    supportsConversations: true,
    supportsAdaptiveThinking: false,
    supportsEffortXhigh: modelId.startsWith("gpt-5.4"),
    supportsEffortMax: false,
    supportsNativeCompaction: modelId.startsWith("gpt-5.4"),
    supportsContextEditingToolUses: false,
    supportsContextEditingThinking: false,
    supportsServerCompaction: modelId.startsWith("gpt-5.4"),
    supportsAllowedTools: true,
    supportsCustomTools: true,
    supportsCFG: true,
    supportsToolSearch: true,
    supportsSearchResultBlocks: false,
    supportsPromptCaching: true, // server-side prefix caching is automatic
    supportsPhaseMetadata: modelId.startsWith("gpt-5.4"),
    supportsParallelToolCalls: true,
    supportsMultimodalImages: true,
    supportsMultimodalPdfs: true,
    supportsBackgroundMode: true,
    // GPT-5.4 exposes a 1.05M-token context window. Inputs above 272K
    // trigger long-context pricing, but 272K is not the model limit.
    contextWindowTokens: modelId.startsWith("gpt-5.4") ? 1_050_000 : 128_000,
  };
}
