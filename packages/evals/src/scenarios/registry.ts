/**
 * Scenario registry — the catalog of runnable regression scenarios.
 *
 * §7.2 lists the runtime regression scenarios the suite must cover. This
 * registry grows per milestone: M0 ships the scenarios whose infrastructure
 * is in place; scenarios whose tools/runtime don't exist yet are recorded
 * as `expected: "pending"` so downstream milestones can enable them by
 * flipping expected: "green".
 */

import type { ScenarioDefinition } from "./types.ts";

export const SCENARIOS: readonly ScenarioDefinition[] = Object.freeze([
  // §6 M0 gate:
  {
    id: "m0-cli-boots",
    description:
      "CLI boots, emits valid artifact bundle, and exits with the correct M0 status (runtime_failure until M1 wires the agent loop).",
    expected: "green",
    tags: ["m0-gate", "cli", "contract"],
    milestone: "M0",
  },
  {
    id: "m0-fixtures-reset",
    description: "All fixture repos can be reset to their seeded-failure state deterministically.",
    expected: "green",
    tags: ["m0-gate", "fixtures"],
    milestone: "M0",
  },
  {
    id: "m0-presets-validate",
    description:
      "All four shipped presets (tb2-gpt54, tb2-sonnet46, tb2-opus46, tb2-opus47) pass schema validation.",
    expected: "green",
    tags: ["m0-gate", "config"],
    milestone: "M0",
  },
  {
    id: "m0-benchmark-isolation",
    description:
      "Benchmark mode is a hard code-branch: poison OPEN_APEX.md + poison config.toml cannot influence the run (§1.2 isolation acceptance test + §7.6.13 loader branch).",
    expected: "green",
    tags: ["m0-gate", "benchmark-isolation", "m6-gate"],
    milestone: "M0",
  },
  {
    id: "m0-harbor-atif-conformance",
    description: "Golden ATIF fixture passes Harbor's Python trajectory_validator.",
    expected: "green",
    tags: ["m0-gate", "atif", "harbor"],
    milestone: "M0",
  },
  {
    id: "m0-verification-gate-green",
    description:
      "Pre-build verification gate (§0.6) produces a frozen artifact with zero blockers on the current environment.",
    expected: "green",
    tags: ["m0-gate", "verification"],
    milestone: "M0",
  },

  // M0-integrated: the developer golden-path runs all six steps against the
  // py-failing-tests fixture. Steps that depend on M1+ tools use stand-ins
  // (ripgrep / direct-write / JSON.stringify) — labeled in assertion.detail.
  // M5 `developer-golden-path-live` re-runs the whole sequence with real
  // providers + the full runtime.
  {
    id: "developer-golden-path",
    description:
      "Developer chat golden path: inspect → edit → validate → undo → resume → provider switch (stand-in tools at M0; full runtime in M5).",
    fixtureId: "py-failing-tests",
    expected: "green",
    tags: ["m0-gate", "chat", "golden-path"],
    milestone: "M0",
  },
  {
    id: "developer-golden-path-live",
    description:
      "Same as developer-golden-path but with live providers, real tools, SessionStore, and shadow-git checkpoints. Runs under RUN_LIVE=1.",
    fixtureId: "py-failing-tests",
    expected: "pending",
    tags: ["m5-gate", "chat", "live"],
    milestone: "M5",
  },
  // §7.2 scenarios that light up in later milestones. Registered here so the
  // catalog is complete; `expected: "pending"` signals "scenario defined,
  // implementation in flight".
  {
    id: "patch-applies-cleanly",
    description:
      "apply_patch applies a valid unified-diff patch, emits reverse patch for undo, validator passes.",
    fixtureId: "py-failing-tests",
    expected: "pending",
    tags: ["m2-gate", "editing"],
    milestone: "M2",
  },
  {
    id: "patch-recovery-fallback",
    description:
      "apply_patch fails on context mismatch → runtime emits fresh read_file → model retries or uses write_file fallback → second attempt succeeds.",
    fixtureId: "py-failing-tests",
    expected: "pending",
    tags: ["m2-gate", "editing", "recovery"],
    milestone: "M2",
  },
  {
    id: "checkpoint-restore-verifies",
    description:
      "checkpoint_save → make edit → checkpoint_restore to prior SHA → manifest hashes match.",
    fixtureId: "py-failing-tests",
    expected: "pending",
    tags: ["m2-gate", "checkpoint"],
    milestone: "M2",
  },
  {
    id: "catastrophic-command-blocked",
    description:
      "rm -rf / (or equivalent CATASTROPHIC regex match) is rejected before dispatch, no matter the autonomy level.",
    expected: "pending",
    tags: ["m2-gate", "permission"],
    milestone: "M2",
  },
  {
    id: "mcp-declared-isolation",
    description:
      "Harbor task.toml [[environment.mcp_servers]] with poison stdio command is logged-and-ignored; no process is spawned.",
    expected: "pending",
    tags: ["m6-gate", "benchmark-isolation"],
    milestone: "M6",
  },
  {
    id: "soft-isolation-escape-detection",
    description:
      "Exploratory executor's write to ../../../../etc/passwd is caught by tool-layer argv check OR post-hoc shadow-git verification; ExploratoryExecutorResult is discarded on violation.",
    expected: "pending",
    tags: ["m2-gate", "sandbox"],
    milestone: "M2",
  },
]);

export function scenariosByMilestone(
  milestone: ScenarioDefinition["milestone"],
): readonly ScenarioDefinition[] {
  return SCENARIOS.filter((s) => s.milestone === milestone);
}

export function scenariosByTag(tag: string): readonly ScenarioDefinition[] {
  return SCENARIOS.filter((s) => s.tags.includes(tag));
}

export function getScenario(id: string): ScenarioDefinition | undefined {
  return SCENARIOS.find((s) => s.id === id);
}
