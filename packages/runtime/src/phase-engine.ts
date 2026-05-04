import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";

import {
  extractSubagentContent,
  predict,
  type ExecutionContext,
  type Message,
  type OpenApexRunContext,
  parseDurationMsEnv,
  type PredictionResult,
  type ProviderAdapter,
  type RecoveryDecision,
  type RequestOptions,
  type SubagentResult,
  type SubagentRole,
  type ToolDefinition,
  type TokenUsage,
  type ValidationResult,
  type ValidatorCandidate,
  type ValidatorRun,
} from "@open-apex/core";
import {
  buildRepoMap,
  createEmptySymbolIndex,
  detectStack,
  indexBatch,
  probeEnvironment,
  symbolIndexStats,
} from "@open-apex/indexer";
import { createRestrictedRunShell, sandboxBackend } from "@open-apex/tools";

import {
  decideRecovery,
  newRecoveryEngineState,
  normalizedSimilarity,
  type RecoveryEngineState,
} from "./recovery-engine.ts";
import { runSynthesis, type SynthesisResult } from "./synthesis.ts";
import {
  runAgenticTurns,
  type MutationBatchCompletedEvent,
  type RunObserverEvent,
  type TurnRunnerResult,
} from "./turn-runner.ts";
import { discoverValidators, sanitizeValidatorCandidate } from "./validation/discoverer.ts";
import {
  isWeakValidatorCommand,
  isInsufficientValidatorCommand,
  routeValidation,
  validationHasUncoveredSemanticRequirements,
  validationIsInsufficientPassSet,
  type CompletionRouting,
} from "./validation/completion-policy.ts";
import { runValidator } from "./validation/runner.ts";

export const DEFAULT_REEXPLORE_TURN = 20;
const DEFAULT_MAX_RECOVERY_ATTEMPTS = 5;
const PHASE_TIMEOUT_DEFAULTS_MS = {
  repo_scout: 30_000,
  environment_scout: 15_000,
  web_researcher: 30_000,
  strategy_planner: 75_000,
  verifier: 60_000,
  exploratory_executor: 120_000,
  synthesis: 120_000,
  gather: 180_000,
} as const;

type PhaseBudgetKey = keyof typeof PHASE_TIMEOUT_DEFAULTS_MS;

export interface PhaseEngineOptions {
  adapter: ProviderAdapter;
  systemPrompt: string;
  synthesisPrompt: string;
  taskInstruction: string;
  initialMessages: Message[];
  tools: ToolDefinition[];
  toolRegistry: Map<string, ToolDefinition>;
  ctx: OpenApexRunContext;
  requestOptions?: RequestOptions;
  maxTurns?: number;
  benchmarkMode?: boolean;
  /** Internal wall-clock deadline used to avoid starting expensive advisory lanes near Harbor timeout. */
  deadlineAtMs?: number;
  skipValidation?: boolean;
  forceVerifier?: boolean;
  enabled?: {
    subagentFanout?: boolean;
    synthesis?: boolean;
    midExecReExplore?: boolean;
    exploratoryExecutor?: boolean;
    strategyPlanner?: boolean;
    verifierSubagent?: boolean;
    webSearch?: boolean;
    repoMap?: boolean;
    symbolIndex?: boolean;
    envProbe?: boolean;
  };
  reExploreTurn?: number;
  /** Optional child runner used to keep benchmark exploratory setup out of the parent event loop. */
  exploratoryRunnerPath?: string;
  exploratoryPresetId?: string;
  onEvent?: (event: PhaseEngineEvent) => void;
}

export type PhaseName =
  | "predict"
  | "gather"
  | "synthesize"
  | "execute"
  | "validate"
  | "recover"
  | "re_explore"
  | "finish";

export type PhaseEngineEvent =
  | { type: "phase_started"; phase: PhaseName }
  | { type: "phase_finished"; phase: PhaseName; detail?: string }
  | { type: "gather_subagent_started"; role: SubagentResult["role"] }
  | { type: "gather_subagent_finished"; role: SubagentResult["role"]; confidence: string }
  | {
      type: "subagent_lane_timed_out";
      role: SubagentResult["role"];
      timeoutMs: number;
      phase: PhaseBudgetKey;
      elapsedMs?: number;
    }
  | {
      type: "subagent_json_parse_failed";
      role: SubagentRole;
      provider: string;
      stopReason: string;
      reason: string;
    }
  | {
      type: "subagent_json_schema_empty";
      role: SubagentRole;
      provider: string;
      stopReason: string;
    }
  | {
      type: "subagent_json_retry";
      role: SubagentRole;
      provider: string;
      stopReason: string;
      reason: "empty" | "parse_failed";
    }
  | { type: "synthesis_degraded"; reason: string }
  | { type: "validation_started"; validators: number }
  | {
      type: "mutation_validation_started";
      cadence: "cheap_structural" | "targeted" | "final_only";
      tools: string[];
      turn: number;
    }
  | {
      type: "mutation_validation_finished";
      cadence: "cheap_structural" | "targeted" | "final_only";
      status: CompletionRouting["status"];
      injectedFeedback: boolean;
    }
  | { type: "recovery_decision"; action: string; reason: string; attempt: number }
  | {
      type: "verifier_triggered";
      reason:
        | "low_confidence_pass"
        | "medium_only_pass"
        | "constraint_sensitive_pass"
        | "repeated_same_approach"
        | "validator_crash"
        | "explicit_request";
    }
  | {
      type: "verifier_budget_exhausted";
      reason:
        | "low_confidence_pass"
        | "medium_only_pass"
        | "constraint_sensitive_pass"
        | "repeated_same_approach"
        | "validator_crash"
        | "explicit_request";
    }
  | {
      type: "validator_candidate_rejected";
      command: string;
      reason: string;
      source: string;
    }
  | {
      type: "exploratory_child_result_received";
      elapsedMs: number;
      confidence: string;
    }
  | {
      type: "exploratory_child_exit_lagged";
      elapsedMs: number;
      cleanupMs: number;
    }
  | {
      type: "subagent_json_retry_skipped";
      role: SubagentRole;
      provider: string;
      stopReason: string;
      reason: "deadline";
    }
  | { type: "re_explore_started"; turn: number }
  | { type: "re_explore_skipped_progressing"; turn: number; reason: string }
  | { type: "turn_runner_event"; event: RunObserverEvent };

export interface PhaseEngineResult {
  prediction: PredictionResult;
  subagentResults: SubagentResult[];
  synthesis: SynthesisResult;
  executionContext: ExecutionContext;
  runResult: TurnRunnerResult;
  validation: ValidationResult;
  routing: CompletionRouting;
  recoveryAttempts: number;
  reExplored: boolean;
  validationHistory: ValidationResult[];
  recoveryHistory: RecoveryDecision[];
  verifierRuns: number;
  usage: TokenUsage;
}

