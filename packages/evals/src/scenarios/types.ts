/**
 * Scenario harness types.
 *
 * A scenario is a single testable behavior (patch apply → validate → undo,
 * catastrophic-command-blocked, resume-after-restart, etc.). Each scenario
 * has:
 *   - an id and description
 *   - a fixture id it runs against (or "none" for synthetic tests)
 *   - a list of assertions evaluated after the run
 *   - expected outcome: green | red | pending
 *
 * The ScenarioRunner drives the CLI/runtime under test and collects the
 * resulting assertions into a ScenarioReport.
 */

export type ScenarioExpectedOutcome = "green" | "red" | "pending";

export interface ScenarioDefinition {
  id: string;
  description: string;
  fixtureId?: string;
  expected: ScenarioExpectedOutcome;
  tags: string[];
  milestone: "M0" | "M1" | "M2" | "M3" | "M4" | "M5" | "M6" | "M7";
}

export interface ScenarioAssertion {
  name: string;
  passed: boolean;
  detail?: string;
}

export interface ScenarioReport {
  scenario: ScenarioDefinition;
  startedAt: string;
  durationMs: number;
  outcome: ScenarioExpectedOutcome;
  assertions: ScenarioAssertion[];
  notes?: string;
}
