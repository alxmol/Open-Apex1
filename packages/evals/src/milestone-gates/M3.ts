#!/usr/bin/env bun
/**
 * Milestone 3 gate — intelligence layer.
 *
 * §6 M3 exit criteria:
 *   - search outputs always include provenance and survive provider formatting
 *   - repo map + symbol lookup reduce blind file reads on local fixtures
 *   - multimodal input works in real provider requests
 *   - search-heavy slice shows non-negative net effect vs search-disabled (A/B
 *     handoff — runs outside this offline gate)
 */

import { existsSync, writeFileSync } from "node:fs";
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
    const base: MilestoneGateCheck = {
      id,
      description,
      status: r.skip ? "skip" : r.ok ? "pass" : "fail",
      durationMs: Date.now() - started,
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

  // Baseline: same as M1/M2 — the full suite + build discipline.
  checks.push(
    await runCheck("m3-bun-test", "bun test (all packages) exits 0", async () => {
      const r = await capture(["bun", "test"]);
      return {
        ok: r.code === 0,
        detail: r.code === 0 ? "all tests passed" : (r.stderr || r.stdout).slice(-600),
      };
    }),
  );
  checks.push(
    await runCheck("m3-typecheck", "bun x tsc -p tsconfig.json --noEmit exits 0", async () => {
      const r = await capture(["bun", "x", "tsc", "-p", "tsconfig.json", "--noEmit"]);
      return {
        ok: r.code === 0,
        detail: r.code === 0 ? "clean" : (r.stderr || r.stdout).slice(-600),
      };
    }),
  );
  checks.push(
    await runCheck("m3-lint", "bun run lint exits 0", async () => {
      const r = await capture(["bun", "run", "lint"]);
      return {
        ok: r.code === 0,
        detail: r.code === 0 ? "clean" : (r.stderr || r.stdout).slice(-600),
      };
    }),
  );
  checks.push(
    await runCheck("m3-format-check", "bun run format:check exits 0", async () => {
      const r = await capture(["bun", "run", "format:check"]);
      return {
        ok: r.code === 0,
        detail: r.code === 0 ? "clean" : (r.stderr || r.stdout).slice(-600),
      };
    }),
  );

  // §M3: search package (Serper + SerpAPI + normalize + contamination + extract).
  checks.push(
    await runCheck(
      "m3-search-package",
      "packages/search unit + contract tests: normalizer, ranker, extractor, contamination, run-search, render",
      async () => {
        const r = await capture(["bun", "test", "packages/search/test/"]);
        return {
          ok: r.code === 0,
          detail: r.code === 0 ? "search layer green" : (r.stderr || r.stdout).slice(-600),
        };
      },
    ),
  );

  // §M3: indexer package (repo-map + stack-detect + tree-sitter symbol index + env-probe).
  checks.push(
    await runCheck(
      "m3-indexer-package",
      "packages/indexer unit tests: language-detect, repo-map, stack-detect, symbol-index (tree-sitter), env-probe",
      async () => {
        const r = await capture(["bun", "test", "packages/indexer/test/"]);
        return {
          ok: r.code === 0,
          detail: r.code === 0 ? "indexer green" : (r.stderr || r.stdout).slice(-600),
        };
      },
    ),
  );

  // §M3: prediction phase.
  checks.push(
    await runCheck(
      "m3-prediction-phase",
      "predict(): category + key files + multimodal + risk + language/framework hints",
      async () => {
        const r = await capture(["bun", "test", "packages/core/test/prediction.test.ts"]);
        return {
          ok: r.code === 0,
          detail: r.code === 0 ? "prediction green" : (r.stderr || r.stdout).slice(-600),
        };
      },
    ),
  );

  // §M3: environment_context enrichment (prediction + repo_map sections).
  checks.push(
    await runCheck(
      "m3-environment-context",
      "renderEnvironmentContext appends prediction + repo_map sections when supplied",
      async () => {
        const r = await capture(["bun", "test", "packages/core/test/environment-context.test.ts"]);
        return {
          ok: r.code === 0,
          detail:
            r.code === 0 ? "env_context enrichment green" : (r.stderr || r.stdout).slice(-600),
        };
      },
    ),
  );

  // §M3: 5 new tools registered + behavior.
  checks.push(
    await runCheck(
      "m3-new-tools",
      "web_search + fetch_url + symbol_lookup + repo_map + read_asset tests green",
      async () => {
        const r = await capture([
          "bun",
          "test",
          "packages/tools/test/web-search.test.ts",
          "packages/tools/test/fetch-url.test.ts",
          "packages/tools/test/symbol-lookup.test.ts",
          "packages/tools/test/repo-map.test.ts",
          "packages/tools/test/read-asset.test.ts",
        ]);
        return {
          ok: r.code === 0,
          detail: r.code === 0 ? "tool surface green" : (r.stderr || r.stdout).slice(-600),
        };
      },
    ),
  );

  // §M3: provider rendering (multimodal + search_result).
  checks.push(
    await runCheck(
      "m3-provider-multimodal",
      "OpenAI input_file/input_image + Anthropic document/image/search_result rendering green",
      async () => {
        const r = await capture([
          "bun",
          "test",
          "packages/provider-openai/test/multimodal-rendering.test.ts",
          "packages/provider-anthropic/test/multimodal-rendering.test.ts",
        ]);
        return {
          ok: r.code === 0,
          detail: r.code === 0 ? "multimodal rendering green" : (r.stderr || r.stdout).slice(-600),
        };
      },
    ),
  );

  // §M3: mixed-monorepo indexer integration.
  checks.push(
    await runCheck(
      "m3-indexer-integration",
      "mixed-monorepo repo-map + symbol-index spans python + ts + rust + go",
      async () => {
        const r = await capture(["bun", "test", "packages/evals/test/indexer-integration.test.ts"]);
        return {
          ok: r.code === 0,
          detail: r.code === 0 ? "integration green" : (r.stderr || r.stdout).slice(-600),
        };
      },
    ),
  );

  // §7.6.4 contamination blocklist on disk.
  checks.push(
    await runCheck(
      "m3-contamination-blocklist",
      "packages/config/contamination-blocklist.v1.json exists with 89 TB2 task ids",
      async () => {
        const blocklistPath = path.join(
          REPO_ROOT,
          "packages/config/contamination-blocklist.v1.json",
        );
        if (!existsSync(blocklistPath)) {
          return { ok: false, detail: `missing: ${blocklistPath}` };
        }
        const json = JSON.parse(await Bun.file(blocklistPath).text()) as {
          schema_version: string;
          denied_task_ids: string[];
        };
        if (json.schema_version !== "1") {
          return { ok: false, detail: `wrong schema_version: ${json.schema_version}` };
        }
        if (!Array.isArray(json.denied_task_ids) || json.denied_task_ids.length !== 89) {
          return {
            ok: false,
            detail: `expected 89 task ids, got ${json.denied_task_ids?.length ?? "n/a"}`,
          };
        }
        return { ok: true, detail: `blocklist ok (89 task ids)`, artifactPath: blocklistPath };
      },
    ),
  );

  // §M3 fixtures: docs-image-pdf + mixed-monorepo exist and reset cleanly.
  checks.push(
    await runCheck(
      "m3-fixtures",
      "docs-image-pdf (canary.png + canary.pdf + reset.sh) + mixed-monorepo (python/ts/rust/go) scaffolded",
      async () => {
        const required: Array<[string, string]> = [
          ["packages/evals/fixtures/docs-image-pdf", "canary.png"],
          ["packages/evals/fixtures/docs-image-pdf", "canary.pdf"],
          ["packages/evals/fixtures/docs-image-pdf", "reset.sh"],
          ["packages/evals/fixtures/docs-image-pdf", "expected.json"],
          ["packages/evals/fixtures/mixed-monorepo", "Makefile"],
          ["packages/evals/fixtures/mixed-monorepo/python", "pyproject.toml"],
          ["packages/evals/fixtures/mixed-monorepo/ts", "tsconfig.json"],
          ["packages/evals/fixtures/mixed-monorepo/rust", "Cargo.toml"],
          ["packages/evals/fixtures/mixed-monorepo/go", "go.mod"],
          ["packages/evals/fixtures/mixed-monorepo", "reset.sh"],
        ];
        const missing: string[] = [];
        for (const [dir, file] of required) {
          if (!existsSync(path.join(REPO_ROOT, dir, file))) missing.push(`${dir}/${file}`);
        }
        return {
          ok: missing.length === 0,
          detail:
            missing.length === 0 ? "both fixtures scaffolded" : `missing: ${missing.join(", ")}`,
        };
      },
    ),
  );

  // §M3 presets bumped to r2 with new enabled flags.
  checks.push(
    await runCheck(
      "m3-preset-revisions",
      "tb2-gpt54 / tb2-sonnet46 / tb2-opus46 / tb2-opus47 at revision r2 with M3 enabled flags",
      async () => {
        const presetFiles = [
          "tb2-gpt54.json",
          "tb2-sonnet46.json",
          "tb2-opus46.json",
          "tb2-opus47.json",
        ];
        const misses: string[] = [];
        for (const f of presetFiles) {
          const p = path.join(REPO_ROOT, "packages/config/presets", f);
          if (!existsSync(p)) {
            misses.push(`${f} missing`);
            continue;
          }
          const preset = JSON.parse(await Bun.file(p).text()) as {
            revision?: string;
            enabled?: Record<string, boolean>;
          };
          if (preset.revision !== "r2") {
            misses.push(`${f} revision != r2`);
          }
          const required = ["prediction", "repoMap", "symbolIndex", "webSearch", "readAsset"];
          for (const k of required) {
            if (preset.enabled?.[k] !== true) misses.push(`${f} enabled.${k} != true`);
          }
        }
        return {
          ok: misses.length === 0,
          detail: misses.length === 0 ? "all four presets at r2" : misses.join("; "),
        };
      },
    ),
  );

  // Live canaries (gated on RUN_LIVE + keys).
  const runLive = process.env.RUN_LIVE === "1";
  const openaiKey = !!process.env.OPENAI_API_KEY;
  const anthropicKey = !!process.env.ANTHROPIC_API_KEY;
  const serperKey = !!process.env.SERPER_API_KEY;
  const serpApiKey = !!(process.env.SERP_API_KEY ?? process.env.SERPAPI_KEY);

  checks.push(
    await runCheck("m3-live-openai-multimodal", "OpenAI multimodal canary green", async () => {
      if (!runLive || !openaiKey) {
        return {
          ok: true,
          skip: true,
          detail: "RUN_LIVE or OPENAI_API_KEY not set; run `RUN_LIVE=1 bun run canaries:openai`",
        };
      }
      const report = await runCanaryMatrix({ only: ["openai-multimodal-image-pdf"] });
      return {
        ok: report.failed === 0,
        detail: `${report.passed} pass, ${report.failed} fail, ${report.skipped} skip`,
      };
    }),
  );
  checks.push(
    await runCheck(
      "m3-live-anthropic-multimodal-and-search-result",
      "Anthropic multimodal + search_result canaries green",
      async () => {
        if (!runLive || !anthropicKey) {
          return {
            ok: true,
            skip: true,
            detail:
              "RUN_LIVE or ANTHROPIC_API_KEY not set; run `RUN_LIVE=1 bun run canaries:anthropic`",
          };
        }
        const report = await runCanaryMatrix({
          only: ["anthropic-multimodal-image-pdf", "anthropic-search-result-block"],
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
      "m3-live-search",
      "Serper live + SerpAPI AI Overview canaries green",
      async () => {
        if (!runLive || (!serperKey && !serpApiKey)) {
          return {
            ok: true,
            skip: true,
            detail:
              "RUN_LIVE or SERPER_API_KEY / SERP_API_KEY not set; run `RUN_LIVE=1 bun run test:live:search`",
          };
        }
        const report = await runCanaryMatrix({
          only: ["search-serper-live", "search-serpapi-ai-overview"],
        });
        return {
          ok: report.failed === 0,
          detail: `${report.passed} pass, ${report.failed} fail, ${report.skipped} skip`,
        };
      },
    ),
  );

  // A/B search-heavy handoff for tb2-slice-search-heavy (user-gated).
  checks.push(
    await runCheck(
      "m3-ab-search-heavy-handoff",
      "TB2 A/B handoff: compare search-enabled vs search-disabled on tb2-slice-search-heavy",
      async () => {
        const handoff = [
          "",
          "A/B search-heavy benchmark is user-gated. For each preset run:",
          "  Baseline (search off):",
          "    harbor run -d terminal-bench@2.0 \\",
          "      --include-task-names <tb2-slice-search-heavy ids> \\",
          "      --agent-import-path open_apex_agent:OpenApexAgent \\",
          "      --agent-kwarg preset=<tb2-gpt54|tb2-sonnet46|tb2-opus46> \\",
          "      --ae OPEN_APEX_FORCE_SEARCH_OFF=1 \\",
          "      --ae OPENAI_API_KEY=$OPENAI_API_KEY --ae ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY",
          "",
          "  Search-on (default):",
          "    harbor run -d terminal-bench@2.0 --include-task-names <same ids> \\",
          "      --agent-import-path open_apex_agent:OpenApexAgent \\",
          "      --agent-kwarg preset=<same preset> \\",
          "      --ae OPENAI_API_KEY=$OPENAI_API_KEY --ae ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \\",
          "      --ae SERPER_API_KEY=$SERPER_API_KEY --ae SERP_API_KEY=$SERP_API_KEY",
          "",
          "Paste both artifact bundles back; M3 scored when search-on ≥ search-off.",
          "",
        ].join("\n");
        return { ok: true, skip: true, detail: handoff };
      },
    ),
  );

  // Harbor smoke hand-off (same as M2).
  checks.push(
    await runCheck(
      "m3-harbor-smoke-handoff",
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
          "    --ae OPENAI_API_KEY=$OPENAI_API_KEY --ae ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \\",
          "    --ae SERPER_API_KEY=$SERPER_API_KEY --ae SERP_API_KEY=$SERP_API_KEY",
          "",
          "Paste the resulting artifact paths back; M3 commit happens after smoke is green.",
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
    milestone: "M3",
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
  const artifactPath = milestoneGateResultPath("M3");
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
}

void main();
