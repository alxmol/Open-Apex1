import { describe, expect, test } from "bun:test";

import {
  CircuitBreaker,
  DefaultRetryPolicy,
  RateLimiter,
  type AgentRequest,
  type StreamEvent,
} from "@open-apex/core";

import { AnthropicAdapter } from "../src/adapter.ts";

function sseResponse(
  bodyText: string,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  const body = new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(bodyText));
      c.close();
    },
  });
  return new Response(body, {
    status,
    headers: { "content-type": "text/event-stream", ...headers },
  });
}

const PLAIN_STREAM = [
  'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_123","usage":{"input_tokens":8,"output_tokens":0}}}',
  "",
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
  "",
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ok"}}',
  "",
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
  "",
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":2}}',
  "",
  'event: message_stop\ndata: {"type":"message_stop"}',
  "",
  "",
].join("\n");

describe("AnthropicAdapter (mocked fetch)", () => {
  const req: AgentRequest = {
    systemPrompt: "be helpful",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
  };

  test("generate() streams text_delta + usage_update + done", async () => {
    const adapter = new AnthropicAdapter({
      modelId: "claude-opus-4-6",
      apiKey: "sk-ant-test",
      fetchFn: (async () => sseResponse(PLAIN_STREAM)) as unknown as typeof fetch,
      rateLimiter: new RateLimiter(),
      circuitBreaker: new CircuitBreaker(),
    });
    const events: StreamEvent[] = [];
    for await (const ev of adapter.generate(req, { effort: "high" })) events.push(ev);
    expect(events.map((e) => e.type)).toEqual(["text_delta", "usage_update", "done"]);
    const done = events[2];
    if (done?.type !== "done") throw new Error("unreachable");
    if (done.providerHandle.kind !== "anthropic_messages") throw new Error("wrong handle kind");
    expect(Array.isArray(done.providerHandle.messages)).toBe(true);
  });

  test("sends beta headers when preset enables them", async () => {
    let sentHeaders: Record<string, string> = {};
    const adapter = new AnthropicAdapter({
      modelId: "claude-opus-4-6",
      apiKey: "sk-ant-test",
      alwaysOnBetaHeaders: ["context-management-2025-06-27"],
      fetchFn: (async (_u: string | Request | URL, init?: RequestInit) => {
        sentHeaders = init?.headers as Record<string, string>;
        return sseResponse(PLAIN_STREAM);
      }) as unknown as typeof fetch,
      rateLimiter: new RateLimiter(),
      circuitBreaker: new CircuitBreaker(),
    });
    const events: StreamEvent[] = [];
    for await (const ev of adapter.generate(req, {
      providerBetaHeaders: ["compact-2026-01-12"],
    })) {
      events.push(ev);
    }
    expect(sentHeaders["anthropic-beta"]).toContain("context-management-2025-06-27");
    expect(sentHeaders["anthropic-beta"]).toContain("compact-2026-01-12");
  });

  test("retries on 529 (overloaded) then succeeds", async () => {
    let call = 0;
    const adapter = new AnthropicAdapter({
      modelId: "claude-opus-4-6",
      apiKey: "sk-ant-test",
      retryPolicy: new DefaultRetryPolicy({
        initialDelayMs: 1,
        maxDelayMs: 2,
        jitter: "none",
        sleep: async () => {},
      }),
      fetchFn: (async () => {
        call++;
        if (call === 1) return new Response("overloaded", { status: 529 });
        return sseResponse(PLAIN_STREAM);
      }) as unknown as typeof fetch,
      rateLimiter: new RateLimiter(),
      circuitBreaker: new CircuitBreaker(),
    });
    const events: StreamEvent[] = [];
    for await (const ev of adapter.generate(req, {})) events.push(ev);
    expect(call).toBe(2);
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  test("does NOT retry on 401", async () => {
    let call = 0;
    const adapter = new AnthropicAdapter({
      modelId: "claude-opus-4-6",
      apiKey: "sk-ant-test",
      retryPolicy: new DefaultRetryPolicy({
        initialDelayMs: 1,
        sleep: async () => {},
      }),
      fetchFn: (async () => {
        call++;
        return new Response("bad key", { status: 401 });
      }) as unknown as typeof fetch,
      rateLimiter: new RateLimiter(),
      circuitBreaker: new CircuitBreaker(),
    });
    let threw = false;
    try {
      for await (const _ of adapter.generate(req, {})) void _;
    } catch (err) {
      threw = true;
      expect((err as { httpStatus?: number }).httpStatus).toBe(401);
    }
    expect(threw).toBe(true);
    expect(call).toBe(1);
  });

  test("auto-downgrades strict when Anthropic returns 'Schema is too complex' 400", async () => {
    // Regression for the production 9-tool manifest: when many strict-tagged
    // tools are sent together, the combined grammar exceeds Anthropic's
    // compilation budget and the API returns
    //   400 {"error":{"message":"Schema is too complex for compilation..."}}
    // The adapter must transparently retry ONCE with strict disabled so the
    // model still runs (we lose grammar enforcement but recover correctness).
    let call = 0;
    const sentPayloads: Array<{ tools?: Array<{ strict?: boolean }> }> = [];
    const adapter = new AnthropicAdapter({
      modelId: "claude-opus-4-6",
      apiKey: "sk-ant-test",
      strictTools: true,
      fetchFn: (async (_url: string | Request | URL, init?: RequestInit) => {
        call++;
        const body = JSON.parse((init?.body as string) ?? "{}");
        sentPayloads.push(body);
        if (call === 1) {
          return new Response(
            JSON.stringify({
              type: "error",
              error: {
                type: "invalid_request_error",
                message:
                  "Schema is too complex for compilation. Try reducing the number of tools or simplifying tool schemas.",
              },
            }),
            { status: 400 },
          );
        }
        return sseResponse(PLAIN_STREAM);
      }) as unknown as typeof fetch,
      rateLimiter: new RateLimiter(),
      circuitBreaker: new CircuitBreaker(),
    });
    const reqWithTools: AgentRequest = {
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          name: "read_file",
          description: "",
          parameters: {
            type: "object",
            required: ["path"],
            additionalProperties: false,
            properties: { path: { type: "string" } },
          },
        },
      ],
    };
    const events: StreamEvent[] = [];
    for await (const ev of adapter.generate(reqWithTools, {})) events.push(ev);
    expect(call).toBe(2);
    // Turn 1 was strict, turn 2 dropped strict.
    expect(sentPayloads[0]?.tools?.[0]?.strict).toBe(true);
    expect(sentPayloads[1]?.tools?.[0]?.strict).toBeUndefined();
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  test("auto-downgrades strict when Anthropic returns optional-parameter budget 400", async () => {
    let call = 0;
    const sentPayloads: Array<{ tools?: Array<{ strict?: boolean }> }> = [];
    const adapter = new AnthropicAdapter({
      modelId: "claude-opus-4-6",
      apiKey: "sk-ant-test",
      strictTools: true,
      fetchFn: (async (_url: string | Request | URL, init?: RequestInit) => {
        call++;
        const body = JSON.parse((init?.body as string) ?? "{}");
        sentPayloads.push(body);
        if (call === 1) {
          return new Response(
            JSON.stringify({
              type: "error",
              error: {
                type: "invalid_request_error",
                message:
                  "Schemas contains too many optional parameters (27), which would make grammar compilation inefficient. Reduce the number of optional parameters in your tool schemas (limit: 24).",
              },
            }),
            { status: 400 },
          );
        }
        return sseResponse(PLAIN_STREAM);
      }) as unknown as typeof fetch,
      rateLimiter: new RateLimiter(),
      circuitBreaker: new CircuitBreaker(),
    });
    const reqWithTools: AgentRequest = {
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          name: "read_file",
          description: "",
          parameters: {
            type: "object",
            required: ["path"],
            additionalProperties: false,
            properties: { path: { type: "string" }, startLine: { type: "integer" } },
          },
        },
      ],
    };
    const events: StreamEvent[] = [];
    for await (const ev of adapter.generate(reqWithTools, {})) events.push(ev);
    expect(call).toBe(2);
    expect(sentPayloads[0]?.tools?.[0]?.strict).toBe(true);
    expect(sentPayloads[1]?.tools?.[0]?.strict).toBeUndefined();
    expect(events.some((e) => e.type === "done")).toBe(true);
  });

  test("fallback only fires once: second 'Schema too complex' propagates as HttpError", async () => {
    let call = 0;
    const adapter = new AnthropicAdapter({
      modelId: "claude-opus-4-6",
      apiKey: "sk-ant-test",
      strictTools: true,
      retryPolicy: new DefaultRetryPolicy({ initialDelayMs: 1, sleep: async () => {} }),
      fetchFn: (async () => {
        call++;
        return new Response(
          JSON.stringify({
            error: { message: "Schema is too complex for compilation." },
          }),
          { status: 400 },
        );
      }) as unknown as typeof fetch,
      rateLimiter: new RateLimiter(),
      circuitBreaker: new CircuitBreaker(),
    });
    const reqWithTools: AgentRequest = {
      systemPrompt: "s",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "a", description: "", parameters: { type: "object" } }],
    };
    let threw = false;
    try {
      for await (const _ of adapter.generate(reqWithTools, {})) void _;
    } catch (err) {
      threw = true;
      expect((err as { httpStatus?: number }).httpStatus).toBe(400);
    }
    expect(threw).toBe(true);
    // One strict attempt + one non-strict retry; no third attempt.
    expect(call).toBe(2);
  });

  test("compact() returns not-applicable (Anthropic rule)", async () => {
    const adapter = new AnthropicAdapter({
      modelId: "claude-opus-4-6",
      apiKey: "sk-ant-test",
    });
    const r = await adapter.compact(
      { kind: "anthropic_messages", messages: [], betaHeaders: [] },
      {},
    );
    expect(r.applicable).toBe(false);
  });

  test("providerHandle prunes multimodal base64 from replay after first send", async () => {
    const adapter = new AnthropicAdapter({
      modelId: "claude-opus-4-6",
      apiKey: "sk-ant-test",
      fetchFn: (async () => sseResponse(PLAIN_STREAM)) as unknown as typeof fetch,
      rateLimiter: new RateLimiter(),
      circuitBreaker: new CircuitBreaker(),
    });
    const multimodalReq: AgentRequest = {
      systemPrompt: "sys",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolCallId: "toolu_asset",
              content: [
                { type: "text", text: "Attached asset" },
                {
                  type: "image",
                  source: {
                    kind: "base64",
                    data: "iVBORw0KGgo=",
                    mediaType: "image/png",
                  },
                },
                { type: "pdf", source: { kind: "base64", data: "JVBERi0xLjQK" } },
              ],
            },
          ],
        },
      ],
      tools: [],
    };
    const events: StreamEvent[] = [];
    for await (const ev of adapter.generate(multimodalReq, {})) events.push(ev);
    const done = events.find((e) => e.type === "done");
    if (done?.type !== "done" || done.providerHandle.kind !== "anthropic_messages") {
      throw new Error("missing anthropic handle");
    }
    const serialized = JSON.stringify(done.providerHandle.messages);
    expect(serialized).not.toContain("iVBORw0KGgo=");
    expect(serialized).not.toContain("JVBERi0xLjQK");
    expect(serialized).toContain("omitted from replay");
  });

  test("capability matrix matches Opus 4.6 flags", () => {
    const adapter = new AnthropicAdapter({
      modelId: "claude-opus-4-6",
      apiKey: "sk-ant-test",
    });
    const caps = adapter.getCapabilities();
    expect(caps.providerId).toBe("anthropic");
    expect(caps.supportsAdaptiveThinking).toBe(true);
    expect(caps.supportsEffortMax).toBe(true);
    expect(caps.supportsEffortXhigh).toBe(false);
  });

  test(
    "empty-args tool_use missing content_block_stop still ends up in providerHandle.messages " +
      "(tb2-12 regression: plan Fix A end-to-end)",
    async () => {
      // Raw SSE mirroring the tb2-12 Claude behavior: a tool_use is started
      // but the stream proceeds directly to message_delta + message_stop
      // without firing content_block_stop. The flush-on-message_stop fix
      // must recover the tool_use into the assistant message so resume()
      // ships it back to Anthropic (otherwise: "unexpected tool_use_id").
      const STREAM = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_empty","usage":{"input_tokens":5,"output_tokens":0}}}',
        "",
        'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_empty","name":"write_file","input":{}}}',
        "",
        // No input_json_delta, no content_block_stop — jumps straight to
        // message_delta + message_stop.
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":2}}',
        "",
        'event: message_stop\ndata: {"type":"message_stop"}',
        "",
        "",
      ].join("\n");
      const adapter = new AnthropicAdapter({
        modelId: "claude-opus-4-6",
        apiKey: "sk-ant-test",
        fetchFn: (async () => sseResponse(STREAM)) as unknown as typeof fetch,
        rateLimiter: new RateLimiter(),
        circuitBreaker: new CircuitBreaker(),
      });
      const events: StreamEvent[] = [];
      for await (const ev of adapter.generate(req, {})) events.push(ev);
      const done = events.find((e) => e.type === "done");
      expect(done).toBeDefined();
      if (done?.type !== "done") throw new Error("unreachable");
      if (done.providerHandle.kind !== "anthropic_messages") throw new Error("wrong handle kind");
      const msgs = done.providerHandle.messages as Array<{ role: string; content: unknown }>;
      // Last message should be the assistant with the tool_use block.
      const lastAsst = [...msgs].reverse().find((m) => m.role === "assistant");
      expect(lastAsst).toBeDefined();
      const parts = lastAsst!.content as Array<{
        type: string;
        toolCallId?: string;
        name?: string;
        arguments?: unknown;
      }>;
      const toolUse = parts.find((p) => p.type === "tool_use");
      expect(toolUse).toBeDefined();
      expect(toolUse?.toolCallId).toBe("toolu_empty");
      expect(toolUse?.name).toBe("write_file");
      expect(toolUse?.arguments).toEqual({});
    },
  );
});
