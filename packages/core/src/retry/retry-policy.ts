/**
 * DefaultRetryPolicy — concrete §1.2 retry-policy implementation.
 *
 * - Decorrelated-jitter backoff by default:
 *     next = min(maxDelayMs, random(initialDelayMs, prev * baseMultiplier * 3))
 *   (See "Exponential Backoff And Jitter" by Marc Brooker, AWS Architecture Blog.)
 * - `Retry-After` / `retry-after` header respect (ms taken as max of computed backoff).
 * - Classification table from §1.2:
 *     408, 425, 429, 500, 502, 503, 504, 520-524, 529 → retry
 *     400, 401, 402, 403, 404, 413, 422 → do not retry
 *     409 → do not retry (conflict)
 * - Known-failure reconstruction for OpenAI
 *     `400 "No tool output found for function call"` — the caller injects this
 *     as `error.knownFailure: "openai_no_tool_output"`; we treat it as retryable
 *     so the adapter can reconstruct missing tool output or fall back to a
 *     fresh turn with previous_response_id: null.
 */

import {
  isHttpError,
  type HttpError,
  type Jitter,
  type RetryDecision,
  type RetryEvent,
  type RetryPolicy,
} from "./types.ts";

const RETRYABLE_STATUSES = new Set<number>([
  408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529,
]);

const NON_RETRYABLE_STATUSES = new Set<number>([400, 401, 402, 403, 404, 409, 413, 422]);

export interface DefaultRetryPolicyOptions {
  initialDelayMs?: number;
  maxDelayMs?: number;
  maxRetries?: number;
  baseMultiplier?: number;
  jitter?: Jitter;
  /** RNG hook for deterministic tests. Returns a value in [0, 1). */
  random?: () => number;
  /** Sleep hook for deterministic tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export class DefaultRetryPolicy implements RetryPolicy {
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly maxRetries: number;
  readonly baseMultiplier: number;
  readonly jitter: Jitter;
  private readonly random: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Carries the decorrelated-jitter `prev` delay across attempts. */
  private prevDelayMs: number;

  constructor(opts: DefaultRetryPolicyOptions = {}) {
    this.initialDelayMs = opts.initialDelayMs ?? 1000;
    this.maxDelayMs = opts.maxDelayMs ?? 60_000;
    this.maxRetries = opts.maxRetries ?? 5;
    this.baseMultiplier = opts.baseMultiplier ?? 2;
    this.jitter = opts.jitter ?? "decorrelated";
    this.random = opts.random ?? Math.random;
    this.sleep = opts.sleep ?? defaultSleep;
    this.prevDelayMs = this.initialDelayMs;
  }

  classify(error: unknown): RetryDecision {
    if (!isHttpError(error)) {
      // Non-HTTP error (network, abort, parse): retryable iff tagged transient.
      if (
        typeof error === "object" &&
        error !== null &&
        (error as { transient?: boolean }).transient === true
      ) {
        return { retry: true, reason: "transient network/transport error" };
      }
      return { retry: false, reason: "non-retryable error type" };
    }
    const e = error as HttpError;
    if (e.knownFailure === "openai_no_tool_output") {
      // §1.2 known-failure handling: retry with tool-output reconstruction.
      return {
        retry: true,
        reason: "openai_no_tool_output — reconstruct missing tool output",
      };
    }
    if (NON_RETRYABLE_STATUSES.has(e.httpStatus)) {
      return {
        retry: false,
        reason: `HTTP ${e.httpStatus} is non-retryable`,
      };
    }
    if (RETRYABLE_STATUSES.has(e.httpStatus)) {
      const decision: RetryDecision = {
        retry: true,
        reason: `HTTP ${e.httpStatus} is retryable`,
      };
      if (e.retryAfterMs !== undefined) {
        (decision as { retryAfterMs?: number }).retryAfterMs = e.retryAfterMs;
      }
      return decision;
    }
    // Unknown HTTP status: default to non-retryable to avoid runaway retries.
    return {
      retry: false,
      reason: `HTTP ${e.httpStatus} is not in the retryable set`,
    };
  }

  nextDelayMs(attempt: number, retryAfterHeaderMs?: number): number {
    const computed = this.computeJitteredDelay(attempt);
    if (retryAfterHeaderMs !== undefined && retryAfterHeaderMs > 0) {
      return Math.max(retryAfterHeaderMs, computed);
    }
    return computed;
  }

  private computeJitteredDelay(attempt: number): number {
    // Exponential envelope.
    const envelope = Math.min(
      this.maxDelayMs,
      this.initialDelayMs * this.baseMultiplier ** attempt,
    );
    switch (this.jitter) {
      case "none": {
        this.prevDelayMs = envelope;
        return envelope;
      }
      case "full": {
        // Between 0 and envelope.
        const d = this.random() * envelope;
        this.prevDelayMs = d;
        return d;
      }
      case "decorrelated": {
        // next = min(maxDelayMs, random(initialDelayMs, prev * baseMultiplier * 3))
        const low = this.initialDelayMs;
        const high = Math.max(low + 1, this.prevDelayMs * this.baseMultiplier * 3);
        const d = Math.min(this.maxDelayMs, low + this.random() * (high - low));
        this.prevDelayMs = d;
        return d;
      }
    }
  }

  async execute<T>(
    fn: (attempt: number) => Promise<T>,
    opts?: { signal?: AbortSignal; onRetry?: (e: RetryEvent) => void },
  ): Promise<T> {
    this.prevDelayMs = this.initialDelayMs;
    let attempt = 0;
    while (true) {
      if (opts?.signal?.aborted) {
        throw new RetryAbortError("aborted before attempt");
      }
      try {
        return await fn(attempt);
      } catch (err) {
        const decision = this.classify(err);
        if (!decision.retry) throw err;
        if (attempt >= this.maxRetries) {
          throw err;
        }
        const delayMs = this.nextDelayMs(attempt, decision.retryAfterMs);
        opts?.onRetry?.({
          attempt: attempt + 1,
          delayMs,
          reason: decision.reason,
          error: err,
        });
        await this.sleep(delayMs, opts?.signal);
        attempt++;
      }
    }
  }
}

export class RetryAbortError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryAbortError";
  }
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new RetryAbortError("aborted"));
      return;
    }
    const t = setTimeout(() => resolve(), ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(t);
        reject(new RetryAbortError("aborted during sleep"));
      },
      { once: true },
    );
  });
}

/**
 * Parse a Retry-After header into milliseconds.
 *   - numeric seconds  (RFC 9110): "120"           → 120_000
 *   - HTTP-date:       "Wed, 21 Oct 2015 07:28:00 GMT" → ms-until-date
 *   - returns undefined on parse failure.
 */
export function parseRetryAfterHeader(
  headerValue: string | null | undefined,
  now: () => number = Date.now,
): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  if (!trimmed) return undefined;
  // Numeric seconds.
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    const sec = Number.parseFloat(trimmed);
    if (Number.isFinite(sec) && sec >= 0) return Math.floor(sec * 1000);
  }
  // HTTP-date.
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const diff = dateMs - now();
    if (diff > 0) return diff;
    return 0;
  }
  return undefined;
}