export async function runPhaseEngine(options: PhaseEngineOptions): Promise<PhaseEngineResult> {
  const emit = options.onEvent ?? (() => {});
  const enabled = options.enabled ?? {};
  // Central M4 ledger. The phase engine owns the live workspace and final
  // completion decision; every model lane, validation pass, recovery attempt,
  // and verifier run is recorded here so usage/telemetry are not lost when the
  // current runResult is replaced by recovery or re-exploration.
  const validationHistory: ValidationResult[] = [];
  const recoveryHistory: RecoveryDecision[] = [];
  const synthesisHistory: SynthesisResult[] = [];
  const runHistory: TurnRunnerResult[] = [];
  const recoveryState = newRecoveryEngineState();
  let usageTotal: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let verifierRuns = 0;
  let lastFailureDiff = "";
  let consecutiveFailureCount = 0;
  let reExplored = false;
  let recoveryCheckpointSha: string | null = null;
  let latestVerifier: Extract<SubagentResult, { role: "verifier" }> | null = null;
  const mutationRequiredArtifactFeedbackSeen = new Set<string>();

  const recordRun = (result: TurnRunnerResult): TurnRunnerResult => {
    runHistory.push(result);
    usageTotal = addUsage(usageTotal, result.usage);
    return result;
  };
  const recordSynthesis = (result: SynthesisResult): SynthesisResult => {
    synthesisHistory.push(result);
    usageTotal = addUsage(usageTotal, result.usage);
    return result;
  };
  // M4 validation cadence: after a mutating tool batch, run the normal
  // validator ladder immediately and feed a concise failure summary back into
  // the next model turn. This keeps bad edits from accumulating silently until
  // the final validation pass while still leaving final success/failure
  // routing owned by the normal completion policy.
  const runMutationValidation = async (event: MutationBatchCompletedEvent) => {
    const cadence = classifyMutationCadence(event);
    emit({
      type: "mutation_validation_started",
      cadence,
      tools: event.tools,
      turn: event.turn,
    });
    const midValidation = await validate(options, emit);
    validationHistory.push(midValidation);
    const midRouting = routeValidation(midValidation, {
      taskInstruction: options.taskInstruction,
    });
    if (midRouting.status === "success") {
      const message = [
        "Runtime validation passed after this mutation batch.",
        "Open-Apex is stopping execution now and will run final validation before reporting success.",
      ].join("\n");
      emit({
        type: "mutation_validation_finished",
        cadence,
        status: midRouting.status,
        injectedFeedback: true,
      });
      return { message, stop: true, reason: "strong_validation_success" };
    }
    // Mid-run validation is evidence, not a time budget knob. Feed it back to
    // the model only when it found a real, task-relevant failure. Weak or
    // unknown validation is recorded for routing/artifacts but should not
    // repeatedly steer the executor into shallow correction loops.
    const actionability = classifyValidationActionability(midValidation, options.taskInstruction);
    let feedback: string | null = null;
    if (midRouting.status === "task_failure" && actionability.kind === "strong_task_failure") {
      feedback = buildMutationValidationFeedback(cadence, midValidation, midRouting);
    } else if (
      midRouting.status === "task_failure" &&
      actionability.kind === "required_artifact_missing"
    ) {
      const unseen = actionability.paths.filter(
        (p) => !mutationRequiredArtifactFeedbackSeen.has(p),
      );
      if (unseen.length > 0) {
        for (const p of unseen) mutationRequiredArtifactFeedbackSeen.add(p);
        feedback = buildMutationValidationFeedback(cadence, midValidation, midRouting);
      }
    }
    emit({
      type: "mutation_validation_finished",
      cadence,
      status: midRouting.status,
      injectedFeedback: feedback !== null,
    });
    return feedback ? { message: feedback } : undefined;
  };

  emit({ type: "phase_started", phase: "predict" });
  const repoMapForPrediction = await safeRepoMap(options.ctx.userContext.workspace);
  const prediction = predict({
    taskText: options.taskInstruction,
    repoLanguageCounts: repoMapForPrediction?.languageCounts ?? {},
  });
  emit({ type: "phase_finished", phase: "predict", detail: prediction.taskCategory });

  emit({ type: "phase_started", phase: "gather" });
  const subagentResults: SubagentResult[] = await runWithPhaseBudget(
    options,
    "gather",
    emit,
    (timedOptions) => gather(timedOptions, prediction, emit),
  ).catch((err) => {
    emit({ type: "synthesis_degraded", reason: `gather fallback: ${(err as Error).message}` });
    return [heuristicStrategy(prediction, "gather timeout fallback")];
  });
  for (const result of subagentResults) {
    const usage = (result as { __usage?: TokenUsage }).__usage;
    if (usage) usageTotal = addUsage(usageTotal, usage);
  }
  emit({
    type: "phase_finished",
    phase: "gather",
    detail: `${subagentResults.length} result(s)`,
  });

  emit({ type: "phase_started", phase: "synthesize" });
  // Synthesis is the Apex2-style compression step: turn the parallel gather
  // artifacts into a compact ExecutionContext for the real executor. Tests can
  // disable it for legacy mock scripts, but real preset runs take the model path
  // and log explicit degraded events if schema synthesis fails.
  const synthesis =
    enabled.synthesis === false
      ? mechanicalSynthesis(options.taskInstruction, prediction, subagentResults)
      : await runWithPhaseBudget(options, "synthesis", emit, (timedOptions) =>
          runSynthesis({
            adapter: timedOptions.adapter,
            synthesisPrompt: timedOptions.synthesisPrompt,
            taskInstruction: timedOptions.taskInstruction,
            prediction,
            subagentResults,
            abort: timedOptions.ctx.signal,
            ...(timedOptions.requestOptions ? { requestOptions: timedOptions.requestOptions } : {}),
            onEvent: (event) => {
              if (event.type === "synthesis_degraded") {
                emit({ type: "synthesis_degraded", reason: event.reason });
              }
            },
          }),
        ).catch((err) => {
          emit({
            type: "synthesis_degraded",
            reason: `synthesis fallback: ${(err as Error).message}`,
          });
          return mechanicalSynthesis(options.taskInstruction, prediction, subagentResults);
        });
  recordSynthesis(synthesis);
  emit({
    type: "phase_finished",
    phase: "synthesize",
    detail: synthesis.degraded ? "degraded" : "structured",
  });

  let executionContext = synthesis.executionContext;
  // Split the first execution pass at the re-explore threshold. If the model
  // burns through that budget, we pause and refresh only the high-value lanes
  // instead of letting a stale approach consume the entire maxTurns budget.
  const firstExecuteTurns =
    enabled.midExecReExplore === false
      ? (options.maxTurns ?? 50)
      : Math.min(options.maxTurns ?? 50, options.reExploreTurn ?? DEFAULT_REEXPLORE_TURN);
  const executionMessages = withExecutionContext(options.initialMessages, executionContext);

  emit({ type: "phase_started", phase: "execute" });
  let runResult = recordRun(
    await runAgenticTurns({
      adapter: options.adapter,
      systemPrompt: options.systemPrompt,
      initialMessages: executionMessages,
      tools: options.tools,
      toolRegistry: options.toolRegistry,
      ctx: options.ctx,
      options: {
        maxTurns: firstExecuteTurns,
        abort: options.ctx.signal,
        ...(options.benchmarkMode !== undefined ? { benchmarkMode: options.benchmarkMode } : {}),
        ...(options.requestOptions ? { requestOptions: options.requestOptions } : {}),
        onMutationBatch: runMutationValidation,
        onEvent: (event) => emit({ type: "turn_runner_event", event }),
      },
    }),
  );
  if (
    enabled.midExecReExplore !== false &&
    runResult.terminationReason === "max_turns" &&
    runResult.turnsRun >= (options.reExploreTurn ?? DEFAULT_REEXPLORE_TURN) &&
    hasRemainingBudget(options, PHASE_TIMEOUT_DEFAULTS_MS.web_researcher + 45_000)
  ) {
    const opusProgressSkipReason = opusReExploreProgressSkipReason(options, runResult);
    if (opusProgressSkipReason) {
      emit({
        type: "re_explore_skipped_progressing",
        turn: runResult.turnsRun,
        reason: opusProgressSkipReason,
      });
    } else {
      emit({ type: "re_explore_started", turn: runResult.turnsRun });
      emit({ type: "phase_started", phase: "re_explore" });
      const miniResults = await miniGather(options, prediction, runResult, emit);
      const updated = recordSynthesis(
        await runWithPhaseBudget(options, "synthesis", emit, (timedOptions) =>
          runSynthesis({
            adapter: timedOptions.adapter,
            synthesisPrompt: timedOptions.synthesisPrompt,
            taskInstruction: [
              timedOptions.taskInstruction,
              "",
              "Update the approach based on this mid-execution evidence. Keep the existing task scope.",
            ].join("\n"),
            prediction,
            subagentResults: [...subagentResults, ...miniResults],
            abort: timedOptions.ctx.signal,
            ...(timedOptions.requestOptions ? { requestOptions: timedOptions.requestOptions } : {}),
            onEvent: (event) => {
              if (event.type === "synthesis_degraded") {
                emit({ type: "synthesis_degraded", reason: event.reason });
              }
            },
          }),
        ).catch((err) => {
          emit({
            type: "synthesis_degraded",
            reason: `mid-execution synthesis fallback: ${(err as Error).message}`,
          });
          return mechanicalSynthesis(options.taskInstruction, prediction, [
            ...subagentResults,
            ...miniResults,
          ]);
        }),
      );
      executionContext = updated.executionContext;
      reExplored = true;
      emit({ type: "phase_finished", phase: "re_explore", detail: "updated execution context" });
    }
    const remainingTurns = Math.max(1, (options.maxTurns ?? 50) - runResult.turnsRun);
    runResult = recordRun(
      await runAgenticTurns({
        adapter: options.adapter,
        systemPrompt: options.systemPrompt,
        initialMessages: withExecutionContext(runResult.history, executionContext),
        tools: options.tools,
        toolRegistry: options.toolRegistry,
        ctx: options.ctx,
        options: {
          maxTurns: remainingTurns,
          abort: options.ctx.signal,
          ...(options.benchmarkMode !== undefined ? { benchmarkMode: options.benchmarkMode } : {}),
          ...(options.requestOptions ? { requestOptions: options.requestOptions } : {}),
          onMutationBatch: runMutationValidation,
          onEvent: (event) => emit({ type: "turn_runner_event", event }),
        },
      }),
    );
  }
  emit({ type: "phase_finished", phase: "execute", detail: runResult.terminationReason });

  let validation = await validate(options, emit);
  validationHistory.push(validation);
  // The verifier is advisory. It can improve the next recovery decision, but
  // it never promotes weak validation to success or demotes a real validator
  // pass. Completion routing below always comes from routeValidation().
  const verifierAfterInitial = await maybeRunVerifier({
    options,
    prediction,
    validation,
    validationHistory,
    runResult,
    subagentResults,
    verifierRuns,
    repeatedApproach: false,
    emit,
  });
  verifierRuns = verifierAfterInitial.verifierRuns;
  usageTotal = addUsage(usageTotal, verifierAfterInitial.usage);
  if (verifierAfterInitial.verifier) latestVerifier = verifierAfterInitial.verifier;
  let routing = routeValidation(validation, { taskInstruction: options.taskInstruction });

  while (
    routing.status === "task_failure" &&
    recoveryState.attempts < DEFAULT_MAX_RECOVERY_ATTEMPTS
  ) {
    const actionability = classifyValidationActionability(validation, options.taskInstruction);
    if (
      options.benchmarkMode &&
      actionability.kind !== "strong_task_failure" &&
      actionability.kind !== "required_artifact_missing"
    ) {
      emit({
        type: "synthesis_degraded",
        reason: `recovery skipped because failing validators are ${actionability.kind}`,
      });
      break;
    }
    if (options.benchmarkMode && !hasRemainingBudget(options, 75_000)) {
      emit({
        type: "synthesis_degraded",
        reason: "recovery skipped because benchmark deadline is too close",
      });
      break;
    }
    emit({ type: "phase_started", phase: "recover" });
    const diff = await workspaceDiff(options.ctx.userContext.workspace);
    // Repeated-approach detection intentionally combines a deterministic diff
    // similarity signal with a consecutive-failure fallback. In temporary
    // workspaces without git, the diff is empty, so the counter still prevents
    // endless minor local-fix loops.
    const repeatedApproach =
      consecutiveFailureCount >= (options.benchmarkMode ? 2 : 4) ||
      (consecutiveFailureCount >= 1 &&
        lastFailureDiff.length > 0 &&
        normalizedSimilarity(lastFailureDiff, diff) > 0.85);
    consecutiveFailureCount++;
    lastFailureDiff = diff;
    recoveryCheckpointSha ??= await saveRecoveryCheckpoint(options, recoveryState);
    const decision = decideRecovery(recoveryState, {
      routing,
      validation,
      executionContext,
      runResult,
      ...(recoveryCheckpointSha ? { checkpointSha: recoveryCheckpointSha } : {}),
      repeatedApproach,
      ...(latestVerifier ? { latestVerifier } : {}),
      eventLogRefs: validationEventRefs(validationHistory.length, latestVerifier),
    });
    recoveryHistory.push(decision);
    emit({
      type: "recovery_decision",
      action: decision.action,
      reason: routing.summary,
      attempt: recoveryState.attempts,
    });
    if (decision.action === "give_up") {
      emit({ type: "phase_finished", phase: "recover", detail: "give_up" });
      break;
    }
    if (decision.action === "checkpoint_restore") {
      await restoreCheckpoint(options, decision.commitSha);
      emit({ type: "phase_finished", phase: "recover", detail: "checkpoint restored" });
    } else if (decision.action === "re_explore") {
      if (options.benchmarkMode && !hasRemainingBudget(options, 120_000)) {
        emit({
          type: "synthesis_degraded",
          reason: "recovery re-explore skipped because benchmark deadline is too close",
        });
        emit({ type: "phase_finished", phase: "recover", detail: "re_explore skipped" });
        break;
      }
      // Scoped re-exploration mirrors the M4 plan: do not rerun the full
      // gather fan-out or exploratory executor mid-recovery. We only refresh
      // web research + strategy, then synthesize a lightweight approach update.
      emit({ type: "re_explore_started", turn: runResult.turnsRun });
      const miniResults = await miniGather(options, prediction, runResult, emit);
      subagentResults.push(...miniResults);
      const updated = recordSynthesis(
        await runWithPhaseBudget(options, "synthesis", emit, (timedOptions) =>
          runSynthesis({
            adapter: timedOptions.adapter,
            synthesisPrompt: timedOptions.synthesisPrompt,
            taskInstruction: [
              timedOptions.taskInstruction,
              "",
              "Update the approach based on failed validation evidence. Keep the task scope fixed.",
            ].join("\n"),
            prediction,
            subagentResults,
            abort: timedOptions.ctx.signal,
            ...(timedOptions.requestOptions ? { requestOptions: timedOptions.requestOptions } : {}),
            onEvent: (event) => {
              if (event.type === "synthesis_degraded") {
                emit({ type: "synthesis_degraded", reason: event.reason });
              }
            },
          }),
        ).catch((err) => {
          emit({
            type: "synthesis_degraded",
            reason: `recovery synthesis fallback: ${(err as Error).message}`,
          });
          return mechanicalSynthesis(options.taskInstruction, prediction, subagentResults);
        }),
      );
      executionContext = mergeExecutionContext(executionContext, updated.executionContext);
      reExplored = true;
      emit({ type: "phase_finished", phase: "recover", detail: "re_explore completed" });
    } else {
      const prompt =
        decision.action === "local_fix"
          ? decision.prompt
          : buildAlternativeApproachPrompt(
              executionContext,
              decision.fromExecutionContextAlternative,
            );
      runResult = recordRun(
        await runAgenticTurns({
          adapter: options.adapter,
          systemPrompt: options.systemPrompt,
          initialMessages: [
            ...runResult.history,
            {
              role: "user",
              content: prompt,
            },
          ],
          tools: options.tools,
          toolRegistry: options.toolRegistry,
          ctx: options.ctx,
          options: {
            maxTurns: Math.min(12, options.maxTurns ?? 50),
            abort: options.ctx.signal,
            ...(options.benchmarkMode !== undefined
              ? { benchmarkMode: options.benchmarkMode }
              : {}),
            ...(options.requestOptions ? { requestOptions: options.requestOptions } : {}),
            onMutationBatch: runMutationValidation,
            onEvent: (event) => emit({ type: "turn_runner_event", event }),
          },
        }),
      );
      emit({ type: "phase_finished", phase: "recover", detail: `${decision.action} attempted` });
    }
    validation = await validate(options, emit);
    validationHistory.push(validation);
    const verifierAfterRecovery = await maybeRunVerifier({
      options,
      prediction,
      validation,
      validationHistory,
      runResult,
      subagentResults,
      verifierRuns,
      repeatedApproach,
      emit,
    });
    verifierRuns = verifierAfterRecovery.verifierRuns;
    usageTotal = addUsage(usageTotal, verifierAfterRecovery.usage);
    if (verifierAfterRecovery.verifier) latestVerifier = verifierAfterRecovery.verifier;
    routing = routeValidation(validation, { taskInstruction: options.taskInstruction });
    if (routing.status !== "task_failure") {
      consecutiveFailureCount = 0;
      break;
    }
  }

  emit({ type: "phase_finished", phase: "finish", detail: routing.status });
  return {
    prediction,
    subagentResults,
    synthesis,
    executionContext,
    runResult,
    validation,
    routing,
    recoveryAttempts: recoveryState.attempts,
    reExplored,
    validationHistory,
    recoveryHistory,
    verifierRuns,
    usage: usageTotal,
  };
}

