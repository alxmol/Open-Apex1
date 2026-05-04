import { describe, expect, test } from "bun:test";

import type { StreamEvent } from "@open-apex/core";

import { AnthropicEventTranslator, parseSseStream, type SseEvent } from "../src/sse-parser.ts";

function toStream(bytes: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(c) {
      c.enqueue(encoder.encode(bytes));
      c.close();
    },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<SseEvent[]> {
  const out: SseEvent[] = [];
  for await (const ev of parseSseStream(stream)) out.push(ev);
  return out;
}

describe("Anthropic parseSseStream", () => {
  test("parses two events with LF separators", async () => {
    const raw = 'event: a\ndata: {"x":1}\n\nevent: b\ndata: {"y":2}\n\n';
    const events = await collect(toStream(raw));
    expect(events).toEqual([
      { event: "a", data: '{"x":1}' },
      { event: "b", data: '{"y":2}' },
    ]);
  });
});

describe("AnthropicEventTranslator", () => {
  function ev(event: string, obj: unknown): SseEvent {
    return { event, data: JSON.stringify(obj) };
  }

  test("full flow: message_start → text_delta → message_delta → message_stop", () => {
    const t = new AnthropicEventTranslator(["context-management-2025-06-27"]);
    const out: StreamEvent[] = [];
    out.push(
      ...t.translate(
        ev("message_start", {
          type: "message_start",
          message: {
            id: "msg_abc",
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        }),
      ),
    );
    out.push(
      ...t.translate(
        ev("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text" },
        }),
      ),
    );
    out.push(
      ...t.translate(
        ev("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "hi" },
        }),
      ),
    );
    out.push(
      ...t.translate(
        ev("content_block_stop", {
          type: "content_block_stop",
          index: 0,
        }),
      ),
    );
    out.push(
      ...t.translate(
        ev("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "end_turn" },
          usage: { output_tokens: 5 },
        }),
      ),
    );
    out.push(...t.translate(ev("message_stop", { type: "message_stop" })));

    expect(out[0]).toMatchObject({ type: "text_delta", delta: "hi" });
    const usage = out.find((e) => e.type === "usage_update");
    expect(usage).toBeDefined();
    if (usage?.type !== "usage_update") throw new Error("unreachable");
    expect(usage.usage.inputTokens).toBe(10);
    expect(usage.usage.outputTokens).toBe(5);
    const done = out.find((e) => e.type === "done");
    expect(done).toBeDefined();
    if (done?.type !== "done") throw new Error("unreachable");
    expect(done.stopReason).toBe("end_turn");
    if (done.providerHandle.kind !== "anthropic_messages") throw new Error("wrong handle");
    expect(done.providerHandle.betaHeaders).toEqual(["context-management-2025-06-27"]);
  });

  test("thinking deltas emit thinking_delta and signature_delta preserves signature", () => {
    const t = new AnthropicEventTranslator();
    const out: StreamEvent[] = [];
    out.push(
      ...t.translate(
        ev("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking" },
        }),
      ),
    );
    out.push(
      ...t.translate(
        ev("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "considering..." },
        }),
      ),
    );
    out.push(
      ...t.translate(
        ev("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "sig-abc" },
        }),
      ),
    );
    // Second thinking_delta after signature should carry it.
    out.push(
      ...t.translate(
        ev("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: " more" },
        }),
      ),
    );
    expect(out[0]).toMatchObject({ type: "thinking_delta", delta: "considering..." });
    const lastThinking = out.filter((e) => e.type === "thinking_delta").at(-1);
    expect(lastThinking).toBeDefined();
    if (lastThinking?.type !== "thinking_delta") throw new Error("unreachable");
    expect(lastThinking.signature).toBe("sig-abc");
  });

  test("tool_use block: start → input_json_delta → stop → tool_call events", () => {
    const t = new AnthropicEventTranslator();
    const out: StreamEvent[] = [];
    out.push(
      ...t.translate(
        ev("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "tu_1",
            name: "read_file",
            input: {},
          },
        }),
      ),
    );
    out.push(
      ...t.translate(
        ev("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"path":"' },
        }),
      ),
    );
    out.push(
      ...t.translate(
        ev("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: 'a.ts"}' },
        }),
      ),
    );
    out.push(...t.translate(ev("content_block_stop", { type: "content_block_stop", index: 0 })));
    expect(out[0]).toEqual({
      type: "tool_call_start",
      callId: "tu_1",
      name: "read_file",
      argsSchema: "json",
    });
    expect(out.at(-1)).toEqual({
      type: "tool_call_done",
      callId: "tu_1",
      args: { path: "a.ts" },
    });
  });

  test("error SSE for transient codes → retryable: true", () => {
    const t = new AnthropicEventTranslator();
    const out = t.translate(
      ev("error", {
        type: "error",
        error: { type: "overloaded_error", message: "busy" },
      }),
    );
    expect(out[0]).toMatchObject({
      type: "error",
      code: "overloaded_error",
      retryable: true,
    });
  });

  test("error SSE for non-transient → retryable: false", () => {
    const t = new AnthropicEventTranslator();
    const out = t.translate(
      ev("error", {
        type: "error",
        error: { type: "invalid_request_error", message: "bad" },
      }),
    );
    expect(out[0]).toMatchObject({
      type: "error",
      code: "invalid_request_error",
      retryable: false,
    });
  });

  test("ping is no-op", () => {
    const t = new AnthropicEventTranslator();
    const out = t.translate(ev("ping", { type: "ping" }));
    expect(out).toEqual([]);
  });

  test("getAssistantMessage accumulates text + tool_use + thinking in emit order", () => {
    const t = new AnthropicEventTranslator();
    // thinking block (index 0)
    t.translate(
      ev("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: { type: "thinking" },
      }),
    );
    t.translate(
      ev("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "pondering" },
      }),
    );
    t.translate(
      ev("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "signature_delta", signature: "sig-1" },
      }),
    );
    t.translate(ev("content_block_stop", { type: "content_block_stop", index: 0 }));
    // text block (index 1)
    t.translate(
      ev("content_block_start", {
        type: "content_block_start",
        index: 1,
        content_block: { type: "text" },
      }),
    );
    t.translate(
      ev("content_block_delta", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "reading file " },
      }),
    );
    t.translate(
      ev("content_block_delta", {
        type: "content_block_delta",
        index: 1,
        delta: { type: "text_delta", text: "now" },
      }),
    );
    t.translate(ev("content_block_stop", { type: "content_block_stop", index: 1 }));
    // tool_use block (index 2)
    t.translate(
      ev("content_block_start", {
        type: "content_block_start",
        index: 2,
        content_block: {
          type: "tool_use",
          id: "tu_9",
          name: "read_file",
          input: {},
        },
      }),
    );
    t.translate(
      ev("content_block_delta", {
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: '{"path":"a.ts"}' },
      }),
    );
    t.translate(ev("content_block_stop", { type: "content_block_stop", index: 2 }));

    const msg = t.getAssistantMessage();
    expect(msg).not.toBeNull();
    expect(msg?.role).toBe("assistant");
    const parts = msg?.content as unknown as Array<Record<string, unknown>>;
    expect(parts.length).toBe(3);
    expect(parts[0]).toMatchObject({
      type: "thinking",
      text: "pondering",
      signature: "sig-1",
    });
    expect(parts[1]).toMatchObject({ type: "text", text: "reading file now" });
    expect(parts[2]).toMatchObject({
      type: "tool_use",
      toolCallId: "tu_9",
      name: "read_file",
      arguments: { path: "a.ts" },
    });
  });

  test("getAssistantMessage returns null when no content blocks completed", () => {
    const t = new AnthropicEventTranslator();
    t.translate(ev("message_start", { type: "message_start", message: { id: "m1" } }));
    expect(t.getAssistantMessage()).toBeNull();
  });

  test("adapter-emitted done handle carries assistantMessage for replay", () => {
    // This asserts the invariant the real AnthropicAdapter depends on: by
    // the time message_stop fires, getAssistantMessage() has enough info
    // for the adapter to build `[...req.messages, assistant]` and put it in
    // the providerHandle.messages replay buffer.
    const t = new AnthropicEventTranslator(["context-management-2025-06-27"]);
    t.translate(
      ev("content_block_start", {
        type: "content_block_start",
        index: 0,
        content_block: {
          type: "tool_use",
          id: "tu_handle_1",
          name: "run_shell",
          input: {},
        },
      }),
    );
    t.translate(
      ev("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"argv":["ls"]}' },
      }),
    );
    t.translate(ev("content_block_stop", { type: "content_block_stop", index: 0 }));
    t.translate(
      ev("message_delta", {
        type: "message_delta",
        delta: { stop_reason: "tool_use" },
      }),
    );
    t.translate(ev("message_stop", { type: "message_stop" }));

    const msg = t.getAssistantMessage();
    expect(msg).not.toBeNull();
    const parts = msg?.content as unknown as Array<{ type: string; toolCallId?: string }>;
    const toolUse = parts.find((p) => p.type === "tool_use");
    expect(toolUse?.toolCallId).toBe("tu_handle_1");
  });

  describe("flush-on-message_stop (tb2-12 regression: plan Fix A)", () => {
    // Anthropic's docs say content_block_stop always fires, but real-world
    // runs (tb2-12 opus/adaptive-rejection-sampler, sonnet/gcode-to-text)
    // show it gets skipped when Claude emits a tool_use with empty input.
    // The translator must defensively flush any open blocks on message_stop
    // so the replay buffer (providerHandle.messages) always reflects every
    // tool_use that was started.
    test("empty-args tool_use missing content_block_stop → still in assistantParts", () => {
      const t = new AnthropicEventTranslator();
      t.translate(
        ev("message_start", {
          type: "message_start",
          message: { id: "msg_1", usage: { input_tokens: 1, output_tokens: 0 } },
        }),
      );
      t.translate(
        ev("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: {
            type: "tool_use",
            id: "toolu_empty",
            name: "write_file",
            input: {},
          },
        }),
      );
      // No input_json_delta, no content_block_stop — just straight to
      // message_delta + message_stop as observed in the failing trial.
      t.translate(
        ev("message_delta", {
          type: "message_delta",
          delta: { stop_reason: "tool_use" },
        }),
      );
      const finalEvents = t.translate(ev("message_stop", { type: "message_stop" }));
      // done event still fires as usual.
      expect(finalEvents.some((e) => e.type === "done")).toBe(true);
      const msg = t.getAssistantMessage();
      expect(msg).not.toBeNull();
      const parts = msg?.content as unknown as Array<{
        type: string;
        toolCallId?: string;
        arguments?: unknown;
      }>;
      const toolUse = parts.find((p) => p.type === "tool_use");
      expect(toolUse).toBeDefined();
      expect(toolUse?.toolCallId).toBe("toolu_empty");
      expect(toolUse?.arguments).toEqual({});
    });

    test("pending text block flushed on message_stop", () => {
      const t = new AnthropicEventTranslator();
      t.translate(
        ev("message_start", {
          type: "message_start",
          message: { id: "msg_2", usage: { input_tokens: 1, output_tokens: 0 } },
        }),
      );
      t.translate(
        ev("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        }),
      );
      t.translate(
        ev("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "hello world" },
        }),
      );
      // No content_block_stop for the text block.
      t.translate(ev("message_stop", { type: "message_stop" }));
      const msg = t.getAssistantMessage();
      const parts = msg?.content as unknown as Array<{ type: string; text?: string }>;
      const text = parts.find((p) => p.type === "text");
      expect(text?.text).toBe("hello world");
    });

    test("pending thinking block flushed with signature", () => {
      const t = new AnthropicEventTranslator();
      t.translate(
        ev("message_start", {
          type: "message_start",
          message: { id: "msg_3", usage: { input_tokens: 1, output_tokens: 0 } },
        }),
      );
      t.translate(
        ev("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "" },
        }),
      );
      t.translate(
        ev("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "thinking_delta", thinking: "pondering..." },
        }),
      );
      t.translate(
        ev("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "abc123" },
        }),
      );
      // No content_block_stop.
      t.translate(ev("message_stop", { type: "message_stop" }));
      const msg = t.getAssistantMessage();
      const parts = msg?.content as unknown as Array<{
        type: string;
        text?: string;
        signature?: string;
      }>;
      const thinking = parts.find((p) => p.type === "thinking");
      expect(thinking?.text).toBe("pondering...");
      expect(thinking?.signature).toBe("abc123");
    });

    test("normal content_block_stop path is unchanged (no double-push)", () => {
      const t = new AnthropicEventTranslator();
      t.translate(
        ev("message_start", {
          type: "message_start",
          message: { id: "msg_4", usage: { input_tokens: 1, output_tokens: 0 } },
        }),
      );
      t.translate(
        ev("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_good", name: "run_shell", input: {} },
        }),
      );
      t.translate(
        ev("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"argv":["ls"]}' },
        }),
      );
      t.translate(ev("content_block_stop", { type: "content_block_stop", index: 0 }));
      t.translate(ev("message_stop", { type: "message_stop" }));
      const msg = t.getAssistantMessage();
      const parts = msg?.content as unknown as Array<{ type: string; toolCallId?: string }>;
      // Exactly ONE tool_use — the stop handler pushed it; the message_stop
      // flush should have seen an empty blocks map and done nothing.
      const toolUses = parts.filter((p) => p.type === "tool_use");
      expect(toolUses).toHaveLength(1);
      expect(toolUses[0]?.toolCallId).toBe("toolu_good");
    });

    test("malformed tool input normalizes to empty object for replay", () => {
      const t = new AnthropicEventTranslator();
      t.translate(
        ev("message_start", {
          type: "message_start",
          message: { id: "msg_5", usage: { input_tokens: 1, output_tokens: 0 } },
        }),
      );
      t.translate(
        ev("content_block_start", {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_bad", name: "write_file", input: [] },
        }),
      );
      t.translate(
        ev("content_block_delta", {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '"scalar"' },
        }),
      );
      t.translate(ev("content_block_stop", { type: "content_block_stop", index: 0 }));

      const msg = t.getAssistantMessage();
      const parts = msg?.content as unknown as Array<{ type: string; arguments?: unknown }>;
      const toolUse = parts.find((p) => p.type === "tool_use");
      expect(toolUse?.arguments).toEqual({});
    });
  });
});
