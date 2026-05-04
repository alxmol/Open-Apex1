import { describe, expect, test } from "bun:test";

import type { ExecutionContext, ValidationResult, ValidatorRun } from "@open-apex/core";

import {
  classifyFailure,
  decideRecovery,
  newRecoveryEngineState,
  normalizedSimilarity,
} from "../src/recovery-engine.ts";
import type { TurnRunnerResult } from "../src/turn-runner.ts";

function validatorRun(overrides: Partial<ValidatorRun> = {}): ValidatorRun {
  return {
    validator: {
      command: "bun test",
      confidence: "medium",
      source: "repo_manifest",
      justification: "package script",
    },
    validatorStatus: "fail",
    exitCode: 1,
    signal: null,
    stdoutTail: "",
    stderrTail: "SyntaxError: Unexpected token",
    wallMs: 12,
    ...overrides,
  };
}

function validation(run = validatorRun()): ValidationResult {
  return { passed: false, validatorsRun: [run], incompleteReasons: ["failed"] };
}

function runResult(): TurnRunnerResult {
  return {
    history: [],
    usage: { inputTokens: 0, outputTokens: 0 },
    finalAssistant: null,
    providerHandle: null,
    turnsRun: 1,
    maxTurnsHit: false,
    toolCalls: [],
    terminationReason: "end_turn",
    hallucinationStrikes: 0,
  };
}

const context: ExecutionContext = {
  chosenApproach: "patch the parser",
  prioritizedFacts: [],
  executionPlan: [],
  filesToInspect: ["src/index.ts"],
  filesToChange: ["src/index.ts"],
  validators: [],
  riskGuards: [],
  searchPivotHooks: ["parser official docs"],
  completionChecklist: [],
  evidenceRefs: [],
};

describe("RecoveryEngine (§M4)", () => {
  test("classifies validator stderr into concrete failure classes", () => {
    expect(classifyFailure(validation(), runResult())).toBe("syntax_error");
    expect(
      classifyFailure(
        validation(validatorRun({ stderrTail: "ModuleNotFoundError: No module named x" })),
        runResult(),
      ),
    ).toBe("import_error");
    expect(
      classifyFailure(validation(validatorRun({ stderrTail: "permission denied" })), runResult()),
    ).toBe("permission_denied");
  });

  test("sequences local fix, checkpoint restore, re-explore, and give-up decisions", () => {
    const state = newRecoveryEngineState();
    const common = {
      routing: { status: "task_failure" as const, exitCode: 1 as const, summary: "failed" },
      validation: validation(),
      executionContext: context,
      runResult: runResult(),
      checkpointSha: "abc123",
    };

    expect(decideRecovery(state, { ...common, repeatedApproach: false }).action).toBe("local_fix");
    expect(decideRecovery(state, { ...common, repeatedApproach: false }).action).toBe("local_fix");
    expect(decideRecovery(state, { ...common, repeatedApproach: false }).action).toBe(
      "checkpoint_restore",
    );
    expect(decideRecovery(state, { ...common, repeatedApproach: true }).action).toBe("re_explore");
    expect(decideRecovery(state, { ...common, repeatedApproach: false }).action).toBe("local_fix");
    expect(decideRecovery(state, { ...common, repeatedApproach: false }).action).toBe("give_up");
  });

  test("computes deterministic repeated-approach similarity", () => {
    expect(normalizedSimilarity("+ return 1\n", "+ return 1\n")).toBe(1);
    expect(normalizedSimilarity("+ return 1\n", "- completely different\n")).toBeLessThan(0.7);
  });

  test("uses verifier advice for recovery routing without changing completion policy", () => {
    const state = newRecoveryEngineState();
    const decision = decideRecovery(state, {
      routing: { status: "task_failure", exitCode: 1, summary: "failed" },
      validation: validation(validatorRun({ stderrTail: "assertion failed" })),
      executionContext: context,
      runResult: runResult(),
      repeatedApproach: false,
      latestVerifier: {
        role: "verifier",
        confidence: "high",
        findings: [
          {
            finding: "same approach is repeating a wrong assumption",
            evidence: "diffs only rename variables while the assertion failure is unchanged",
            severity: "error",
          },
        ],
        diffsReviewed: ["git diff"],
        logsReviewed: ["validation"],
        validatorsReviewed: ["bun test"],
      },
    });

    expect(decision.action).toBe("re_explore");
  });

  test("does not repeat re-explore for the same repeated-approach ladder", () => {
    const state = newRecoveryEngineState();
    const common = {
      routing: { status: "task_failure" as const, exitCode: 1 as const, summary: "failed" },
      validation: validation(validatorRun({ stderrTail: "assertion failed" })),
      executionContext: context,
      runResult: runResult(),
      repeatedApproach: true,
    };

    expect(decideRecovery(state, common).action).toBe("re_explore");
    expect(decideRecovery(state, common).action).not.toBe("re_explore");
  });
});
