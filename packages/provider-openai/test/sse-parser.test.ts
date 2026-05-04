/**
 * SSE parser + OpenAI event translator tests.
 * Uses synthetic SSE bytes that mirror the real Responses API shape.
 */

import { describe, expect, test } from "bun:test";

import type { StreamEvent } from "@open-apex/core";

import { OpenAiEventTranslator, parseSseStream, type SseEvent } from "../src/sse-parser.ts";

function toStream(bytes: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(bytes));
      controller.close();
    },
  });
}

function toChunkedStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(chunks[i]!));
      i++;
    },
  });
}

async function collectSse(stream: ReadableStream<Uint8Array>): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const ev of parseSseStream(stream)) out.push(ev);
  return out;
}

describe("parseSseStream", () => {
  test("parses two simple events separated by blank lines", async () => {
    const raw = 'event: first\ndata: {"a":1}\n\n' + 'event: second\ndata: {"a":2}\n\n';
    const events = await collectSse(toStream(raw));
    expect(events).toEqual([
      { event: "first", data: '{"a":1}' },
      { event: "second", data: '{"a":2}' },
    ]);
  });

  test("handles CRLF line endings", async () => {
    const raw = 'event: x\r\ndata: {"a":1}\r\n\r\n';
    const events = await collectSse(toStream(raw));
    expect(events[0]).toEqual({ event: "x", data: '{"a":1}' });
  });

  test("joins multiline data fields", async () => {
    const raw = "event: m\ndata: line1\ndata: line2\n\n";
    const events = await collectSse(toStream(raw));
    expect(events[0]?.data).toBe("line1\nline2");
  });

  test("handles byte-level chunking mid-event", async () => {
    const parts = ["event: a\nd", 'ata: {"x"', ":1}\n\n", "event: b\ndata: ok\n\n"];
    const events = await collectSse(toChunkedStream(parts));
    expect(events.length).toBe(2);
    expect(events[0]?.data).toBe('{"x":1}');
    expect(events[1]?.event).toBe("b");
  });

  test("skips comment lines (starting with ':')", async () => {
    const raw = ":keepalive\nevent: x\ndata: 1\n\n";
    const events = await collectSse(toStream(raw));
    expect(events).toEqual([{ event: "x", data: "1" }]);
  });
});

describe("OpenAiEventTranslator", () => {
  function ev(event: string, obj: unknown): SseEvent {
    return { event, data: JSON.stringify(obj) };
  }

  test("text delta → text_delta StreamEvent", () => {
    const t = new OpenAiEventTranslator();
    const out = t.translate(
      ev("response.output_text.delta", {
        type: "response.output_text.delta",
        delta: "hello",
      }),
    );
    expect(out).toEqual([{ type: "text_delta", delta: "hello" }]);
  });

  test("reasoning delta → reasoning_delta", () => {
    const t = new OpenAiEventTranslator();
    const out = t.translate(
      ev("response.reasoning_summary_text.delta", {
        type: "response.reasoning_summary_text.delta",
        delta: "thinking",
      }),
    );
    expect(out).toEqual([{ type: "reasoning_delta", delta: "thinking" }]);
  });

  test("compaction output item → compaction_block", () => {
    const t = new OpenAiEventTranslator();
    const out = t.translate(
      ev("response.output_item.done", {
        type: "response.output_item.done",
        item: {
          type: "compaction",
          id: "cmp_1",
          summary_tokens: 123,
          replaced_range: [1, 7],
        },
      }),
    );
    expect(out).toEqual([{ type: "compaction_block", summaryTokens: 123, replacedRange: [1, 7] }]);
  });

  test("tool call lifecycle: start → delta → done", () => {
    const t = new OpenAiEventTranslator();
    const events: StreamEvent[] = [];
    events.push(
      ...t.translate(
        ev("response.output_item.added", {
          type: "response.output_item.added",
          item: {
            type: "function_call",
            id: "item_1",
            call_id: "call_1",
            name: "read_file",
          },
        }),
      ),
    );
    events.push(
      ...t.translate(
        ev("response.function_call_arguments.delta", {
          type: "response.function_call_arguments.delta",
          item_id: "item_1",
          delta: '{"pat',
        }),
      ),
    );
    events.push(
      ...t.translate(
        ev("response.function_call_arguments.delta", {
          type: "response.function_call_arguments.delta",
          item_id: "item_1",
          delta: 'h":"a.ts"}',
        }),
      ),
    );
    events.push(
      ...t.translate(
        ev("response.function_call_arguments.done", {
          type: "response.function_call_arguments.done",
          item: { id: "item_1", call_id: "call_1" },
          item_id: "item_1",
        }),
      ),
    );
    expect(events[0]).toEqual({
      type: "tool_call_start",
      callId: "call_1",
      name: "read_file",
      argsSchema: "json",
    });
    expect(events.at(-1)).toEqual({
      type: "tool_call_done",
      callId: "call_1",
      args: { path: "a.ts" },
    });
  });

  test("response.completed emits usage_update + done", () => {
    const t = new OpenAiEventTranslator();
    const out = t.translate(
      ev("response.completed", {
        type: "response.completed",
        response: {
          id: "resp_abc",
          usage: {
            input_tokens: 120,
            output_tokens: 45,
            input_tokens_details: { cached_tokens: 30 },
            output_tokens_details: { reasoning_tokens: 12 },
          },
        },
      }),
    );
    expect(out[0]).toMatchObject({
      type: "usage_update",
      cacheHit: true,
      usage: {
        inputTokens: 120,
        outputTokens: 45,
        cachedInputTokens: 30,
        reasoningTokens: 12,
      },
    });
    expect(out[1]).toMatchObject({
      type: "done",
      stopReason: "end_turn",
      providerHandle: { kind: "openai_response", responseId: "resp_abc" },
    });
  });

  test("error SSE with transient code → retryable: true", () => {
    const t = new OpenAiEventTranslator();
    const out = t.translate(
      ev("error", {
        type: "error",
        error: { code: "server_error", message: "boom" },
      }),
    );
    expect(out).toEqual([
      { type: "error", code: "server_error", message: "boom", retryable: true },
    ]);
  });

  test("error SSE with non-transient code → retryable: false", () => {
    const t = new OpenAiEventTranslator();
    const out = t.translate(
      ev("error", {
        type: "error",
        error: { code: "invalid_request_error", message: "bad" },
      }),
    );
    expect(out).toEqual([
      {
        type: "error",
        code: "invalid_request_error",
        message: "bad",
        retryable: false,
      },
    ]);
  });

  test("unknown event becomes provider_metadata", () => {
    const t = new OpenAiEventTranslator();
    const out = t.translate(ev("some.unrecognized", { type: "some.unrecognized", custom: 1 }));
    expect(out[0]?.type).toBe("provider_metadata");
  });

  test("malformed JSON is swallowed (not a hard error)", () => {
    const t = new OpenAiEventTranslator();
    const out = t.translate({ event: "response.output_text.delta", data: "{not-json" });
    expect(out).toEqual([]);
  });
});
