#!/usr/bin/env bun
/**
 * Milestone 5 gate — session management, GPT context-management, slash
 * commands, and background jobs.
 *
 * This gate intentionally never runs Harbor or Terminal-Bench. Benchmark work
 * remains a user-gated handoff after M5 product/session stability is green.
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

export async function runM5Gate(): Promise<MilestoneGateResult> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const checks: MilestoneGateCheck[] = [];

  for (const [id, description, argv] of [
    ["m5-bun-test", "bun test exits 0", ["bun", "test", "--timeout", "60000"]],
    [
      "m5-typecheck",
      "bun x tsc -p tsconfig.json --noEmit exits 0",
      ["bun", "x", "tsc", "-p", "tsconfig.json", "--noEmit"],
    ],
    ["m5-lint", "bun run lint exits 0", ["bun", "run", "lint"]],
    ["m5-format-check", "bun run format:check exits 0", ["bun", "run", "format:check"]],
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

  for (const [id, description, files] of [
    [
      "m5-session-store",
      "JSONL + SQLite SessionStore tests green",
      ["packages/runtime/test/session-store.test.ts"],
    ],
    [
      "m5-openai-context-management",
      "OpenAI context-management request, compaction, and adapter contract tests green",
      [
        "packages/provider-openai/test/adapter.test.ts",
        "packages/provider-openai/test/request-builder.context-management.test.ts",
        "packages/provider-openai/test/sse-parser.test.ts",
      ],
    ],
    [
      "m5-gpt-continuation",
      "Turn-runner GPT continuation and stale-handle replay tests green",
      ["packages/runtime/test/turn-runner.resume-contract.test.ts"],
    ],
    [
      "m5-job-tools",
      "JobManager and background job tools tests green",
      ["packages/tools/test/jobs.test.ts"],
    ],
    [
      "m5-command-registry",
      "M5 slash command registry tests green",
      ["apps/cli/test/commands.test.ts", "apps/cli/test/chat.test.ts"],
    ],
    [
      "m5-product-preset",
      "GPT-first chat preset and config defaults are product-safe",
      ["packages/config/test/preset-loader.test.ts", "packages/config/test/config-toml.test.ts"],
    ],
    [
      "m5-product-bench",
      "Deterministic developer-product bench: crash resume, compact resume, conversations, file-state, jobs",
      [
        "apps/cli/test/commands.test.ts",
        "apps/cli/test/chat.test.ts",
        "packages/runtime/test/session-store.test.ts",
        "packages/runtime/test/turn-runner.resume-contract.test.ts",
        "packages/provider-openai/test/adapter.test.ts",
        "packages/tools/test/jobs.test.ts",
      ],
    ],
  ] as const) {
    checks.push(
      await runCheck(id, description, async () => {
        const r = await capture(["bun", "test", ...files]);
        return {
          ok: r.code === 0,
          detail: r.code === 0 ? "green" : (r.stderr || r.stdout).slice(-800),
        };
      }),
    );
  }

  checks.push(
    await runCheck(
      "m5-live-gpt-handoff",
      "live GPT continuation canaries are green when RUN_LIVE=1",
      async () => {
        if (process.env.RUN_LIVE !== "1" || !process.env.OPENAI_API_KEY) {
          return {
            ok: true,
            skip: true,
            detail: "Set RUN_LIVE=1 with OPENAI_API_KEY to run GPT M5 handoff canaries.",
          };
        }
        const report = await runCanaryMatrix({
          only: [
            "openai-previous-response-id",
            "openai-conversation-resume",
            "openai-conversation-response-resume",
            "openai-compact-continuation",
            "openai-multimodal-resume",
            "openai-allowed-tools",
            "openai-count-tokens",
            "search-serper-live",
            "search-serpapi-ai-overview",
          ],
        });
        return {
          ok: report.failed === 0,
          detail: `${report.passed} pass, ${report.failed} fail, ${report.skipped} skip`,
        };
      },
    ),
  );

  checks.push(
    await runCheck(
      "m5-tb-harbor-handoff",
      "Terminal-Bench/Harbor are never run by this gate",
      async () => ({
        ok: true,
        skip: true,
        detail: "User handoff only: run Harbor/TB after M5 gate passes.",
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
    milestone: "M5",
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
  const artifactPath = milestoneGateResultPath("M5");
  writeFileSync(artifactPath, JSON.stringify(result, null, 2) + "\n", "utf8");
  console.log(
    `\n=== Milestone 5 gate ${result.passed ? "PASSED" : "FAILED"} ===\n` +
      `pass=${summary.passed} fail=${summary.failed} skip=${summary.skipped}\n` +
      `artifact=${repoRelativeArtifactPath(artifactPath)}\n`,
  );
  return result;
}

if (import.meta.main) {
  const result = await runM5Gate();
  process.exit(result.passed ? 0 : 1);
}
