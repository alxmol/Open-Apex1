/**
 * SSE idle-watchdog regression test.
 *
 * After the `crack-7z-hash` TB2 task hung for 15 minutes with zero SSE bytes,
 * we added a per-request watchdog that aborts the stream when no data has
 * arrived within `sseIdleTimeoutMs`. The retry layer then classifies the
 * abort as a transient 503 and retries, instead of letting Harbor kill the
 * agent externally with zero forensic data.
 *
 * These tests use a mock fetch whose ReadableStream never closes (no SSE
 * events ever). The watchdog must:
 *   1. Abort the request within the configured idle window.
 *   2. Surface a transient HttpError (retryable).
 *   3. Exhaust retries and throw cleanly — no hang.
 */

import { describe, expect, test } from "bun:test";

import type { AgentRequest, RequestOptions } from "@open-apex/core";

import { OpenAiAdapter } from "../src/adapter.ts";

/** A Response body that never emits any SSE events; lives forever unless aborted. */
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
      // Intentionally emit nothing. Stream stays open.
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("OpenAI SSE idle watchdog (§1.2 streaming-failure extension)", () => {
  test("aborts when no SSE event arrives within sseIdleTimeoutMs", async () => {
    // Track whether fetch was called, and capture the signal so the stream
    // can close cleanly on abort.
    let fetchCalls = 0;
    const fetchFn = (async (_url: string, init?: RequestInit) => {
      fetchCalls++;
      return silentSseResponse(init?.signal as AbortSignal | undefined);
    }) as typeof fetch;

    const adapter = new OpenAiAdapter({
      modelId: "gpt-5.4",
      apiKey: "sk-test",
      fetchFn,
      sseIdleTimeoutMs: 50,
      // Disable retry so the test fails fast instead of burning 50ms × maxRetries.
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
        // nothing should arrive
      }
    } catch (e) {
      err = e;
    }
    const elapsed = Date.now() - start;

    expect(err).not.toBeNull();
    expect(fetchCalls).toBe(1);
    // Watchdog should fire near the 50ms mark; allow generous upper bound
    // for CI jitter but reject "never aborted".
    expect(elapsed).toBeLessThan(5_000);
    // Error should be classified as transient so the retry layer restarts.
    const e = err as {
      transient?: boolean;
      httpStatus?: number;
      providerCode?: string;
      rawMessage?: string;
    };
    expect(e.transient).toBe(true);
    expect(e.httpStatus).toBe(503);
    expect(e.providerCode).toBe("sse_idle_timeout");
  }, 10_000);

  test("does NOT abort when stream is making progress (watchdog resets on each SSE)", async () => {
    // Stream emits one SSE event every 20ms, ten times, then `done`.
    const fetchFn = (async (_url: string, _init?: RequestInit) => {
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          for (let i = 0; i < 10; i++) {
            controller.enqueue(
              encoder.encode(
                `event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"chunk${i}"}\n\n`,
              ),
            );
            await new Promise((r) => setTimeout(r, 20));
          }
          controller.enqueue(
            encoder.encode(
              `event: response.completed\ndata: {"type":"response.completed","response":{"id":"resp_x","usage":{"input_tokens":10,"output_tokens":5}}}\n\n`,
            ),
          );
          controller.close();
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }) as typeof fetch;

    const adapter = new OpenAiAdapter({
      modelId: "gpt-5.4",
      apiKey: "sk-test",
      fetchFn,
      // 100ms idle timeout; 20ms between SSEs means watchdog must reset on
      // every event or it would fire mid-stream.
      sseIdleTimeoutMs: 100,
    });

    const events: string[] = [];
    for await (const ev of adapter.generate(
      {
        systemPrompt: "sys",
        messages: [{ role: "user", content: "go" }],
        tools: [],
      },
      {} as RequestOptions,
    )) {
      events.push(ev.type);
    }
    expect(events).toContain("text_delta");
    expect(events).toContain("done");
    expect(events.filter((t) => t === "text_delta").length).toBe(10);
  }, 10_000);
});
