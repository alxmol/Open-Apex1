/**
 * Orchestration contracts.
 * Locked per §3.4.3.
 *
 * These are the glue between predict → gather → synthesize → execute →
 * validate → recover or finish. Every phase produces one of these; the
 * orchestrator never moves forward on loose prompt text.
 */

import type { SubagentRole, ValidatorCandidate } from "../subagent/types.ts";

// ─── Prediction ───────────────────────────────────────────────────────────────

export type TaskCategory =
  | "software_engineering"
  | "system_administration"
  | "scientific_computing"
  | "security"
  | "data_science"
  | "debugging"
  | "file_operations"
  | "mathematics"
  | "model_training"
  | "data_processing"
  | "machine_learning"
  | "games"
  | "personal_assistant"
  | "optimization"
  | "data_querying"
  | "video_processing"
  | "other";

export interface PredictionResult {
  taskCategory: TaskCategory;
  /** File paths mentioned in the instruction. */
  keyFiles: string[];
  multimodalNeeded: boolean;
  riskProfile: "low" | "medium" | "high";
  likelyLanguages: string[];
  likelyFrameworks: string[];
  notes: string;
}

// ─── Synthesis output: ExecutionContext ───────────────────────────────────────

export interface EvidenceRef {
  /** Subagent role the fact came from; `task` when user-supplied. */
  sourceRole: SubagentRole | "task" | "prediction";
  /** Pointer into gather-phase artifacts. */
  artifactPath?: string;
  /** Human-readable summary of what the evidence shows. */
  quote: string;
}

export interface PlanStep {
  id: string;
  description: string;
  preconditions: string[];
  expectedOutcome: string;
  validatorHook?: string;
}

export interface ExecutionContext {
  chosenApproach: string;
  prioritizedFacts: string[];
  executionPlan: PlanStep[];
  filesToInspect: string[];
  filesToChange: string[];
  validators: ValidatorCandidate[];
  riskGuards: string[];
  searchPivotHooks: string[];
  completionChecklist: string[];
  evidenceRefs: EvidenceRef[];
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * §M4 / §3.4.3 validatorStatus taxonomy.
 *   - pass: exit 0, validator ran to completion.
 *   - fail: non-zero exit, real-code failure; routes to exit 1 `task_failure`.
 *   - crash: SIGKILL/SIGTERM/SIGSEGV/timeout/missing interpreter/spawn failure/
 *     exit 137 OOM. Validator itself broken or environmental; routes to exit 2
 *     `validation_unknown`, NEVER 1.
 *   - noop: exit 0 but output matches "didn't actually validate" pattern
 *     (`pytest` `collected 0 items`, `cargo test` "no test targets", etc.).
 *     Routes to exit 2 `validation_unknown`.
 */
export type ValidatorStatus = "pass" | "fail" | "crash" | "noop";

export type CrashReason =
  | "timeout"
  | "missing_interpreter"
  | "signal"
  | "nonzero_exit_137_oom"
  | "spawn_failed"
  | "other";

export interface ValidatorRun {
  validator: ValidatorCandidate;
  validatorStatus: ValidatorStatus;
  /** null when crash (e.g., SIGKILL before exit). */
  exitCode: number | null;
  /** POSIX signal name (e.g., "SIGKILL") when killed by timeout/signal. */
  signal: string | null;
  /** Last ~8 KB of captured output. */
  stdoutTail: string;
  stderrTail: string;
  wallMs: number;
  crashReason?: CrashReason;
}

export interface ValidationResult {
  /** True iff every validator in validatorsRun had status === "pass". */
  passed: boolean;
  validatorsRun: ValidatorRun[];
  /** Empty iff passed === true. */
  incompleteReasons: string[];
}

// ─── Recovery engine (§M4 §7.6.3) ─────────────────────────────────────────────

export type FailureClass =
  | "syntax_error"
  | "import_error"
  | "path_not_found"
  | "permission_denied"
  | "connection_timeout"
  | "test_failure"
  | "validation_failure"
  | "patch_apply_failed"
  | "heredoc_malformed"
  | "stuck_command"
  | "search_failures"
  | "repeated_failures_same_approach";

export interface FailureReport {
  class: FailureClass;
  seenCountsByClass: Partial<Record<FailureClass, number>>;
  eventLogRefs: string[];
  summary: string;
}

export type RecoveryDecision =
  | { action: "local_fix"; prompt: string; targetFiles: string[] }
  | {
      action: "checkpoint_restore";
      commitSha: string;
      reason: string;
    }
  | {
      action: "re_explore";
      queries: string[];
      roles: SubagentRole[];
    }
  | {
      action: "alternative_approach";
      fromExecutionContextAlternative: number;
    }
  | { action: "give_up"; structuredFailure: FailureReport };

// ─── Completion ───────────────────────────────────────────────────────────────

export type CompletionStatus =
  | "success"
  | "task_failure"
  | "validation_unknown"
  | "runtime_failure";

export interface CompletionDecision {
  status: CompletionStatus;
  validation: ValidationResult;
  artifactPaths: string[];
  checkpointCount: number;
  finalSummary: string;
}
