/**
 * Live canary matrix contract.
 * Locked per §5.4 Online API test strategy.
 *
 * A canary is a focused, live-API test that exercises one specific provider
 * capability from §3.6. Each canary:
 *   - declares which env key it needs (skipped otherwise)
 *   - has a budget (dollars USD) the CI circuit breaker tracks
 *   - returns a structured result (pass/fail/skip) + notes
 */

import type { GateMilestone } from "../milestone-gates/types.ts";

export interface CanarySpec {
  id: string;
  provider: "openai" | "anthropic" | "external";
  description: string;
  /** The §3.6 capability this canary covers. */
  capability: string;
  /** The milestone gate this canary most directly supports. */
  milestone: GateMilestone;
  /** Approximate dollar cost per run; caps are enforced in the runner. */
  estimatedCostUsd: number;
  run(): Promise<CanaryResult>;
}

export type CanaryOutcome = "pass" | "fail" | "skip";

export interface CanaryResult {
  outcome: CanaryOutcome;
  /** Observable evidence (response id, cache read tokens, signature length). */
  evidence?: Record<string, unknown>;
  /** Reason for failure/skip. */
  reason?: string;
  wallMs: number;
}

export interface CanaryBatchReport {
  startedAt: string;
  finishedAt: string;
  totalMs: number;
  totalEstimatedCostUsd: number;
  passed: number;
  failed: number;
  skipped: number;
  results: Array<{ spec: CanarySpec; result: CanaryResult }>;
}
