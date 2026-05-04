import { describe, expect, test } from "bun:test";

import {
  FIXTURES,
  getFixture,
  resetAllFixtures,
  resetFixture,
  SCENARIOS,
  scenariosByMilestone,
  scenariosByTag,
} from "../src/index.ts";

describe("fixture registry (§7.6.6)", () => {
  test("FIXTURES list contains the M0/M2/M3 minimum set", () => {
    expect(FIXTURES.length).toBeGreaterThanOrEqual(3);
    const ids = FIXTURES.map((f) => f.id).sort();
    // M0 baseline fixtures must always be present.
    expect(ids).toContain("infra-shell-heavy");
    expect(ids).toContain("node-lint-build-test");
    expect(ids).toContain("py-failing-tests");
    // M3 additions are expected once the milestone lands.
    expect(ids).toContain("docs-image-pdf");
    expect(ids).toContain("mixed-monorepo");
  });

  test("every fixture declares seededFailure; validators may be empty for non-benchmark fixtures", () => {
    for (const f of FIXTURES) {
      expect(f.expected.seededFailure.length).toBeGreaterThan(0);
      // Validators list is optional for M3 scaffolding fixtures
      // (docs-image-pdf + mixed-monorepo have no direct validator).
      expect(Array.isArray(f.expected.validators)).toBe(true);
    }
  });

  test("getFixture returns the record for a known id, undefined otherwise", () => {
    expect(getFixture("py-failing-tests")?.id).toBe("py-failing-tests");
    expect(getFixture("nope")).toBeUndefined();
  });

  test("resetFixture on a known id returns ok=true", async () => {
    const r = await resetFixture("py-failing-tests");
    expect(r.ok).toBe(true);
    expect(r.id).toBe("py-failing-tests");
  });

  test("resetAllFixtures resets every shipped fixture", async () => {
    const reports = await resetAllFixtures();
    expect(reports.length).toBe(FIXTURES.length);
    expect(reports.every((r) => r.ok)).toBe(true);
  });
});

describe("scenario registry (§7.2)", () => {
  test("SCENARIOS list is non-empty and includes M0 gate scenarios", () => {
    const m0 = scenariosByMilestone("M0");
    expect(m0.length).toBeGreaterThanOrEqual(5);
    const ids = m0.map((s) => s.id);
    expect(ids).toContain("m0-cli-boots");
    expect(ids).toContain("m0-fixtures-reset");
    expect(ids).toContain("m0-presets-validate");
  });

  test("future-milestone scenarios are registered but marked pending", () => {
    const m2 = scenariosByMilestone("M2");
    expect(m2.length).toBeGreaterThanOrEqual(3);
    for (const s of m2) {
      expect(s.expected).toBe("pending");
    }
  });

  test("scenariosByTag('m0-gate') returns every M0 check", () => {
    const m0gate = scenariosByTag("m0-gate");
    expect(m0gate.length).toBeGreaterThan(0);
  });

  test("no duplicate scenario ids", () => {
    const ids = SCENARIOS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
