/**
 * Anthropic Messages SSE → normalized StreamEvent translator.
 *
 * Events (per Messages streaming docs):
 *   message_start         — { message: { id, usage, ... } }
 *   content_block_start   — { index, content_block: { type, ... } }
 *   content_block_delta   — { index, delta: { type: "text_delta"|"input_json_delta"|"thinking_delta"|"signature_delta", ... } }
 *   content_block_stop    — { index }
 *   message_delta         — { delta: { stop_reason }, usage: { output_tokens } }
 *   message_stop
 *   error                 — { error: { type, message } }
 *   ping                  — keepalive
 */

import type {
  ContentPart,
  Message,
  ProviderContinuationHandle,
  StopReason,
  StreamEvent,
  TokenUsage,
} from "@open-apex/core";

export interface SseEvent {
  event: string;
  data: string;
}

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
        const sep = findBoundary(buffer);
        if (sep === -1) break;
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + (buffer.substr(sep, 4) === "\r\n\r\n" ? 4 : 2));
        const ev = parseBlock(block);
        if (ev) yield ev;
      }
    }
    if (buffer.trim().length > 0) {
      const ev = parseBlock(buffer);
      if (ev) yield ev;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

function findBoundary(s: string): number {
  const a = s.indexOf("\n\n");
  const b = s.indexOf("\r\n\r\n");
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

function parseBlock(block: string): SseEvent | null {
  const lines = block.split(/\r?\n/);
  let event = "message";
  const dataLines: string[] = [];
  for (const line of lines) {
    if (!line || line.startsWith(":")) continue;
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

/** Per-content-block state needed to emit normalized StreamEvents. */
interface ToolUseState {
  kind: "tool_use";
  id: string;
  name: string;
  argsBuffer: string;
  startInput: Record<string, unknown>;
}
interface ThinkingState {
  kind: "thinking";
  textBuffer: string;
  signature?: string;
}
interface TextState {
  kind: "text";
  textBuffer: string;
}
type BlockState = ToolUseState | ThinkingState | TextState;

export class AnthropicEventTranslator {
  private blocks = new Map<number, BlockState>();
  /**
   * Completed assistant content blocks in emit order. Populated at
   * `content_block_stop` so the adapter can materialize the assistant
   * message for the providerHandle replay buffer — Anthropic has no
   * server-side continuation, so resume() needs the full prior history
   * including the assistant's own tool_use / text / thinking blocks, or
   * subsequent tool_result blocks fail with "unknown tool_use_id".
   */
  private assistantParts: ContentPart[] = [];
  private messageId: string | null = null;
  private inputTokens = 0;
  private outputTokens = 0;
  private cachedInputTokens = 0;
  private cacheCreationInputTokens = 0;
  private thinkingTokens = 0;
  private stopReason: StopReason = "end_turn";
  private betaHeaders: string[] = [];

  /**
   * @param betaHeaders — the beta headers the adapter sent on the request;
   *   stored here so the final providerHandle can echo them for resume().
   */
  constructor(betaHeaders: string[] = []) {
    this.betaHeaders = betaHeaders;
  }

  translate(ev: SseEvent): StreamEvent[] {
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(ev.data) as Record<string, unknown>;
    } catch {
      return [];
    }
    const type = (data.type as string) ?? ev.event;
    switch (type) {
      case "ping":
        return [];
      case "message_start": {
        const msg = data.message as { id?: string; usage?: Record<string, number> } | undefined;
        if (msg?.id) this.messageId = msg.id;
        if (msg?.usage) this.mergeUsage(msg.usage);
        return [];
      }
      case "content_block_start": {
        const index = data.index as number | undefined;
        const cb = data.content_block as
          | { type?: string; id?: string; name?: string; input?: unknown }
          | undefined;
        if (index === undefined || !cb) return [];
        if (cb.type === "tool_use" && cb.id && cb.name) {
          this.blocks.set(index, {
            kind: "tool_use",
            id: cb.id,
            name: cb.name,
            argsBuffer: "",
            startInput: normalizeToolInput(cb.input),
          });
          return [
            {
              type: "tool_call_start",
              callId: cb.id,
              name: cb.name,
              argsSchema: "json",
            },
          ];
        }
        if (cb.type === "thinking") {
          this.blocks.set(index, { kind: "thinking", textBuffer: "" });
          return [];
        }
        this.blocks.set(index, { kind: "text", textBuffer: "" });
        return [];
      }
      case "content_block_delta": {
        const index = data.index as number | undefined;
        const delta = data.delta as
          | {
              type?: string;
              text?: string;
              partial_json?: string;
              thinking?: string;
              signature?: string;
            }
          | undefined;
        if (index === undefined || !delta) return [];
        const state = this.blocks.get(index);
        const dt = delta.type;
        if (dt === "text_delta" && typeof delta.text === "string") {
          if (state?.kind === "text") state.textBuffer += delta.text;
          return delta.text ? [{ type: "text_delta", delta: delta.text }] : [];
        }
        if (
          dt === "input_json_delta" &&
          typeof delta.partial_json === "string" &&
          state?.kind === "tool_use"
        ) {
          state.argsBuffer += delta.partial_json;
          return [
            {
              type: "tool_call_delta",
              callId: state.id,
              argsDelta: delta.partial_json,
            },
          ];
        }
        if (dt === "thinking_delta" && typeof delta.thinking === "string") {
          if (state?.kind === "thinking") state.textBuffer += delta.thinking;
          const out: StreamEvent = {
            type: "thinking_delta",
            delta: delta.thinking,
          };
          if (state?.kind === "thinking" && state.signature !== undefined) {
            (out as { signature?: string }).signature = state.signature;
          }
          return [out];
        }
        if (
          dt === "signature_delta" &&
          typeof delta.signature === "string" &&
          state?.kind === "thinking"
        ) {
          state.signature = delta.signature;
          return [];
        }
        return [];
      }
      case "content_block_stop": {
        const index = data.index as number | undefined;
        if (index === undefined) return [];
        const state = this.blocks.get(index);
        // Remove the block from the pending map so the message_stop
        // defensive flush doesn't double-push it (tb2-12 regression Fix A).
        if (state !== undefined) this.blocks.delete(index);
        if (state?.kind === "tool_use") {
          const args = parseToolArgs(state);
          this.assistantParts.push({
            type: "tool_use",
            toolCallId: state.id,
            name: state.name,
            arguments: args,
          });
          return [{ type: "tool_call_done", callId: state.id, args }];
        }
        if (state?.kind === "text") {
          if (state.textBuffer.length > 0) {
            this.assistantParts.push({ type: "text", text: state.textBuffer });
          }
          return [];
        }
        // For thinking blocks, emit a terminal thinking_delta (empty text)
        // carrying the final signature so callers can round-trip it.
        if (state?.kind === "thinking") {
          const part: ContentPart = { type: "thinking", text: state.textBuffer };
          if (state.signature !== undefined) {
            (part as { signature?: string }).signature = state.signature;
          }
          this.assistantParts.push(part);
          if (state.signature !== undefined) {
            return [
              {
                type: "thinking_delta",
                delta: "",
                signature: state.signature,
              },
            ];
          }
          return [];
        }
        return [];
      }
      case "message_delta": {
        const delta = data.delta as
          | { stop_reason?: string; stop_sequence?: string | null }
          | undefined;
        const usage = data.usage as Record<string, number> | undefined;
        if (usage) this.mergeUsage(usage);
        if (delta?.stop_reason) {
          this.stopReason = mapStopReason(delta.stop_reason);
        }
        return [];
      }
      case "message_stop": {
        // Defensive flush for any block whose `content_block_stop` never
        // arrived. Anthropic's SSE spec says content_block_stop always fires,
        // but observed on tb2-12 (opus/adaptive-rejection-sampler,
        // opus/gcode-to-text, sonnet/gcode-to-text): Claude emits a
        // tool_use with empty input, Anthropic closes the stream directly
        // via message_stop without content_block_stop, and our replay
        // buffer ends up missing the tool_use. The next resume() then
        // sends a tool_result whose tool_use_id has no matching tool_use
        // in the previous assistant message → HTTP 400.
        //
        // Flush each open block using the same logic as content_block_stop
        // so `getAssistantMessage()` always reflects every tool_use /
        // text / thinking block that was ever started.
        for (const [index, state] of this.blocks.entries()) {
          if (state.kind === "tool_use") {
            const args = parseToolArgs(state);
            this.assistantParts.push({
              type: "tool_use",
              toolCallId: state.id,
              name: state.name,
              arguments: args,
            });
          } else if (state.kind === "text") {
            if (state.textBuffer.length > 0) {
              this.assistantParts.push({ type: "text", text: state.textBuffer });
            }
          } else if (state.kind === "thinking") {
            const part: ContentPart = { type: "thinking", text: state.textBuffer };
            if (state.signature !== undefined) {
              (part as { signature?: string }).signature = state.signature;
            }
            this.assistantParts.push(part);
          }
          this.blocks.delete(index);
        }
        const usage = this.buildUsage();
        return [
          {
            type: "usage_update",
            usage,
            cacheHit: (usage.cachedInputTokens ?? 0) > 0,
          },
          {
            type: "done",
            stopReason: this.stopReason,
            providerHandle: this.currentHandle(),
          },
        ];
      }
      case "error": {
        const err = data.error as { type?: string; message?: string } | undefined;
        const code = err?.type ?? "stream_error";
        const retryable = isTransientAnthropicCode(code);
        return [
          {
            type: "error",
            code,
            message: err?.message ?? "stream_error",
            retryable,
          },
        ];
      }
      default:
        return [{ type: "provider_metadata", opaque: data }];
    }
  }

  currentHandle(): ProviderContinuationHandle {
    return {
      kind: "anthropic_messages",
      messages: [], // adapter fills this from its own state
      betaHeaders: this.betaHeaders,
    };
  }

  /**
   * Materialize the assistant message this translator observed over the
   * stream. Returns null when no content blocks were accumulated (e.g., the
   * stream aborted before any content_block_stop). Adapter callers include
   * this in the providerHandle so resume() replays `[...req.messages,
   * assistant]`; without it, Anthropic rejects subsequent tool_result blocks
   * as orphans (no matching tool_use_id in conversation).
   */
  getAssistantMessage(): Message | null {
    if (this.assistantParts.length === 0) return null;
    return {
      role: "assistant",
      content: this.assistantParts.slice(),
    };
  }

  private mergeUsage(u: Record<string, number>): void {
    if (typeof u.input_tokens === "number") this.inputTokens = u.input_tokens;
    if (typeof u.output_tokens === "number") this.outputTokens = u.output_tokens;
    if (typeof u.cache_read_input_tokens === "number")
      this.cachedInputTokens = u.cache_read_input_tokens;
    if (typeof u.cache_creation_input_tokens === "number")
      this.cacheCreationInputTokens = u.cache_creation_input_tokens;
    if (typeof u.thinking_tokens === "number") this.thinkingTokens = u.thinking_tokens;
  }

  private buildUsage(): TokenUsage {
    const out: TokenUsage = {
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
    };
    if (this.cachedInputTokens > 0) out.cachedInputTokens = this.cachedInputTokens;
    if (this.cacheCreationInputTokens > 0)
      out.cacheCreationInputTokens = this.cacheCreationInputTokens;
    if (this.thinkingTokens > 0) out.thinkingTokens = this.thinkingTokens;
    return out;
  }
}

function mapStopReason(native: string): StopReason {
  switch (native) {
    case "end_turn":
      return "end_turn";
    case "tool_use":
      return "tool_use";
    case "max_tokens":
      return "max_tokens";
    case "stop_sequence":
      return "stop_sequence";
    case "refusal":
      return "refusal";
    default:
      return "end_turn";
  }
}

function isTransientAnthropicCode(code: string): boolean {
  const n = code.toLowerCase();
  return (
    n === "overloaded_error" ||
    n === "api_error" ||
    n === "internal_server_error" ||
    n.includes("timeout")
  );
}

function parseToolArgs(state: ToolUseState): Record<string, unknown> {
  if (!state.argsBuffer) return state.startInput;
  try {
    return normalizeToolInput(JSON.parse(state.argsBuffer));
  } catch {
    return {};
  }
}

function normalizeToolInput(input: unknown): Record<string, unknown> {
  if (
    input !== null &&
    typeof input === "object" &&
    !Array.isArray(input) &&
    (Object.getPrototypeOf(input) === Object.prototype || Object.getPrototypeOf(input) === null)
  ) {
    return input as Record<string, unknown>;
  }
  return {};
}