async function gather(
  options: PhaseEngineOptions,
  prediction: PredictionResult,
  emit: (event: PhaseEngineEvent) => void,
): Promise<SubagentResult[]> {
  // The gather fan-out is a mix of deterministic probes and model-backed
  // lanes, all normalized into SubagentResult. The parent phase engine keeps
  // write ownership; subagents observe/propose, except exploratory_executor
  // which mutates only inside its disposable workspace.
  const roles: GatherLane[] = [];
  roles.push({
    role: "repo_scout",
    budget: "repo_scout",
    run: (timedOptions) => repoScout(timedOptions, prediction, emit),
  });
  if (options.enabled?.envProbe !== false)
    roles.push({
      role: "environment_scout",
      budget: "environment_scout",
      run: (timedOptions) => envScout(timedOptions, emit),
    });
  if (options.enabled?.webSearch !== false)
    roles.push({
      role: "web_researcher",
      budget: "web_researcher",
      run: (timedOptions) => webResearcher(timedOptions, prediction, emit),
    });
  if (options.enabled?.strategyPlanner !== false)
    roles.push({
      role: "strategy_planner",
      budget: "strategy_planner",
      run: (timedOptions) => strategyPlanner(timedOptions, prediction, emit),
    });
  if (options.enabled?.exploratoryExecutor !== false) {
    roles.push({
      role: "exploratory_executor",
      budget: "exploratory_executor",
      run: (timedOptions) => exploratoryExecutor(timedOptions, emit),
    });
  }
  const max = options.enabled?.subagentFanout === false ? 2 : 5;
  return Promise.all(
    roles.slice(0, max).map((lane) => runGatherLane(options, lane, prediction, emit)),
  );
}

async function miniGather(
  options: PhaseEngineOptions,
  prediction: PredictionResult,
  runResult: TurnRunnerResult,
  emit: (event: PhaseEngineEvent) => void,
): Promise<SubagentResult[]> {
  void runResult;
  // Re-exploration is intentionally scoped. Re-running the exploratory executor
  // mid-recovery is expensive and risks over-weighting disposable mutations, so
  // only web research and strategy planning are refreshed.
  return Promise.all([
    runGatherLane(
      options,
      {
        role: "web_researcher",
        budget: "web_researcher",
        run: (timedOptions) =>
          webResearcher(timedOptions, prediction, emit, "mid-execution failure recovery"),
      },
      prediction,
      emit,
    ),
    runGatherLane(
      options,
      {
        role: "strategy_planner",
        budget: "strategy_planner",
        run: (timedOptions) =>
          strategyPlanner(timedOptions, prediction, emit, "mid-execution failure recovery"),
      },
      prediction,
      emit,
    ),
  ]);
}

interface GatherLane {
  role: SubagentResult["role"];
  budget: PhaseBudgetKey;
  run: (timedOptions: PhaseEngineOptions) => Promise<SubagentResult>;
}

async function runGatherLane(
  options: PhaseEngineOptions,
  lane: GatherLane,
  prediction: PredictionResult,
  emit: (event: PhaseEngineEvent) => void,
): Promise<SubagentResult> {
  if (options.benchmarkMode) {
    const timeoutMs = phaseTimeoutMs(lane.budget);
    const startedAt = Date.now();
    const controller = new AbortController();
    const parentSignal = options.ctx.signal;
    const abortFromParent = () => controller.abort(parentSignal.reason);
    if (parentSignal.aborted) controller.abort(parentSignal.reason);
    else parentSignal.addEventListener("abort", abortFromParent, { once: true });
    const timedOptions: PhaseEngineOptions = {
      ...options,
      ctx: { ...options.ctx, signal: controller.signal },
      requestOptions: { ...(options.requestOptions ?? {}), signal: controller.signal },
    };
    const runPromise = lane.run(timedOptions);
    runPromise.catch(() => {});
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const result = await Promise.race<SubagentResult | "timeout">([
        runPromise,
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => {
            controller.abort(new Error(`${lane.budget} timed out after ${timeoutMs}ms`));
            resolve("timeout");
          }, timeoutMs);
        }),
      ]);
      if (result !== "timeout") return result;
      const elapsedMs = Date.now() - startedAt;
      const reason = `${lane.role} degraded: ${lane.budget} timed out after ${timeoutMs}ms`;
      emit({
        type: "subagent_lane_timed_out",
        role: lane.role,
        timeoutMs,
        phase: lane.budget,
        elapsedMs,
      });
      emit({ type: "synthesis_degraded", reason });
      return degradedSubagentResult(lane.role, prediction, reason, options);
    } catch (err) {
      const reason = `${lane.role} degraded: ${(err as Error).message}`;
      emit({ type: "synthesis_degraded", reason });
      return degradedSubagentResult(lane.role, prediction, reason, options);
    } finally {
      if (timer) clearTimeout(timer);
      parentSignal.removeEventListener("abort", abortFromParent);
    }
  }
  try {
    return await runWithPhaseBudget(options, lane.budget, emit, lane.run);
  } catch (err) {
    const reason = `${lane.role} degraded: ${(err as Error).message}`;
    if (options.benchmarkMode && /timed out|aborted/i.test((err as Error).message)) {
      emit({
        type: "subagent_lane_timed_out",
        role: lane.role,
        timeoutMs: phaseTimeoutMs(lane.budget),
        phase: lane.budget,
      });
    }
    emit({ type: "synthesis_degraded", reason });
    return degradedSubagentResult(lane.role, prediction, reason, options);
  }
}

async function repoScout(
  options: PhaseEngineOptions,
  prediction: PredictionResult,
  emit: (event: PhaseEngineEvent) => void,
): Promise<SubagentResult> {
  emit({ type: "gather_subagent_started", role: "repo_scout" });
  try {
    const workspace = options.ctx.userContext.workspace;
    // Benchmark workspaces can have very deep fixture/history trees. Keep the
    // deterministic scout bounded there so gather remains useful under Harbor's
    // parent timeout; local/non-benchmark runs keep the richer map.
    const maxFiles = options.benchmarkMode ? 1000 : 5000;
    const maxSymbolFiles = options.benchmarkMode ? 40 : 250;
    const map = await buildRepoMap({ workspace, maxFiles, signal: options.ctx.signal });
    const stack = detectStack(workspace, map);
    const keyPaths = [...new Set([...prediction.keyFiles, ...stack.keyConfigFiles])].slice(0, 12);
    const keyFileContents = await Promise.all(
      keyPaths.map(async (rel) => {
        try {
          const text = await readFile(path.join(workspace, rel), "utf8");
          return { path: rel, excerpt: text.slice(0, 4096) };
        } catch {
          return null;
        }
      }),
    );
    const index = createEmptySymbolIndex(workspace);
    const indexOptions = options.benchmarkMode
      ? { signal: options.ctx.signal, maxFileBytes: 512 * 1024 }
      : { signal: options.ctx.signal };
    await indexBatch(
      index,
      map.files
        .filter((f) => f.language !== undefined)
        .slice(0, maxSymbolFiles)
        .map((f) => f.path),
      indexOptions,
    );
    const result: SubagentResult = {
      role: "repo_scout",
      confidence: "high",
      repoMap: map,
      languages: stack.languages,
      testFrameworks: stack.testFrameworks,
      buildSystems: stack.buildSystems,
      packageManagers: stack.packageManagers,
      keyFileContents: keyFileContents.filter(
        (entry): entry is { path: string; excerpt: string } => entry !== null,
      ),
      symbolIndex: symbolIndexStats(index),
    };
    emit({ type: "gather_subagent_finished", role: "repo_scout", confidence: result.confidence });
    return result;
  } catch (err) {
    const result: SubagentResult = {
      role: "repo_scout",
      confidence: "low",
      errors: [(err as Error).message],
      repoMap: { root: options.ctx.userContext.workspace, files: [], totalFiles: 0, totalBytes: 0 },
      languages: [],
      testFrameworks: [],
      buildSystems: [],
      packageManagers: [],
      keyFileContents: [],
      symbolIndex: { symbolCount: 0, byKind: {}, indexedLanguages: [] },
    };
    emit({ type: "gather_subagent_finished", role: "repo_scout", confidence: result.confidence });
    return result;
  }
}

async function envScout(
  options: PhaseEngineOptions,
  emit: (event: PhaseEngineEvent) => void,
): Promise<SubagentResult> {
  emit({ type: "gather_subagent_started", role: "environment_scout" });
  const probe = await probeEnvironment({
    workspace: options.ctx.userContext.workspace,
    signal: options.ctx.signal,
  });
  const result: SubagentResult = {
    role: "environment_scout",
    confidence: probe.probeErrors.length > 0 ? "medium" : "high",
    ...(probe.probeErrors.length > 0 ? { errors: probe.probeErrors } : {}),
    installedPackages: probe.installedPackages,
    runningProcesses: probe.runningProcesses,
    diskFree: probe.diskFree,
    memoryFree: probe.memoryFree,
    runtimeVersions: probe.runtimeVersions,
    ...(probe.containerContext ? { containerContext: probe.containerContext } : {}),
  };
  emit({
    type: "gather_subagent_finished",
    role: "environment_scout",
    confidence: result.confidence,
  });
  return result;
}

async function webResearcher(
  options: PhaseEngineOptions,
  prediction: PredictionResult,
  emit: (event: PhaseEngineEvent) => void,
  reason = "initial gather",
): Promise<SubagentResult> {
  emit({ type: "gather_subagent_started", role: "web_researcher" });
  const query = buildSearchQuery(options.taskInstruction, prediction, reason);
  const tool = options.toolRegistry.get("web_search");
  if (!tool) {
    const result: SubagentResult = {
      role: "web_researcher",
      confidence: "low",
      errors: ["web_search tool is not registered"],
      queries: [query],
      results: [],
      roundsCompleted: 0,
    };
    emit({
      type: "gather_subagent_finished",
      role: "web_researcher",
      confidence: result.confidence,
    });
    return result;
  }
  const output = await tool.execute(
    { query, numResults: 6, includeAiOverview: true },
    options.ctx,
    options.ctx.signal,
  );
  const parts = Array.isArray(output.content) ? output.content : [];
  const results = parts
    .filter(
      (part): part is Extract<(typeof parts)[number], { type: "search_result" }> =>
        part.type === "search_result",
    )
    .map((part) => ({
      query,
      url: part.url,
      title: part.title,
      snippet: part.snippet,
      excerpt: part.content,
      fetchStatus: "ok" as const,
      rankScore: typeof part.metadata?.rankScore === "number" ? part.metadata.rankScore : 0,
      sourceTier:
        typeof part.metadata?.sourceTier === "string"
          ? (part.metadata.sourceTier as "official_docs" | "source_repo" | "so" | "blog" | "other")
          : "other",
      provenance: {
        provider:
          part.metadata?.provider === "serpapi" || part.metadata?.provider === "serper"
            ? part.metadata.provider
            : "serper",
        fetchedAt:
          typeof part.metadata?.fetchedAt === "string"
            ? part.metadata.fetchedAt
            : new Date().toISOString(),
      },
    }));
  const result: SubagentResult = {
    role: "web_researcher",
    confidence: output.isError ? "low" : results.length > 0 ? "medium" : "low",
    ...(output.isError ? { errors: [String(output.content)] } : {}),
    queries: [query],
    results,
    roundsCompleted:
      output.metadata &&
      typeof output.metadata === "object" &&
      "rounds" in output.metadata &&
      typeof output.metadata.rounds === "number"
        ? output.metadata.rounds
        : 1,
  };
  emit({ type: "gather_subagent_finished", role: "web_researcher", confidence: result.confidence });
  return result;
}

