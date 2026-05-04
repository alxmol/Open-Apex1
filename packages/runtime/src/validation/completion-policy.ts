/**
 * §M4 validatorStatus → exit-code routing (M1 baseline).
 *
 * Summary:
 *   - all pass                                 → success (exit 0)
 *   - any fail                                 → task_failure (exit 1)
 *   - no fail, but any crash or noop           → validation_unknown (exit 2)
 *   - no validators attempted                  → validation_unknown (exit 2)
 *
 * §7.6.2 policy: if the final validator set has confidence `low` and all
 * it proves is that the code compiles, autonomous mode MUST return
 * validation_unknown rather than success.
 */

import {
  ExitCodes,
  type CompletionStatus,
  type ExitCode,
  type ValidationResult,
  type ValidatorRun,
} from "@open-apex/core";

export interface CompletionRouting {
  status: CompletionStatus;
  exitCode: ExitCode;
  summary: string;
}

export interface CompletionRoutingOptions {
  taskInstruction?: string;
}

export function routeValidation(
  result: ValidationResult,
  options: CompletionRoutingOptions = {},
): CompletionRouting {
  const runs = result.validatorsRun;
  if (runs.length === 0) {
    return {
      status: "validation_unknown",
      exitCode: ExitCodes.validation_unknown,
      summary: "no validator candidates were discovered for this task",
    };
  }
  const hasFail = runs.some((r) => r.validatorStatus === "fail");
  if (hasFail) {
    const failing = runs.filter((r) => r.validatorStatus === "fail");
    return {
      status: "task_failure",
      exitCode: ExitCodes.task_failure,
      summary: `${failing.length}/${runs.length} validator(s) failed: ${summarizeRuns(failing)}`,
    };
  }
  const allPass = runs.every((r) => r.validatorStatus === "pass");
  if (allPass) {
    // §7.6.2 honest-completion rule: if ALL we proved was low-confidence
    // minimal-safe compile, we still return validation_unknown.
    const onlyFallback = runs.every((r) => r.validator.source === "minimal_safe_fallback");
    if (onlyFallback) {
      return {
        status: "validation_unknown",
        exitCode: ExitCodes.validation_unknown,
        summary:
          "only minimal-safe fallback validators ran; code compiles but task correctness is unverified",
      };
    }
    // Weak-validator downgrade: `test -s /path`, `[ -f /path ]`,
    // `python -m py_compile`, `python -c "import X"`, `node -e "require(...)"`
    // etc. prove narrow facts (file exists / syntax valid / module
    // imports) but NOT that the task-level output is correct. The TB2
    // tb2-smoke sonnet gcode-to-text trial passed `[test -s /app/out.txt,
    // python3 -m py_compile analyze2.py]` locally but Harbor's verifier
    // checked the content (expected a specific flag) and rejected.
    // Treat pass-sets where every validator is weak the same as the
    // minimal-safe fallback: validation_unknown.
    const uncoveredRequirements = uncoveredSemanticRequirements(runs, options.taskInstruction);
    if (uncoveredRequirements.length > 0) {
      return {
        status: "validation_unknown",
        exitCode: ExitCodes.validation_unknown,
        summary: `validators passed, but task-level semantic constraint(s) are unverified: ${uncoveredRequirements.join(", ")}`,
      };
    }
    const onlyWeak = runs.every((r) => isWeakValidatorCommand(r.validator.command));
    if (onlyWeak) {
      return {
        status: "validation_unknown",
        exitCode: ExitCodes.validation_unknown,
        summary:
          "only weak validators ran (file-existence / syntax / import smoke) — task correctness unverified",
      };
    }
    const onlyInsufficient = runs.every((r) => isInsufficientValidatorCommand(r.validator.command));
    if (onlyInsufficient) {
      return {
        status: "validation_unknown",
        exitCode: ExitCodes.validation_unknown,
        summary:
          "only shallow validators ran (service reachability / compile / warning smoke) — task correctness unverified",
      };
    }
    return {
      status: "success",
      exitCode: ExitCodes.success,
      summary: `all ${runs.length} validator(s) passed`,
    };
  }
  // Mixed result with crashes/noops but no fails → validation_unknown.
  return {
    status: "validation_unknown",
    exitCode: ExitCodes.validation_unknown,
    summary: `validator outcomes: ${runs
      .map((r) => r.validatorStatus)
      .join(", ")} — cannot confirm success`,
  };
}

function summarizeRuns(runs: ValidatorRun[]): string {
  return runs
    .slice(0, 3)
    .map((r) => `\`${r.validator.command}\` (exit ${r.exitCode})`)
    .join("; ");
}

/**
 * A validator command is "weak" when it only proves a narrow fact (file
 * exists, syntax parses, module imports) without verifying task-level
 * correctness. When every passing validator is weak we downgrade the
 * completion status to `validation_unknown` so the agent can't declare
 * victory on these alone.
 */
export function validationHasUncoveredSemanticRequirements(
  result: ValidationResult,
  taskInstruction?: string,
): boolean {
  return uncoveredSemanticRequirements(result.validatorsRun, taskInstruction).length > 0;
}

export function validationIsInsufficientPassSet(result: ValidationResult): boolean {
  return (
    result.validatorsRun.length > 0 &&
    result.validatorsRun.every((run) => run.validatorStatus === "pass") &&
    result.validatorsRun.every((run) => isInsufficientValidatorCommand(run.validator.command))
  );
}

