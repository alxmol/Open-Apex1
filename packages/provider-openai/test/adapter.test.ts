/**
 * OpenAiAdapter mock tests (no API calls).
 *   - Mocked fetch returns pre-recorded SSE bodies.
 *   - Verifies retry/rate-limit/circuit-breaker wiring.
 */

import { describe, expect, test } from "bun:test";

import {
  CircuitBreaker,
  DefaultRetryPolicy,
  RateLimiter,
  type AgentRequest,
  type StreamEvent,
} from "@open-apex/core";

import { OpenAiAdapter } from "../src/adapter.ts";

function sseResponse(
  bodyText: string,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(bodyText));
      controller.close();
    },
  });
  return new Response(body, {
    status,
    headers: { "content-type": "text/event-stream", ...headers },
  });
}

function jsonResponse(obj: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

const PLAIN_STREAM =
  'event: response.created\ndata: {"type":"response.created","response":{"id":"resp_abc"}}\n\n' +
  'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"hi"}\n\n' +
  'event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_abc","usage":{"input_tokens":10,"output_tokens":2}}}\n\n';

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

describe("OpenAiAdapter with mocked fetch", () => {
  const req: AgentRequest = {
    systemPrompt: "be helpful",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
  };

  test("generate() streams text_delta + usage_update + done", async () => {
    const calls: Request[] = [];
    const adapter = new OpenAiAdapter({
      modelId: "gpt-5.4",
      apiKey: "sk-test",
      fetchFn: (async (url: string | Request | URL, init?: RequestInit) => {
        calls.push({ url, init } as unknown as Request);
        return sseResponse(PLAIN_STREAM, 200, {
          "x-ratelimit-limit-tokens": "1000000",
          "x-ratelimit-remaining-tokens": "999800",
        });
      }) as unknown as typeof fetch,
      rateLimiter: new RateLimiter(),
      circuitBreaker: new CircuitBreaker(),
    });
    const events: StreamEvent[] = [];
    for await (const ev of adapter.generate(req, { effort: "high" })) events.push(ev);
    expect(events.map((e) => e.type)).toEqual(["text_delta", "usage_update", "done"]);
    if (events[2]!.type !== "done") throw new Error("unreachable");
    expect(events[2]!.providerHandle).toMatchObject({
      kind: "openai_response",
      responseId: "resp_abc",
    });
    expect(calls).toHaveLength(1);
  });

  test("generate() retries on 503 then succeeds", async () => {
    let call = 0;
    const adapter = new OpenAiAdapter({
      modelId: "gpt-5.4",
      apiKey: "sk-test",
      retryPolicy: new DefaultRetryPolicy({
        initialDelayMs: 1,
        maxDelayMs: 2,
        jitter: "none",
        sleep: async () => {},
      }),
      fetchFn: (async () => {
        call++;
        if (call === 1) return new Response("nope", { status: 503 });
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

  test("generate() does NOT retry on 401", async () => {
    let call = 0;
    const adapter = new OpenAiAdapter({
      modelId: "gpt-5.4",
      apiKey: "sk-test",
      retryPolicy: new DefaultRetryPolicy({
        initialDelayMs: 1,
        sleep: async () => {},
      }),
      fetchFn: (async () => {
        call++;
        return new Response("unauthorized", { status: 401 });
      }) as unknown as typeof fetch,
      rateLimiter: new RateLimiter(),
      circuitBreaker: new CircuitBreaker(),
    });
    let threw = false;
    try {
      for await (const _ of adapter.generate(req, {})) {
        void _;
      }
    } catch (err) {
      threw = true;
      expect((err as { httpStatus?: number }).httpStatus).toBe(401);
    }
    expect(threw).toBe(true);
    expect(call).toBe(1);
  });

  test("generate() throws when OPENAI_API_KEY is missing", async () => {
    const orig = process.env.OPENAI_API_KEY;
    try {
      delete process.env.OPENAI_API_KEY;
      const adapter = new OpenAiAdapter({
        modelId: "gpt-5.4",
        fetchFn: (async () => sseResponse(PLAIN_STREAM)) as unknown as typeof fetch,
      });
      let threw = false;
      try {
        for await (const _ of adapter.generate(req, {})) void _;
      } catch (err) {
        threw = true;
        expect((err as Error).message).toContain("OPENAI_API_KEY");
      }
      expect(threw).toBe(true);
    } finally {
      if (orig !== undefined) process.env.OPENAI_API_KEY = orig;
    }
  });

  test("countTokens() uses /responses/input_tokens", async () => {
    let seenUrl = "";
    const adapter = new OpenAiAdapter({
      modelId: "gpt-5.4",
      apiKey: "sk-test",
      fetchFn: (async (u: string | Request | URL) => {
        seenUrl = typeof u === "string" ? u : (u as Request).url;
        return jsonResponse({ input_tokens: 42, cached_tokens: 10 });
      }) as unknown as typeof fetch,
      rateLimiter: new RateLimiter(),
      circuitBreaker: new CircuitBreaker(),
    });
    const result = await adapter.countTokens([{ role: "user", content: "hi" }], {});
    expect(result).toEqual({ inputTokens: 42, cachedTokens: 10 });
    expect(seenUrl).toContain("/responses/input_tokens");
  });

  test("startConversation() posts to /conversations and returns an openai_conversation handle", async () => {
    let seenUrl = "";
    let seenBody: Record<string, unknown> | undefined;
    const adapter = new OpenAiAdapter({
      modelId: "gpt-5.4",
      apiKey: "sk-test",
      fetchFn: (async (u: string | Request | URL, init?: RequestInit) => {
        seenUrl = typeof u === "string" ? u : (u as Request).url;
        seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({ id: "conv_123" });
      }) as unknown as typeof fetch,
      rateLimiter: new RateLimiter(),
      circuitBreaker: new CircuitBreaker(),
    });

    const result = await adapter.startConversation({
      metadata: { session_id: "s_123", preset_id: "chat-gpt54" },
    });

    expect(seenUrl).toContain("/conversations");
    expect(seenBody).toEqual({ metadata: { session_id: "s_123", preset_id: "chat-gpt54" } });
    expect(result).toEqual({
      applicable: true,
      providerHandle: { kind: "openai_conversation", conversationId: "conv_123" },
    });
  });

  test("resume() with openai_conversation sends conversation plus delta-only input", async () => {
    let seenBody: Record<string, unknown> | undefined;
    const adapter = new OpenAiAdapter({
      modelId: "gpt-5.4",
      apiKey: "sk-test",
      fetchFn: (async (_u: string | Request | URL, init?: RequestInit) => {
        seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return sseResponse(PLAIN_STREAM);
      }) as unknown as typeof fetch,
      rateLimiter: new RateLimiter(),
      circuitBreaker: new CircuitBreaker(),
    });

    const events: StreamEvent[] = [];
    for await (const ev of adapter.resume(
      { kind: "openai_conversation", conversationId: "conv_resume" },
      {
        systemPrompt: "fresh instructions",
        messages: [{ role: "user", content: "new delta only" }],
        tools: [
          {
            name: "read_file",
            description: "Read a file",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
      },
      { effort: "high" },
    )) {
      events.push(ev);
    }

    expect(seenBody?.conversation).toBe("conv_resume");
    expect(seenBody?.store).toBe(true);
    expect(seenBody?.previous_response_id).toBeUndefined();
    expect(seenBody?.instructions).toBe("fresh instructions");
    expect(Array.isArray(seenBody?.tools)).toBe(true);
    expect(seenBody?.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "new delta only" }] },
    ]);
    const done = events.find((e) => e.type === "done");
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.providerHandle).toMatchObject({ conversationId: "conv_resume" });
    }
  });

  test("resume() with conversation-backed openai_response uses conversation only", async () => {
    let seenBody: Record<string, unknown> | undefined;
    const adapter = new OpenAiAdapter({
      modelId: "gpt-5.4",
      apiKey: "sk-test",
      fetchFn: (async (_u: string | Request | URL, init?: RequestInit) => {
        seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return sseResponse(PLAIN_STREAM);
      }) as unknown as typeof fetch,
      rateLimiter: new RateLimiter(),
      circuitBreaker: new CircuitBreaker(),
    });

    const events = await collect(
      adapter.resume(
        {
          kind: "openai_response",
          responseId: "resp_prev",
          reasoningItemsIncluded: true,
          conversationId: "conv_thread",
        },
        req,
        {},
      ),
    );

    expect(seenBody?.conversation).toBe("conv_thread");
    expect(seenBody?.previous_response_id).toBeUndefined();
    const done = events.find((e) => e.type === "done");
    expect(done?.type).toBe("done");
    if (done?.type === "done") {
      expect(done.providerHandle).toMatchObject({ conversationId: "conv_thread" });
    }
  });

  test("resume() with plain openai_response strips stale conversation option", async () => {
    let seenBody: Record<string, unknown> | undefined;
    const adapter = new OpenAiAdapter({
      modelId: "gpt-5.4",
      apiKey: "sk-test",
      fetchFn: (async (_u: string | Request | URL, init?: RequestInit) => {
        seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return sseResponse(PLAIN_STREAM);
      }) as unknown as typeof fetch,
      rateLimiter: new RateLimiter(),
      circuitBreaker: new CircuitBreaker(),
    });

    await collect(
      adapter.resume(
        {
          kind: "openai_response",
          responseId: "resp_prev",
          reasoningItemsIncluded: true,
        },
        req,
        { conversationId: "conv_stale", store: true },
      ),
    );

    expect(seenBody?.previous_response_id).toBe("resp_prev");
    expect(seenBody?.conversation).toBeUndefined();
  });

  test("compact() posts full context to /responses/compact without previous_response_id", async () => {
    let seenUrl = "";
    let seenBody: Record<string, unknown> | undefined;
    const adapter = new OpenAiAdapter({
      modelId: "gpt-5.4",
      apiKey: "sk-test",
      fetchFn: (async (u: string | Request | URL, init?: RequestInit) => {
        seenUrl = typeof u === "string" ? u : (u as Request).url;
        seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "summary" }],
            },
          ],
          summary_tokens: 12,
          replaced_range: [0, 2],
        });
      }) as unknown as typeof fetch,
      rateLimiter: new RateLimiter(),
      circuitBreaker: new CircuitBreaker(),
    });

    const request: AgentRequest = {
      systemPrompt: "stay inside repo",
      messages: [{ role: "user", content: "summarize current context" }],
      tools: [
        {
          name: "read_file",
          description: "Read a workspace file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
          },
        },
      ],
      toolChoice: { type: "auto" },
    };
    const result = await adapter.compact(
      {
        kind: "openai_response",
        responseId: "resp_prev",
        reasoningItemsIncluded: false,
        conversationId: "conv_compact",
      },
      { request, requestOptions: { effort: "high", conversationId: "conv_compact" } },
    );

    expect(seenUrl).toContain("/responses/compact");
    expect(seenBody?.model).toBe("gpt-5.4");
    expect(seenBody?.instructions).toBe("stay inside repo");
    expect(seenBody?.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "summarize current context" }] },
    ]);
    expect(Array.isArray(seenBody?.tools)).toBe(true);
    expect(seenBody?.previous_response_id).toBeUndefined();
    expect(seenBody?.conversation).toBeUndefined();
    expect(result).toMatchObject({
      applicable: true,
      summaryTokens: 12,
      replacedRange: [0, 2],
      providerHandle: { kind: "openai_compacted" },
    });
    expect(result.providerHandle?.kind).toBe("openai_compacted");
    if (result.providerHandle?.kind === "openai_compacted") {
      expect(result.providerHandle.conversationId).toBeUndefined();
    }
  });

  test("resume() with openai_compacted prepends compacted output and omits previous_response_id", async () => {
    let seenBody: Record<string, unknown> | undefined;
    const compacted = {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "prior compacted state" }],
    };
    const adapter = new OpenAiAdapter({
      modelId: "gpt-5.4",
      apiKey: "sk-test",
      fetchFn: (async (_u: string | Request | URL, init?: RequestInit) => {
        seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return sseResponse(PLAIN_STREAM);
      }) as unknown as typeof fetch,
      rateLimiter: new RateLimiter(),
      circuitBreaker: new CircuitBreaker(),
    });

    const events: StreamEvent[] = [];
    for await (const ev of adapter.resume(
      { kind: "openai_compacted", input: [compacted], reasoningItemsIncluded: true },
      req,
      { conversationId: "conv_stale_before_compact" },
    )) {
      events.push(ev);
    }

    expect(events.some((e) => e.type === "done")).toBe(true);
    expect(seenBody?.previous_response_id).toBeUndefined();
    expect(seenBody?.conversation).toBeUndefined();
    expect(seenBody?.input).toEqual([
      compacted,
      { role: "user", content: [{ type: "input_text", text: "hello" }] },
    ]);
  });

  test("resume() with openai_compacted uses only its fresh conversation id", async () => {
    let seenBody: Record<string, unknown> | undefined;
    const compacted = {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "prior compacted state" }],
    };
    const adapter = new OpenAiAdapter({
      modelId: "gpt-5.4",
      apiKey: "sk-test",
      fetchFn: (async (_u: string | Request | URL, init?: RequestInit) => {
        seenBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return sseResponse(PLAIN_STREAM);
      }) as unknown as typeof fetch,
      rateLimiter: new RateLimiter(),
      circuitBreaker: new CircuitBreaker(),
    });

    await collect(
      adapter.resume(
        {
          kind: "openai_compacted",
          input: [compacted],
          reasoningItemsIncluded: true,
          conversationId: "conv_fresh_after_compact",
        },
        req,
        { conversationId: "conv_stale_before_compact" },
      ),
    );

    expect(seenBody?.previous_response_id).toBeUndefined();
    expect(seenBody?.conversation).toBe("conv_fresh_after_compact");
    expect(seenBody?.input).toEqual([
      compacted,
      { role: "user", content: [{ type: "input_text", text: "hello" }] },
    ]);
  });

  test("capability matrix reports OpenAI flags", () => {
    const adapter = new OpenAiAdapter({
      modelId: "gpt-5.4",
      apiKey: "sk-test",
    });
    const caps = adapter.getCapabilities();
    expect(caps.providerId).toBe("openai");
    expect(caps.supportsPreviousResponseId).toBe(true);
    expect(caps.supportsPhaseMetadata).toBe(true);
  });
});
