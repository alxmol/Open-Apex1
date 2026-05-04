/**
 * Normalized StreamEvent discriminated union.
 * Locked per §3.4.2.
 *
 * Event-ordering invariants (enforceable as asserts in tests):
 *   - `done` is always last.
 *   - `usage_update` may appear anywhere.
 *   - `compaction_block` and `context_edit_applied` appear before any post-compaction content.
 */

import type { ProviderContinuationHandle } from "./adapter.ts";

export type StreamEvent =
  | { type: "text_delta"; delta: string }
  | { type: "reasoning_delta"; delta: string } // OpenAI: reasoning summary
  | {
      type: "thinking_delta"; // Anthropic: thinking block stream
      delta: string;
      signature?: string;
    }
  | {
      type: "phase_marker"; // OpenAI: phase parameter
      phase: "commentary" | "final_answer";
    }
  | {
      type: "tool_call_start";
      callId: string;
      name: string;
      argsSchema: "json" | "custom";
    }
  | { type: "tool_call_delta"; callId: string; argsDelta: string }
  | { type: "tool_call_done"; callId: string; args: unknown }
  | {
      type: "context_edit_applied";
      editType: string;
      tokensCleared: number;
      toolUsesCleared: number;
    }
  | {
      type: "compaction_block";
      summaryTokens: number;
      replacedRange: [number, number];
    }
  | { type: "usage_update"; usage: TokenUsage; cacheHit: boolean }
  | { type: "cache_hit"; cachedInputTokens: number }
  | { type: "provider_metadata"; opaque: Record<string, unknown> }
  | {
      type: "error";
      code: string;
      message: string;
      retryable: boolean;
    }
  | {
      type: "done";
      stopReason: StopReason;
      providerHandle: ProviderContinuationHandle;
    };

export type StopReason =
  | "end_turn"
  | "tool_use"
  | "max_tokens"
  | "stop_sequence"
  | "content_filter"
  | "refusal";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  /** OpenAI: reasoning tokens (billed as output). */
  reasoningTokens?: number;
  /** Anthropic: thinking tokens (billed as output). */
  thinkingTokens?: number;
  cachedInputTokens?: number;
  cacheCreationInputTokens?: number;
}

export interface TokenCount {
  inputTokens: number;
  cachedTokens?: number;
}

export function zeroUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0 };
}

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  const result: TokenUsage = {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
  if (a.reasoningTokens !== undefined || b.reasoningTokens !== undefined) {
    result.reasoningTokens = (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0);
  }
  if (a.thinkingTokens !== undefined || b.thinkingTokens !== undefined) {
    result.thinkingTokens = (a.thinkingTokens ?? 0) + (b.thinkingTokens ?? 0);
  }
  if (a.cachedInputTokens !== undefined || b.cachedInputTokens !== undefined) {
    result.cachedInputTokens = (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0);
  }
  if (a.cacheCreationInputTokens !== undefined || b.cacheCreationInputTokens !== undefined) {
    result.cacheCreationInputTokens =
      (a.cacheCreationInputTokens ?? 0) + (b.cacheCreationInputTokens ?? 0);
  }
  return result;
}
