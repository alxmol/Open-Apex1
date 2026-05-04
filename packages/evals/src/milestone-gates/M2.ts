#!/usr/bin/env bun
/**
 * Milestone 2 gate.
 *
 * §6 M2 exit criteria:
 *   - deterministic edit / undo / checkpoint fixture scenarios pass end to end
 *   - permission system is enforced in runtime rather than prompt-only
 *   - catastrophic-command deny path is deterministic and covered by tests
 *   - shell and git behavior is stable under benchmark smoke
 *   - baseline redaction and workspace-boundary protections are active
 *
 * The gate reuses the M1 harness scaffolding (offline/tsc/lint/format/
 * autonomous-fixture checks) plus adds M2-specific checks for the full
 * classifier, patch-recovery flow, shadow-git hash-verify, and the two
 * new fixtures. Live canaries + harbor smoke handoff carry over.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

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
    const durationMs = Date.now() - started;
    const base: MilestoneGateCheck = {
      id,
      description,
      status: r.skip ? "skip" : r.ok ? "pass" : "fail",
      durationMs,
    };
    if (r.detail !== undefined) base.detail = r.detail;
    if (r.artifactPath !== undefined) base.artifactPath = r.artifactPath;
    return base;
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

async function main(): Promise<void> {
  const checks: MilestoneGateCheck[] = [];

  // Baseline: tests + build discipline (same as M1).
  checks.push(
    await runCheck("m2-bun-test", "bun test (all packages) exits 0", async () => {
      const r = await capture(["bun", "test"]);
      return {
        ok: r.code === 0,
        detail: r.code === 0 ? "all tests passed" : (r.stderr || r.stdout).slice(-600),
      };
    }),
  );
  checks.push(
    await runCheck("m2-typecheck", "bun x tsc -p tsconfig.json --noEmit exits 0", async () => {
      const r = await capture(["bun", "x", "tsc", "-p", "tsconfig.json", "--noEmit"]);
      return {
        ok: r.code === 0,
        detail: r.code === 0 ? "clean" : (r.stderr || r.stdout).slice(-600),
      };
    }),
  );
  checks.push(
    await runCheck("m2-lint", "bun run lint exits 0", async () => {
      const r = await capture(["bun", "run", "lint"]);
      return {
        ok: r.code === 0,
        detail: r.code === 0 ? "clean" : (r.stderr || r.stdout).slice(-600),
      };
    }),
  );
  checks.push(
    await runCheck("m2-format-check", "bun run format:check exits 0", async () => {
      const r = await capture(["bun", "run", "format:check"]);
      return {
        ok: r.code === 0,
        detail: r.code === 0 ? "clean" : (r.stderr || r.stdout).slice(-600),
      };
    }),
  );

  // §M2: classifier fixtures must all pass.
  checks.push(
    await runCheck(
      "m2-classifier-fixtures",
      "\u00a77.6.1 five-tier classifier passes all fixtures (CATASTROPHIC + rule-table + composition + network + autonomy-gate)",
      async () => {
        const r = await capture([
          "bun",
          "test",
          "packages/tools/test/classifier.test.ts",
          "packages/tools/test/permissions.test.ts",
        ]);
        return {
          ok: r.code === 0,
          detail:
            r.code === 0 ? "all classifier fixtures green" : (r.stderr || r.stdout).slice(-600),
        };
      },
    ),
  );

  // §M2: scheduler wires classifier into tool-loop.
  checks.push(
    await runCheck(
      "m2-scheduler-classifier-gate",
      "tool-loop classifier gate: shell tools are classified + gated before dispatch",
      async () => {
        const r = await capture([
          "bun",
          "test",
          "packages/runtime/test/tool-loop-classifier.test.ts",
        ]);
        return {
          ok: r.code === 0,
          detail: r.code === 0 ? "classifier gate wired" : (r.stderr || r.stdout).slice(-600),
        };
      },
    ),
  );

  // §1.2: runtime-mediated patch recovery.
  checks.push(
    await runCheck(
      "m2-patch-recovery",
      "\u00a71.2 patch-failure recovery flow: synthetic read_file injected; write_file opens on second attempt; exhausted after 3 failures",
      async () => {
        const r = await capture(["bun", "test", "packages/runtime/test/patch-recovery.test.ts"]);
        return {
          ok: r.code === 0,
          detail: r.code === 0 ? "recovery ladder green" : (r.stderr || r.stdout).slice(-600),
        };
      },
    ),
  );

  // §1.2: file-state map + file_stale_read detection.
  checks.push(
    await runCheck(
      "m2-file-state-map",
      "FileStateMap records reads + detects shell-side drift; mutating tools return file_stale_read",
      async () => {
        const r = await capture(["bun", "test", "packages/runtime/test/file-state-map.test.ts"]);
        return {
          ok: r.code === 0,
          detail: r.code === 0 ? "stale detection wired" : (r.stderr || r.stdout).slice(-600),
        };
      },
    ),
  );

  // §7.6.7: full shadow-git manifest with hash-verify + mismatch rollback.
  checks.push(
    await runCheck(
      "m2-shadow-git-hash-verify",
      "\u00a77.6.7 full manifest: sha256 tree, mismatch rollback, session jsonl log, statvfs preflight, LFS exclude",
      async () => {
        const r = await capture(["bun", "test", "packages/tools/test/checkpoint.test.ts"]);
        return {
          ok: r.code === 0,
          detail: r.code === 0 ? "manifest verified" : (r.stderr || r.stdout).slice(-600),
        };
      },
    ),
  );

  // §M2: new tools (delete_file, move_file, shell_command) register and work.
  checks.push(
    await runCheck(
      "m2-new-tools",
      "delete_file + move_file + shell_command registered and integration-test green",
      async () => {
        const r = await capture(["bun", "test", "packages/tools/test/tools.integration.test.ts"]);
        return {
          ok: r.code === 0,
          detail: r.code === 0 ? "tool surface green" : (r.stderr || r.stdout).slice(-600),
        };
      },
    ),
  );

  // §M2: sandbox probe + restricted shell factory.
  checks.push(
    await runCheck(
      "m2-sandbox-scaffolding",
      "landlock probe, seatbelt detection, createRestrictedRunShell + block-list (no live consumer at M2)",
      async () => {
        const r = await capture(["bun", "test", "packages/tools/test/sandbox.test.ts"]);
        return {
          ok: r.code === 0,
          detail: r.code === 0 ? "sandbox scaffolding green" : (r.stderr || r.stdout).slice(-600),
        };
      },
    ),
  );

  // §M2: new fixtures exist and reset cleanly.
  checks.push(
    await runCheck(
      "m2-fixture-reset",
      "new fixtures (recovery-malformed-patch + catastrophic-command-blocker) have reset.sh + expected.json",
      async () => {
        const fixtures = [
          "packages/evals/fixtures/recovery-malformed-patch",
          "packages/evals/fixtures/catastrophic-command-blocker",
        ];
        const missing: string[] = [];
        for (const f of fixtures) {
          for (const n of ["reset.sh", "expected.json", "README.md"]) {
            const p = path.join(REPO_ROOT, f, n);
            if (!existsSync(p)) missing.push(`${f}/${n}`);
          }
        }
        return {
          ok: missing.length === 0,
          detail:
            missing.length === 0 ? "both fixtures scaffolded" : `missing: ${missing.join(", ")}`,
        };
      },
    ),
  );

  // §7.6.3: recovery prompt library literals are loadable.
  checks.push(
    await runCheck(
      "m2-recovery-prompts",
      "\u00a77.6.3 recovery prompt library literals load cleanly",
      async () => {
        const r = await capture(["bun", "test", "packages/core/test/recovery-prompts.test.ts"]);
        return {
          ok: r.code === 0,
          detail: r.code === 0 ? "library green" : (r.stderr || r.stdout).slice(-600),
        };
      },
    ),
  );

  // Live canaries (gated on RUN_LIVE).
  const runLive = process.env.RUN_LIVE === "1";
  const openaiKey = !!process.env.OPENAI_API_KEY;
  const anthropicKey = !!process.env.ANTHROPIC_API_KEY;
  checks.push(
    await runCheck("m2-live-openai", "OpenAI canary matrix green (\u00a75.4)", async () => {
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
    await runCheck("m2-live-anthropic", "Anthropic canary matrix green (\u00a75.4)", async () => {
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

  // Harbor smoke hand-off — user runs harbor themselves, identical to M1.
  checks.push(
    await runCheck(
      "m2-harbor-smoke-handoff",
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
          "Paste the resulting artifact paths back; M2 commit happens after smoke is green.",
          "",
        ].join("\n");
        return { ok: true, skip: true, detail: handoff };
      },
    ),
  );

  // Write the artifact.
  const startedAt = new Date().toISOString();
  const finishedAt = new Date().toISOString();
  const passed = checks.filter((c) => c.status === "pass").length;
  const failed = checks.filter((c) => c.status === "fail").length;
  const skipped = checks.filter((c) => c.status === "skip").length;
  const totalDurationMs = checks.reduce((a, c) => a + c.durationMs, 0);
  const result: MilestoneGateResult = {
    schema_version: "open-apex-gate-result.v1",
    milestone: "M2",
    startedAt,
    finishedAt,
    totalDurationMs,
    passed: failed === 0,
    summary: { total: checks.length, passed, failed, skipped },
    checks,
    env: {
      cliVersion: "0.0.1",
      bunVersion:
        (typeof Bun !== "undefined" && (Bun as { version?: string }).version) || "unknown",
      cwd: process.cwd(),
    },
  };

  const artifactPath = milestoneGateResultPath("M2");
  writeFileSync(artifactPath, JSON.stringify(result, null, 2) + "\n", "utf8");

  console.log(
    `${passed}/${checks.length} checks passed (${skipped} skip, ${failed} fail) — ${totalDurationMs}ms`,
  );
  for (const c of checks) {
    const glyph = c.status === "pass" ? "\u2713" : c.status === "fail" ? "\u2717" : "\u25CB";
    console.log(`  ${glyph} ${c.id} — ${c.description}`);
    if (c.detail) console.log(`     ${c.detail}`);
  }
  console.log("");
  console.log(`gate artifact: ${repoRelativeArtifactPath(artifactPath)}`);
  if (failed > 0) process.exit(1);

  // Silence unused import on success paths.
  void mkdtempSync;
  void tmpdir;
  void readFileSync;
}

void main();