async function strategyPlanner(
  options: PhaseEngineOptions,
  prediction: PredictionResult,
  emit: (event: PhaseEngineEvent) => void,
  reason = "initial gather",
): Promise<SubagentResult> {
  emit({ type: "gather_subagent_started", role: "strategy_planner" });
  try {
    // Primary path: a real read-only model lane proposes approaches and pivots.
    // If the provider returns malformed JSON or exhausts the mock script, we
    // degrade visibly to the deterministic heuristic rather than silently
    // pretending the planner ran.
    const parsed = await runWithPhaseBudget(options, "strategy_planner", emit, (timedOptions) =>
      runSubagentJson<Partial<Extract<SubagentResult, { role: "strategy_planner" }>>>(
        timedOptions,
        "strategy_planner",
        [
          "You are the Open-Apex strategy_planner subagent.",
          "Return ranked approaches, likely validators, risky operations, failure pivots, search pivots, and confidence.",
          `Reason: ${reason}`,
          `Task: ${timedOptions.taskInstruction}`,
          `Prediction: ${JSON.stringify(prediction)}`,
        ].join("\n"),
        [
          "repo_map",
          "list_tree",
          "read_file",
          "search_text",
          "symbol_lookup",
          "web_search",
          "fetch_url",
        ],
        2,
        emit,
      ),
    );
    const result: SubagentResult = {
      role: "strategy_planner",
      confidence: normalizeConfidence(parsed.confidence),
      rankedApproaches:
        Array.isArray(parsed.rankedApproaches) && parsed.rankedApproaches.length > 0
          ? parsed.rankedApproaches.map((entry) => ({
              approach: String(
                (entry as { approach?: unknown }).approach ?? "Inspect, patch, validate.",
              ),
              pros: stringArray((entry as { pros?: unknown }).pros),
              cons: stringArray((entry as { cons?: unknown }).cons),
              confidence:
                typeof (entry as { confidence?: unknown }).confidence === "number"
                  ? Math.max(0, Math.min(1, (entry as { confidence: number }).confidence))
                  : 0.7,
            }))
          : heuristicStrategy(prediction, reason).rankedApproaches,
      likelyValidators: Array.isArray(parsed.likelyValidators)
        ? (parsed.likelyValidators as Extract<
            SubagentResult,
            { role: "strategy_planner" }
          >["likelyValidators"])
        : [],
      riskyOperations: stringArray(parsed.riskyOperations),
      failurePivots: stringArray(parsed.failurePivots),
      searchPivots: stringArray(parsed.searchPivots),
    };
    if (parsed.__usage) (result as { __usage?: TokenUsage }).__usage = parsed.__usage;
    emit({
      type: "gather_subagent_finished",
      role: "strategy_planner",
      confidence: result.confidence,
    });
    return result;
  } catch (err) {
    emit({
      type: "synthesis_degraded",
      reason: `strategy_planner fallback: ${(err as Error).message}`,
    });
  }
  const result = heuristicStrategy(prediction, reason);
  emit({
    type: "gather_subagent_finished",
    role: "strategy_planner",
    confidence: result.confidence,
  });
  return result;
}

function heuristicStrategy(
  prediction: PredictionResult,
  reason: string,
): Extract<SubagentResult, { role: "strategy_planner" }> {
  const result: SubagentResult = {
    role: "strategy_planner",
    confidence: "medium",
    rankedApproaches: [
      {
        approach: `Use ${prediction.taskCategory} heuristics to inspect, change, validate, and recover as needed (${reason}).`,
        pros: [
          "Works with current Open-Apex tool substrate",
          "Keeps parent workspace mutations centralized",
        ],
        cons: ["May require re-exploration if validators expose a wrong assumption"],
        confidence: 0.72,
      },
    ],
    likelyValidators: [],
    riskyOperations:
      prediction.riskProfile === "high"
        ? ["Destructive or production-like operation mentioned in task"]
        : [],
    failurePivots: [
      "If validators fail repeatedly, inspect the exact stderr and changed diff before editing again.",
      "If framework/API behavior is uncertain, search official documentation before another patch.",
    ],
    searchPivots: prediction.likelyFrameworks.map(
      (framework) => `${framework} official docs ${reason}`,
    ),
  };
  return result;
}

function degradedSubagentResult(
  role: SubagentResult["role"],
  prediction: PredictionResult,
  reason: string,
  options: PhaseEngineOptions,
): SubagentResult {
  // Lane timeouts should preserve the phase shape: synthesis still receives a
  // role-specific artifact and can reason about missing evidence instead of
  // losing the lane entirely.
  if (role === "strategy_planner") {
    return { ...heuristicStrategy(prediction, reason), errors: [reason] };
  }
  if (role === "repo_scout") {
    return {
      role,
      confidence: "low",
      errors: [reason],
      repoMap: { root: options.ctx.userContext.workspace, files: [], totalFiles: 0, totalBytes: 0 },
      languages: [],
      testFrameworks: [],
      buildSystems: [],
      packageManagers: [],
      keyFileContents: [],
      symbolIndex: { symbolCount: 0, byKind: {}, indexedLanguages: [] },
    };
  }
  if (role === "environment_scout") {
    return {
      role,
      confidence: "low",
      errors: [reason],
      installedPackages: [],
      runningProcesses: [],
      diskFree: "unknown",
      memoryFree: "unknown",
      runtimeVersions: {},
    };
  }
  if (role === "web_researcher") {
    return {
      role,
      confidence: "low",
      errors: [reason],
      queries: [],
      results: [],
      roundsCompleted: 0,
    };
  }
  if (role === "exploratory_executor") {
    return {
      role,
      confidence: "low",
      errors: [reason],
      commandsAttempted: [],
      validatorOutcomes: [],
      observedFailures: [reason],
      environmentDiscoveries: [],
      checkpointSha: "unavailable",
      sandboxIsolationBackend: sandboxBackend(),
    };
  }
  return {
    role,
    confidence: "low",
    errors: [reason],
    findings: [],
    diffsReviewed: [],
    logsReviewed: [],
    validatorsReviewed: [],
  };
}

async function exploratoryExecutor(
  options: PhaseEngineOptions,
  emit: (event: PhaseEngineEvent) => void,
): Promise<SubagentResult> {
  if (options.benchmarkMode && options.exploratoryRunnerPath) {
    const skipped = await maybeSkipExploratoryChild(options, emit);
    if (skipped) return skipped;
    return exploratoryExecutorChildProcess(options, emit);
  }
  return runWithPhaseBudget(options, "exploratory_executor", emit, (timedOptions) =>
    exploratoryExecutorInner(timedOptions, emit),
  );
}

async function maybeSkipExploratoryChild(
  options: PhaseEngineOptions,
  emit: (event: PhaseEngineEvent) => void,
): Promise<SubagentResult | null> {
  let validators;
  try {
    validators = await discoverValidators({
      workspace: options.ctx.userContext.workspace,
      taskInstruction: options.taskInstruction,
      maxCandidates: 2,
    });
  } catch {
    // Discovery failures are not enough reason to skip the isolated lane; let
    // the child take the normal path where the error is captured/degraded.
    return null;
  }
  const probeValidators = validators.candidates
    .filter(isSubstantiveExploratoryCandidate)
    .slice(0, 2);
  if (probeValidators.length > 0) return null;

  emit({ type: "gather_subagent_started", role: "exploratory_executor" });
  const result = skippedExploratoryResult({
    validators,
    checkpointSha: "unavailable",
    backend: sandboxBackend(),
  });
  emit({
    type: "gather_subagent_finished",
    role: "exploratory_executor",
    confidence: result.confidence,
  });
  return result;
}

async function exploratoryExecutorChildProcess(
  options: PhaseEngineOptions,
  emit: (event: PhaseEngineEvent) => void,
): Promise<SubagentResult> {
  const runnerPath = options.exploratoryRunnerPath;
  if (!runnerPath) {
    throw new Error("exploratory child runner path is required");
  }
  emit({ type: "gather_subagent_started", role: "exploratory_executor" });
  const timeoutMs = phaseTimeoutMs("exploratory_executor");
  const startedAt = Date.now();
  const parentSignal = options.ctx.signal;
  const inputDir = path.join(options.ctx.userContext.openApexHome, "explore-child-inputs");
  await mkdir(inputDir, { recursive: true });
  const inputPath = path.join(inputDir, `${options.ctx.runId}-${Date.now()}.json`);
  await writeFile(
    inputPath,
    JSON.stringify(
      {
        workspace: options.ctx.userContext.workspace,
        openApexHome: options.ctx.userContext.openApexHome,
        runId: options.ctx.runId,
        sessionId: options.ctx.userContext.sessionId,
        taskInstruction: options.taskInstruction,
        systemPrompt: options.systemPrompt,
        requestOptions: options.requestOptions ?? {},
        presetId: options.exploratoryPresetId,
      },
      null,
      2,
    ) + "\n",
  );
  const proc = Bun.spawn([process.execPath, "run", runnerPath, inputPath], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, OPEN_APEX_CHECKPOINT_ISOLATION: "1" },
  });
  const kill = () => {
    try {
      proc.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  };
  if (parentSignal.aborted) kill();
  else parentSignal.addEventListener("abort", kill, { once: true });
  const stderrPromise = readStreamWithDeadline(proc.stderr, timeoutMs + 5_000).catch(
    (err) => `stderr read failed: ${(err as Error).message}`,
  );
  try {
    const stdoutResult = await readFirstJsonLineWithDeadline<SubagentResult>(
      proc.stdout,
      timeoutMs,
    );
    if (stdoutResult.kind === "timeout") {
      kill();
      throw new Error(`exploratory child timed out after ${timeoutMs}ms`);
    }
    if (stdoutResult.kind === "json") {
      const parsed = stdoutResult.value;
      const elapsedMs = Date.now() - startedAt;
      emit({
        type: "exploratory_child_result_received",
        elapsedMs,
        confidence: parsed.confidence,
      });
      const exitCode = await waitForProcessExit(proc, 1_000);
      if (exitCode === "timeout") {
        emit({
          type: "exploratory_child_exit_lagged",
          elapsedMs,
          cleanupMs: 1_000,
        });
        kill();
        await waitForProcessExit(proc, 5_000).catch(() => "timeout");
      }
      emit({
        type: "gather_subagent_finished",
        role: "exploratory_executor",
        confidence: parsed.confidence,
      });
      return parsed;
    }
    const exitCode = await waitForProcessExit(proc, 5_000);
    const stderr = await stderrPromise;
    if (exitCode !== 0) {
      throw new Error(
        `exploratory child exited ${exitCode}: ${
          (stderr || stdoutResult.raw).slice(-1000) || "(no output)"
        }`,
      );
    }
    throw new Error("exploratory child exited without a JSON result");
  } finally {
    parentSignal.removeEventListener("abort", kill);
    await stderrPromise.catch(() => "");
    await rm(inputPath, { force: true }).catch(() => {});
  }
}

