/**
 * Canary matrix runner.
 *
 * Runs a filtered set of canaries, reports a summary. Honors:
 *   - RUN_LIVE=1                  — required; otherwise all canaries skip
 *   - CANARY_FILTER=<substr>      — only run canaries whose id/provider/capability
 *                                   contains the substring (e.g. "openai", "anthropic",
 *                                   "cache")
 *   - CANARY_BUDGET_USD=<number>  — cap on total estimated cost; excess canaries skip
 */

import { sharedCircuitBreaker, sharedRateLimiter } from "@open-apex/core";

import { ANTHROPIC_CANARIES } from "./anthropic.ts";
import { OPENAI_CANARIES } from "./openai.ts";
import { SEARCH_CANARIES } from "./search.ts";
import type { CanaryBatchReport, CanarySpec } from "./types.ts";

export function allCanaries(): CanarySpec[] {
  return [...OPENAI_CANARIES, ...ANTHROPIC_CANARIES, ...SEARCH_CANARIES];
}

export interface RunMatrixOptions {
  filter?: string;
  budgetUsd?: number;
  only?: string[];
}

export async function runCanaryMatrix(opts: RunMatrixOptions = {}): Promise<CanaryBatchReport> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const filter = opts.filter ?? process.env.CANARY_FILTER ?? undefined;
  const budgetUsd =
    opts.budgetUsd ??
    (process.env.CANARY_BUDGET_USD ? Number.parseFloat(process.env.CANARY_BUDGET_USD) : undefined);
  const only = opts.only;

  const results: CanaryBatchReport["results"] = [];
  let spent = 0;
  let passed = 0;
  let failed = 0;
  let skipped = 0;

  for (const spec of allCanaries()) {
    if (only && !only.includes(spec.id)) continue;
    if (
      filter &&
      !spec.id.includes(filter) &&
      !spec.provider.includes(filter) &&
      !spec.capability.includes(filter)
    )
      continue;
    if (budgetUsd !== undefined && spent + spec.estimatedCostUsd > budgetUsd) {
      results.push({
        spec,
        result: {
          outcome: "skip",
          reason: `over budget (spent ${spent.toFixed(3)} + ${spec.estimatedCostUsd.toFixed(3)} > ${budgetUsd.toFixed(3)})`,
          wallMs: 0,
        },
      });
      skipped++;
      continue;
    }
    // Canaries are independent: reset the shared breaker + rate limiter so
    // a retry-storm in one canary doesn't cascade and fast-fail the rest.
    sharedCircuitBreaker.reset();
    sharedRateLimiter.reset();
    const result = await spec.run();
    spent += spec.estimatedCostUsd;
    results.push({ spec, result });
    if (result.outcome === "pass") passed++;
    else if (result.outcome === "fail") failed++;
    else skipped++;
  }

  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    totalMs: Date.now() - startedMs,
    totalEstimatedCostUsd: spent,
    passed,
    failed,
    skipped,
    results,
  };
}

/** Format a CanaryBatchReport for console output. */
export function formatReport(report: CanaryBatchReport): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(
    `=== Canary matrix: ${report.passed} pass, ${report.failed} fail, ${report.skipped} skip (≈ $${report.totalEstimatedCostUsd.toFixed(3)}, ${report.totalMs}ms) ===`,
  );
  for (const { spec, result } of report.results) {
    const mark = result.outcome === "pass" ? "✓" : result.outcome === "fail" ? "✗" : "○";
    lines.push(`  ${mark} ${spec.id} — ${spec.description} (${result.wallMs}ms)`);
    if (result.reason) lines.push(`    ${result.reason}`);
    if (result.evidence && Object.keys(result.evidence).length > 0) {
      lines.push(`    evidence: ${JSON.stringify(result.evidence)}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}
