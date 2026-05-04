/**
 * SSE idle-watchdog regression test for Anthropic (mirrors OpenAI).
 *
 * §1.2 streaming-failures covered mid-stream drops + server_error events,
 * but zero-bytes-received was invisible. The watchdog fires after
 * sseIdleTimeoutMs of no SSE data and surfaces a transient 503 so the
 * retry layer restarts the request.
 */

import { describe, expect, test } from "bun:test";

import type { AgentRequest, RequestOptions } from "@open-apex/core";

import { AnthropicAdapter } from "../src/adapter.ts";

function silentSseResponse(abortSignal?: AbortSignal): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      if (abortSignal) {
        abortSignal.addEventListener("abort", () => {
          try {
            controller.error(new DOMException("aborted", "AbortError"));
          } catch {
            /* already closed */
          }
        });
      }
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("Anthropic SSE idle watchdog", () => {
  test("aborts when no SSE event arrives within sseIdleTimeoutMs", async () => {
    let fetchCalls = 0;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      fetchCalls++;
      return silentSseResponse(init?.signal as AbortSignal | undefined);
    }) as typeof fetch;

    const adapter = new AnthropicAdapter({
      modelId: "claude-opus-4-6",
      apiKey: "sk-ant-test",
      fetchFn,
      sseIdleTimeoutMs: 50,
      retryPolicy: {
        initialDelayMs: 0,
        maxDelayMs: 0,
        maxRetries: 0,
        baseMultiplier: 1,
        jitter: "none",
        classify: () => ({ retry: false, reason: "test" }),
        nextDelayMs: () => 0,
        async execute<T>(fn: (attempt: number) => Promise<T>): Promise<T> {
          return fn(0);
        },
      },
    });

    const req: AgentRequest = {
      systemPrompt: "sys",
      messages: [{ role: "user", content: "go" }],
      tools: [],
    };
    const start = Date.now();
    let err: unknown = null;
    try {
      for await (const _ev of adapter.generate(req, {} as RequestOptions)) {
        // no events should arrive
      }
    } catch (e) {
      err = e;
    }
    const elapsed = Date.now() - start;
    expect(err).not.toBeNull();
    expect(fetchCalls).toBe(1);
    expect(elapsed).toBeLessThan(5_000);
    const e = err as {
      transient?: boolean;
      httpStatus?: number;
      providerCode?: string;
    };
    expect(e.transient).toBe(true);
    expect(e.httpStatus).toBe(503);
    expect(e.providerCode).toBe("sse_idle_timeout");
  }, 10_000);
});