async function exploratoryExecutorInner(
  options: PhaseEngineOptions,
  emit: (event: PhaseEngineEvent) => void,
): Promise<SubagentResult> {
  emit({ type: "gather_subagent_started", role: "exploratory_executor" });
  const backend = sandboxBackend();
  let checkpointSha = "unavailable";
  const checkpointStore = (
    options.ctx.userContext as {
      checkpointStore?: {
        save(
          reason: "pre_exploratory_executor",
          sessionId: string,
          stepId: number,
        ): Promise<{
          commitSha: string;
        }>;
      };
    }
  ).checkpointStore;
  if (checkpointStore) {
    try {
      const checkpoint = await checkpointStore.save(
        "pre_exploratory_executor",
        options.ctx.userContext.sessionId,
        0,
      );
      checkpointSha = checkpoint.commitSha;
    } catch (err) {
      checkpointSha = `save_failed:${(err as Error).message.slice(0, 80)}`;
    }
  } else if (options.benchmarkMode) {
    // Autonomous benchmark runs need Episode-1 feedback. If we cannot anchor it
    // to a checkpoint-capable runtime, fail fast instead of synthesizing from a
    // partial or unsafe exploratory pass.
    throw new Error("exploratory executor requires checkpointStore in benchmark mode");
  }
  const validators = await discoverValidators({
    workspace: options.ctx.userContext.workspace,
    taskInstruction: options.taskInstruction,
    maxCandidates: 2,
  });
  const probeValidators = validators.candidates
    .filter(isSubstantiveExploratoryCandidate)
    .slice(0, 2);
  if (probeValidators.length === 0) {
    const result = skippedExploratoryResult({ validators, checkpointSha, backend });
    emit({
      type: "gather_subagent_finished",
      role: "exploratory_executor",
      confidence: result.confidence,
    });
    return result;
  }
  const worktree = path.join(
    exploratoryWorktreeRoot(options),
    `${options.ctx.runId}-${Date.now()}`,
  );
  const commandsAttempted: Array<{
    command: string;
    exitCode: number;
    stdoutTail: string;
    stderrTail: string;
  }> = [];
  const validatorOutcomes: Array<{ validator: string; passed: boolean }> = [];
  const observedFailures: string[] = [];
  let exploratoryUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  try {
    // Episode 1 isolation: copy the parent workspace into an Open-Apex-owned
    // disposable directory, wire tools against that directory, and clean it up
    // after harvesting observations. Parent writes still happen only in the
    // main execute/recovery phases.
    await mkdir(path.dirname(worktree), { recursive: true });
    await cp(options.ctx.userContext.workspace, worktree, {
      recursive: true,
      filter(source) {
        const base = path.basename(source);
        return ![".git", "node_modules", "dist", "build", "target", ".open-apex"].includes(base);
      },
    });
    const isolatedRegistry = scopedToolRegistry(options, "exploratory_executor", worktree, backend);
    const isolatedTools = [...isolatedRegistry.values()];
    const isolatedCtx: OpenApexRunContext = {
      ...options.ctx,
      userContext: {
        ...options.ctx.userContext,
        workspace: worktree,
        openApexHome: path.join(worktree, ".open-apex"),
        checkpointStore: undefined,
        sandboxAvailable: backend !== "soft",
      } as OpenApexRunContext["userContext"],
    };
    if (shouldRunExploratoryModelProbe(options, probeValidators)) {
      // Stage 2 is a probe, not a disposable solve attempt. The lane now gets
      // read/search plus restricted shell only, and a single model turn, so it
      // can explain validator evidence without spending three turns trying to
      // implement the task in a throwaway workspace. Opus defaults to the
      // deterministic validator pass below unless the task has strong evidence
      // worth spending an exploratory model call on.
      const exploratoryRun = await runAgenticTurns({
        adapter: options.adapter,
        systemPrompt: options.systemPrompt,
        initialMessages: [
          {
            role: "user",
            content: [
              "You are the exploratory_executor subagent.",
              "Do not solve or edit the task. Use at most one read/search/shell probe if it clarifies validator behavior.",
              "Return concise observations about what worked, what failed, and likely validators.",
              `Known validators to reason about: ${probeValidators.map((c) => c.command).join("; ")}`,
              `Task: ${options.taskInstruction}`,
            ].join("\n"),
          },
        ],
        tools: isolatedTools,
        toolRegistry: isolatedRegistry,
        ctx: isolatedCtx,
        options: {
          maxTurns: 1,
          abort: options.ctx.signal,
          ...(options.requestOptions ? { requestOptions: options.requestOptions } : {}),
        },
      });
      exploratoryUsage = exploratoryRun.usage;
      for (const entry of exploratoryRun.toolCalls) {
        if (entry.call.name === "run_shell" || entry.call.name === "shell_command") {
          commandsAttempted.push({
            command: renderToolCommand(entry.call.arguments),
            exitCode: entry.result.status === "ok" ? 0 : 1,
            stdoutTail: stringifyContent(entry.result.content).slice(-4000),
            stderrTail:
              entry.result.status === "ok"
                ? ""
                : stringifyContent(entry.result.content).slice(-4000),
          });
        }
        if (entry.result.status !== "ok") {
          observedFailures.push(
            `${entry.call.name}: ${stringifyContent(entry.result.content).slice(0, 500)}`,
          );
        }
      }
    } else {
      observedFailures.push(
        "Opus exploratory model probe skipped; deterministic validator probes supplied the lane evidence.",
      );
    }
    for (const candidate of probeValidators) {
      if (/^\(.*\)$/.test(candidate.command)) continue;
      const run = await runValidator(candidate, { workspace: worktree, timeoutMs: 60_000 });
      commandsAttempted.push({
        command: candidate.command,
        exitCode: run.exitCode ?? -1,
        stdoutTail: run.stdoutTail,
        stderrTail: run.stderrTail,
      });
      validatorOutcomes.push({
        validator: candidate.command,
        passed: run.validatorStatus === "pass",
      });
      if (run.validatorStatus !== "pass") {
        observedFailures.push(`${candidate.command}: ${run.validatorStatus}`);
      }
    }
  } catch (err) {
    observedFailures.push(`exploratory workspace setup failed: ${(err as Error).message}`);
    if (options.benchmarkMode) throw err;
  } finally {
    await rm(worktree, { recursive: true, force: true }).catch(() => {});
  }
  const result: SubagentResult = {
    role: "exploratory_executor",
    confidence: commandsAttempted.length > 0 ? "medium" : "low",
    commandsAttempted,
    validatorOutcomes,
    observedFailures:
      validators.candidates.length === 0
        ? ["No validator found during exploratory pass", ...observedFailures]
        : observedFailures,
    environmentDiscoveries: validators.trace.map(
      (t) => `${t.step}: ${t.matched ? "matched" : "miss"}`,
    ),
    checkpointSha,
    sandboxIsolationBackend: backend,
  };
  (result as { __usage?: TokenUsage }).__usage = exploratoryUsage;
  emit({
    type: "gather_subagent_finished",
    role: "exploratory_executor",
    confidence: result.confidence,
  });
  return result;
}

function skippedExploratoryResult(input: {
  validators: {
    candidates: ValidatorCandidate[];
    trace: Array<{ step: string; matched: boolean }>;
  };
  checkpointSha: string;
  backend: ReturnType<typeof sandboxBackend>;
}): SubagentResult {
  return {
    role: "exploratory_executor",
    confidence: "low",
    errors: [
      input.validators.candidates.length === 0
        ? "exploratory executor skipped because no validators were discovered"
        : "exploratory executor skipped because only weak or shallow validators were discovered",
    ],
    commandsAttempted: [],
    validatorOutcomes: [],
    observedFailures: [
      "No substantive probe was available; execution and final validation own live-workspace decisions.",
    ],
    environmentDiscoveries: input.validators.trace.map(
      (t) => `${t.step}: ${t.matched ? "matched" : "miss"}`,
    ),
    checkpointSha: input.checkpointSha,
    sandboxIsolationBackend: input.backend,
  };
}

export async function runExploratoryExecutorForChild(
  options: PhaseEngineOptions,
): Promise<SubagentResult> {
  return exploratoryExecutorInner(options, () => {});
}

async function maybeRunVerifier(input: {
  options: PhaseEngineOptions;
  prediction: PredictionResult;
  validation: ValidationResult;
  validationHistory: ValidationResult[];
  runResult: TurnRunnerResult;
  subagentResults: SubagentResult[];
  verifierRuns: number;
  repeatedApproach: boolean;
  emit: (event: PhaseEngineEvent) => void;
}): Promise<{
  verifierRuns: number;
  usage: TokenUsage;
  verifier?: Extract<SubagentResult, { role: "verifier" }>;
}> {
  if (input.options.enabled?.verifierSubagent === false) {
    return { verifierRuns: input.verifierRuns, usage: { inputTokens: 0, outputTokens: 0 } };
  }
  // Keep verifier calls sparse and explainable. Every run is tied to one of
  // the M4 firing rules so telemetry can distinguish useful verification from
  // accidental extra model spend.
  const trigger = verifierTriggerReason(
    input.validation,
    input.options.taskInstruction,
    input.repeatedApproach,
    input.options.forceVerifier === true,
  );
  if (!trigger)
    return { verifierRuns: input.verifierRuns, usage: { inputTokens: 0, outputTokens: 0 } };
  // The verifier budget is per task, not per trigger. When it is exhausted we
  // still emit the skipped reason so postmortems can see which signal was
  // suppressed.
  if (input.verifierRuns >= 2) {
    input.emit({ type: "verifier_budget_exhausted", reason: trigger });
    return { verifierRuns: input.verifierRuns, usage: { inputTokens: 0, outputTokens: 0 } };
  }
  if (input.options.benchmarkMode) {
    const advisoryOnlyValidation =
      validationIsWeakOrMissing(input.validation) ||
      validationIsInsufficientPassSet(input.validation) ||
      validationHasUncoveredSemanticRequirements(input.validation, input.options.taskInstruction);
    if (advisoryOnlyValidation && input.verifierRuns >= 1) {
      input.emit({ type: "verifier_budget_exhausted", reason: trigger });
      return { verifierRuns: input.verifierRuns, usage: { inputTokens: 0, outputTokens: 0 } };
    }
    if (
      input.options.deadlineAtMs !== undefined &&
      input.options.deadlineAtMs - Date.now() < 90_000
    ) {
      input.emit({ type: "verifier_budget_exhausted", reason: trigger });
      return { verifierRuns: input.verifierRuns, usage: { inputTokens: 0, outputTokens: 0 } };
    }
  }
  input.emit({ type: "verifier_triggered", reason: trigger });
  input.emit({ type: "gather_subagent_started", role: "verifier" });
  try {
    const result = await runWithPhaseBudget(input.options, "verifier", input.emit, (timedOptions) =>
      runSubagentJson<Partial<Extract<SubagentResult, { role: "verifier" }>>>(
        timedOptions,
        "verifier",
        [
          "You are the Open-Apex verifier subagent. Review validation evidence, produced artifacts, and task claims.",
          "Return confidence, findings, diffs reviewed, logs reviewed, and validators reviewed.",
          "You are advisory. Do not decide final success.",
          "When validators are weak (file existence, syntax, imports), inspect the actual artifact content and challenge semantic correctness.",
          `Task: ${timedOptions.taskInstruction}`,
          `Prediction: ${JSON.stringify(input.prediction)}`,
          `Validation: ${JSON.stringify(input.validation)}`,
          `Likely artifacts to inspect: ${JSON.stringify(extractClaimedArtifactPaths(timedOptions.taskInstruction))}`,
        ].join("\n"),
        ["repo_map", "list_tree", "read_file", "search_text", "symbol_lookup"],
        1,
        input.emit,
      ),
    );
    const verifier: SubagentResult = {
      role: "verifier",
      confidence: normalizeConfidence(result.confidence),
      findings: Array.isArray(result.findings)
        ? result.findings.map((finding) => ({
            finding: String(
              (finding as { finding?: unknown }).finding ?? "validator evidence reviewed",
            ),
            evidence: String((finding as { evidence?: unknown }).evidence ?? ""),
            severity: normalizeSeverity((finding as { severity?: unknown }).severity),
          }))
        : [],
      diffsReviewed: stringArray(result.diffsReviewed),
      logsReviewed: stringArray(result.logsReviewed),
      validatorsReviewed: stringArray(result.validatorsReviewed),
    };
    input.subagentResults.push(verifier);
    input.emit({
      type: "gather_subagent_finished",
      role: "verifier",
      confidence: verifier.confidence,
    });
    return {
      verifierRuns: input.verifierRuns + 1,
      usage: result.__usage ?? { inputTokens: 0, outputTokens: 0 },
      verifier,
    };
  } catch (err) {
    const verifier: SubagentResult = {
      role: "verifier",
      confidence: "low",
      errors: [(err as Error).message],
      findings: [],
      diffsReviewed: [],
      logsReviewed: [],
      validatorsReviewed: input.validation.validatorsRun.map((run) => run.validator.command),
    };
    input.subagentResults.push(verifier);
    input.emit({
      type: "gather_subagent_finished",
      role: "verifier",
      confidence: verifier.confidence,
    });
    return {
      verifierRuns: input.verifierRuns + 1,
      usage: { inputTokens: 0, outputTokens: 0 },
      verifier,
    };
  }
}

