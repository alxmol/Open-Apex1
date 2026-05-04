/**
 * OpenAI Responses SSE → normalized StreamEvent translator.
 *
 * The Responses API streams events like:
 *   event: response.created
 *   data: { "type": "response.created", "response": { "id": "resp_..." }}
 *
 *   event: response.output_text.delta
 *   data: { "type": "response.output_text.delta", "delta": "hello" }
 *
 *   event: response.function_call_arguments.delta
 *   data: { "type": "...", "item_id": "fc_1", "delta": "{\"path\":" }
 *
 *   event: response.completed
 *   data: { "type": "response.completed", "response": { ... final ... } }
 *
 * We translate each into our normalized StreamEvent discriminated union
 * (§3.4.2) so the orchestrator never sees provider-specific shapes.
 */

import type {
  ProviderContinuationHandle,
  StopReason,
  StreamEvent,
  TokenUsage,
} from "@open-apex/core";

/** Raw SSE event from the HTTP stream. */
export interface SseEvent {
  event: string;
  data: string;
}

/** Generator that parses an SSE byte stream into SseEvents. */
export async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const sep = findEventBoundary(buffer);
        if (sep === -1) break;
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + eventBoundaryLength(buffer, sep));
        const ev = parseEventBlock(block);
        if (ev) yield ev;
      }
    }
    // Flush remaining buffer (unlikely, but possible).
    if (buffer.trim().length > 0) {
      const ev = parseEventBlock(buffer);
      if (ev) yield ev;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* lock may already be released on error paths */
    }
  }
}

