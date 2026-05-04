/**
 * Retry-layer tests — policy, rate limiter, circuit breaker.
 *
 * All deterministic: RNG, sleep, and clock are injected.
 */

import { describe, expect, test } from "bun:test";

import {
  CircuitBreaker,
  CircuitOpenError,
  DefaultRetryPolicy,
  RateLimiter,
  parseRetryAfterHeader,
  type HttpError,
} from "../src/retry/index.ts";

// ─── DefaultRetryPolicy ──────────────────────────────────────────────────────

describe("DefaultRetryPolicy.classify (§1.2 table)", () => {
  const p = new DefaultRetryPolicy();

  function err(httpStatus: number, extra: Partial<HttpError> = {}): HttpError {
    return { httpStatus, ...extra };
  }

  test("429 rate-limit → retry", () => {
    expect(p.classify(err(429))).toMatchObject({ retry: true });
  });

  test("408/425/500/502/503/504/520-524/529 → retry", () => {
    for (const s of [408, 425, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529]) {
      expect(p.classify(err(s)).retry).toBe(true);
    }
  });

  test("400/401/402/403/404/409/413/422 → no retry", () => {
    for (const s of [400, 401, 402, 403, 404, 409, 413, 422]) {
      const d = p.classify(err(s));
      expect(d.retry).toBe(false);
    }
  });

  test("Retry-After passed through to decision", () => {
    const d = p.classify(err(429, { retryAfterMs: 5000 }));
    expect(d).toEqual({
      retry: true,
      reason: expect.any(String),
      retryAfterMs: 5000,
    });
  });

  test("knownFailure=openai_no_tool_output → retry", () => {
    const d = p.classify({ httpStatus: 400, knownFailure: "openai_no_tool_output" });
    expect(d.retry).toBe(true);
    if (d.retry) expect(d.reason).toContain("openai_no_tool_output");
  });

  test("non-HTTP error with transient:true → retry", () => {
    expect(p.classify({ transient: true }).retry).toBe(true);
  });

  test("non-HTTP unknown error → no retry", () => {
    expect(p.classify(new Error("boom")).retry).toBe(false);
  });

  test("unknown HTTP status → no retry (safe default)", () => {
    expect(p.classify(err(999)).retry).toBe(false);
  });
});

describe("DefaultRetryPolicy.nextDelayMs / jitter", () => {
  test("decorrelated jitter stays within bounds across attempts", () => {
    let r = 0;
    const seq = [0, 0.25, 0.5, 0.75, 0.99];
    const p = new DefaultRetryPolicy({
      initialDelayMs: 1000,
      maxDelayMs: 60_000,
      baseMultiplier: 2,
      jitter: "decorrelated",
      random: () => seq[r++ % seq.length]!,
    });
    for (let i = 0; i < 5; i++) {
      const d = p.nextDelayMs(i);
      expect(d).toBeGreaterThanOrEqual(1000);
      expect(d).toBeLessThanOrEqual(60_000);
    }
  });

  test("Retry-After wins when larger than computed backoff", () => {
    const p = new DefaultRetryPolicy({
      initialDelayMs: 100,
      maxDelayMs: 60_000,
      jitter: "none",
    });
    const computed = p.nextDelayMs(0);
    const viaHeader = p.nextDelayMs(0, computed + 5000);
    expect(viaHeader).toBeGreaterThanOrEqual(computed + 5000);
  });

  test("computed wins when Retry-After is smaller", () => {
    const p = new DefaultRetryPolicy({
      initialDelayMs: 5000,
      maxDelayMs: 60_000,
      jitter: "none",
    });
    const d = p.nextDelayMs(0, 10);
    expect(d).toBeGreaterThanOrEqual(5000);
  });

  test("full jitter produces [0, envelope] values", () => {
    const p = new DefaultRetryPolicy({
      initialDelayMs: 1000,
      maxDelayMs: 60_000,
      jitter: "full",
      random: () => 0.5,
    });
    expect(p.nextDelayMs(3)).toBeLessThanOrEqual(8000); // envelope = 1000*2^3
  });

  test("none jitter is deterministic exponential", () => {
    const p = new DefaultRetryPolicy({
      initialDelayMs: 1000,
      maxDelayMs: 60_000,
      jitter: "none",
    });
    expect(p.nextDelayMs(0)).toBe(1000);
    expect(p.nextDelayMs(1)).toBe(2000);
    expect(p.nextDelayMs(2)).toBe(4000);
  });
});

