#!/usr/bin/env bun
/**
 * Milestone 1 gate.
 *
 * §6 M1 exit criteria:
 *   - chat mode can answer and call tools on deterministic fixtures
 *   - autonomous mode can complete simple local fixture tasks
 *   - autonomous mode cannot report success without a validator pass
 *   - all three model presets can run benchmark smoke end to end  ← HAND-OFF
 *   - OpenAI and Anthropic live canaries for basic turn, streaming,
 *     and tool round-trip are green
 *   - artifacts are emitted and schema-valid for every run
 *
 * The TB2 smoke check (4th bullet) is implemented as a non-blocking hand-off
 * marker per user directive: M1 never runs `harbor run` itself — it prints
 * the exact command for the user to run.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { simpleTextScript, type AtifTrajectory } from "@open-apex/core";
import { MockAnthropicAdapter } from "@open-apex/provider-anthropic";
import { validateAtifTrajectory } from "@open-apex/telemetry";

import { runAutonomous } from "../../../../apps/cli/src/index.ts";
import { runCanaryMatrix } from "../canaries/runner.ts";
import { milestoneGateResultPath, REPO_ROOT, repoRelativeArtifactPath } from "./artifacts.ts";
import type { MilestoneGateCheck, MilestoneGateResult } from "./types.ts";

function nullStderr(): NodeJS.WritableStream {
  return {
    write() {
      return true;
    },
  } as unknown as NodeJS.WritableStream;
}

function tmp(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), `openapex-m1-${prefix}-`));
}

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
    const out: MilestoneGateCheck = {
      id,
      description,
      status: r.skip ? "skip" : r.ok ? "pass" : "fail",
      durationMs: Date.now() - started,
    };
    if (r.detail !== undefined) out.detail = r.detail;
    if (r.artifactPath !== undefined) out.artifactPath = r.artifactPath;
    return out;
  } catch (err) {
    return {
      id,
      description,
      status: "fail",
      detail: `threw: ${(err as Error).message}`,
      durationMs: Date.now() - started,
    };
  }
}

export async function runM1Gate(): Promise<MilestoneGateResult> {
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const checks: MilestoneGateCheck[] = [];

  // Inherit M0 discipline checks.
  checks.push(
    await runCheck(
      "m1-bun-test",
      "bun test (mock + contract tests across all packages) exits 0",
      async () => {
        // 60s timeout covers live-adapter smoke tests when RUN_LIVE=1.
        const r = await capture(["bun", "test", "--timeout", "60000"]);
        return {
          ok: r.code === 0,
          detail: r.code === 0 ? "all tests passed" : r.stderr.slice(-1500),
        };
      },
    ),
  );
  checks.push(
    await runCheck("m1-typecheck", "bun x tsc -p tsconfig.json --noEmit exits 0", async () => {
      const r = await capture(["bun", "x", "tsc", "-p", "tsconfig.json", "--noEmit"]);
      return {
        ok: r.code === 0,
        detail: r.code === 0 ? "clean" : (r.stdout + r.stderr).slice(-1500),
      };
    }),
  );
  checks.push(
    await runCheck("m1-lint", "bun run lint exits 0", async () => {
      const r = await capture(["bun", "run", "lint"]);
      return {
        ok: r.code === 0,
        detail: r.code === 0 ? "clean" : (r.stdout + r.stderr).slice(-1500),
      };
    }),
  );
  checks.push(
    await runCheck("m1-format-check", "bun run format:check exits 0", async () => {
      const r = await capture(["bun", "run", "format:check"]);
      return {
        ok: r.code === 0,
        detail: r.code === 0 ? "clean" : (r.stdout + r.stderr).slice(-1500),
      };
    }),
  );

  // Autonomous-run end-to-end with a mock adapter: bundle validates clean.
  checks.push(
    await runCheck(
      "m1-autonomous-fixture-run",
      "autonomous mode drives a mock-scripted run on py-failing-tests and emits a valid bundle",
      async () => {
        const fixturePath = path.join(
          REPO_ROOT,
          "packages",
          "evals",
          "fixtures",
          "py-failing-tests",
        );
        const outDir = tmp("out");
        const taskFile = path.join(tmp("task"), "task.txt");
        writeFileSync(taskFile, "Run the tests and confirm pytest is clean.\n");
        const adapter = new MockAnthropicAdapter({
          script: simpleTextScript("I inspected the workspace and the tests pass.", "anthropic"),
        });
        const outcome = await runAutonomous(
          {
            kind: "autonomous",
            workspace: fixturePath,
            preset: "tb2-opus46",
            outputDir: outDir,
            benchmark: true,
            taskFile,
          },
          nullStderr(),
          { adapter, skipValidation: true },
        );
        const trajPath = outcome.result.artifact_paths.trajectory;
        if (!existsSync(trajPath)) return { ok: false, detail: "trajectory.json missing" };
        const t = JSON.parse(readFileSync(trajPath, "utf8")) as AtifTrajectory;
        const errs = validateAtifTrajectory(t);
        if (errs.length > 0) {
          return {
            ok: false,
            detail: errs.map((e) => `${e.path}: ${e.message}`).join("; "),
          };
        }
        // Bundle logs subpaths present (§3.4.10 inheritance from M0).
        const logsDir = outcome.result.artifact_paths.logs_dir;
        for (const sub of ["orchestrator.log", "provider.log", "tools"]) {
          if (!existsSync(path.join(logsDir, sub))) {
            return { ok: false, detail: `missing pinned log subpath: ${sub}` };
          }
        }
        return {
          ok: true,
          detail: `${t.steps.length} steps, status=${outcome.result.status}`,
          artifactPath: trajPath,
        };
      },
    ),
  );

  // Validation floor: empty workspace + no discoverable validator → validation_unknown.
  checks.push(
    await runCheck(
      "m1-validation-floor",
      "empty workspace with no validators → status=validation_unknown (exit 2) per §7.6.2",
      async () => {
        const workspace = tmp("empty-ws");
        const outDir = tmp("out");
        const taskFile = path.join(tmp("task"), "task.txt");
        writeFileSync(taskFile, "do nothing\n");
        const adapter = new MockAnthropicAdapter({
          script: simpleTextScript("done", "anthropic"),
        });
        const outcome = await runAutonomous(
          {
            kind: "autonomous",
            workspace,
            preset: "tb2-opus46",
            outputDir: outDir,
            benchmark: true,
            taskFile,
          },
          nullStderr(),
          { adapter },
        );
        const ok = outcome.exitCode === 2 && outcome.result.status === "validation_unknown";
        return {
          ok,
          detail: ok
            ? "exit=2 validation_unknown (honest-completion rule held)"
            : `expected exit=2 validation_unknown; got exit=${outcome.exitCode} status=${outcome.result.status}`,
        };
      },
    ),
  );

  // Developer golden-path scenario still green.
  checks.push(
    await runCheck(
      "m1-golden-path",
      "developer golden-path scenario still green (M0 test, guards against regressions)",
      async () => {
        const r = await capture(["bun", "test", "packages/evals/test/golden-path.test.ts"]);
        return {
          ok: r.code === 0,
          detail: r.code === 0 ? "all assertions green" : r.stderr.slice(-1500),
        };
      },
    ),
  );

  // Resume contract: fresh systemPrompt + tools on every turn 2+; delta-only
  // messages. This is the blocking check for the M1-patch smoking gun.
  checks.push(
    await runCheck(
      "m1-resume-contract",
      "ProviderAdapter.resume() carries fresh systemPrompt + tools and delta-only messages on turn 2+",
      async () => {
        const r = await capture([
          "bun",
          "test",
          "packages/runtime/test/turn-runner.resume-contract.test.ts",
          "packages/provider-openai/test/request-builder.resume.test.ts",
          "packages/provider-anthropic/test/request-builder.resume.test.ts",
        ]);
        return {
          ok: r.code === 0,
          detail: r.code === 0 ? "resume contract held" : r.stderr.slice(-1500),
        };
      },
    ),
  );

  // Aggressive hallucinated-tool recovery (benchmark-mode 3-strike loop).
  checks.push(
    await runCheck(
      "m1-hallucination-recovery",
      "3-strike hallucinated-tool recovery: nudge + tool_choice=required + runtime_failure on strike 3",
      async () => {
        const r = await capture([
          "bun",
          "test",
          "packages/runtime/test/turn-runner.recovery.test.ts",
        ]);
        return {
          ok: r.code === 0,
          detail: r.code === 0 ? "strike ladder green" : r.stderr.slice(-1500),
        };
      },
    ),
  );

  // Full §7.6.2 validator ladder (rungs 1-6).
  checks.push(
    await runCheck(
      "m1-validator-ladder",
      "full §7.6.2 validator ladder: explicit + manifest + framework + search + workspace-local + fallback",
      async () => {
        const r = await capture(["bun", "test", "packages/runtime/test/validation.test.ts"]);
        return {
          ok: r.code === 0,
          detail: r.code === 0 ? "ladder green" : r.stderr.slice(-1500),
        };
      },
    ),
  );

  // Live canaries (gated on RUN_LIVE).
  const runLive = process.env.RUN_LIVE === "1";
  const openaiKey = !!process.env.OPENAI_API_KEY;
  const anthropicKey = !!process.env.ANTHROPIC_API_KEY;
  checks.push(
    await runCheck("m1-live-openai", "OpenAI canary matrix green (§5.4)", async () => {
      if (!runLive || !openaiKey) {
        return {
          ok: true,
          skip: true,
          detail:
            "RUN_LIVE or OPENAI_API_KEY not set; run `RUN_LIVE=1 bun run canaries:openai` manually",
        };
      }
      const report = await runCanaryMatrix({ filter: "openai" });
      return {
        ok: report.failed === 0,
        detail: `${report.passed} pass, ${report.failed} fail, ${report.skipped} skip; ≈$${report.totalEstimatedCostUsd.toFixed(3)}`,
      };
    }),
  );
  checks.push(
    await runCheck("m1-live-anthropic", "Anthropic canary matrix green (§5.4)", async () => {
      if (!runLive || !anthropicKey) {
        return {
          ok: true,
          skip: true,
          detail:
            "RUN_LIVE or ANTHROPIC_API_KEY not set; run `RUN_LIVE=1 bun run canaries:anthropic` manually",
        };
      }
      const report = await runCanaryMatrix({ filter: "anthropic" });
      return {
        ok: report.failed === 0,
        detail: `${report.passed} pass, ${report.failed} fail, ${report.skipped} skip; ≈$${report.totalEstimatedCostUsd.toFixed(3)}`,
      };
    }),
  );

  // Harbor smoke hand-off — always a skip with instructions (user directive).
  checks.push(
    await runCheck(
      "m1-harbor-smoke-handoff",
      "TB2 smoke hand-off: user runs harbor run for tb2-smoke-6 on each preset",
      async () => {
        const handoff = [
          "",
          "TB2 smoke on tb2-smoke-6 is a user-gated step. Run (per preset):",
          "  harbor run -d terminal-bench@2.0 --include-task-name \\",
          "    fix-git --include-task-name configure-git-webserver \\",
          "    --include-task-name hf-model-inference --include-task-name crack-7z-hash \\",
          "    --include-task-name gcode-to-text --include-task-name overfull-hbox \\",
          "    --agent-import-path open_apex_agent:OpenApexAgent \\",
          "    --agent-kwarg preset=<tb2-gpt54|tb2-sonnet46|tb2-opus46> \\",
          "    --ae OPENAI_API_KEY=$OPENAI_API_KEY --ae ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY",
          "",
          "Paste the resulting artifact paths back; M1 commit happens after smoke is green.",
          "",
        ];
        return {
          ok: true,
          skip: true,
          detail: handoff.join("\n"),
        };
      },
    ),
  );

  const finishedAt = new Date().toISOString();
  const totalDurationMs = Date.now() - startedMs;
  const passed = checks.filter((c) => c.status === "pass").length;
  const failed = checks.filter((c) => c.status === "fail").length;
  const skipped = checks.filter((c) => c.status === "skip").length;

  return {
    schema_version: "open-apex-gate-result.v1",
    milestone: "M1",
    startedAt,
    finishedAt,
    totalDurationMs,
    passed: failed === 0,
    summary: { total: checks.length, passed, failed, skipped },
    checks,
    env: {
      cliVersion: "0.0.1",
      bunVersion: Bun.version,
      cwd: process.cwd(),
    },
  };
}

if (import.meta.main) {
  const result = await runM1Gate();
  const outPath = milestoneGateResultPath("M1");
  writeFileSync(outPath, JSON.stringify(result, null, 2) + "\n");
  console.log(`\n=== Milestone 1 gate ${result.passed ? "PASSED" : "FAILED"} ===`);
  console.log(
    `${result.summary.passed}/${result.summary.total} checks passed (${result.summary.skipped} skip, ${result.summary.failed} fail) — ${result.totalDurationMs}ms`,
  );
  for (const c of result.checks) {
    const mark = c.status === "pass" ? "✓" : c.status === "skip" ? "○" : "✗";
    console.log(`  ${mark} ${c.id} — ${c.description}`);
    if (c.detail) {
      for (const line of c.detail.split("\n")) console.log(`     ${line}`);
    }
  }
  console.log(`\ngate artifact: ${repoRelativeArtifactPath(outPath)}`);
  // Randomize unused var.
  void randomUUID;
  process.exit(result.passed ? 0 : 1);
}
