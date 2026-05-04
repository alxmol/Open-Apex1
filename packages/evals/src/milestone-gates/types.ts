/**
 * Milestone-gate result contract.
 * Locked per §6 "Per-milestone scripts live in packages/evals/src/milestone-gates/<M>.ts"
 */

export interface MilestoneGateCheck {
  id: string;
  description: string;
  status: "pass" | "fail" | "skip";
  detail?: string;
  /** Pointer to an artifact (trajectory.json, test output log, etc.). */
  artifactPath?: string;
  /** Milliseconds the check took. */
  durationMs: number;
}

export interface MilestoneGateResult {
  schema_version: "open-apex-gate-result.v1";
  milestone: "M0" | "M1" | "M2" | "M3" | "M4" | "M5" | "M6" | "M7";
  startedAt: string;
  finishedAt: string;
  totalDurationMs: number;
  passed: boolean;
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
  };
  checks: MilestoneGateCheck[];
  /** Environment context captured at gate-run time. */
  env: {
    cliVersion: string;
    bunVersion: string;
    gitSha?: string;
    cwd: string;
  };
}

export type GateMilestone = MilestoneGateResult["milestone"];
