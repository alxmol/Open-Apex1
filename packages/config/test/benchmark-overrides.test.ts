import { describe, expect, test } from "bun:test";

import { applyOverrides, validateOverride, type BenchmarkOverride } from "../src/index.ts";

function goodOverride(partial: Partial<BenchmarkOverride> = {}): BenchmarkOverride {
  return {
    id: "bump-effort-to-max-on-repair",
    scope: ["tb2-opus46"],
    allowedFields: ["repairTurnEffort"],
    rationale:
      "Opus 4.6 supports output_config.effort:max; repair turn benefits from maximum reasoning depth.",
    evidenceRefs: ["docs/experiments/2026-04-18-repair-effort.md#results"],
    introducedAtRevision: "r1",
    reviewPoint: "M7 tuning pass",
    values: { repairTurnEffort: "max" },
    ...partial,
  };
}

describe("benchmark override validator (§1.2)", () => {
  test("good override passes", () => {
    const errs = validateOverride(goodOverride(), "tb2-opus46");
    expect(errs).toEqual([]);
  });

  test("override out of scope for requested preset rejected", () => {
    const errs = validateOverride(goodOverride({ scope: ["tb2-gpt54"] }), "tb2-opus46");
    expect(errs.some((e) => e.path === "scope")).toBe(true);
  });

  test("'all_benchmark' scope applies everywhere", () => {
    const errs = validateOverride(goodOverride({ scope: ["all_benchmark"] }), "tb2-opus47");
    expect(errs).toEqual([]);
  });

  test("values key not in allowedFields rejected", () => {
    const errs = validateOverride(
      goodOverride({
        allowedFields: ["effort"],
        values: { repairTurnEffort: "max" },
      }),
      "tb2-opus46",
    );
    expect(errs.some((e) => e.path === "values.repairTurnEffort")).toBe(true);
  });

  test("rationale with TB2 task keyword rejected as task-derived", () => {
    const errs = validateOverride(
      goodOverride({
        rationale:
          "Helps terminal-bench's fix-git task specifically because the repo has an unusual structure",
      }),
      "tb2-opus46",
    );
    expect(errs.some((e) => e.path === "rationale")).toBe(true);
  });

  test("values with task-specific object key rejected", () => {
    const evil: BenchmarkOverride = {
      ...goodOverride(),
      allowedFields: ["contextManagement"],
      values: {
        contextManagement: {
          // This would be a task-specific hint — forbidden.
          taskSolution: "step 1: reset git",
        } as never,
      },
    };
    const errs = validateOverride(evil, "tb2-opus46");
    expect(errs.some((e) => e.path.includes("taskSolution"))).toBe(true);
  });

  test("empty evidenceRefs rejected (promotion requires evidence)", () => {
    const errs = validateOverride(goodOverride({ evidenceRefs: [] }), "tb2-opus46");
    expect(errs.some((e) => e.path === "evidenceRefs")).toBe(true);
  });

  test("applyOverrides mutates preset by field path and records ids", () => {
    const preset = {
      repairTurnEffort: "high",
      contextManagement: { compactThreshold: 150000 },
    } as Record<string, unknown>;
    const result = applyOverrides(preset, [goodOverride()], "tb2-opus46");
    expect(result.applied).toEqual(["bump-effort-to-max-on-repair"]);
    expect(result.errors).toEqual([]);
    expect((result.preset as any).repairTurnEffort).toBe("max");
  });

  test("applyOverrides surfaces errors from invalid overrides (scope mismatch)", () => {
    const preset = { repairTurnEffort: "high" } as Record<string, unknown>;
    const bad = goodOverride({ scope: ["tb2-gpt54"] });
    const result = applyOverrides(preset, [bad], "tb2-opus46");
    expect(result.applied).toEqual([]);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]!.path).toContain("override[bump-effort-to-max-on-repair]");
  });
});
