/**
 * StreamAccumulator — folds StreamEvents from a ProviderAdapter into an
 * assistant message + tool-call list.
 *
 * Preserves:
 *   - OpenAI `phase` metadata on the assistant item
 *   - Anthropic thinking blocks with `signature`
 *   - per-turn TokenUsage (including cached + reasoning/thinking)
 *   - final StopReason + ProviderContinuationHandle
 */

import type {
  ContentPart,
  HistoryItem,
  ProviderContinuationHandle,
  StopReason,
  StreamEvent,
  TokenUsage,
} from "@open-apex/core";

export interface AccumulatedTurn {
  /** Rolled-out assistant history item (content parts merged). */
  assistant: HistoryItem;
  /** Tool calls the model emitted, in emission order. */
  toolCalls: Array<{ id: string; name: string; args: unknown }>;
  /** Final usage for the turn (may be zero if the provider didn't report). */
  usage: TokenUsage;
  /** Whether the turn saw a cache hit per provider-reported usage. */
  cacheHit: boolean;
  stopReason: StopReason;
  providerHandle: ProviderContinuationHandle;
  /** Current phase (latest phase_marker seen; defaults to "final_answer"). */
  phase: "commentary" | "final_answer";
}

export class StreamAccumulator {
  private text = "";
  private reasoning = "";
  private thinking = "";
  private thinkingSignature: string | undefined;
  private phase: "commentary" | "final_answer" = "final_answer";
  private toolCalls: Array<{
    id: string;
    name: string;
    args: unknown;
    argsSchema: "json" | "custom";
  }> = [];
  private toolCallsByCallId = new Map<string, number>();
  private usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  private cacheHit = false;
  private stopReason: StopReason = "end_turn";
  private providerHandle: ProviderContinuationHandle | null = null;

  ingest(event: StreamEvent): void {
    switch (event.type) {
      case "text_delta":
        this.text += event.delta;
        break;
      case "reasoning_delta":
        this.reasoning += event.delta;
        break;
      case "thinking_delta":
        this.thinking += event.delta;
        if (event.signature !== undefined) this.thinkingSignature = event.signature;
        break;
      case "phase_marker":
        this.phase = event.phase;
        break;
      case "tool_call_start": {
        this.toolCallsByCallId.set(event.callId, this.toolCalls.length);
        this.toolCalls.push({
          id: event.callId,
          name: event.name,
          args: undefined,
          argsSchema: event.argsSchema,
        });
        break;
      }
      case "tool_call_delta":
        // Deltas are captured by the adapter-level translator; we don't need
        // to buffer them here. `tool_call_done` carries the final args.
        break;
      case "tool_call_done": {
        const idx = this.toolCallsByCallId.get(event.callId);
        if (idx !== undefined) {
          this.toolCalls[idx]!.args = event.args;
        }
        break;
      }
      case "usage_update":
        this.usage = event.usage;
        this.cacheHit = event.cacheHit;
        break;
      case "cache_hit":
        this.cacheHit = true;
        break;
      case "done":
        this.stopReason = event.stopReason;
        this.providerHandle = event.providerHandle;
        break;
      // context_edit_applied, compaction_block, provider_metadata, error
      // handled by the caller; accumulator is shape-only.
      default:
        break;
    }
  }

  /** True when the stream has ended (done event seen). */
  isComplete(): boolean {
    return this.providerHandle !== null;
  }

  /** Build the final turn. Throws if not complete. */
  finalize(id: string): AccumulatedTurn {
    if (!this.providerHandle) {
      throw new Error("StreamAccumulator.finalize() called before done event");
    }
    const content: ContentPart[] = [];
    if (this.reasoning.length > 0) {
      content.push({ type: "reasoning", summary: this.reasoning });
    }
    if (this.thinking.length > 0) {
      const tb: ContentPart = { type: "thinking", text: this.thinking };
      if (this.thinkingSignature !== undefined) {
        (tb as { signature?: string }).signature = this.thinkingSignature;
      }
      content.push(tb);
    }
    if (this.text.length > 0) content.push({ type: "text", text: this.text });
    for (const call of this.toolCalls) {
      const args =
        call.args === undefined
          ? ({} as Record<string, unknown>)
          : (call.args as Record<string, unknown> | string);
      content.push({
        type: "tool_use",
        toolCallId: call.id,
        name: call.name,
        arguments: args,
      });
    }
    const assistant: HistoryItem = {
      id,
      createdAt: new Date().toISOString(),
      role: "assistant",
      content,
      phase: this.phase,
    };
    return {
      assistant,
      toolCalls: this.toolCalls.map((t) => ({
        id: t.id,
        name: t.name,
        args: t.args ?? {},
      })),
      usage: this.usage,
      cacheHit: this.cacheHit,
      stopReason: this.stopReason,
      providerHandle: this.providerHandle,
      phase: this.phase,
    };
  }
}
