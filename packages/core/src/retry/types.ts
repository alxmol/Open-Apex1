/**
 * Retry-layer contracts.
 * Locked per §1.2 Provider API retry policy.
 */

export type Jitter = "full" | "decorrelated" | "none";

export interface RetryPolicy {
  readonly initialDelayMs: number; // default 1000
  readonly maxDelayMs: number; // default 60000
  readonly maxRetries: number; // default 5
  readonly baseMultiplier: number; // default 2 (exponential base)
  readonly jitter: Jitter; // default "decorrelated"

  classify(error: unknown): RetryDecision;
  nextDelayMs(attempt: number, retryAfterHeaderMs?: number): number;
  execute<T>(
    fn: (attempt: number) => Promise<T>,
    opts?: { signal?: AbortSignal; onRetry?: (e: RetryEvent) => void },
  ): Promise<T>;
}

export type RetryDecision =
  | { retry: true; reason: string; retryAfterMs?: number }
  | { retry: false; reason: string };

export interface RetryEvent {
  attempt: number;
  delayMs: number;
  reason: string;
  error: unknown;
}

/**
 * Shape of HTTP-level errors the retry layer classifies. Adapters wrap their
 * transport errors in this envelope so the classifier is provider-neutral.
 */
export interface HttpError {
  httpStatus: number;
  /** Provider-native error code (e.g., OpenAI "rate_limit_exceeded"). */
  providerCode?: string;
  /** Raw response body for diagnostics. */
  rawMessage?: string;
  /** Retry-After header value (seconds OR HTTP-date; parsed to ms here). */
  retryAfterMs?: number;
  /** If true, treat as retryable regardless of status (e.g., network errors). */
  transient?: boolean;
  /** Original error (network exception, abort, etc.). */
  cause?: unknown;
  /** Tag for known-failure fingerprinting (e.g., "openai_no_tool_output"). */
  knownFailure?: "openai_no_tool_output";
}

/** Type guard used by adapter code. */
export function isHttpError(e: unknown): e is HttpError {
  return (
    typeof e === "object" &&
    e !== null &&
    "httpStatus" in e &&
    typeof (e as { httpStatus: unknown }).httpStatus === "number"
  );
}
