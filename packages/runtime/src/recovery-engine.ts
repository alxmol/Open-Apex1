import {
  fillRecoveryPrompt,
  type ExecutionContext,
  type FailureClass,
  type FailureReport,
  type RecoveryDecision,
  type RecoveryPromptKey,
  type SubagentResult,
  type ValidationResult,
  type ValidatorRun,
} from "@open-apex/core";

import type { TurnRunnerResult } from "./turn-runner.ts";
import type { CompletionRouting } from "./validation/completion-policy.ts";

export interface RecoveryEngineState {
  attempts: number;
  localFixAttempts: number;
  checkpointRestores: number;
  alternativeAttempts: number;
  reExploreAttempts: number;
  seenCountsByClass: Partial<Record<FailureClass, number>>;
  restoredCheckpoints: Set<string>;
}

export interface RecoveryEngineInput {
  routing: CompletionRouting;
  validation: ValidationResult;
  executionContext: ExecutionContext;
  runResult: TurnRunnerResult;
  checkpointSha?: string;
  repeatedApproach: boolean;
  latestVerifier?: Extract<SubagentResult, { role: "verifier" }>;
  eventLogRefs?: string[];
}

export function newRecoveryEngineState(): RecoveryEngineState {
  return {
    attempts: 0,
    localFixAttempts: 0,
    checkpointRestores: 0,
    alternativeAttempts: 0,
    reExploreAttempts: 0,
    seenCountsByClass: {},
    restoredCheckpoints: new Set(),
  };
}

export const MAX_RECOVERY_ATTEMPTS = 5;

export function decideRecovery(
  state: RecoveryEngineState,
  input: RecoveryEngineInput,
): RecoveryDecision {
  // Recovery state is intentionally mutable and task-scoped. The phase engine
  // calls this after each failed validation pass; the state object remembers
  // how far up the ladder this task has already climbed.
  const failureClass = input.repeatedApproach
    ? "repeated_failures_same_approach"
    : classifyFailure(input.validation, input.runResult);
  state.seenCountsByClass[failureClass] = (state.seenCountsByClass[failureClass] ?? 0) + 1;
  state.attempts++;

  if (state.attempts > MAX_RECOVERY_ATTEMPTS) {
    return { action: "give_up", structuredFailure: buildFailureReport(state, failureClass, input) };
  }

  if (failureClass === "repeated_failures_same_approach" && state.reExploreAttempts < 1) {
    state.reExploreAttempts++;
    return {
      action: "re_explore",
      roles: ["web_researcher", "strategy_planner"],
      queries: input.executionContext.searchPivotHooks.slice(0, 3),
    };
  }
  if (
    failureClass === "repeated_failures_same_approach" &&
    state.alternativeAttempts >= 1 &&
    (!input.checkpointSha || state.restoredCheckpoints.has(input.checkpointSha))
  ) {
    return { action: "give_up", structuredFailure: buildFailureReport(state, failureClass, input) };
  }

  // Verifier findings are advisory only. They may steer the next recovery
  // action, but completion status is still decided by routeValidation() in the
  // phase engine. This keeps model judgment from overriding validator truth.
  const verifierAdvice = classifyVerifierAdvice(input.latestVerifier);
  if (verifierAdvice === "re_explore" && state.reExploreAttempts < 1) {
    state.reExploreAttempts++;
    return {
      action: "re_explore",
      roles: ["web_researcher", "strategy_planner"],
      queries: input.executionContext.searchPivotHooks.slice(0, 3),
    };
  }
  if (verifierAdvice === "alternative_approach" && state.alternativeAttempts < 1) {
    state.alternativeAttempts++;
    return {
      action: "alternative_approach",
      fromExecutionContextAlternative: 1,
    };
  }

  if (
    state.localFixAttempts >= 2 &&
    input.checkpointSha &&
    !state.restoredCheckpoints.has(input.checkpointSha)
  ) {
    // Restore only once per checkpoint. If the next attempts fail, move up the
    // ladder instead of bouncing between the same snapshot and same local fix.
    state.checkpointRestores++;
    state.restoredCheckpoints.add(input.checkpointSha);
    return {
      action: "checkpoint_restore",
      commitSha: input.checkpointSha,
      reason: "two local recovery attempts failed; restoring pre-recovery checkpoint",
    };
  }

  if (state.localFixAttempts >= 3 && state.alternativeAttempts < 1) {
    state.alternativeAttempts++;
    return {
      action: "alternative_approach",
      fromExecutionContextAlternative: 1,
    };
  }

  state.localFixAttempts++;
  return {
    action: "local_fix",
    targetFiles: input.executionContext.filesToChange,
    prompt: buildRecoveryPrompt(failureClass, input),
  };
}

