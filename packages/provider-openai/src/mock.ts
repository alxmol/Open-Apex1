/**
 * MockOpenAiAdapter — deterministic script-replay ProviderAdapter.
 *
 * Intent: mock tests MIRROR live tests (per user directive). The mock
 * adapter consumes a MockScript whose turns are arrays of normalized
 * StreamEvents — the same events a real live run would emit. Live runs
 * can capture their event sequences into scripts; mocks replay them.
 *
 * Used at M0 by the developer-golden-path scenario. M1+ contract tests
 * reuse this adapter verbatim.
 */

import type {
  AgentRequest,
  CompactionOptions,
  CompactionResult,
  ConversationStartOptions,
  ConversationStartResult,
  Message,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderContinuationHandle,
  RequestOptions,
  StreamEvent,
  TokenCount,
} from "@open-apex/core";
import { MockAdapterError, type MockRecordedCall, type MockScript } from "@open-apex/core";

import { openAiCapabilities } from "./capabilities.ts";

export interface MockOpenAiAdapterOptions {
  modelId?: string;
  script: MockScript;
}

export class MockOpenAiAdapter implements ProviderAdapter {
  private readonly modelId: string;
  private script: MockScript;
  private turnCursor = 0;
  private conversationCursor = 0;
  readonly recordedCalls: MockRecordedCall[] = [];

  constructor(opts: MockOpenAiAdapterOptions) {
    this.modelId = opts.modelId ?? "gpt-5.4";
    this.script = opts.script;
  }

  /** Reset cursor (useful between test cases sharing the same adapter instance). */
  reset(newScript?: MockScript): void {
    if (newScript) this.script = newScript;
    this.turnCursor = 0;
    this.conversationCursor = 0;
    this.recordedCalls.length = 0;
  }

  private record(method: MockRecordedCall["method"], payload: unknown): void {
    this.recordedCalls.push({
      method,
      payload: cloneForRecord(payload),
      timestamp: new Date().toISOString(),
    });
  }

  private async *replayTurn(): AsyncIterable<StreamEvent> {
    const turn = this.script.turns[this.turnCursor];
    if (!turn) {
      throw new MockAdapterError(
        `MockOpenAiAdapter: script exhausted at turn index ${this.turnCursor}`,
      );
    }
    this.turnCursor++;
    if (turn.throwError) {
      yield {
        type: "error",
        code: turn.throwError.code,
        message: turn.throwError.message,
        retryable: turn.throwError.retryable ?? false,
      };
      throw new MockAdapterError(
        `scripted error at turn ${this.turnCursor}: ${turn.throwError.code}`,
      );
    }
    for (const ev of turn.events) {
      yield ev;
    }
  }

  async *generate(req: AgentRequest, opts: RequestOptions): AsyncIterable<StreamEvent> {
    this.record("generate", { req, opts });
    yield* this.withConversation(this.replayTurn(), opts.conversationId);
  }

  async *resume(
    handle: ProviderContinuationHandle,
    req: AgentRequest,
    opts: RequestOptions,
  ): AsyncIterable<StreamEvent> {
    this.record("resume", { handle, req, opts });
    const conversationId = conversationIdForResume(handle);
    yield* this.withConversation(this.replayTurn(), conversationId);
  }

  async countTokens(messages: Message[], opts: RequestOptions): Promise<TokenCount> {
    this.record("countTokens", { messages, opts });
    return this.script.tokenCount ?? { inputTokens: 0 };
  }

  getCapabilities(): ProviderCapabilities {
    const base = openAiCapabilities(this.modelId);
    return { ...base, ...(this.script.capabilityOverrides ?? {}) };
  }

  async startConversation(opts: ConversationStartOptions = {}): Promise<ConversationStartResult> {
    this.record("startConversation", { opts });
    const sequenced = this.script.conversationResults?.[this.conversationCursor++];
    if (sequenced) return sequenced;
    return (
      this.script.conversationResult ?? {
        applicable: true,
        providerHandle: {
          kind: "openai_conversation",
          conversationId: "mock_conv_1",
        },
      }
    );
  }

  async compact(
    handle: ProviderContinuationHandle,
    opts: CompactionOptions,
  ): Promise<CompactionResult> {
    this.record("compact", { handle, opts });
    const result = this.script.compactionResult ?? {
      applicable: true,
      summaryTokens: 0,
      replacedRange: [0, 0],
      output: [{ type: "message", role: "assistant", content: [] }],
      providerHandle: {
        kind: "openai_compacted",
        input: [{ type: "message", role: "assistant", content: [] }],
        reasoningItemsIncluded: true,
      },
    };
    return result;
  }

  private async *withConversation(
    events: AsyncIterable<StreamEvent>,
    conversationId: string | undefined,
  ): AsyncIterable<StreamEvent> {
    for await (const ev of events) {
      if (conversationId && ev.type === "done" && ev.providerHandle.kind === "openai_response") {
        yield {
          ...ev,
          providerHandle: {
            ...ev.providerHandle,
            conversationId,
          },
        };
      } else {
        yield ev;
      }
    }
  }
}

function conversationIdForResume(handle: ProviderContinuationHandle): string | undefined {
  if (handle.kind === "openai_conversation") return handle.conversationId;
  if (handle.kind === "openai_response" || handle.kind === "openai_compacted") {
    return handle.conversationId;
  }
  return undefined;
}

function cloneForRecord(payload: unknown): unknown {
  try {
    return structuredClone(payload);
  } catch {
    return stripUncloneable(payload);
  }
}

function stripUncloneable(value: unknown): unknown {
  if (value instanceof AbortSignal) return "[AbortSignal]";
  if (Array.isArray(value)) return value.map(stripUncloneable);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, stripUncloneable(entry)]),
    );
  }
  return value;
}