async function runSubagentJson<T extends object>(
  options: PhaseEngineOptions,
  role: SubagentRole,
  prompt: string,
  allowedToolNames: string[],
  maxTurns: number,
  emit: (event: PhaseEngineEvent) => void,
): Promise<T & { __usage?: TokenUsage }> {
  const registry = scopedToolRegistry(
    options,
    role,
    options.ctx.userContext.workspace,
    sandboxBackend(),
  );
  for (const name of [...registry.keys()]) {
    if (!allowedToolNames.includes(name)) registry.delete(name);
  }
  const tools = [...registry.values()];
  const brief = [
    `<subagent_brief role="${role}">`,
    prompt,
    "Use the allowed read-only tools only when they materially improve the answer.",
    "</subagent_brief>",
  ].join("\n");
  let history: Message[] = [
    {
      role: "user",
      content: brief,
    },
  ];
  let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

  // Provider-native structured output constrains the model's final assistant
  // text, not the intermediate tool-use loop. Live tbench traces showed the
  // combined "use tools and return JSON" loop often hit max_turns immediately
  // after tool results, so tool gathering and schema finalization are split:
  // first a bounded read-only exploration pass, then one no-tool structured
  // final turn over the gathered transcript.
  if (tools.length > 0 && maxTurns > 0) {
    const gatherResult = await runAgenticTurns({
      adapter: options.adapter,
      systemPrompt: options.systemPrompt,
      initialMessages: history,
      tools,
      toolRegistry: registry,
      ctx: options.ctx,
      options: {
        maxTurns,
        abort: options.ctx.signal,
        requestOptions: {
          ...(options.requestOptions ?? {}),
          maxOutputTokens: options.requestOptions?.maxOutputTokens ?? 1600,
        },
      },
    });
    usage = addUsage(usage, gatherResult.usage);
    history = [
      ...gatherResult.history,
      {
        role: "user",
        content: [
          `<subagent_structured_final role="${role}">`,
          "Now produce the final JSON object for this subagent result.",
          "Use only evidence already in the transcript. Do not call tools.",
          "Return machine-parseable JSON only. Do not include markdown fences.",
          "</subagent_structured_final>",
        ].join("\n"),
      },
    ];
  } else {
    history = [
      {
        role: "user",
        content: [
          brief,
          "Return machine-parseable JSON only. Do not include markdown fences.",
        ].join("\n"),
      },
    ];
  }

  const provider = providerLabel(options);
  const first = await runStructuredSubagentFinal(options, role, history);
  usage = addUsage(usage, first.usage);
  const firstParsed = parseStructuredSubagentFinal<T>(first, {
    role,
    provider,
    usage,
    emit,
    emitFailureTelemetry: true,
  });
  if (firstParsed.ok) return firstParsed.value;

  // Live provider traces can occasionally end a schema-constrained request with
  // an empty assistant after tool use. Retry once with a compact no-tool
  // transcript summary so the fallback path remains a degraded backup, not the
  // normal strategy/verifier behavior.
  if (options.benchmarkMode && remainingBudgetMs(options) < 20_000) {
    emit({
      type: "subagent_json_retry_skipped",
      role,
      provider,
      stopReason: first.terminationReason,
      reason: "deadline",
    });
    throw firstParsed.error;
  }
  emit({
    type: "subagent_json_retry",
    role,
    provider,
    stopReason: first.terminationReason,
    reason: firstParsed.reason,
  });
  const retryHistory: Message[] = [
    {
      role: "user",
      content: [
        `<subagent_structured_retry role="${role}">`,
        "The previous structured final response was empty or not parseable.",
        "Produce the JSON object now using only this compact transcript summary.",
        compactSubagentTranscript(history),
        "Return machine-parseable JSON only. Do not include markdown fences.",
        "</subagent_structured_retry>",
      ].join("\n"),
    },
  ];
  const retry = await runStructuredSubagentFinal(options, role, retryHistory);
  usage = addUsage(usage, retry.usage);
  const retryParsed = parseStructuredSubagentFinal<T>(retry, {
    role,
    provider,
    usage,
    emit,
    emitFailureTelemetry: true,
  });
  if (retryParsed.ok) return retryParsed.value;
  throw (
    retryParsed.error ?? firstParsed.error ?? new Error("subagent did not return a JSON object")
  );
}

async function runStructuredSubagentFinal(
  options: PhaseEngineOptions,
  role: SubagentRole,
  history: Message[],
): Promise<TurnRunnerResult> {
  return runAgenticTurns({
    adapter: options.adapter,
    systemPrompt: options.systemPrompt,
    initialMessages: history,
    tools: [],
    toolRegistry: new Map(),
    ctx: options.ctx,
    options: {
      maxTurns: 1,
      abort: options.ctx.signal,
      requestOptions: {
        ...(options.requestOptions ?? {}),
        maxOutputTokens: options.requestOptions?.maxOutputTokens ?? 1600,
        structuredOutput: {
          type: "json_schema",
          name: `${role}_result`,
          strict: true,
          schema: subagentJsonSchema(role),
        },
      },
    },
  });
}

function parseStructuredSubagentFinal<T extends object>(
  result: TurnRunnerResult,
  input: {
    role: SubagentRole;
    provider: string;
    usage: TokenUsage;
    emit: (event: PhaseEngineEvent) => void;
    emitFailureTelemetry: boolean;
  },
):
  | { ok: true; value: T & { __usage?: TokenUsage } }
  | { ok: false; reason: "empty" | "parse_failed"; error: Error } {
  const candidates = extractSubagentJsonCandidates(result);
  if (candidates.length === 0) {
    if (input.emitFailureTelemetry) {
      input.emit({
        type: "subagent_json_schema_empty",
        role: input.role,
        provider: input.provider,
        stopReason: result.terminationReason,
      });
    }
    return {
      ok: false,
      reason: "empty",
      error: new Error(
        `${input.role} structured output empty (provider=${input.provider}, stop=${result.terminationReason})`,
      ),
    };
  }
  let lastError: Error | null = null;
  for (const candidate of candidates) {
    try {
      const parsed = parseJsonObject(candidate) as T & { __usage?: TokenUsage };
      parsed.__usage = input.usage;
      return { ok: true, value: parsed };
    } catch (err) {
      lastError = err as Error;
    }
  }
  if (input.emitFailureTelemetry) {
    input.emit({
      type: "subagent_json_parse_failed",
      role: input.role,
      provider: input.provider,
      stopReason: result.terminationReason,
      reason: lastError?.message ?? "unknown parse failure",
    });
  }
  return {
    ok: false,
    reason: "parse_failed",
    error: lastError ?? new Error("subagent did not return a JSON object"),
  };
}

function compactSubagentTranscript(history: Message[]): string {
  const lines = history.slice(-10).map((item) => {
    const text = stringifyContent(item.content).replace(/\s+/g, " ").slice(0, 1600);
    return `${item.role}: ${text}`;
  });
  return lines.join("\n").slice(-12_000);
}

function subagentJsonSchema(role: SubagentRole): Record<string, unknown> {
  if (role === "strategy_planner") {
    return {
      type: "object",
      additionalProperties: false,
      required: [
        "confidence",
        "rankedApproaches",
        "likelyValidators",
        "riskyOperations",
        "failurePivots",
        "searchPivots",
      ],
      properties: {
        confidence: { type: "string", enum: ["high", "medium", "low"] },
        rankedApproaches: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["approach", "pros", "cons", "confidence"],
            properties: {
              approach: { type: "string" },
              pros: { type: "array", items: { type: "string" } },
              cons: { type: "array", items: { type: "string" } },
              confidence: { type: "number" },
            },
          },
        },
        likelyValidators: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["command", "confidence", "source", "justification"],
            properties: {
              command: { type: "string" },
              confidence: { type: "string", enum: ["high", "medium", "low"] },
              source: {
                type: "string",
                enum: [
                  "task_instruction",
                  "repo_manifest",
                  "framework_convention",
                  "repo_search",
                  "minimal_safe_fallback",
                  "harbor_task_convention",
                ],
              },
              justification: { type: "string" },
            },
          },
        },
        riskyOperations: { type: "array", items: { type: "string" } },
        failurePivots: { type: "array", items: { type: "string" } },
        searchPivots: { type: "array", items: { type: "string" } },
      },
    };
  }
  if (role === "verifier") {
    return {
      type: "object",
      additionalProperties: false,
      required: ["confidence", "findings", "diffsReviewed", "logsReviewed", "validatorsReviewed"],
      properties: {
        confidence: { type: "string", enum: ["high", "medium", "low"] },
        findings: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["finding", "evidence", "severity"],
            properties: {
              finding: { type: "string" },
              evidence: { type: "string" },
              severity: { type: "string", enum: ["info", "warning", "error"] },
            },
          },
        },
        diffsReviewed: { type: "array", items: { type: "string" } },
        logsReviewed: { type: "array", items: { type: "string" } },
        validatorsReviewed: { type: "array", items: { type: "string" } },
      },
    };
  }
  return {
    type: "object",
    additionalProperties: true,
    properties: { confidence: { type: "string", enum: ["high", "medium", "low"] } },
  };
}