function findEventBoundary(buf: string): number {
  // SSE events are separated by a blank line: \n\n (or \r\n\r\n).
  const a = buf.indexOf("\n\n");
  const b = buf.indexOf("\r\n\r\n");
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

function eventBoundaryLength(buf: string, pos: number): number {
  return buf.substr(pos, 4) === "\r\n\r\n" ? 4 : 2;
}

function parseEventBlock(block: string): SseEvent | null {
  const lines = block.split(/\r?\n/);
  let event = "message";
  const dataLines: string[] = [];
  for (const line of lines) {
    if (!line || line.startsWith(":")) continue; // comment
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const field = line.slice(0, colon);
    const value = line.slice(colon + 1).replace(/^\s/, "");
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
  }
  if (dataLines.length === 0) return null;
  return { event, data: dataLines.join("\n") };
}

// ─── OpenAI event → StreamEvent translator ───────────────────────────────────

/**
 * Translator state. A single stream produces a sequence of events; we need
 * to carry accumulating tool-call metadata between deltas.
 */
export class OpenAiEventTranslator {
  /** Index of emitted tool calls, by Responses item_id. */
  private toolCalls = new Map<
    string,
    {
      callId: string;
      name: string;
      argsBuffer: string;
      schema: "json" | "custom";
      doneEmitted: boolean;
    }
  >();

  private responseId: string | null = null;
  private finalUsage: TokenUsage | null = null;
  private stopReason: StopReason = "end_turn";
  private cacheHit = false;

  translate(event: SseEvent): StreamEvent[] {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(event.data) as Record<string, unknown>;
    } catch {
      return [];
    }
    const type = (data.type as string) ?? event.event;

    switch (type) {
      case "response.created": {
        const resp = data.response as { id?: string } | undefined;
        if (resp?.id) this.responseId = resp.id;
        return [];
      }
      case "response.output_text.delta": {
        const delta = (data.delta as string) ?? "";
        return delta ? [{ type: "text_delta", delta }] : [];
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning.delta": {
        const delta = (data.delta as string) ?? "";
        return delta ? [{ type: "reasoning_delta", delta }] : [];
      }
      case "response.compaction.done":
      case "response.compaction.completed":
      case "response.context_management.compaction.done":
      case "response.output_item.done": {
        const item = data.item as
          | {
              type?: string;
              id?: string;
              call_id?: string;
              arguments?: unknown;
              input?: unknown;
              summary_tokens?: number;
              replaced_range?: [number, number];
            }
          | undefined;
        if (item?.type === "compaction") {
          return [
            {
              type: "compaction_block",
              summaryTokens: item.summary_tokens ?? 0,
              replacedRange: item.replaced_range ?? [0, 0],
            },
          ];
        }
        // Fall through to tool-call completion handling below for normal
        // output_item.done events.
        if (type !== "response.output_item.done")
          return [{ type: "provider_metadata", opaque: data }];
        return this.translateOutputItemDone(data);
      }
      case "response.output_item.added": {
        const item = data.item as
          | { type?: string; id?: string; call_id?: string; name?: string }
          | undefined;
        if (
          item &&
          (item.type === "function_call" || item.type === "custom_tool_call") &&
          item.id
        ) {
          this.toolCalls.set(item.id, {
            callId: item.call_id ?? item.id,
            name: item.name ?? "",
            argsBuffer: "",
            schema: item.type === "custom_tool_call" ? "custom" : "json",
            doneEmitted: false,
          });
          return [
            {
              type: "tool_call_start",
              callId: item.call_id ?? item.id,
              name: item.name ?? "",
              argsSchema: item.type === "custom_tool_call" ? "custom" : "json",
            },
          ];
        }
        return [];
      }
      case "response.function_call_arguments.delta":
      case "response.custom_tool_call_input.delta": {
        const itemId = data.item_id as string | undefined;
        const delta = (data.delta as string) ?? "";
        if (!itemId) return [];
        const state = this.toolCalls.get(itemId);
        if (!state) return [];
        state.argsBuffer += delta;
        return [{ type: "tool_call_delta", callId: state.callId, argsDelta: delta }];
      }
      case "response.function_call_arguments.done":
      case "response.custom_tool_call_input.done":
        return this.translateOutputItemDone(data);
      case "response.completed": {
        const resp = data.response as
          | {
              id?: string;
              status?: string;
              usage?: {
                input_tokens?: number;
                output_tokens?: number;
                input_tokens_details?: { cached_tokens?: number };
                output_tokens_details?: { reasoning_tokens?: number };
              };
              incomplete_details?: { reason?: string };
            }
          | undefined;
        if (resp?.id) this.responseId = resp.id;
        const out: StreamEvent[] = [];
        if (resp?.usage) {
          const usage: TokenUsage = {
            inputTokens: resp.usage.input_tokens ?? 0,
            outputTokens: resp.usage.output_tokens ?? 0,
          };
          const cached = resp.usage.input_tokens_details?.cached_tokens;
          if (cached !== undefined) {
            usage.cachedInputTokens = cached;
            if (cached > 0) this.cacheHit = true;
          }
          const reasoning = resp.usage.output_tokens_details?.reasoning_tokens;
          if (reasoning !== undefined) usage.reasoningTokens = reasoning;
          this.finalUsage = usage;
          out.push({ type: "usage_update", usage, cacheHit: this.cacheHit });
        }
        const reason = resp?.incomplete_details?.reason;
        if (reason === "max_output_tokens") this.stopReason = "max_tokens";
        else if (reason === "content_filter") this.stopReason = "content_filter";
        out.push({
          type: "done",
          stopReason: this.stopReason,
          providerHandle: this.currentHandle(),
        });
        return out;
      }
      case "response.incomplete":
      case "response.failed": {
        const err = (data.response as { error?: { code?: string; message?: string } } | undefined)
          ?.error;
        const code = err?.code ?? "response_failed";
        return [
          {
            type: "error",
            code,
            message: err?.message ?? "response_failed",
            retryable: isTransientOpenAiCode(code),
          },
        ];
      }
      case "error": {
        const err = data.error as { code?: string; message?: string; type?: string } | undefined;
        const code = err?.code ?? err?.type ?? "stream_error";
        return [
          {
            type: "error",
            code,
            message: err?.message ?? "stream_error",
            retryable: isTransientOpenAiCode(code),
          },
        ];
      }
      default:
        // Unknown event types are surfaced as provider_metadata so
        // telemetry can still capture them.
        return [{ type: "provider_metadata", opaque: data }];
    }
  }

  currentHandle(): ProviderContinuationHandle {
    return {
      kind: "openai_response",
      responseId: this.responseId ?? "",
      reasoningItemsIncluded: true,
    };
  }

  private translateOutputItemDone(data: Record<string, unknown>): StreamEvent[] {
    const item = data.item as
      | { type?: string; id?: string; call_id?: string; arguments?: unknown; input?: unknown }
      | undefined;
    const itemId = (item?.id as string) ?? (data.item_id as string);
    if (!itemId) return [];
    const state = this.toolCalls.get(itemId);
    if (!state || state.doneEmitted) return [];
    state.doneEmitted = true;
    let args: unknown = state.argsBuffer;
    if (state.schema === "json") {
      try {
        args = state.argsBuffer ? JSON.parse(state.argsBuffer) : {};
      } catch {
        // Keep raw string so the tool scheduler can surface bad_args.
      }
    } else if (item?.input !== undefined) {
      args = item.input;
    }
    return [{ type: "tool_call_done", callId: state.callId, args }];
  }

  getUsage(): TokenUsage | null {
    return this.finalUsage;
  }
}

/**
 * Mid-stream error codes that count as transient. OpenAI's public docs list
 * `server_error`, `overloaded`, `rate_limit_exceeded`, `internal_error`, and
 * `response_failed` as retryable in practice.
 */
function isTransientOpenAiCode(code: string): boolean {
  const normalized = code.toLowerCase();
  return (
    normalized === "server_error" ||
    normalized === "internal_error" ||
    normalized === "overloaded" ||
    normalized === "rate_limit_exceeded" ||
    normalized === "response_failed" ||
    normalized.includes("timeout")
  );
}