export function classifyFailure(
  validation: ValidationResult,
  runResult?: TurnRunnerResult,
): FailureClass {
  const erroredTool = runResult?.toolCalls.find((entry) => entry.result.status !== "ok");
  if (erroredTool?.result.errorType === "permission_denied") return "permission_denied";
  if (erroredTool?.call.name === "apply_patch") return "patch_apply_failed";
  if (erroredTool?.result.errorType === "shell_timeout") return "stuck_command";
  if (erroredTool?.result.errorType === "path_outside_workspace") return "path_not_found";

  const runs = validation.validatorsRun;
  const crashed = runs.find((run) => run.validatorStatus === "crash");
  if (crashed) {
    if (crashed.crashReason === "timeout") return "stuck_command";
    if (crashed.crashReason === "missing_interpreter") return "import_error";
    return "validation_failure";
  }
  const failed = runs.find((run) => run.validatorStatus === "fail");
  if (failed) return classifyValidatorFailure(failed);
  return "validation_failure";
}

export function normalizedSimilarity(a: string, b: string): number {
  const left = normalizeForSimilarity(a);
  const right = normalizeForSimilarity(b);
  if (left.length === 0 && right.length === 0) return 1;
  if (left.length === 0 || right.length === 0) return 0;
  const distance = levenshtein(left, right);
  return 1 - distance / Math.max(left.length, right.length);
}

function classifyValidatorFailure(run: ValidatorRun): FailureClass {
  const text = `${run.stdoutTail}\n${run.stderrTail}`.toLowerCase();
  if (/syntaxerror|parse error|unexpected token|ts\d{4}/.test(text)) return "syntax_error";
  if (/modulenotfound|cannot find module|importerror|no module named/.test(text)) {
    return "import_error";
  }
  if (/permission denied|eacces|operation not permitted/.test(text)) return "permission_denied";
  if (/enoent|no such file|not found/.test(text)) return "path_not_found";
  if (/timeout|timed out|connection refused|connection reset|econnrefused/.test(text)) {
    return "connection_timeout";
  }
  return "test_failure";
}

function classifyVerifierAdvice(
  verifier?: Extract<SubagentResult, { role: "verifier" }>,
): "re_explore" | "alternative_approach" | null {
  if (!verifier || verifier.findings.length === 0) return null;
  // Keep this deterministic and intentionally conservative. The verifier can
  // say "you are repeating yourself" or "the validator environment looks bad";
  // it cannot invent a new completion outcome.
  const text = verifier.findings
    .map((finding) => `${finding.severity} ${finding.finding} ${finding.evidence}`)
    .join("\n")
    .toLowerCase();
  if (/repeat|same approach|same failing|wrong assumption|unclear validator/.test(text)) {
    return "re_explore";
  }
  if (/environment|missing interpreter|validator crash|oom|timeout|network/.test(text)) {
    return "re_explore";
  }
  if (/alternative|different approach|rewrite|replace strategy/.test(text)) {
    return "alternative_approach";
  }
  return null;
}

function buildRecoveryPrompt(failureClass: FailureClass, input: RecoveryEngineInput): string {
  const key = promptKeyForClass(failureClass);
  const values = {
    "failure summary": input.routing.summary,
    "stderr tail": input.validation.validatorsRun.map((run) => run.stderrTail).join("\n---\n"),
    "stdout tail": input.validation.validatorsRun.map((run) => run.stdoutTail).join("\n---\n"),
    "validator command": input.validation.validatorsRun
      .map((run) => run.validator.command)
      .join("; "),
    "current approach": input.executionContext.chosenApproach,
  };
  if (!key) {
    // Some classes are routing concepts rather than prompt-template names. Keep
    // those recoveries structured so artifacts still explain what failed.
    return [
      `<recovery class="${failureClass}">`,
      input.routing.summary,
      "Use a different minimal fix; do not repeat the same failed edit.",
      JSON.stringify(values, null, 2),
      "</recovery>",
    ].join("\n");
  }
  return fillRecoveryPrompt(key, values);
}

function promptKeyForClass(failureClass: FailureClass): RecoveryPromptKey | null {
  switch (failureClass) {
    case "syntax_error":
    case "import_error":
    case "path_not_found":
    case "permission_denied":
    case "patch_apply_failed":
    case "test_failure":
      return failureClass;
    case "stuck_command":
    case "connection_timeout":
      return "shell_timeout";
    default:
      return null;
  }
}

function buildFailureReport(
  state: RecoveryEngineState,
  failureClass: FailureClass,
  input: RecoveryEngineInput,
): FailureReport {
  return {
    class: failureClass,
    seenCountsByClass: state.seenCountsByClass,
    eventLogRefs: input.eventLogRefs ?? [],
    summary: `Recovery exhausted after ${state.attempts} attempt(s): ${input.routing.summary}`,
  };
}

function normalizeForSimilarity(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 20_000);
}

function levenshtein(a: string, b: string): number {
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]!;
  }
  return prev[b.length]!;
}