describe("DefaultRetryPolicy.execute", () => {
  test("succeeds on first attempt without sleeping", async () => {
    let sleeps = 0;
    const p = new DefaultRetryPolicy({
      sleep: async () => {
        sleeps++;
      },
    });
    const result = await p.execute(async () => 42);
    expect(result).toBe(42);
    expect(sleeps).toBe(0);
  });

  test("retries a 503 then succeeds", async () => {
    let call = 0;
    const sleeps: number[] = [];
    const retried: number[] = [];
    const p = new DefaultRetryPolicy({
      initialDelayMs: 1,
      maxDelayMs: 5,
      jitter: "none",
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    const result = await p.execute(
      async () => {
        call++;
        if (call === 1) {
          const e: HttpError = { httpStatus: 503 };
          throw e;
        }
        return "ok";
      },
      { onRetry: (e) => retried.push(e.attempt) },
    );
    expect(result).toBe("ok");
    expect(call).toBe(2);
    expect(retried).toEqual([1]);
    expect(sleeps).toEqual([1]);
  });

  test("exhausts maxRetries then throws", async () => {
    const p = new DefaultRetryPolicy({
      initialDelayMs: 1,
      maxDelayMs: 2,
      maxRetries: 2,
      jitter: "none",
      sleep: async () => {},
    });
    let threw = false;
    try {
      await p.execute<void>(async () => {
        throw { httpStatus: 503 } satisfies HttpError;
      });
    } catch (err) {
      threw = true;
      expect((err as HttpError).httpStatus).toBe(503);
    }
    expect(threw).toBe(true);
  });

  test("non-retryable error is thrown immediately", async () => {
    let calls = 0;
    const p = new DefaultRetryPolicy({ sleep: async () => {} });
    await expect(
      p.execute<void>(async () => {
        calls++;
        throw { httpStatus: 400 } satisfies HttpError;
      }),
    ).rejects.toMatchObject({ httpStatus: 400 });
    expect(calls).toBe(1);
  });

  test("honors Retry-After from the error", async () => {
    const sleeps: number[] = [];
    let call = 0;
    const p = new DefaultRetryPolicy({
      initialDelayMs: 1,
      maxDelayMs: 100,
      jitter: "none",
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await p.execute(async () => {
      call++;
      if (call === 1) {
        throw { httpStatus: 429, retryAfterMs: 50 } satisfies HttpError;
      }
      return "ok";
    });
    expect(sleeps[0]).toBeGreaterThanOrEqual(50);
  });

  test("abort signal short-circuits before attempt", async () => {
    const ac = new AbortController();
    ac.abort();
    const p = new DefaultRetryPolicy({ sleep: async () => {} });
    await expect(p.execute(async () => 1, { signal: ac.signal })).rejects.toBeDefined();
  });
});

// ─── parseRetryAfterHeader ──────────────────────────────────────────────────

describe("parseRetryAfterHeader", () => {
  test("numeric seconds", () => {
    expect(parseRetryAfterHeader("30")).toBe(30_000);
    expect(parseRetryAfterHeader("0.5")).toBe(500);
  });

  test("HTTP-date in the future", () => {
    const now = Date.now();
    const future = new Date(now + 5000).toUTCString();
    const ms = parseRetryAfterHeader(future, () => now);
    expect(ms).toBeDefined();
    expect(ms!).toBeGreaterThanOrEqual(4000);
    expect(ms!).toBeLessThanOrEqual(6000);
  });

  test("HTTP-date in the past → 0", () => {
    const now = Date.now();
    const past = new Date(now - 5000).toUTCString();
    expect(parseRetryAfterHeader(past, () => now)).toBe(0);
  });

  test("empty / garbage → undefined", () => {
    expect(parseRetryAfterHeader("")).toBeUndefined();
    expect(parseRetryAfterHeader(null)).toBeUndefined();
    expect(parseRetryAfterHeader("zzz")).toBeUndefined();
  });
});

// ─── RateLimiter ─────────────────────────────────────────────────────────────

describe("RateLimiter (§1.2 proactive throttling)", () => {
  test("reserve() returns immediately when no bucket state", async () => {
    const rl = new RateLimiter();
    const t0 = Date.now();
    await rl.reserve("openai");
    expect(Date.now() - t0).toBeLessThan(50);
  });

  test("updateFromHeaders + reserve injects delay when <10% remaining", async () => {
    const sleeps: number[] = [];
    const rl = new RateLimiter({
      throttleBelow: 0.1,
      throttleDelayMs: 500,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    rl.updateFromHeaders("openai", {
      "x-ratelimit-limit-tokens": "1000000",
      "x-ratelimit-remaining-tokens": "50000", // 5%, below threshold
    });
    await rl.reserve("openai");
    expect(sleeps).toEqual([500]);
  });

  test("no delay when above threshold", async () => {
    const sleeps: number[] = [];
    const rl = new RateLimiter({
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    rl.updateFromHeaders("anthropic", {
      "anthropic-ratelimit-tokens-limit": "100000",
      "anthropic-ratelimit-tokens-remaining": "80000",
    });
    await rl.reserve("anthropic");
    expect(sleeps).toEqual([]);
  });

  test("concurrent reserves serialize their delays (not their calls)", async () => {
    const sleeps: number[] = [];
    const rl = new RateLimiter({
      throttleBelow: 0.5,
      throttleDelayMs: 10,
      sleep: async (ms) => {
        sleeps.push(ms);
        await new Promise((r) => setTimeout(r, ms));
      },
    });
    rl.updateFromHeaders("openai", {
      "x-ratelimit-limit-tokens": "100",
      "x-ratelimit-remaining-tokens": "10", // 10%
    });
    await Promise.all([rl.reserve("openai"), rl.reserve("openai"), rl.reserve("openai")]);
    expect(sleeps.length).toBe(3);
  });

  test("snapshot surfaces the last recorded bucket state", () => {
    const rl = new RateLimiter();
    rl.updateFromHeaders("openai", {
      "x-ratelimit-limit-tokens": "100",
      "x-ratelimit-remaining-tokens": "42",
    });
    const s = rl.snapshot("openai");
    expect(s?.limit).toBe(100);
    expect(s?.remaining).toBe(42);
  });

  test("parses OpenAI compact reset notation (e.g. '60ms', '1m')", () => {
    const rl = new RateLimiter({ now: () => 0 });
    rl.updateFromHeaders("openai", {
      "x-ratelimit-reset-tokens": "1m",
    });
    expect(rl.snapshot("openai")?.resetSeconds).toBe(60);
    rl.updateFromHeaders("openai", {
      "x-ratelimit-reset-tokens": "250ms",
    });
    expect(rl.snapshot("openai")?.resetSeconds).toBe(0.25);
  });
});

// ─── CircuitBreaker ─────────────────────────────────────────────────────────

describe("CircuitBreaker (§1.2 3-in-60s → open-30s)", () => {
  test("closed state allows calls, records success → reset failures", () => {
    const cb = new CircuitBreaker();
    cb.beforeCall("a");
    cb.recordSuccess("a");
    expect(cb.stateOf("a")).toBe("closed");
  });

  test("3 failures within window → open, fast-fails further calls", () => {
    let now = 0;
    const cb = new CircuitBreaker({
      failureThreshold: 3,
      windowMs: 60_000,
      openDurationMs: 30_000,
      now: () => now,
    });
    now = 0;
    cb.recordFailure("ep1");
    now = 1_000;
    cb.recordFailure("ep1");
    now = 2_000;
    cb.recordFailure("ep1");
    expect(cb.stateOf("ep1")).toBe("open");
    expect(() => cb.beforeCall("ep1")).toThrow(CircuitOpenError);
  });

  test("after openDurationMs the circuit becomes half_open on beforeCall", () => {
    let now = 0;
    const cb = new CircuitBreaker({
      failureThreshold: 2,
      windowMs: 60_000,
      openDurationMs: 30_000,
      now: () => now,
    });
    cb.recordFailure("ep1");
    now = 500;
    cb.recordFailure("ep1");
    expect(cb.stateOf("ep1")).toBe("open");
    now = 30_500;
    cb.beforeCall("ep1"); // does not throw
    expect(cb.stateOf("ep1")).toBe("half_open");
    cb.recordSuccess("ep1");
    expect(cb.stateOf("ep1")).toBe("closed");
  });

  test("failures aged out of the window don't count", () => {
    let now = 0;
    const cb = new CircuitBreaker({
      failureThreshold: 3,
      windowMs: 60_000,
      now: () => now,
    });
    cb.recordFailure("ep1"); // t=0
    now = 61_000; // outside window
    cb.recordFailure("ep1");
    cb.recordFailure("ep1");
    expect(cb.stateOf("ep1")).toBe("closed");
  });

  test("different endpoints are independent", () => {
    const cb = new CircuitBreaker({ failureThreshold: 2 });
    cb.recordFailure("a");
    cb.recordFailure("a");
    expect(cb.stateOf("a")).toBe("open");
    expect(cb.stateOf("b")).toBe("closed");
  });
});
