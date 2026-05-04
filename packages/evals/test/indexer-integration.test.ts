/**
 * §M3 integration: repo-map + symbol-index on the mixed-monorepo fixture.
 *
 * Asserts the indexer produces at-least-expected symbol counts per language
 * so drift is caught before it regresses solve-rate on benchmark runs.
 */

import { describe, expect, test } from "bun:test";
import * as path from "node:path";

import { buildRepoMap, detectStack } from "@open-apex/indexer";
import {
  createEmptySymbolIndex,
  findSymbols,
  indexBatch,
  SYMBOL_INDEXABLE_LANGUAGES,
  symbolIndexStats,
} from "@open-apex/indexer";

const FIXTURE = path.resolve(import.meta.dir, "..", "fixtures", "mixed-monorepo");

describe("mixed-monorepo: repo-map + stack detection", () => {
  test("detects python, typescript, rust, go", async () => {
    const map = await buildRepoMap({ workspace: FIXTURE });
    expect(map.languageCounts.python).toBeGreaterThan(0);
    expect(map.languageCounts.typescript).toBeGreaterThan(0);
    expect(map.languageCounts.rust).toBeGreaterThan(0);
    expect(map.languageCounts.go).toBeGreaterThan(0);
    const stack = detectStack(FIXTURE, map);
    expect(stack.languages).toContain("python");
    expect(stack.languages).toContain("typescript");
    expect(stack.languages).toContain("rust");
    expect(stack.languages).toContain("go");
    expect(stack.buildSystems).toContain("make");
  });
});

describe("mixed-monorepo: symbol-index cross-language", () => {
  test("indexes Orchestrator (Py), Gateway (TS), Pipeline (Rust), Scheduler (Go)", async () => {
    const map = await buildRepoMap({ workspace: FIXTURE });
    const candidates = map.files
      .filter(
        (f) =>
          f.language !== undefined &&
          (SYMBOL_INDEXABLE_LANGUAGES as readonly string[]).includes(f.language),
      )
      .map((f) => f.path);
    const idx = createEmptySymbolIndex(FIXTURE);
    await indexBatch(idx, candidates);
    const stats = symbolIndexStats(idx);
    expect(stats.symbolCount).toBeGreaterThan(5);
    // Per-language lookups.
    expect(findSymbols(idx, "Orchestrator", { kind: "class" })[0]?.language).toBe("python");
    expect(findSymbols(idx, "Gateway", { kind: "class" })[0]?.language).toBe("typescript");
    expect(findSymbols(idx, "Pipeline", { kind: "struct" })[0]?.language).toBe("rust");
    // Go scheduler is a type_spec with @name.type capture.
    expect(findSymbols(idx, "Scheduler", { language: "go" })[0]?.name).toBe("Scheduler");
    // Cross-language helper names.
    expect(findSymbols(idx, "compute_total")[0]?.name).toBe("compute_total");
    expect(findSymbols(idx, "ComputeTotal")[0]?.language).toBe("go");
  });
});
