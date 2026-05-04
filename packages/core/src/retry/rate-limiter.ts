/**
 * RateLimiter singleton.
 * Locked per §1.2 Provider API retry policy — Proactive throttling.
 *
 * Per-provider throttle state shared across concurrent requests. When a
 * response's remaining-tokens drops below 10% of the known capacity, the
 * limiter injects a 500ms preemptive delay on the NEXT `reserve()` call.
 * This flattens subagent-bursty traffic without serializing the actual
 * provider calls themselves.
 *
 * Gather-phase subagent requests therefore serialize their throttle waits
 * without serializing their actual provider calls.
 */

export type ProviderId = "openai" | "anthropic";

interface BucketSnapshot {
  /** Capacity observed from headers (max tokens per minute or equivalent). */
  limit?: number;
  /** Remaining tokens observed from the most recent response. */
  remaining?: number;
  /** Seconds until the bucket resets (from headers). */
  resetSeconds?: number;
  /** Time when the snapshot was recorded, for staleness decisions. */
  recordedAt: number;
}

/**
 * Parse headers (lower-cased) into a BucketSnapshot.
 * Accepts both OpenAI (`x-ratelimit-*`) and Anthropic (`anthropic-ratelimit-*`)
 * header conventions.
 */
function parseHeaders(
  headers: Record<string, string | null | undefined>,
  now: number,
): BucketSnapshot {
  const h: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v !== null && v !== undefined) h[k.toLowerCase()] = v;
  }
  const result: BucketSnapshot = { recordedAt: now };

  // Token-remaining headers: OpenAI + Anthropic variants.
  const remainingTokens =
    h["x-ratelimit-remaining-tokens"] ??
    h["anthropic-ratelimit-tokens-remaining"] ??
    h["anthropic-ratelimit-input-tokens-remaining"];
  if (remainingTokens !== undefined) {
    const v = Number.parseInt(remainingTokens, 10);
    if (Number.isFinite(v)) result.remaining = v;
  }
  const limitTokens =
    h["x-ratelimit-limit-tokens"] ??
    h["anthropic-ratelimit-tokens-limit"] ??
    h["anthropic-ratelimit-input-tokens-limit"];
  if (limitTokens !== undefined) {
    const v = Number.parseInt(limitTokens, 10);
    if (Number.isFinite(v)) result.limit = v;
  }
  const resetTokens =
    h["x-ratelimit-reset-tokens"] ??
    h["anthropic-ratelimit-tokens-reset"] ??
    h["anthropic-ratelimit-input-tokens-reset"];
  if (resetTokens !== undefined) {
    const parsed = parseResetValue(resetTokens, now);
    if (parsed !== undefined) result.resetSeconds = parsed;
  }
  return result;
}

/**
 * Parse a reset-time header value. OpenAI uses "6ms" / "60s" / "1m"; Anthropic
 * uses either an ISO-8601 timestamp or a numeric value. Returns seconds until
 * reset, or undefined on parse failure.
 */
function parseResetValue(raw: string, now: number): number | undefined {
  const trimmed = raw.trim();
  // OpenAI compact form: "6ms" / "60s" / "1m".
  const compact = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/.exec(trimmed);
  if (compact) {
    const n = Number.parseFloat(compact[1]!);
    const unit = compact[2]!;
    const seconds = unit === "ms" ? n / 1000 : unit === "s" ? n : unit === "m" ? n * 60 : n * 3600;
    return seconds;
  }
  // ISO-8601 timestamp.
  const t = Date.parse(trimmed);
  if (!Number.isNaN(t)) {
    const diffMs = t - now;
    return Math.max(0, diffMs / 1000);
  }
  // Numeric seconds.
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Number.parseFloat(trimmed);
  }
  return undefined;
}

export interface RateLimiterOptions {
  /** Fraction of capacity below which we start preemptively throttling. Default 0.1. */
  throttleBelow?: number;
  /** Preemptive delay in ms when below the threshold. Default 500. */
  throttleDelayMs?: number;
  /** Sleep hook for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock hook for tests. */
  now?: () => number;
}

export class RateLimiter {
  private readonly throttleBelow: number;
  private readonly throttleDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly buckets = new Map<ProviderId, BucketSnapshot>();
  /** Serial gate per provider so concurrent callers await the same delay chain. */
  private readonly chains = new Map<ProviderId, Promise<void>>();

  constructor(opts: RateLimiterOptions = {}) {
    this.throttleBelow = opts.throttleBelow ?? 0.1;
    this.throttleDelayMs = opts.throttleDelayMs ?? 500;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
  }

  /**
   * Called before firing a request. Awaits the throttle delay chain if the
   * provider's bucket is below threshold. Returns immediately otherwise.
   */
  async reserve(provider: ProviderId): Promise<void> {
    const bucket = this.buckets.get(provider);
    const prevChain = this.chains.get(provider) ?? Promise.resolve();
    const needsThrottle =
      bucket?.limit !== undefined &&
      bucket.remaining !== undefined &&
      bucket.limit > 0 &&
      bucket.remaining / bucket.limit < this.throttleBelow;
    const next = needsThrottle ? prevChain.then(() => this.sleep(this.throttleDelayMs)) : prevChain;
    // Store the new tail so subsequent reservers queue behind it.
    this.chains.set(provider, next);
    await next;
  }

  /** Update bucket state from the most recent response's headers. */
  updateFromHeaders(
    provider: ProviderId,
    headers: Record<string, string | null | undefined>,
  ): void {
    const snapshot = parseHeaders(headers, this.now());
    // Merge over the previous snapshot — a single response may not carry all fields.
    const prev = this.buckets.get(provider);
    const merged: BucketSnapshot = {
      recordedAt: snapshot.recordedAt,
    };
    if (snapshot.limit !== undefined) merged.limit = snapshot.limit;
    else if (prev?.limit !== undefined) merged.limit = prev.limit;
    if (snapshot.remaining !== undefined) merged.remaining = snapshot.remaining;
    else if (prev?.remaining !== undefined) merged.remaining = prev.remaining;
    if (snapshot.resetSeconds !== undefined) merged.resetSeconds = snapshot.resetSeconds;
    else if (prev?.resetSeconds !== undefined) merged.resetSeconds = prev.resetSeconds;
    this.buckets.set(provider, merged);
  }

  /** Expose current snapshot (testing / telemetry). */
  snapshot(provider: ProviderId): Readonly<BucketSnapshot> | undefined {
    const b = this.buckets.get(provider);
    return b ? { ...b } : undefined;
  }

  /** Test utility. */
  reset(): void {
    this.buckets.clear();
    this.chains.clear();
  }
}

/** Process-wide singleton. */
export const sharedRateLimiter = new RateLimiter();