async function runWithPhaseBudget<T>(
  options: PhaseEngineOptions,
  phase: PhaseBudgetKey,
  emit: (event: PhaseEngineEvent) => void,
  run: (timedOptions: PhaseEngineOptions) => Promise<T>,
): Promise<T> {
  if (!options.benchmarkMode) return run(options);
  const timeoutMs = phaseTimeoutMs(phase);
  const controller = new AbortController();
  const parentSignal = options.ctx.signal;
  const abortFromParent = () => controller.abort(parentSignal.reason);
  if (parentSignal.aborted) {
    controller.abort(parentSignal.reason);
  } else {
    parentSignal.addEventListener("abort", abortFromParent, { once: true });
  }
  const timedOptions: PhaseEngineOptions = {
    ...options,
    ctx: { ...options.ctx, signal: controller.signal },
    requestOptions: { ...(options.requestOptions ?? {}), signal: controller.signal },
  };
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const runPromise = run(timedOptions);
  runPromise.catch(() => {});
  try {
    return await Promise.race([
      runPromise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort(new Error(`${phase} timed out after ${timeoutMs}ms`));
          emit({
            type: "synthesis_degraded",
            reason: `${phase} timed out after ${timeoutMs}ms`,
          });
          reject(new Error(`${phase} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } catch (err) {
    if (!timedOut && controller.signal.aborted) {
      throw new Error(`${phase} aborted`);
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    parentSignal.removeEventListener("abort", abortFromParent);
  }
}

function phaseTimeoutMs(phase: PhaseBudgetKey): number {
  const envName = `OPEN_APEX_${phase.toUpperCase()}_TIMEOUT_MS`;
  return parseDurationMsEnv(envName, PHASE_TIMEOUT_DEFAULTS_MS[phase]);
}

async function readStreamWithDeadline(
  stream: ReadableStream<Uint8Array> | number | undefined,
  deadlineMs: number,
): Promise<string> {
  if (!stream || typeof stream === "number") return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = Symbol("stream_deadline");
  const read = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
      if (output.length > 256 * 1024) {
        output = output.slice(-256 * 1024);
      }
    }
    return output;
  })();
  try {
    const winner = await Promise.race([
      read,
      new Promise<typeof deadline>((resolve) => {
        timer = setTimeout(() => resolve(deadline), deadlineMs);
      }),
    ]);
    if (winner === deadline) {
      try {
        await reader.cancel("deadline");
      } catch {
        /* stream may already be closed */
      }
      return `${output}\n... [stream read deadline exceeded]`;
    }
    return winner;
  } finally {
    if (timer) clearTimeout(timer);
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

async function readFirstJsonLineWithDeadline<T>(
  stream: ReadableStream<Uint8Array> | number | undefined,
  deadlineMs: number,
): Promise<{ kind: "json"; value: T; raw: string } | { kind: "closed" | "timeout"; raw: string }> {
  if (!stream || typeof stream === "number") return { kind: "closed", raw: "" };
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = Symbol("json_line_deadline");
  const read = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      output += decoder.decode(value, { stream: true });
      if (output.length > 256 * 1024) output = output.slice(-256 * 1024);
      const lines = output.split(/\r?\n/);
      for (let i = 0; i < lines.length - 1; i++) {
        const line = lines[i]!.trim();
        if (!line) continue;
        try {
          return { kind: "json" as const, value: JSON.parse(line) as T, raw: output };
        } catch {
          // Child diagnostics should go to stderr, but tolerate stray stdout
          // lines and keep waiting for the JSON result line.
        }
      }
    }
    const tail = output.trim();
    if (tail) {
      try {
        return { kind: "json" as const, value: JSON.parse(tail) as T, raw: output };
      } catch {
        /* closed without a parseable result */
      }
    }
    return { kind: "closed" as const, raw: output };
  })();
  try {
    const winner = await Promise.race([
      read,
      new Promise<typeof deadline>((resolve) => {
        timer = setTimeout(() => resolve(deadline), deadlineMs);
      }),
    ]);
    if (winner === deadline) {
      try {
        await reader.cancel("deadline");
      } catch {
        /* stream may already be closed */
      }
      return { kind: "timeout", raw: output };
    }
    return winner;
  } finally {
    if (timer) clearTimeout(timer);
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

async function waitForProcessExit(
  proc: { exited: Promise<number>; exitCode: number | null },
  timeoutMs: number,
): Promise<number | "timeout"> {
  const timeout = Symbol("process_exit_timeout");
  const winner = await Promise.race([
    proc.exited.catch(() => proc.exitCode ?? -1),
    new Promise<typeof timeout>((resolve) => setTimeout(() => resolve(timeout), timeoutMs)),
  ]);
  return winner === timeout ? "timeout" : winner;
}

function opusReExploreProgressSkipReason(
  options: PhaseEngineOptions,
  runResult: TurnRunnerResult,
): string | null {
  const capabilities = options.adapter.getCapabilities();
  const isOpus =
    capabilities.providerId === "anthropic" && /opus/i.test(capabilities.modelId ?? "");
  if (!isOpus) return null;
  if (hasRepeatedBadArgs(runResult)) return null;
  if (mutationValidationTaskFailureCount(runResult) >= 2) return null;
  return hasSuccessfulSerialProgress(options, runResult) ? "successful_serial_progress" : null;
}

function hasSuccessfulSerialProgress(
  options: PhaseEngineOptions,
  runResult: TurnRunnerResult,
): boolean {
  for (const { call, result } of runResult.toolCalls) {
    if (result.status !== "ok") continue;
    const kind = options.toolRegistry.get(call.name)?.kind;
    if (kind === "editor" || kind === "apply_patch" || kind === "shell") return true;
  }
  return false;
}

function hasRepeatedBadArgs(runResult: TurnRunnerResult): boolean {
  const counts = new Map<string, number>();
  for (const { call, result } of runResult.toolCalls) {
    if (result.status !== "error" || result.errorType !== "bad_args") continue;
    const key = `${call.name}:${stringifyContent(result.content)
      .replace(/\s+/g, " ")
      .slice(0, 160)}`;
    const next = (counts.get(key) ?? 0) + 1;
    if (next >= 2) return true;
    counts.set(key, next);
  }
  return false;
}

function mutationValidationTaskFailureCount(runResult: TurnRunnerResult): number {
  let count = 0;
  for (const item of runResult.history) {
    const text = historyItemText(item);
    if (/<mutation_validation\b[^>]*status="task_failure"/.test(text)) count++;
  }
  return count;
}

function remainingBudgetMs(options: PhaseEngineOptions): number {
  if (options.deadlineAtMs === undefined) return Number.POSITIVE_INFINITY;
  return options.deadlineAtMs - Date.now();
}

function hasRemainingBudget(options: PhaseEngineOptions, minimumMs: number): boolean {
  return remainingBudgetMs(options) >= minimumMs;
}

function scopedToolRegistry(
  options: PhaseEngineOptions,
  role: SubagentRole,
  worktree: string,
  backend: ReturnType<typeof sandboxBackend>,
): Map<string, ToolDefinition> {
  const allowed =
    role === "exploratory_executor"
      ? new Set([
          "read_file",
          "list_tree",
          "search_text",
          "repo_map",
          "symbol_lookup",
          "web_search",
          "fetch_url",
          "run_shell",
        ])
      : new Set([
          "read_file",
          "list_tree",
          "search_text",
          "repo_map",
          "symbol_lookup",
          "web_search",
          "fetch_url",
        ]);
  const registry = new Map<string, ToolDefinition>();
  for (const [name, tool] of options.toolRegistry.entries()) {
    if (allowed.has(name)) registry.set(name, tool);
  }
  if (role === "exploratory_executor" && registry.has("run_shell")) {
    registry.set(
      "run_shell",
      createRestrictedRunShell({ worktree, sandboxBackend: backend }) as unknown as ToolDefinition,
    );
  }
  return registry;
}

async function validate(
  options: PhaseEngineOptions,
  emit: (event: PhaseEngineEvent) => void,
): Promise<ValidationResult> {
  emit({ type: "phase_started", phase: "validate" });
  if (options.skipValidation) {
    const validation = {
      passed: false,
      validatorsRun: [],
      incompleteReasons: ["validation skipped by caller"],
    };
    emit({ type: "phase_finished", phase: "validate", detail: "skipped" });
    return validation;
  }
  const discovered = await discoverValidators({
    workspace: options.ctx.userContext.workspace,
    taskInstruction: options.taskInstruction,
    harborTestsDir: "/tests",
  });
  const candidates = discovered.candidates.filter((candidate) => {
    const sanity = sanitizeValidatorCandidate(candidate, options.ctx.userContext.workspace);
    if (sanity.ok) return true;
    emit({
      type: "validator_candidate_rejected",
      command: candidate.command,
      reason: sanity.reason,
      source: candidate.source,
    });
    return false;
  });
  emit({ type: "validation_started", validators: candidates.length });
  const validatorsRun: ValidatorRun[] = [];
  for (const candidate of candidates.slice(0, 4)) {
    if (/^\(.*\)$/.test(candidate.command)) continue;
    validatorsRun.push(
      await runValidator(candidate, { workspace: options.ctx.userContext.workspace }),
    );
  }
  const validation: ValidationResult = {
    passed: validatorsRun.length > 0 && validatorsRun.every((v) => v.validatorStatus === "pass"),
    validatorsRun,
    incompleteReasons:
      validatorsRun.length === 0
        ? ["no validator candidates discovered"]
        : validatorsRun
            .filter((v) => v.validatorStatus !== "pass")
            .map((v) => `validator '${v.validator.command}' status=${v.validatorStatus}`),
  };
  emit({
    type: "phase_finished",
    phase: "validate",
    detail: routeValidation(validation, { taskInstruction: options.taskInstruction }).status,
  });
  return validation;
}

function lowConfidencePass(validation: ValidationResult): boolean {
  return (
    validation.validatorsRun.length > 0 &&
    validation.validatorsRun.every((run) => run.validatorStatus === "pass") &&
    validation.validatorsRun.every(
      (run) =>
        run.validator.confidence === "low" || run.validator.source === "minimal_safe_fallback",
    )
  );
}

function isWeakCandidate(candidate: {
  command: string;
  confidence: string;
  source: string;
}): boolean {
  return (
    candidate.confidence === "low" ||
    candidate.source === "minimal_safe_fallback" ||
    isWeakValidatorCommand(candidate.command)
  );
}

function isSubstantiveExploratoryCandidate(candidate: {
  command: string;
  confidence: string;
  source: string;
}): boolean {
  if (/^\(.*\)$/.test(candidate.command.trim())) return false;
  if (candidate.confidence === "low") return false;
  if (isWeakCandidate(candidate)) return false;
  if (isInsufficientValidatorCommand(candidate.command)) return false;
  return true;
}

function shouldRunExploratoryModelProbe(
  options: PhaseEngineOptions,
  probeValidators: Array<
    Pick<ValidatorCandidate, "confidence" | "source" | "command" | "justification">
  >,
): boolean {
  const capabilities = options.adapter.getCapabilities();
  if (capabilities.providerId !== "anthropic" || !/opus/i.test(capabilities.modelId)) {
    return true;
  }
  const text = `${options.taskInstruction}\n${probeValidators
    .map((candidate) => `${candidate.command}\n${candidate.justification}`)
    .join("\n")}`.toLowerCase();
  const hasHighSignalValidator = probeValidators.some(
    (candidate) =>
      candidate.confidence === "high" &&
      (candidate.source === "harbor_task_convention" ||
        /(?:run_tests|verify|test_outputs|pytest|diff|cmp|golden|reference)/i.test(
          `${candidate.command}\n${candidate.justification}`,
        )),
  );
  const asksForPlannerProbe =
    /\b(?:investigate|explore|determine|figure out|which approach|compare approaches|root cause)\b/.test(
      text,
    );
  return hasHighSignalValidator || asksForPlannerProbe;
}

function exploratoryWorktreeRoot(options: PhaseEngineOptions): string {
  const workspace = path.resolve(options.ctx.userContext.workspace);
  const defaultRoot = path.resolve(options.ctx.userContext.openApexHome, "explore-worktrees");
  // Local/dev runs often keep OPEN_APEX_HOME at `<workspace>/.open-apex`. Node
  // refuses to recursively copy a directory into its own descendant, so move
  // disposable exploration worktrees beside the workspace in that case.
  if (pathIsInside(defaultRoot, workspace)) {
    return path.join(path.dirname(workspace), ".open-apex-explore-worktrees");
  }
  return defaultRoot;
}

function pathIsInside(candidate: string, parent: string): boolean {
  const rel = path.relative(parent, candidate);
  return rel === "" || (!!rel && !rel.startsWith("..") && !path.isAbsolute(rel));
}

function validationIsWeakOrMissing(validation: ValidationResult): boolean {
  if (validation.validatorsRun.length === 0) return true;
  if (
    validation.incompleteReasons.some((reason) =>
      /no validator|minimal_safe|minimal safe|syntax only/i.test(reason),
    )
  ) {
    return true;
  }
  return validation.validatorsRun.every(
    (run) =>
      run.validator.confidence === "low" ||
      run.validator.source === "minimal_safe_fallback" ||
      isWeakValidatorCommand(run.validator.command),
  );
}

export type ValidationActionability =
  | { kind: "strong_task_failure" }
  | { kind: "required_artifact_missing"; paths: string[] }
  | { kind: "validator_environment" }
  | { kind: "weak_or_semantic_unknown" };

export function classifyValidationActionability(
  validation: ValidationResult,
  taskInstruction?: string,
): ValidationActionability {
  if (validation.validatorsRun.some((run) => validatorRunIsEnvironmentProblem(run))) {
    return { kind: "validator_environment" };
  }
  const requiredPaths = new Set(extractClaimedArtifactPaths(taskInstruction ?? ""));
  const missingRequired = uniqueStrings(
    validation.validatorsRun.flatMap((run) => requiredArtifactFailurePaths(run, requiredPaths)),
  );
  if (missingRequired.length > 0) {
    return { kind: "required_artifact_missing", paths: missingRequired };
  }
  if (validation.validatorsRun.some((run) => validatorRunIsStrongFailure(run, taskInstruction))) {
    return { kind: "strong_task_failure" };
  }
  return { kind: "weak_or_semantic_unknown" };
}

function validatorRunIsEnvironmentProblem(run: ValidatorRun): boolean {
  if (run.validatorStatus === "crash") return true;
  const text = `${run.stdoutTail}\n${run.stderrTail}`;
  return (
    run.validatorStatus === "fail" &&
    /\bpython3?\b[\s\S]*\s-m\s+pytest\b/.test(run.validator.command) &&
    /No module named ['"]?pytest['"]?/i.test(text)
  );
}

function requiredArtifactFailurePaths(run: ValidatorRun, requiredPaths: Set<string>): string[] {
  if (run.validatorStatus !== "fail" || requiredPaths.size === 0) return [];
  const command = run.validator.command.trim();
  const matches = [
    ...command.matchAll(/^test\s+-[sfde]\s+(['"]?)(\S+)\1\s*$/g),
    ...command.matchAll(/^\[\s+-[sfde]\s+(['"]?)(\S+)\1\s+\]\s*$/g),
  ];
  return matches
    .map((match) => (match[2] ?? "").replace(/[.,;:]+$/g, ""))
    .filter((p) => requiredPaths.has(p));
}

function validatorRunIsStrongFailure(run: ValidatorRun, taskInstruction?: string): boolean {
  if (run.validatorStatus !== "fail") return false;
  const command = run.validator.command;
  // File-existence/import/reachability probes are breadcrumbs. Use them to
  // inform final routing, but don't steer the model unless they are tied to a
  // claimed required artifact. Syntax/compile fallbacks remain actionable when
  // they fail because they point at concrete broken code.
  if (validatorRunIsExplicitOverfullFailure(run, taskInstruction)) return true;
  if (run.validator.source === "minimal_safe_fallback") return true;
  if (run.validator.confidence === "high") return true;
  if (run.validator.confidence === "medium" && !isInsufficientValidatorCommand(command)) {
    return true;
  }
  return false;
}

function validatorRunIsExplicitOverfullFailure(
  run: ValidatorRun,
  taskInstruction?: string,
): boolean {
  if (run.validatorStatus !== "fail" || !taskInstruction) return false;
  const command = run.validator.command.toLowerCase();
  const task = taskInstruction.toLowerCase();
  return (
    /\boverfull\s+\\?hbox|\boverfull\b/.test(command) &&
    /\b(?:no|without|fix|remove|avoid)\b[\s\S]{0,80}\boverfull\s+\\?hbox/.test(task)
  );
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function verifierTriggerReason(
  validation: ValidationResult,
  taskInstruction: string,
  repeatedApproach: boolean,
  explicitRequest: boolean,
):
  | "low_confidence_pass"
  | "medium_only_pass"
  | "constraint_sensitive_pass"
  | "repeated_same_approach"
  | "validator_crash"
  | "explicit_request"
  | null {
  // Explicit requests win: chat mode can ask for verification even when the
  // validator set is otherwise strong enough that autonomous mode would skip it.
  if (explicitRequest) return "explicit_request";
  if (lowConfidencePass(validation)) return "low_confidence_pass";
  if (
    validation.validatorsRun.length > 0 &&
    validation.validatorsRun.every((run) => run.validatorStatus === "pass") &&
    validationHasUncoveredSemanticRequirements(validation, taskInstruction)
  ) {
    return "constraint_sensitive_pass";
  }
  if (validationIsInsufficientPassSet(validation)) return "medium_only_pass";
  if (repeatedApproach) return "repeated_same_approach";
  if (validation.validatorsRun.some((run) => run.validatorStatus === "crash")) {
    return "validator_crash";
  }
  return null;
}

function classifyMutationCadence(
  event: MutationBatchCompletedEvent,
): "cheap_structural" | "targeted" | "final_only" {
  // These labels are telemetry and prompt-shaping hints today. They also leave
  // room for cheaper future validators without changing the turn-runner hook.
  if (event.tools.some((tool) => tool === "apply_patch" || tool === "write_file")) {
    return "cheap_structural";
  }
  if (
    event.tools.some(
      (tool) => tool === "run_shell" || tool === "shell_command" || tool === "search_replace",
    )
  ) {
    return "targeted";
  }
  return "final_only";
}

function buildMutationValidationFeedback(
  cadence: "cheap_structural" | "targeted" | "final_only",
  validation: ValidationResult,
  routing: CompletionRouting,
): string {
  // Inject as a synthetic user message, not a tool_result: this is
  // runtime-owned validation evidence rather than output for a model-issued
  // tool call.
  const validatorSummaries = validation.validatorsRun
    .map((run) =>
      [
        `${run.validator.command}: ${run.validatorStatus}`,
        run.crashReason ? `crashReason=${run.crashReason}` : "",
        run.stderrTail ? `stderr=${run.stderrTail.slice(-1200)}` : "",
        run.stdoutTail ? `stdout=${run.stdoutTail.slice(-800)}` : "",
      ]
        .filter(Boolean)
        .join(" | "),
    )
    .join("\n");
  return [
    `<mutation_validation cadence="${cadence}" status="${routing.status}">`,
    routing.summary,
    validatorSummaries || validation.incompleteReasons.join("\n"),
    "Before continuing, correct this validation feedback with the smallest safe change. Do not claim completion until validation passes.",
    "</mutation_validation>",
  ].join("\n");
}

function extractClaimedArtifactPaths(taskInstruction: string): string[] {
  const paths = new Set<string>();
  const pathClaimRe =
    /(?:\/app|~\/|\/tmp|\/workspace)[A-Za-z0-9_./:@+,=%-]+(?:\.[A-Za-z0-9_+-]+)?/g;
  for (const match of taskInstruction.matchAll(pathClaimRe)) {
    paths.add(match[0]!);
  }
  return [...paths].slice(0, 12);
}

function validationEventRefs(
  validationHistoryLength: number,
  verifier: Extract<SubagentResult, { role: "verifier" }> | null,
): string[] {
  const refs = [`validation:${validationHistoryLength}`];
  if (verifier) refs.push(`verifier:${verifier.validatorsReviewed.join(",") || "latest"}`);
  return refs;
}

async function saveRecoveryCheckpoint(
  options: PhaseEngineOptions,
  state: RecoveryEngineState,
): Promise<string | null> {
  const store = checkpointStoreFrom(options);
  if (!store) return null;
  try {
    const cp = await store.save(
      "pre_exploratory_executor",
      options.ctx.userContext.sessionId,
      state.attempts,
    );
    return cp.commitSha;
  } catch {
    return null;
  }
}

async function restoreCheckpoint(options: PhaseEngineOptions, commitSha: string): Promise<void> {
  const store = checkpointStoreFrom(options);
  if (!store)
    throw new Error("checkpoint_restore recovery requested but no checkpointStore is attached");
  await store.restore(commitSha);
}

function checkpointStoreFrom(options: PhaseEngineOptions): {
  save(
    reason: "pre_exploratory_executor",
    sessionId: string,
    stepId: number,
  ): Promise<{ commitSha: string }>;
  restore(commitSha: string): Promise<unknown>;
} | null {
  return (
    (
      options.ctx.userContext as {
        checkpointStore?: {
          save(
            reason: "pre_exploratory_executor",
            sessionId: string,
            stepId: number,
          ): Promise<{ commitSha: string }>;
          restore(commitSha: string): Promise<unknown>;
        };
      }
    ).checkpointStore ?? null
  );
}

async function workspaceDiff(workspace: string): Promise<string> {
  try {
    const proc = Bun.spawn(["git", "diff", "--no-ext-diff", "--unified=0"], {
      cwd: workspace,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    return out.slice(-20_000);
  } catch {
    return "";
  }
}

function mergeExecutionContext(
  current: ExecutionContext,
  updated: ExecutionContext,
): ExecutionContext {
  return {
    ...current,
    chosenApproach: updated.chosenApproach || current.chosenApproach,
    validators: updated.validators.length > 0 ? updated.validators : current.validators,
    riskGuards: updated.riskGuards.length > 0 ? updated.riskGuards : current.riskGuards,
    searchPivotHooks:
      updated.searchPivotHooks.length > 0 ? updated.searchPivotHooks : current.searchPivotHooks,
    prioritizedFacts: [...updated.prioritizedFacts, ...current.prioritizedFacts].slice(0, 20),
    evidenceRefs: [...current.evidenceRefs, ...updated.evidenceRefs].slice(0, 30),
  };
}

function buildAlternativeApproachPrompt(
  context: ExecutionContext,
  alternativeIndex: number,
): string {
  return [
    "<alternative_approach>",
    `Previous approach failed: ${context.chosenApproach}`,
    `Use alternative approach index ${alternativeIndex}. If no explicit alternative is available, choose a materially different implementation path.`,
    "Do not repeat the same failed edit. Run validators before completion.",
    "</alternative_approach>",
  ].join("\n");
}

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  const unfenced = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  try {
    const parsed = JSON.parse(unfenced);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    const start = unfenced.indexOf("{");
    const end = unfenced.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const parsed = JSON.parse(unfenced.slice(start, end + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    }
  }
  throw new Error("subagent did not return a JSON object");
}

function extractSubagentJsonCandidates(result: TurnRunnerResult): string[] {
  // Provider-native structured output is normalized by the adapters into text
  // today, but live traces can still end with an empty final assistant after a
  // tool loop. Walk the final item first, then recent assistant history, and
  // accept provider-like parsed/json/object fields without depending on a
  // provider-specific concrete type.
  const candidates: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === "string" && value.trim().length > 0) {
      candidates.push(value);
    } else if (value && typeof value === "object") {
      candidates.push(JSON.stringify(value));
    }
  };
  push(historyItemText(result.finalAssistant));
  const history = [...result.history].reverse();
  for (const item of history) {
    if (item.role !== "assistant") continue;
    push(historyItemText(item));
    const content = item.content;
    if (typeof content === "string") continue;
    for (const part of content as unknown[]) {
      if (!part || typeof part !== "object") continue;
      const rec = part as Record<string, unknown>;
      push(rec.parsed ?? rec.json ?? rec.object ?? rec.output);
      if (typeof rec.content === "string" || (rec.content && typeof rec.content === "object")) {
        push(rec.content);
      }
    }
  }
  return [...new Set(candidates.map((candidate) => candidate.trim()).filter(Boolean))];
}

function historyItemText(item: TurnRunnerResult["finalAssistant"]): string {
  if (!item) return "";
  const content = item.content;
  if (typeof content === "string") return content;
  return content
    .filter(
      (part): part is Extract<(typeof content)[number], { type: "text" }> => part.type === "text",
    )
    .map((part) => part.text)
    .join("\n");
}

function providerLabel(options: PhaseEngineOptions): string {
  try {
    const caps = options.adapter.getCapabilities();
    return `${caps.providerId}:${caps.modelId}`;
  } catch {
    return "unknown";
  }
}

function normalizeConfidence(value: unknown): "high" | "medium" | "low" {
  return value === "high" || value === "medium" || value === "low" ? value : "medium";
}

function normalizeSeverity(value: unknown): "info" | "warning" | "error" {
  return value === "warning" || value === "error" || value === "info" ? value : "info";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function stringifyContent(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function renderToolCommand(args: unknown): string {
  if (typeof args === "string") return args;
  if (args && typeof args === "object" && Array.isArray((args as { argv?: unknown }).argv)) {
    return (args as { argv: unknown[] }).argv.map(String).join(" ");
  }
  return JSON.stringify(args);
}

function withExecutionContext(messages: Message[], context: ExecutionContext): Message[] {
  return [
    ...messages,
    {
      role: "user",
      content: [
        "<execution_context>",
        JSON.stringify(context, null, 2),
        "</execution_context>",
        "Use this synthesized context for the next execution phase. Validate before claiming success.",
      ].join("\n"),
    },
  ];
}

function buildSearchQuery(
  taskInstruction: string,
  prediction: PredictionResult,
  reason: string,
): string {
  const frameworks = prediction.likelyFrameworks.join(" ");
  return [frameworks, prediction.taskCategory, reason, taskInstruction]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .slice(0, 240);
}

async function safeRepoMap(
  workspace: string,
): Promise<Awaited<ReturnType<typeof buildRepoMap>> | null> {
  try {
    return await buildRepoMap({ workspace, maxFiles: 5000 });
  } catch {
    return null;
  }
}

function mechanicalSynthesis(
  taskInstruction: string,
  prediction: PredictionResult,
  subagentResults: SubagentResult[],
): SynthesisResult {
  const facts = subagentResults.flatMap((result) =>
    extractSubagentContent(result).map((part) => part.text.slice(0, 800)),
  );
  const executionContext: ExecutionContext = {
    chosenApproach: "Use gathered facts to execute the smallest validated solution.",
    prioritizedFacts: [`Task: ${taskInstruction.slice(0, 500)}`, ...facts.slice(0, 8)],
    executionPlan: [
      {
        id: "execute",
        description: "Inspect relevant files, apply a minimal fix, and run validators.",
        preconditions: [],
        expectedOutcome: "Task implementation is complete and validated.",
      },
    ],
    filesToInspect: prediction.keyFiles,
    filesToChange: prediction.keyFiles,
    validators: [],
    riskGuards: ["Do not claim success without validator evidence."],
    searchPivotHooks: [],
    completionChecklist: ["Implementation complete", "Validators passed"],
    evidenceRefs: subagentResults.map((r) => ({ sourceRole: r.role, quote: `${r.role} result` })),
  };
  return {
    executionContext,
    degraded: true,
    attempts: 0,
    usage: { inputTokens: 0, outputTokens: 0 },
    rawText: "synthesis disabled; mechanical context generated",
  };
}

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(a.cachedInputTokens !== undefined || b.cachedInputTokens !== undefined
      ? { cachedInputTokens: (a.cachedInputTokens ?? 0) + (b.cachedInputTokens ?? 0) }
      : {}),
    ...(a.reasoningTokens !== undefined || b.reasoningTokens !== undefined
      ? { reasoningTokens: (a.reasoningTokens ?? 0) + (b.reasoningTokens ?? 0) }
      : {}),
    ...(a.thinkingTokens !== undefined || b.thinkingTokens !== undefined
      ? { thinkingTokens: (a.thinkingTokens ?? 0) + (b.thinkingTokens ?? 0) }
      : {}),
  };
}
