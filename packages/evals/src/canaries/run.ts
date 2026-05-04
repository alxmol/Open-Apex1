#!/usr/bin/env bun
/**
 * Canary matrix runner entrypoint.
 *   bun run packages/evals/src/canaries/run.ts
 *   RUN_LIVE=1 CANARY_FILTER=openai bun run packages/evals/src/canaries/run.ts
 *
 * Writes the full report under gates/<milestone>/canaries/.
 */

import {
  milestoneCanaryResultPath,
  repoRelativeArtifactPath,
} from "../milestone-gates/artifacts.ts";
import { formatReport, runCanaryMatrix } from "./runner.ts";

if (import.meta.main) {
  const report = await runCanaryMatrix();
  console.log(formatReport(report));
  const milestone = report.results[0]?.spec.milestone ?? "M1";
  const out = milestoneCanaryResultPath(milestone, Date.now());
  await Bun.write(out, JSON.stringify(report, null, 2) + "\n");
  console.log(`wrote ${repoRelativeArtifactPath(out)}`);
  process.exit(report.failed === 0 ? 0 : 1);
}
