import { describe, expect, test } from "bun:test";

import { simpleTextScript } from "@open-apex/core";
import { MockAnthropicAdapter } from "@open-apex/provider-anthropic";
import { MockOpenAiAdapter } from "@open-apex/provider-openai";

import { runDeveloperGoldenPath } from "../src/scenarios/golden-path.ts";

describe("developer-golden-path scenario (§M0 integration)", () => {
  test("all six steps assert green against py-failing-tests fixture", async () => {
    const report = await runDeveloperGoldenPath({
      makeOpenAiAdapter: () => new MockOpenAiAdapter({ script: simpleTextScript("ok", "openai") }),
      makeAnthropicAdapter: () =>
        new MockAnthropicAdapter({ script: simpleTextScript("ok", "anthropic") }),
    });
    expect(report.scenario.id).toBe("developer-golden-path");
    // Every expected step surface: fixture-reset-ok + inspect + edit + validate +
    // undo + resume + switch = 7 total assertions.
    const names = report.assertions.map((a) => a.name);
    expect(names).toContain("fixture-reset-ok");
    expect(names).toContain("inspect");
    expect(names).toContain("edit");
    expect(names).toContain("validate");
    expect(names).toContain("undo");
    expect(names).toContain("resume");
    expect(names).toContain("switch");
    // Scenario is green iff every assertion passes.
    const failed = report.assertions.filter((a) => !a.passed);
    if (failed.length > 0) {
      // Print details on failure so the diagnostic is useful.
      for (const f of failed) {
        console.error(`  FAIL ${f.name}: ${f.detail}`);
      }
    }
    expect(report.outcome).toBe("green");
  });
});
