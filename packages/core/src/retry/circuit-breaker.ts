/**
 * Per-endpoint circuit breaker.
 * Locked per §1.2 Provider API retry policy — Circuit breaker.
 *
 *   "If the same endpoint fails its retry budget 3 times within 60 seconds,
 *    the retry policy opens the circuit for 30 seconds and fails fast during
 *    that window. This prevents cost runaway during provider outages."
 */

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerOptions {
  /** Failures within the sliding window that trip the breaker. Default 3. */
  failureThreshold?: number;
  /** Sliding-window size in ms for counting failures. Default 60_000. */
  windowMs?: number;
  /** How long the circuit stays open before entering half-open. Default 30_000. */
  openDurationMs?: number;
  /** Clock hook for tests. */
  now?: () => number;
}

interface EndpointState {
  failures: number[]; // timestamps (ms) within the current window
  openedAt?: number;
  state: CircuitState;
}

export class CircuitOpenError extends Error {
  constructor(
    readonly endpoint: string,
    readonly retryAtMs: number,
  ) {
    super(`circuit open for ${endpoint}; retry at ${new Date(retryAtMs).toISOString()}`);
    this.name = "CircuitOpenError";
  }
}

export class CircuitBreaker {
  private readonly failureThreshold: number;
  private readonly windowMs: number;
  private readonly openDurationMs: number;
  private readonly now: () => number;
  private readonly endpoints = new Map<string, EndpointState>();

  constructor(opts: CircuitBreakerOptions = {}) {
    this.failureThreshold = opts.failureThreshold ?? 3;
    this.windowMs = opts.windowMs ?? 60_000;
    this.openDurationMs = opts.openDurationMs ?? 30_000;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Check whether a call is allowed. Throws CircuitOpenError if the circuit
   * is open. On half-open, allows the call and transitions based on outcome.
   */
  beforeCall(endpoint: string): void {
    const state = this.getOrInit(endpoint);
    if (state.state === "open" && state.openedAt !== undefined) {
      const elapsed = this.now() - state.openedAt;
      if (elapsed >= this.openDurationMs) {
        state.state = "half_open";
        return;
      }
      throw new CircuitOpenError(endpoint, state.openedAt + this.openDurationMs);
    }
  }

  /** Record a successful call. Resets the failure count. */
  recordSuccess(endpoint: string): void {
    const state = this.getOrInit(endpoint);
    state.failures.length = 0;
    state.state = "closed";
    delete state.openedAt;
  }

  /**
   * Record a failure. If the failure threshold is exceeded within the window,
   * trip the circuit open.
   */
  recordFailure(endpoint: string): void {
    const state = this.getOrInit(endpoint);
    const now = this.now();
    state.failures.push(now);
    // Drop failures older than the window.
    const cutoff = now - this.windowMs;
    state.failures = state.failures.filter((t) => t >= cutoff);
    if (state.failures.length >= this.failureThreshold) {
      state.state = "open";
      state.openedAt = now;
    }
  }

  /** Current state of the circuit for an endpoint (for telemetry). */
  stateOf(endpoint: string): CircuitState {
    return this.endpoints.get(endpoint)?.state ?? "closed";
  }

  /** Test utility. */
  reset(): void {
    this.endpoints.clear();
  }

  private getOrInit(endpoint: string): EndpointState {
    let s = this.endpoints.get(endpoint);
    if (!s) {
      s = { failures: [], state: "closed" };
      this.endpoints.set(endpoint, s);
    }
    return s;
  }
}

/** Process-wide singleton. */
export const sharedCircuitBreaker = new CircuitBreaker();
