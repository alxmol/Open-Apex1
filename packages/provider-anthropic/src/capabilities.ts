/**
 * Anthropic capability matrix.
 * Per user directive: Sonnet 4.6, Opus 4.6, Opus 4.7 share the same
 * capability surface — only model ID and some defaults differ. The 4.7 row
 * differs from 4.6 in three ways per §0 and §3.6:
 *   - `xhigh` effort available (4.7 only)
 *   - `max` effort NOT available on 4.7; it's 4.6/Sonnet only
 *   - adaptive thinking is the only supported mode on 4.7 (no manual fallback)
 */

import type { ProviderCapabilities } from "@open-apex/core";

export function anthropicCapabilities(modelId: string): ProviderCapabilities {
  const isOpus47 = modelId.startsWith("claude-opus-4-7");
  const isSonnet46 = modelId.startsWith("claude-sonnet-4-6");
  const isOpus46 = modelId.startsWith("claude-opus-4-6");
  return {
    providerId: "anthropic",
    modelId,
    supportsPreviousResponseId: false,
    supportsConversations: false,
    // All three presets share adaptive thinking support (user directive).
    supportsAdaptiveThinking: isOpus47 || isSonnet46 || isOpus46,
    supportsEffortXhigh: isOpus47,
    supportsEffortMax: isOpus46 || isSonnet46,
    supportsNativeCompaction: false,
    supportsContextEditingToolUses: isOpus47 || isSonnet46 || isOpus46,
    supportsContextEditingThinking: isOpus47 || isSonnet46 || isOpus46,
    supportsServerCompaction: isOpus47 || isSonnet46 || isOpus46,
    supportsAllowedTools: false, // Anthropic filters tools client-side instead
    supportsCustomTools: false,
    supportsCFG: false,
    supportsToolSearch: false,
    supportsSearchResultBlocks: true,
    supportsPromptCaching: true,
    supportsPhaseMetadata: false,
    supportsParallelToolCalls: true,
    supportsMultimodalImages: true,
    supportsMultimodalPdfs: true,
    supportsBackgroundMode: false,
    contextWindowTokens: isOpus47 || isSonnet46 || isOpus46 ? 1_000_000 : 200_000,
  };
}
