/**
 * Shared MockScript types used by both provider-openai/mock and
 * provider-anthropic/mock. Lives in core because:
 *   1. The MockScript shape is provider-neutral (it's a list of StreamEvent arrays).
 *   2. Both downstream provider packages consume it identically.
 *   3. Tests anywhere in the monorepo can import it without dragging in an SDK.
 *
 * This is the "mock tests mirror live" substrate: the canonical mock provider
 * replays scripted StreamEvent sequences, which are the same normalized events
 * a real live run would produce. Live tests capture real event sequences into
 * scripts; mock tests replay them identically.
 */

import type {
  CompactionResult,
  ConversationStartResult,
  ProviderCapabilities,
  ProviderContinuationHandle,
} from "./adapter.ts";
import type { RequestOptions } from "./adapter.ts";
import type { Message } from "./message.ts";
import type { StreamEvent, TokenCount } from "./stream.ts";

export interface MockScriptTurn {
  /** Canned stream events replayed, in order, on the next generate()/resume() call. */
  events: StreamEvent[];
  /**
   * When set, the turn throws the scripted error instead of yielding events.
   * Used by retry-policy tests in M1.
   */
  throwError?: {
    code: string;
    message: string;
    httpStatus?: number;
    /** Set the error's `retryable` flag; mock emits a matching `error` event. */
    retryable?: boolean;
  };
  /** Optional: the next turn replays these events on resume() rather than generate(). */
  onResumeOnly?: boolean;
}

export interface MockScript {
  /** Ordered list of turn outputs. Each generate()/resume() call consumes one. */
  turns: MockScriptTurn[];
  /** Partial override on the base capability matrix. */
  capabilityOverrides?: Partial<ProviderCapabilities>;
  /** What countTokens() should return. Defaults to { inputTokens: 0 }. */
  tokenCount?: TokenCount;
  /** Terminal-handle shape provided to the caller after each turn. */
  handleFactory?: (turnIndex: number) => ProviderContinuationHandle;
  /** Optional compact() response for product/session tests. */
  compactionResult?: CompactionResult;
  /** Optional startConversation() response for product/session tests. */
  conversationResult?: ConversationStartResult;
  /** Optional ordered startConversation() responses for multi-conversation journeys. */
  conversationResults?: ConversationStartResult[];
}

export interface MockRecordedCall {
  method: "generate" | "resume" | "countTokens" | "compact" | "startConversation";
  /** Frozen snapshot of the request payload at call time. */
  payload: unknown;
  timestamp: string;
}

/**
 * MockAdapterError is thrown when the test script hits an edge case
 * the mock doesn't know how to simulate (script exhausted, bad shape, etc.).
 */
export class MockAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MockAdapterError";
  }
}

/** Convenience: build a simple one-turn script that yields plain text + done. */
export function simpleTextScript(text: string, providerId: "openai" | "anthropic"): MockScript {
  const handle: ProviderContinuationHandle =
    providerId === "openai"
      ? {
          kind: "openai_response",
          responseId: "mock_resp_1",
          reasoningItemsIncluded: false,
        }
      : {
          kind: "anthropic_messages",
          messages: [],
          betaHeaders: [],
        };
  return {
    turns: [
      {
        events: [
          { type: "text_delta", delta: text },
          {
            type: "usage_update",
            usage: {
              inputTokens: Math.ceil(text.length / 4),
              outputTokens: Math.ceil(text.length / 4),
            },
            cacheHit: false,
          },
          {
            type: "done",
            stopReason: "end_turn",
            providerHandle: handle,
          },
        ],
      },
    ],
    tokenCount: { inputTokens: Math.ceil(text.length / 4) },
    handleFactory: () => handle,
  };
}

export type { RequestOptions, Message, StreamEvent };
