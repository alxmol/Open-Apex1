/**
 * Fixture registry: known fixture repos and their metadata.
 *
 * M0 ships:
 *   - py-failing-tests
 *   - node-lint-build-test
 *   - infra-shell-heavy
 *
 * Remaining fixtures from §7.6.6 land in M2/M3 as the scenarios they back
 * come online:
 *   M2: recovery-malformed-patch, catastrophic-command-blocker
 *   M3: docs-image-pdf, mixed-monorepo
 *   Deferred: large-context-monorepo (M5 perf), long-running-ml (M5),
 *             flaky-validator (M4 recovery), network-restricted (M5)
 */

import * as path from "node:path";

import type { Fixture, FixtureResetReport } from "./types.ts";

const FIXTURES_ROOT = new URL("../../fixtures/", import.meta.url).pathname;

export const FIXTURES: Fixture[] = [
  {
    id: "py-failing-tests",
    description:
      "Python calculator with a seeded test failure (test_divide_by_zero expects wrong exception type).",
    rootPath: path.join(FIXTURES_ROOT, "py-failing-tests"),
    expected: {
      validators: [{ command: ["pytest"], expectedExitCode: 0 }],
      seededFailure:
        "src/calculator/__init__.py raises ArithmeticError; test expects ZeroDivisionError",
    },
    tags: ["python", "test-fix", "m2-exit-criterion"],
  },
  {
    id: "node-lint-build-test",
    description: "Node/TypeScript app with seeded eslint failure (unused import).",
    rootPath: path.join(FIXTURES_ROOT, "node-lint-build-test"),
    expected: {
      validators: [
        { command: ["bun", "run", "lint"], expectedExitCode: 0 },
        { command: ["bun", "run", "test"], expectedExitCode: 0 },
      ],
      seededFailure: "src/index.ts has an unused `path` import that trips eslint",
    },
    tags: ["typescript", "lint-fix", "m2-exit-criterion"],
  },
  {
    id: "infra-shell-heavy",
    description:
      "Bash-heavy infra fixture with seeded env-var mismatch between compose and script.",
    rootPath: path.join(FIXTURES_ROOT, "infra-shell-heavy"),
    expected: {
      validators: [{ command: ["./run-e2e.sh"], expectedExitCode: 0 }],
      seededFailure: "docker-compose.yml sets DB_NAME=app but script reads $DATABASE_NAME",
    },
    tags: ["shell", "infra", "m2-smoke"],
  },
  {
    id: "docs-image-pdf",
    description:
      "Tiny multimodal fixture (1×1 PNG + minimal PDF with OPEN-APEX-CANARY sentinel). Feeds §M3 multimodal canaries.",
    rootPath: path.join(FIXTURES_ROOT, "docs-image-pdf"),
    expected: {
      validators: [],
      seededFailure: "none (multimodal fixture; assertions live in canaries)",
    },
    tags: ["multimodal", "m3-canary"],
  },
  {
    id: "mixed-monorepo",
    description:
      "Small multi-language tree (python + ts + rust + go) exercising §M3 repo-map + tree-sitter symbol index.",
    rootPath: path.join(FIXTURES_ROOT, "mixed-monorepo"),
    expected: {
      validators: [],
      seededFailure: "none (indexer integration fixture)",
    },
    tags: ["indexer", "m3-integration"],
  },
];

export function getFixture(id: string): Fixture | undefined {
  return FIXTURES.find((f) => f.id === id);
}

/**
 * Reset a fixture repo to its seeded-failure state.
 *
 * Uses the fixture's `reset.sh` if present; otherwise no-ops. This is safe
 * to invoke in CI because fixture dirs are entirely owned by the evals package.
 */
export async function resetFixture(id: string): Promise<FixtureResetReport> {
  const started = Date.now();
  const f = getFixture(id);
  if (!f) {
    return {
      id,
      ok: false,
      durationMs: Date.now() - started,
      output: `fixture '${id}' not found`,
    };
  }
  const resetScript = path.join(f.rootPath, "reset.sh");
  const exists = await Bun.file(resetScript).exists();
  if (!exists) {
    return {
      id,
      ok: true,
      durationMs: Date.now() - started,
      output: `no reset.sh at ${resetScript} (nothing to reset)`,
    };
  }
  const proc = Bun.spawn(["bash", resetScript], {
    cwd: f.rootPath,
    stdout: "pipe",
    stderr: "pipe",
  });
  await proc.exited;
  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  return {
    id,
    ok: proc.exitCode === 0,
    durationMs: Date.now() - started,
    output: (stdout + stderr).trim(),
  };
}

export async function resetAllFixtures(): Promise<FixtureResetReport[]> {
  const reports: FixtureResetReport[] = [];
  for (const f of FIXTURES) {
    reports.push(await resetFixture(f.id));
  }
  return reports;
}