export function isWeakValidatorCommand(command: string): boolean {
  const trimmed = command.trim();
  return (
    // File existence: `test -s|f|d|e PATH`.
    /^test\s+-[sfde]\s+\S+\s*$/.test(trimmed) ||
    // Bracket test: `[ -s|f|d|e PATH ]`.
    /^\[\s+-[sfde]\s+\S+\s+\]\s*$/.test(trimmed) ||
    // Python py_compile smoke: `python3? -m py_compile [paths...]`.
    /^(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*python3?\s+-m\s+py_compile(?:\s|$)/.test(trimmed) ||
    // Python import-only smoke: `python3? -c "import X"` / `import X.Y`.
    /^python3?\s+-c\s+['"]?\s*import\s+[\w.]+\s*['"]?\s*$/.test(trimmed) ||
    // Node require-only smoke: `node -e "require('X')"`.
    /^node\s+-e\s+['"]\s*require\(['"][^'"]+['"]\)['"\s]*$/.test(trimmed) ||
    // Ruby require-only smoke: `ruby -e "require 'X'"`.
    /^ruby\s+-e\s+['"]\s*require\s+['"][^'"]+['"]\s*['"]\s*$/.test(trimmed)
  );
}

export function isInsufficientValidatorCommand(command: string): boolean {
  const trimmed = command.trim();
  return (
    isWeakValidatorCommand(trimmed) ||
    // HTTP reachability probes prove routing/server health, not semantic task
    // correctness. They are useful evidence but cannot be the whole proof.
    /^curl\b[\s\S]*\|\s*grep\s+-qE\s+['"]\^\[234\]['"]/.test(trimmed) ||
    // Compile-only LaTeX and warning-grep probes are shallow unless paired
    // with a validator that checks the task's semantic edit constraints.
    /^(?:pdf|xe|lua)?latex\b/.test(trimmed) ||
    (/^sh\s+-c\b/.test(trimmed) && /\bgrep\b[\s\S]*overfull/i.test(trimmed))
  );
}

type SemanticRequirement =
  | "loadable_model_cache"
  | "allowed_edit_constraints"
  | "reference_or_exact_output"
  | "source_provenance";

function uncoveredSemanticRequirements(
  runs: ValidatorRun[],
  taskInstruction?: string,
): SemanticRequirement[] {
  const requirements = semanticRequirementsFromInstruction(taskInstruction);
  return requirements.filter(
    (requirement) => !runs.some((run) => validatorCoversSemanticRequirement(run, requirement)),
  );
}

function semanticRequirementsFromInstruction(taskInstruction?: string): SemanticRequirement[] {
  if (!taskInstruction) return [];
  const text = taskInstruction.toLowerCase();
  const out = new Set<SemanticRequirement>();
  if (/model_cache|from_pretrained|hugging\s*face|transformers|sentiment_model/.test(text)) {
    out.add("loadable_model_cache");
  }
  if (
    /synonyms?\.txt|synonym families?|only edits?|only modify|allowed edits?|replace\b.*synonym/.test(
      text,
    )
  ) {
    out.add("allowed_edit_constraints");
  }
  if (
    /compare against|match exactly|expected output|golden|reference output|do not modify/.test(text)
  ) {
    out.add("reference_or_exact_output");
  }
  if (instructionRequiresSourceProvenance(text)) {
    out.add("source_provenance");
  }
  return [...out];
}

export function instructionRequiresSourceProvenance(taskInstruction?: string): boolean {
  if (!taskInstruction) return false;
  const text = taskInstruction.toLowerCase();
  return /\b(?:debian\s+(?:source|packages?)|source\s+package|(?:build|built|compile|compiled|install|installed|make|get|extract(?:ed)?)\b[\s\S]{0,120}\bfrom\s+source|from\s+source|extract(?:ed)?\s+(?:the\s+)?source|source\s+tree|no\s+prebuilt|avoid(?:ing)?\s+prebuilt|do\s+not\s+use\s+prebuilt)\b/.test(
    text,
  );
}

function validatorCoversSemanticRequirement(
  run: ValidatorRun,
  requirement: SemanticRequirement,
): boolean {
  const command = run.validator.command.toLowerCase();
  const justification = run.validator.justification.toLowerCase();
  if (isTaskLocalSemanticValidator(run)) return true;
  if (requirement === "loadable_model_cache") {
    return (
      /from_pretrained|automodel|autotokenizer|transformers/.test(command) &&
      /model_cache|sentiment_model/.test(command)
    );
  }
  if (requirement === "allowed_edit_constraints") {
    return /synonym|allowed[-_\s]*edit|edit[-_\s]*constraint/.test(command + "\n" + justification);
  }
  if (requirement === "reference_or_exact_output") {
    return /pytest|verify|run_tests|diff\b|cmp\b|expected|golden|reference/.test(
      command + "\n" + justification,
    );
  }
  if (requirement === "source_provenance") {
    // A runtime smoke command (`pmars -r ...`, `povray ...`) proves the binary
    // runs, not that it came from the requested source package. Require a
    // validator whose command/justification explicitly checks source
    // provenance or an already-recognized task-local/Harbor validator.
    return /source[-_\s]*(?:provenance|package|tree)|built?\s+from\s+source|build\s+from\s+source|dpkg-source|dpkg-buildpackage|debian\/rules|\.orig\.tar|apt\s+source/.test(
      command + "\n" + justification,
    );
  }
  return false;
}

function isTaskLocalSemanticValidator(run: ValidatorRun): boolean {
  const text = `${run.validator.command}\n${run.validator.justification}`.toLowerCase();
  return (
    run.validator.confidence === "high" &&
    (/workspace-local|harbor validator|harbor pytest|test_outputs?\.py|verify\.(?:py|sh)|run_tests\.sh/.test(
      text,
    ) ||
      run.validator.source === "harbor_task_convention")
  );
}
