/**
 * MockAnthropicAdapter — deterministic script-replay ProviderAdapter.
 * Symmetric to MockOpenAiAdapter. See @open-apex/core/provider/mock.ts
 * for the shared MockScript contract.
 */

import type {
  AgentRequest,
  CompactionOptions,
  CompactionResult,
  ConversationStartOptions,
  ConversationStartResult,
  ContentPart,
  Message,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderContinuationHandle,
  RequestOptions,
  StreamEvent,
  TokenCount,
} from "@open-apex/core";
import { MockAdapterError, type MockRecordedCall, type MockScript } from "@open-apex/core";

import { anthropicCapabilities } from "./capabilities.ts";

export interface MockAnthropicAdapterOptions {
  modelId?: string;
  script: MockScript;
}

export class MockAnthropicAdapter implements ProviderAdapter {
  private readonly modelId: string;
  private script: MockScript;
  private turnCursor = 0;
  readonly recordedCalls: MockRecordedCall[] = [];

  constructor(opts: MockAnthropicAdapterOptions) {
    this.modelId = opts.modelId ?? "claude-opus-4-6";
    this.script = opts.script;
  }

  reset(newScript?: MockScript): void {
    if (newScript) this.script = newScript;
    this.turnCursor = 0;
    this.recordedCalls.length = 0;
  }

  private record(method: MockRecordedCall["method"], payload: unknown): void {
    this.recordedCalls.push({
      method,
      payload: cloneForRecord(payload),
      timestamp: new Date().toISOString(),
    });
  }

  private async *replayTurn(req: AgentRequest): AsyncIterable<StreamEvent> {
    const turn = this.script.turns[this.turnCursor];
    if (!turn) {
      throw new MockAdapterError(
        `MockAnthropicAdapter: script exhausted at turn index ${this.turnCursor}`,
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
    // Mirror the real AnthropicAdapter: the translator accumulates content
    // blocks as the stream emits them and enriches the `done` event's
    // providerHandle with [...req.messages, assistantMessage]. Scripts that
    // hard-code `providerHandle.messages` get that value replaced so tests
    // exercise the real replay semantics.
    const assistantParts: ContentPart[] = [];
    const pendingToolCalls = new Map<string, { name: string; args: unknown }>();
    for (const ev of turn.events) {
      if (ev.type === "tool_call_start") {
        pendingToolCalls.set(ev.callId, { name: ev.name, args: {} });
      } else if (ev.type === "tool_call_done") {
        const pending = pendingToolCalls.get(ev.callId);
        if (pending) {
          assistantParts.push({
            type: "tool_use",
            toolCallId: ev.callId,
            name: pending.name,
            arguments:
              (ev.args as Record<string, unknown> | string | undefined) ??
              (pending.args as Record<string, unknown>),
          });
          pendingToolCalls.delete(ev.callId);
        }
      } else if (ev.type === "text_delta") {
        const last = assistantParts[assistantParts.length - 1];
        if (last && last.type === "text") {
          last.text += ev.delta;
        } else {
          assistantParts.push({ type: "text", text: ev.delta });
        }
      } else if (ev.type === "thinking_delta") {
        const last = assistantParts[assistantParts.length - 1];
        if (last && last.type === "thinking") {
          last.text += ev.delta;
          if (ev.signature !== undefined) {
            (last as { signature?: string }).signature = ev.signature;
          }
        } else {
          const part: ContentPart = { type: "thinking", text: ev.delta };
          if (ev.signature !== undefined) {
            (part as { signature?: string }).signature = ev.signature;
          }
          assistantParts.push(part);
        }
      }

      if (ev.type === "done" && ev.providerHandle?.kind === "anthropic_messages") {
        const assistant: Message | null =
          assistantParts.length > 0 ? { role: "assistant", content: assistantParts.slice() } : null;
        const messages: Message[] = assistant ? [...req.messages, assistant] : [...req.messages];
        const enriched: StreamEvent = {
          type: "done",
          stopReason: ev.stopReason,
          providerHandle: {
            kind: "anthropic_messages",
            messages: messages as unknown[],
            betaHeaders: (ev.providerHandle as { betaHeaders?: string[] }).betaHeaders ?? [],
          },
        };
        yield enriched;
      } else {
        yield ev;
      }
    }
  }

  async *generate(req: AgentRequest, opts: RequestOptions): AsyncIterable<StreamEvent> {
    this.record("generate", { req, opts });
    yield* this.replayTurn(req);
  }

  async *resume(
    handle: ProviderContinuationHandle,
    req: AgentRequest,
    opts: RequestOptions,
  ): AsyncIterable<StreamEvent> {
    this.record("resume", { handle, req, opts });
    // Mirror the real AnthropicAdapter.resume: merge the historical replay
    // buffer from the handle with the caller's delta so accumulation below
    // synthesizes the correct `[replayed + delta, assistant]` handle for the
    // NEXT turn.
    if (handle.kind !== "anthropic_messages") {
      throw new MockAdapterError(
        `MockAnthropicAdapter.resume: expected anthropic_messages handle, got ${handle.kind}`,
      );
    }
    const replayed = (handle.messages as Message[]) ?? [];
    const merged: AgentRequest = {
      systemPrompt: req.systemPrompt,
      messages: [...replayed, ...req.messages],
      tools: req.tools,
      ...(req.toolChoice ? { toolChoice: req.toolChoice } : {}),
      ...(req.multimodalInputs ? { multimodalInputs: req.multimodalInputs } : {}),
    };
    yield* this.replayTurn(merged);
  }

  async countTokens(messages: Message[], opts: RequestOptions): Promise<TokenCount> {
    this.record("countTokens", { messages, opts });
    return this.script.tokenCount ?? { inputTokens: 0 };
  }

  getCapabilities(): ProviderCapabilities {
    const base = anthropicCapabilities(this.modelId);
    return { ...base, ...(this.script.capabilityOverrides ?? {}) };
  }

  async startConversation(opts: ConversationStartOptions = {}): Promise<ConversationStartResult> {
    this.record("startConversation", { opts });
    return {
      applicable: false,
      reason: "mock: Anthropic has no durable Conversations API equivalent",
    };
  }

  async compact(
    handle: ProviderContinuationHandle,
    opts: CompactionOptions,
  ): Promise<CompactionResult> {
    this.record("compact", { handle, opts });
    // Anthropic has no standalone compact endpoint; the real adapter returns
    // "not applicable" here. The mock mirrors that so code under test handles
    // both outcomes identically.
    return {
      applicable: false,
      reason: "mock: Anthropic compaction is request-level via context_management",
    };
  }
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
