#!/usr/bin/env bun
/**
 * Milestone 4 gate — full orchestrator phase engine.
 *
 * This gate intentionally never runs Terminal-Bench or Harbor. Benchmark work
 * remains a user-gated handoff after the offline/runtime/live checks pass.
 */

import { writeFileSync } from "node:fs";

import { runCanaryMatrix } from "../canaries/runner.ts";
import { milestoneGateResultPath, REPO_ROOT, repoRelativeArtifactPath } from "./artifacts.ts";
import type { MilestoneGateCheck, MilestoneGateResult } from "./types.ts";

async function capture(argv: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  const p = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", cwd: REPO_ROOT });
  await p.exited;
  const stdout = await new Response(p.stdout).text();
  const stderr = await new Response(p.stderr).text();
  return { stdout, stderr, code: p.exitCode ?? -1 };
}

async function runCheck(
  id: string,
  description: string,
  fn: () => Promise<{ ok: boolean; detail?: string; artifactPath?: string; skip?: boolean }>,
): Promise<MilestoneGateCheck> {
  const started = Date.now();
  try {
    const r = await fn();
    const check: MilestoneGateCheck = {
      id,
      description,
      status: r.skip ? "skip" : r.ok ? "pass" : "fail",
      durationMs: Date.now() - started,
    };
    if (r.detail !== undefined) check.detail = r.detail;
    if (r.artifactPath !== undefined) check.artifactPath = r.artifactPath;
    return check;
  } catch (err) {
    return {
      id,
      description,
      status: "fail",
      durationMs: Date.now() - started,
      detail: `threw: ${(err as Error).message}`,
    };
  }
}

export async function runM4Gate(): Promise<MilestoneGateResult> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const checks: MilestoneGateCheck[] = [];

  for (const [id, description, argv] of [
    ["m4-bun-test", "bun test exits 0", ["bun", "test"]],
    [
      "m4-typecheck",
      "bun x tsc -p tsconfig.json --noEmit exits 0",
      ["bun", "x", "tsc", "-p", "tsconfig.json", "--noEmit"],
    ],
    ["m4-lint", "bun run lint exits 0", ["bun", "run", "lint"]],
    ["m4-format-check", "bun run format:check exits 0", ["bun", "run", "format:check"]],
  ] as const) {
    checks.push(
      await runCheck(id, description, async () => {
        const r = await capture([...argv]);
        return {
          ok: r.code === 0,
          detail: r.code === 0 ? "clean" : (r.stderr || r.stdout).slice(-800),
        };
      }),
    );
  }

  checks.push(
    await runCheck(
      "m4-phase-engine",
      "phase engine tests cover gather/synthesis/execute",
      async () => {
        const r = await capture(["bun", "test", "packages/runtime/test/phase-engine.test.ts"]);
        return {
          ok: r.code === 0,
          detail: r.code === 0 ? "phase engine green" : (r.stderr || r.stdout).slice(-800),
        };
      },
    ),
  );

  checks.push(
    await runCheck(
      "m4-openai-structured-output",
      "OpenAI request-builder emits text.format json_schema",
      async () => {
        const r = await capture([
          "bun",
          "test",
          "packages/provider-openai/test/request-builder.test.ts",
        ]);
        return {
          ok: r.code === 0,
          detail:
            r.code === 0
              ? "OpenAI structured-output request shape green"
              : (r.stderr || r.stdout).slice(-800),
        };
      },
    ),
  );

  checks.push(
    await runCheck("m4-live-provider-handoff", "live M4 canaries are user/CI gated", async () => {
      if (process.env.RUN_LIVE !== "1") {
        return {
          ok: true,
          skip: true,
          detail:
            "Set RUN_LIVE=1 with provider keys to run OpenAI/Anthropic/Search canaries; this gate still excludes Harbor/TB.",
        };
      }
      const report = await runCanaryMatrix({
        only: [
          "openai-previous-response-id",
          "openai-allowed-tools",
          "anthropic-signature-roundtrip",
          "anthropic-multi-tool-result",
          "anthropic-search-result-block",
        ],
      });
      return {
        ok: report.failed === 0,
        detail: `${report.passed} pass, ${report.failed} fail, ${report.skipped} skip`,
      };
    }),
  );

  checks.push(
    await runCheck(
      "m4-tb-harbor-handoff",
      "Terminal-Bench/Harbor are never run by this gate",
      async () => ({
        ok: true,
        skip: true,
        detail:
          "User handoff only: after M4 gate passes, run the desired harbor/tbench slices manually and inspect artifacts.",
      }),
    ),
  );

  const summary = {
    total: checks.length,
    passed: checks.filter((c) => c.status === "pass").length,
    failed: checks.filter((c) => c.status === "fail").length,
    skipped: checks.filter((c) => c.status === "skip").length,
  };
  const result: MilestoneGateResult = {
    schema_version: "open-apex-gate-result.v1",
    milestone: "M4",
    startedAt,
    finishedAt: new Date().toISOString(),
    totalDurationMs: Date.now() - startedMs,
    passed: summary.failed === 0,
    summary,
    checks,
    env: {
      cliVersion: "0.0.1",
      bunVersion: Bun.version,
      cwd: REPO_ROOT,
    },
  };
  const artifactPath = milestoneGateResultPath("M4");
  writeFileSync(artifactPath, JSON.stringify(result, null, 2) + "\n", "utf8");
  console.log(
    `\n=== Milestone 4 gate ${result.passed ? "PASSED" : "FAILED"} ===\n` +
      `pass=${summary.passed} fail=${summary.failed} skip=${summary.skipped}\n` +
      `artifact=${repoRelativeArtifactPath(artifactPath)}\n`,
  );
  return result;
}

if (import.meta.main) {
  const result = await runM4Gate();
  process.exit(result.passed ? 0 : 1);
}
