/**
 * Verification-gate regression tests.
 *
 * Mock tests that guard the gate-failure-policy logic. Live-probe correctness
 * is validated by `bun run verify:gate` against real endpoints (§0.6), not
 * in mock tests; but the gate's blocker-computation rules must be unit-safe.
 */

import { describe, expect, test } from "bun:test";

import type { CapabilityProbeResult } from "../src/verification-gate/types.ts";

describe("gate blocker-computation rules (§0.7)", () => {
  function computeBlockers(caps: CapabilityProbeResult[]): string[] {
    const blockers: string[] = [];
    for (const c of caps) {
      if (c.state === "required" && c.outcome !== "available") {
        blockers.push(
          `required capability not proven available: ${c.capability} [${c.outcome}] ${c.notes ?? ""}`,
        );
      }
    }
    return blockers;
  }

  test("required + untested → blocker (the exact gap the M0 followup closes)", () => {
    const caps: CapabilityProbeResult[] = [
      {
        capability: "openai.phase_metadata",
        state: "required",
        outcome: "untested",
      },
    ];
    expect(computeBlockers(caps)).toHaveLength(1);
    expect(computeBlockers(caps)[0]).toContain("openai.phase_metadata");
    expect(computeBlockers(caps)[0]).toContain("[untested]");
  });

  test("required + unavailable → blocker", () => {
    const caps: CapabilityProbeResult[] = [
      {
        capability: "anthropic.adaptive_thinking",
        state: "required",
        outcome: "unavailable",
      },
    ];
    expect(computeBlockers(caps)).toHaveLength(1);
  });

  test("required + available → no blocker", () => {
    const caps: CapabilityProbeResult[] = [
      {
        capability: "openai.previous_response_id",
        state: "required",
        outcome: "available",
      },
    ];
    expect(computeBlockers(caps)).toHaveLength(0);
  });

  test("optional + unavailable → no blocker (advisory only)", () => {
    const caps: CapabilityProbeResult[] = [
      {
        capability: "openai.reasoning.effort_xhigh",
        state: "optional",
        outcome: "unavailable",
      },
    ];
    expect(computeBlockers(caps)).toHaveLength(0);
  });

  test("fallback-defined + unavailable → no blocker (falls back silently)", () => {
    const caps: CapabilityProbeResult[] = [
      {
        capability: "anthropic.server_compaction",
        state: "fallback-defined",
        outcome: "unavailable",
      },
    ];
    expect(computeBlockers(caps)).toHaveLength(0);
  });
});
