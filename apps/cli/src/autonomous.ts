/**
 * Autonomous-mode entrypoint (M1).
 *
 * Flow:
 *   1. Load preset + config (benchmark mode ignores user/project config per §7.6.10).
 *   2. Instantiate ProviderAdapter, ToolRegistry (9 tools), ShadowGitCheckpointStore.
 *   3. Assemble system prompt from identity + base + tools + appendix.
 *   4. Drive runAgenticTurns until the model stops or maxTurns hits.
 *   5. Discover validators, run them, route outcome via completion policy.
 *   6. Assemble the artifact bundle + OpenApexResult.
 *
 * stdout stays a single machine-readable OpenApexResult JSON line (§3.3).
 */

import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readFile } from "node:fs/promises";
import * as path from "node:path";

import {
  loadOpenApexConfig,
  loadPreset,
  openApexPaths,
  type LoadedPreset,
} from "@open-apex/config";
import {
  ExitCodes,
  estimateCostUsd,
  isHttpError,
  parseDurationMsEnv,
  type ExitCode,
  type HistoryItem,
  type HttpError,
  type Message,
  type OpenApexError,
  type OpenApexResult,
  type OpenApexStatus,
  type TokenUsage,
  type ToolCallRequest,
  type ToolDefinition,
  type ToolResult,
  type ValidationResult,
} from "@open-apex/core";
import {
  assembleSystemPrompt,
  loadPromptFromFile,
  predict,
  renderEnvironmentContext,
  resolvePromptPaths,
} from "@open-apex/core";
import { buildRepoMap, detectStack } from "@open-apex/indexer";
import {
  FileStateMap,
  runPhaseEngine,
  type PhaseEngineEvent,
  type TurnRunnerResult,
} from "@open-apex/runtime";
import { AtifWriter, FileSystemTelemetrySink } from "@open-apex/telemetry";
import {
  BUILTIN_TOOL_NAMES,
  cleanupJobManager,
  registerBuiltinTools,
  setSearchProviderFactory,
  ShadowGitCheckpointStore,
  ToolRegistryImpl,
} from "@open-apex/tools";
import { loadContaminationBlocklist, SerperProvider, SerpApiProvider } from "@open-apex/search";

import { makeAdapter, presetToRequestOptions } from "./adapter-factory.ts";
import type { AutonomousArgs } from "./args.ts";

/**
 * Wire the search tool to a real SERP provider when keys are present.
 * Serper primary; SerpAPI fallback for AI-Overview enrichment.
 */
function wireSearchProvider(preset: LoadedPreset): void {
  const hasSerper = Boolean(process.env.SERPER_API_KEY);
  const hasSerpApi = Boolean(process.env.SERP_API_KEY ?? process.env.SERPAPI_KEY);
  if (!hasSerper && !hasSerpApi) return;
  setSearchProviderFactory(() => {
    const provider = hasSerper ? new SerperProvider() : new SerpApiProvider();
    return { provider, benchmark: preset.benchmarkMode };
  });
}

export interface AutonomousOutcome {
  exitCode: ExitCode;
  result: OpenApexResult;
}

export interface AutonomousDependencies {
  /** Override the provider adapter (tests). */
  adapter?: import("@open-apex/core").ProviderAdapter;
  /** Override selected registered tools by name (tests). */
  toolOverrides?: ToolDefinition[];
  /** Skip validator discovery/run (tests). */
  skipValidation?: boolean;
}

export async function runAutonomous(
  args: AutonomousArgs,
  stderr: NodeJS.WritableStream = process.stderr,
  deps: AutonomousDependencies = {},
): Promise<AutonomousOutcome> {
  const startedAt = Date.now();
  const runId = `run_${Date.now()}_${randomUUID().slice(0, 8)}`;
  const bundleDir = path.join(args.outputDir, runId);
  stderr.write(
    `[open-apex/autonomous] run_id=${runId} preset=${args.preset} benchmark=${args.benchmark} workspace=${args.workspace}\n`,
  );

  // Step 1: load preset.
  let preset: LoadedPreset;
  try {
    preset = await loadPreset(args.preset);
  } catch (err) {
    const msg = (err as Error).message;
    stderr.write(`[open-apex/autonomous] preset load failed: ${msg}\n`);
    return buildErrorOutcome({
      runId,
      bundleDir,
      presetId: args.preset,
      presetRevision: "?",
      status: "config_error",
      exitCode: ExitCodes.config_error,
      summary: `preset load failed: ${msg}`,
      errorReason: msg,
    });
  }

  const benchmarkMode = args.benchmark || preset.benchmarkMode;
  await loadOpenApexConfig({
    userConfigPath: openApexPaths().userConfigPath,
    projectConfigPath: path.join(args.workspace, ".openapex", "config.toml"),
    benchmarkMode,
  });

  // Step 2: read task instruction.
  let instruction: string;
  try {
    if (args.taskFile) {
      instruction = await readFile(args.taskFile, "utf8");
    } else {
      instruction = await readStdin();
    }
    if (!instruction.trim()) throw new Error("empty task instruction");
  } catch (err) {
    const msg = (err as Error).message;
    stderr.write(`[open-apex/autonomous] task source error: ${msg}\n`);
    return buildErrorOutcome({
      runId,
      bundleDir,
      presetId: preset.presetId,
      presetRevision: preset.revision,
      status: "config_error",
      exitCode: ExitCodes.config_error,
      summary: `task source error: ${msg}`,
      errorReason: msg,
    });
  }

  // Step 3: bundle + telemetry sink.
  await mkdir(bundleDir, { recursive: true });
  const sink = new FileSystemTelemetrySink({ outputDir: bundleDir });

  if (benchmarkMode && preset.enabled.contaminationBlocklist) {
    try {
      await loadContaminationBlocklist();
    } catch (err) {
      const msg = (err as Error).message;
      stderr.write(`[open-apex/autonomous] contamination blocklist preflight failed: ${msg}\n`);
      const preflightOutcome = buildErrorOutcome({
        runId,
        bundleDir,
        presetId: preset.presetId,
        presetRevision: preset.revision,
        providerModelIds: [preset.modelId],
        status: "config_error",
        exitCode: ExitCodes.config_error,
        summary: `contamination blocklist preflight failed: ${msg}`,
        errorReason: msg,
      });
      await Bun.write(
        path.join(bundleDir, "result.json"),
        JSON.stringify(preflightOutcome.result, null, 2) + "\n",
      );
      await sink.close();
      return preflightOutcome;
    }
  }

  const totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
  let outcome: AutonomousOutcome | null = null;
  let atifAssistantStepCount = 0;
  let atifWriter: AtifWriter | null = null;
  let partialTimeoutWritten = false;
  const abortController = new AbortController();
  // Progress-aware startup watchdog. M4 can spend meaningful time in predict,
  // gather, synthesis, and validation before the first execute turn starts; the
  // watchdog now distinguishes "no progress" from "pre-execute phase is long"
  // so tbench artifacts point at the active lane instead of shadow-git/prompt
  // assembly by default.
  const STARTUP_STALL_MS = positiveEnvNumber("OPEN_APEX_STARTUP_STALL_MS", 60_000);
  const PRE_EXECUTE_PROGRESS_TIMEOUT_MS = parseDurationMsEnv(
    "OPEN_APEX_PRE_EXECUTE_PROGRESS_TIMEOUT_MS",
    240_000,
  );
  let firstTurnStarted = false;
  let lastProgressAt = Date.now();
  let activePhase = "startup";
  let activeRole: string | undefined;
  let lastTurn: number | undefined;
  let lastValidationStatus: string | undefined;
  const emittedWatchdogKeys = new Set<string>();
  const emitModelEvent = (
    stage:
      | "request_start"
      | "retry"
      | "startup_stall"
      | "pre_execute_phase_long"
      | "partial_timeout_result_written",
    details: Record<string, unknown>,
  ) =>
    sink.emit({
      type: "model_event",
      seq: 0,
      ts: new Date().toISOString(),
      session_id: runId,
      provider: preset.provider,
      model: preset.modelId,
      stage,
      details,
    });
  const noteProgress = (phase: string, role?: string) => {
    lastProgressAt = Date.now();
    activePhase = phase;
    activeRole = role;
  };
  const startupWatchdogTimer = setInterval(
    () => {
      if (firstTurnStarted) return;
      const idleMs = Date.now() - lastProgressAt;
      if (idleMs < STARTUP_STALL_MS) return;
      const progressing = activePhase !== "startup";
      const stage = progressing ? "pre_execute_phase_long" : "startup_stall";
      const key = `${stage}:${activePhase}:${activeRole ?? ""}`;
      if (
        benchmarkMode &&
        progressing &&
        idleMs >= PRE_EXECUTE_PROGRESS_TIMEOUT_MS &&
        !abortController.signal.aborted
      ) {
        abortController.abort(
          new Error(`pre-execute phase made no progress for ${PRE_EXECUTE_PROGRESS_TIMEOUT_MS}ms`),
        );
        void writePartialTimeoutArtifacts(
          `pre-execute no-progress timeout: active_phase=${activePhase}${
            activeRole ? ` role=${activeRole}` : ""
          }`,
        );
      }
      if (emittedWatchdogKeys.has(key)) return;
      emittedWatchdogKeys.add(key);
      const details = {
        threshold_ms: STARTUP_STALL_MS,
        idle_ms: idleMs,
        active_phase: activePhase,
        active_role: activeRole,
        last_progress_at: new Date(lastProgressAt).toISOString(),
      };
      const label = progressing
        ? `pre_execute_phase_long: active_phase=${activePhase}${activeRole ? ` role=${activeRole}` : ""}`
        : "startup_stall: no progress event observed";
      stderr.write(`[open-apex/autonomous] ${label} after ${STARTUP_STALL_MS}ms\n`);
      void emitModelEvent(stage, details);
    },
    Math.max(1_000, Math.min(STARTUP_STALL_MS, 10_000)),
  );
  startupWatchdogTimer.unref?.();
  const writePartialTimeoutArtifacts = async (reason: string): Promise<AutonomousOutcome> => {
    if (outcome) return outcome;
    if (partialTimeoutWritten) {
      return buildOutcome({
        runId,
        bundleDir,
        presetId: preset.presetId,
        presetRevision: preset.revision,
        providerModelIds: [preset.modelId],
        status: "timeout_approaching",
        exitCode: ExitCodes.timeout_approaching,
        summary: `timeout before finalization: ${reason}`,
        validationStatus: "unknown",
        usage: totalUsage,
        providerId: preset.provider,
      });
    }
    partialTimeoutWritten = true;
    const cost = estimateCostUsd(preset.modelId, totalUsage);
    const summary = [
      `timeout before finalization: ${reason}`,
      `last_phase=${activePhase}`,
      activeRole ? `last_role=${activeRole}` : "",
      lastTurn !== undefined ? `last_turn=${lastTurn}` : "",
      lastValidationStatus ? `last_validation_status=${lastValidationStatus}` : "",
      `last_progress_at=${new Date(lastProgressAt).toISOString()}`,
    ]
      .filter(Boolean)
      .join("; ");
    await emitModelEvent("partial_timeout_result_written", {
      reason,
      active_phase: activePhase,
      active_role: activeRole,
      last_turn: lastTurn,
      last_validation_status: lastValidationStatus,
      last_progress_at: new Date(lastProgressAt).toISOString(),
    }).catch(() => {});
    await atifWriter?.flush({ partial: true }).catch(() => {});
    await sink
      .writeSummary({
        schema_version: "open-apex-summary.v1",
        run_id: runId,
        status: "timeout_approaching",
        duration_sec: (Date.now() - startedAt) / 1000,
        tools_used: {},
        permissions: {
          auto_allow: 0,
          auto_deny: 0,
          prompt_allow: 0,
          prompt_deny: 0,
          sandboxed: 0,
        },
        usage: {
          input_tokens: totalUsage.inputTokens,
          output_tokens: totalUsage.outputTokens,
          cached_tokens: totalUsage.cachedInputTokens ?? 0,
          cost_usd: cost.totalUsd,
        },
        checkpoints: 0,
        final_summary: summary,
      })
      .catch(() => {});
    await sink
      .writeReplayLog(
        [
          `# open-apex run ${runId}`,
          "",
          `Preset: \`${preset.presetId}\` (revision \`${preset.revision}\`)`,
          `Model: \`${preset.modelId}\``,
          "",
          "## Partial Timeout",
          "",
          summary,
          "",
          "## Task",
          "",
          instruction.trim(),
          "",
        ].join("\n"),
      )
      .catch(() => {});
    outcome = buildOutcome({
      runId,
      bundleDir,
      presetId: preset.presetId,
      presetRevision: preset.revision,
      providerModelIds: [preset.modelId],
      status: "timeout_approaching",
      exitCode: ExitCodes.timeout_approaching,
      summary,
      validationStatus: "unknown",
      usage: totalUsage,
      costUsd: cost.totalUsd,
      providerId: preset.provider,
    });
    await Bun.write(
      path.join(bundleDir, "result.json"),
      JSON.stringify(outcome.result, null, 2) + "\n",
    ).catch(() => {});
    await sink.flush({ partial: true }).catch(() => {});
    return outcome;
  };
  const handleAbortSignal = (signalName: string) => {
    if (!abortController.signal.aborted) abortController.abort(new Error(signalName));
    void writePartialTimeoutArtifacts(signalName);
  };
  process.once("SIGTERM", handleAbortSignal);
  process.once("SIGINT", handleAbortSignal);
  try {
    await sink.appendOrchestratorLog(
      `[${new Date().toISOString()}] autonomous start run_id=${runId} preset=${preset.presetId} revision=${preset.revision} benchmark=${benchmarkMode} workspace=${args.workspace}`,
    );

    // Step 4a: tool registry + adapter (both pure-construction; safe).
    const adapter = deps.adapter ?? makeAdapter(preset);
    const registry = new ToolRegistryImpl();
    registerBuiltinTools(registry, {
      webSearch: preset.networkEnabled === true && preset.enabled.webSearch !== false,
      repoMap: preset.enabled.repoMap !== false,
      symbolIndex: preset.enabled.symbolIndex !== false,
      readAsset: preset.enabled.readAsset !== false,
    });
    if (preset.networkEnabled === true) wireSearchProvider(preset);
    const toolMap = new Map<string, ToolDefinition>(registry.list().map((t) => [t.name, t]));
    if (deps.toolOverrides) {
      for (const tool of deps.toolOverrides) toolMap.set(tool.name, tool);
    }
    const tools: ToolDefinition[] = Array.from(toolMap.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );

    // Step 4b: assemble the system prompt (pure disk reads of bundled
    // prompt files — fast, no subprocesses). Done BEFORE checkpoint init
    // so the ATIF writer below has `prompt_versions` to stamp, and so a
    // shadow-git hang leaves a trajectory with the prompts already
    // recorded.
    const appendixKey = appendixKeyFor(preset);
    const paths = resolvePromptPaths(appendixKey);
    const assembled = await assembleSystemPrompt({
      identityPath: paths.identityPath,
      baseInstructionsPath: paths.baseInstructionsPath,
      providerAppendixPath: paths.providerAppendixPath,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    });
    const synthesisPrompt = await loadPromptFromFile(paths.synthesisPath);

    // Step 4c: ATIF writer up FRONT. TB2 gpt5.4/fix-git had a 900s silent
    // hang with zero events and no trajectory.json because the writer
    // was created AFTER checkpointStore.init() — a hung git subprocess
    // meant the writer never got a chance to flush a partial trajectory.
    // With the writer ahead, each `markPending` call below drops a
    // breadcrumb to disk so post-mortem analysis can see exactly which
    // startup phase stalled.
    const atifPath = path.join(bundleDir, "trajectory.json");
    atifWriter = new AtifWriter({
      sessionId: runId,
      agent: {
        name: "open-apex",
        version: "0.0.1",
        model_name: preset.modelId,
        tool_definitions: tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
        extra: {
          preset_id: preset.presetId,
          preset_revision: preset.revision,
          milestone: "M4",
          prompt_versions: { ...assembled.versions, synthesis: synthesisPrompt.version },
          tools_registered: BUILTIN_TOOL_NAMES,
        },
      },
      outputPath: atifPath,
    });

    // Step 4d: checkpoint store init (SHADOW-GIT; possibly subprocess-hang).
    // Mark pending BEFORE we dispatch so disk records which phase we're
    // in if the process dies here.
    atifWriter.markPending("startup_phase: initializing shadow-git checkpoint store");
    // §tb2-12 Fix C.2 — in benchmark mode, route save() through a child
    // Bun process so a SIGSEGV during the manifest walk (observed on
    // tb2-12 sonnet4.6/build-cython-ext) doesn't abort the whole agent
    // run. The env flag is read dynamically per-save so tests remain
    // unaffected. Users can opt in/out by setting the env themselves.
    if (benchmarkMode && process.env.OPEN_APEX_CHECKPOINT_ISOLATION === undefined) {
      process.env.OPEN_APEX_CHECKPOINT_ISOLATION = "1";
    }
    const checkpointStore = new ShadowGitCheckpointStore({
      workspace: args.workspace,
      storeRoot: path.join(openApexPaths().checkpointsDir),
    });
    await checkpointStore.init();

    // Step 5: first real step — user message.
    atifWriter.clearPending();
    atifWriter.appendStep({ source: "user", message: instruction.trim() });

    // Step 7: drive the turn loop.
    const fileStateMap = new FileStateMap(args.workspace);
    const benchmarkDeadlineAtMs = benchmarkMode
      ? startedAt + parseDurationMsEnv("OPEN_APEX_BENCHMARK_TIMEOUT_MS", 570_000)
      : undefined;

    const ctx = {
      userContext: {
        workspace: args.workspace,
        openApexHome: openApexPaths().home,
        autonomyLevel: preset.permissionDefaults,
        sessionId: runId,
        benchmarkMode,
        ...(benchmarkDeadlineAtMs !== undefined ? { benchmarkDeadlineAtMs } : {}),
        checkpointStore,
        fileStateMap,
        // Classifier network policy — honors preset flags. `run_shell` +
        // `shell_command` curl/wget calls are tiered via this.
        networkEnabled: preset.networkEnabled ?? false,
        ...(preset.allowedDomains ? { allowedDomains: preset.allowedDomains } : {}),
      },
      runId,
      signal: abortController.signal,
      usage: totalUsage,
    };

    // §7.6.11 pos 7.i — environment_context user message before the task.
    // §M3: enrich the block with a cheap repo-map summary + prediction hints.
    const envContextInputs: Parameters<typeof renderEnvironmentContext>[0] = {
      workspace: args.workspace,
      networkEnabled: preset.networkEnabled ?? false,
      benchmarkMode,
      presetId: preset.presetId,
      taskText: instruction,
    };
    if (preset.allowedDomains) envContextInputs.allowedDomains = preset.allowedDomains;
    try {
      const repoMap = await buildRepoMap({
        workspace: args.workspace,
        maxFiles: 5000,
      });
      const stack = detectStack(args.workspace, repoMap);
      envContextInputs.repoSummary = {
        totalFiles: repoMap.totalFiles,
        totalBytes: repoMap.totalBytes,
        languageCounts: repoMap.languageCounts,
        testFrameworks: stack.testFrameworks,
        buildSystems: stack.buildSystems,
        packageManagers: stack.packageManagers,
      };
      const prediction = predict({
        taskText: instruction,
        repoLanguageCounts: repoMap.languageCounts,
      });
      envContextInputs.prediction = {
        taskCategory: prediction.taskCategory,
        multimodalNeeded: prediction.multimodalNeeded,
        riskProfile: prediction.riskProfile,
        likelyLanguages: prediction.likelyLanguages,
        likelyFrameworks: prediction.likelyFrameworks,
        keyFiles: prediction.keyFiles,
      };
    } catch (err) {
      stderr.write(
        `[open-apex/autonomous] enrichment skipped: ${(err as Error).message.slice(0, 160)}\n`,
      );
    }
    const envBlock = await renderEnvironmentContext(envContextInputs);
    const initialMessages: Message[] = [
      { role: "user", content: envBlock },
      { role: "user", content: instruction.trim() },
    ];

    // Per-run tool-name lookup so tool_event `end` can carry the tool name
    // alongside the call_id that's the only thing available on tool_output.
    const runResultsToolNameByCallId = new Map<string, string>();

    // M4 autonomous mode now enters through the shared phase engine instead of
    // calling the turn runner directly. The CLI still owns artifact/ATIF
    // writing, while the phase engine owns predict -> gather -> synthesize ->
    // execute -> validate -> recover.
    const phaseResult = await runPhaseEngine({
      adapter,
      systemPrompt: assembled.text,
      synthesisPrompt: synthesisPrompt.body,
      taskInstruction: instruction,
      initialMessages,
      tools,
      toolRegistry: toolMap,
      ctx: ctx as Parameters<typeof runPhaseEngine>[0]["ctx"],
      maxTurns: executionMaxTurnsForRun(args, preset, benchmarkMode),
      benchmarkMode,
      ...(benchmarkDeadlineAtMs !== undefined ? { deadlineAtMs: benchmarkDeadlineAtMs } : {}),
      exploratoryRunnerPath:
        process.env.OPEN_APEX_EXPLORATORY_RUNNER_PATH ??
        new URL("./exploratory-runner.ts", import.meta.url).pathname,
      exploratoryPresetId: preset.presetId,
      requestOptions: presetToRequestOptions(preset),
      ...(deps.skipValidation !== undefined ? { skipValidation: deps.skipValidation } : {}),
      enabled: {
        subagentFanout: preset.enabled.subagentFanout,
        // Mock-driven legacy CLI tests script only execute-phase turns. If the
        // phase engine consumed strategy/synthesis/verifier turns in those
        // tests, they would fail for the wrong reason. Runtime/provider tests
        // cover those lanes; real preset runs use the preset defaults.
        synthesis: deps.adapter ? false : preset.enabled.synthesis,
        midExecReExplore: deps.adapter ? false : preset.enabled.midExecReExplore,
        exploratoryExecutor: deps.adapter ? false : preset.enabled.exploratoryExecutor,
        strategyPlanner: deps.adapter ? false : preset.enabled.strategyPlanner,
        verifierSubagent: deps.adapter ? false : preset.enabled.verifierSubagent,
        webSearch: preset.enabled.webSearch,
        repoMap: preset.enabled.repoMap,
        symbolIndex: preset.enabled.symbolIndex,
        envProbe: preset.enabled.envProbe,
      },
      reExploreTurn: executionReExploreTurnForRun(preset, benchmarkMode),
      onEvent: (phaseEv) => {
        noteProgress(phaseEventPhase(phaseEv), phaseEventRole(phaseEv));
        if (phaseEv.type === "mutation_validation_finished") {
          lastValidationStatus = phaseEv.status;
        } else if (phaseEv.type === "phase_finished" && phaseEv.phase === "validate") {
          lastValidationStatus = phaseEv.detail;
        }
        if (phaseEv.type !== "turn_runner_event") {
          void emitModelEvent("request_start", phaseEv);
          return;
        }
        const ev = phaseEv.event;
        if (ev.type === "assistant_message") {
          atifAssistantStepCount++;
          appendAssistantToAtif(atifWriter!, ev.item, preset.modelId);
        } else if (ev.type === "tool_output") {
          appendToolResultToAtif(atifWriter!, ev.result);
          // §5.5: record tool end with wall time + status so post-mortem
          // can diagnose 11-minute gaps (shell runaway vs model round-trip).
          const duration =
            ev.result.endedAt && ev.result.startedAt
              ? ev.result.endedAt - ev.result.startedAt
              : undefined;
          const endEvent: {
            type: "tool_event";
            seq: number;
            ts: string;
            session_id: string;
            tool: string;
            call_id: string;
            action: "end" | "error";
            status: "ok" | "error";
            duration_ms?: number;
            error_type?: string;
            output_summary?: string;
          } = {
            type: "tool_event",
            seq: 0,
            ts: new Date().toISOString(),
            session_id: runId,
            tool: "(unknown)", // overwritten below
            call_id: ev.result.toolCallId,
            action: ev.result.status === "ok" ? "end" : "error",
            status: ev.result.status === "ok" ? "ok" : "error",
          };
          if (duration !== undefined) endEvent.duration_ms = duration;
          if (ev.result.errorType) endEvent.error_type = ev.result.errorType;
          if (ev.result.metadata?.shellTimeoutPolicy) {
            endEvent.output_summary = JSON.stringify({
              shell_timeout_policy: ev.result.metadata.shellTimeoutPolicy,
            }).slice(0, 1000);
          }
          // Look up the tool name by call id from the most recent tool call.
          const recent = runResultsToolNameByCallId.get(ev.result.toolCallId);
          if (recent) endEvent.tool = recent;
          void sink.emit(endEvent);
        } else if (ev.type === "tool_called") {
          runResultsToolNameByCallId.set(ev.call.id, ev.call.name);
          void sink.emit({
            type: "tool_event",
            seq: 0,
            ts: new Date().toISOString(),
            session_id: runId,
            tool: ev.call.name,
            call_id: ev.call.id,
            action: "start",
          });
        } else if (ev.type === "permission_decision") {
          void sink.emit({
            type: "permission_decision",
            seq: 0,
            ts: new Date().toISOString(),
            session_id: runId,
            call_id: ev.callId,
            tool: ev.tool,
            classification: ev.classification,
            gate: ev.gate,
            outcome: ev.outcome,
            ...(ev.reason ? { reason: ev.reason } : {}),
          });
        } else if (ev.type === "search_advice_injected") {
          void sink.emit({
            type: "search_advice_injected",
            seq: 0,
            ts: new Date().toISOString(),
            session_id: runId,
            reason: ev.reason,
            web_search_calls: ev.webSearchCalls,
            fetch_url_calls: ev.fetchUrlCalls,
          });
        } else if (ev.type === "turn_started") {
          lastTurn = ev.turn;
          // §5.5 breadcrumb: if the turn hangs before the assistant
          // message arrives (gpt-5.4 reasoning hang, provider silent
          // stall), the partial trajectory on disk still says "turn N
          // awaiting model response" instead of being 0 bytes.
          atifWriter!.markPending(
            `turn ${ev.turn} started; awaiting model response from ${preset.modelId}`,
          );
          // Startup watchdog: first turn has begun; cancel the stall
          // warning so it doesn't fire mid-run.
          if (!firstTurnStarted) {
            firstTurnStarted = true;
          }
          void emitModelEvent("request_start", { turn: ev.turn });
        } else if (ev.type === "nudge_fired") {
          void emitModelEvent("retry", {
            event: "nudge_fired",
            strike: ev.strike,
            reason: ev.reason,
          });
        } else if (ev.type === "recovery_strike") {
          void emitModelEvent("retry", {
            event: "recovery_strike",
            strike: ev.strike,
            forced_tool_choice: ev.forcedToolChoice,
          });
        } else if (ev.type === "tool_bad_args_recovery_injected") {
          void emitModelEvent("retry", {
            event: "tool_bad_args_recovery_injected",
            tool: ev.tool,
            attempt: ev.attempt,
            signature: ev.signature.slice(0, 240),
          });
        } else if (ev.type === "bad_args_repair_appended") {
          void emitModelEvent("retry", {
            event: "bad_args_repair_appended",
            tool: ev.tool,
            provider: ev.provider,
            attempt: ev.attempt,
          });
        } else if (ev.type === "tool_temporarily_suppressed") {
          void emitModelEvent("retry", {
            event: "tool_temporarily_suppressed",
            tool: ev.tool,
            reason: ev.reason,
            next_turn: ev.nextTurn,
          });
        }
      },
    });
    const runResult = phaseResult.runResult;
    totalUsage.inputTokens = phaseResult.usage.inputTokens;
    totalUsage.outputTokens = phaseResult.usage.outputTokens;
    if (phaseResult.usage.cachedInputTokens !== undefined) {
      totalUsage.cachedInputTokens = phaseResult.usage.cachedInputTokens;
    }

    const validation: ValidationResult = phaseResult.validation;
    for (const vr of validation.validatorsRun) {
      await sink.emit({
        type: "validation",
        seq: 0,
        ts: new Date().toISOString(),
        session_id: runId,
        validator: vr.validator.command,
        status: vr.validatorStatus,
        exit_code: vr.exitCode,
        stderr_tail: vr.stderrTail.slice(-500),
        wall_ms: vr.wallMs,
      });
    }
    let routed = phaseResult.routing;
    if (runResult.terminationReason === "hallucinated_tool_loop") {
      routed = {
        status: "runtime_failure",
        exitCode: ExitCodes.runtime_failure,
        summary: `agent stuck in hallucinated-tool-loop (${runResult.hallucinationStrikes} consecutive strikes with zero real tool calls); run aborted before validation`,
      };
    }

    // Cost estimation (§8 mean_cost_per_task_usd).
    const cost = estimateCostUsd(preset.modelId, totalUsage);

    // Step 9: finalize ATIF, summary, replay.
    atifWriter.setFinalMetrics({
      total_prompt_tokens: totalUsage.inputTokens,
      total_completion_tokens: totalUsage.outputTokens,
      total_cached_tokens: totalUsage.cachedInputTokens ?? 0,
      total_cost_usd: cost.totalUsd,
      total_steps: 1 + atifAssistantStepCount,
    });
    await atifWriter.flush();

    // Permission counters split by classifier outcome (M1 classifier only
    // knows CATASTROPHIC; everything it returned healthily counts as
    // auto_allow — rejections never reach the tool, they error out at
    // dispatch and count as auto_deny).
    const autoDeny = runResult.toolCalls.filter(
      (tc) => tc.result.errorType === "permission_denied",
    ).length;
    const autoAllow = runResult.toolCalls.length - autoDeny;
    const checkpointCount = await mirrorCheckpointArtifacts(runResult.toolCalls, bundleDir);

    await sink.writeSummary({
      schema_version: "open-apex-summary.v1",
      run_id: runId,
      status: routed.status,
      duration_sec: (Date.now() - startedAt) / 1000,
      tools_used: countTools(runResult.toolCalls),
      permissions: {
        auto_allow: autoAllow,
        auto_deny: autoDeny,
        prompt_allow: 0,
        prompt_deny: 0,
        sandboxed: 0,
      },
      usage: {
        input_tokens: totalUsage.inputTokens,
        output_tokens: totalUsage.outputTokens,
        cached_tokens: totalUsage.cachedInputTokens ?? 0,
        cost_usd: cost.totalUsd,
      },
      checkpoints: checkpointCount,
      final_summary: routed.summary,
    });
    await sink.writeReplayLog(
      buildReplayMarkdown(
        runId,
        preset,
        runResult,
        validation,
        routed.summary,
        instruction,
        cost.totalUsd,
      ),
    );

    outcome = buildOutcome({
      runId,
      bundleDir,
      presetId: preset.presetId,
      presetRevision: preset.revision,
      providerModelIds: [preset.modelId],
      status: routed.status,
      exitCode: routed.exitCode,
      summary: routed.summary,
      validationStatus:
        routed.status === "success"
          ? "passed"
          : routed.status === "task_failure"
            ? "failed"
            : "unknown",
      usage: totalUsage,
      costUsd: cost.totalUsd,
      providerId: preset.provider,
      checkpointCount,
    });
    await Bun.write(
      path.join(bundleDir, "result.json"),
      JSON.stringify(outcome.result, null, 2) + "\n",
    );
    await sink.flush({ partial: false });
    // §1.2 / §3.4.5 — persist file-state map so `/resume` (M5) can
    // rehydrate + continue staleness checks across CLI invocations.
    try {
      await Bun.write(
        path.join(bundleDir, `file-state-${runId}.json`),
        JSON.stringify(fileStateMap.serialize(), null, 2) + "\n",
      );
    } catch {
      /* best effort — M5 resume gracefully handles a missing snapshot */
    }
    return outcome;
  } catch (err) {
    const msg = formatThrowable(err);
    stderr.write(`[open-apex/autonomous] runtime error: ${msg}\n`);
    await sink.appendOrchestratorLog(`[${new Date().toISOString()}] runtime error: ${msg}`);
    if (abortController.signal.aborted) {
      return writePartialTimeoutArtifacts(msg);
    }
    // When the adapter threw an HttpError literal (e.g., Anthropic 400 on a
    // strict-incompatible tool schema), surface httpStatus + rawMessage into
    // the structured OpenApexError. Previously this was swallowed as an
    // opaque `{kind:"config"}` with `reason: undefined`.
    const structuredError: OpenApexError = isHttpError(err)
      ? toProviderError(err, preset.provider)
      : { kind: "config", reason: msg };
    const errOutcome = buildErrorOutcome({
      runId,
      bundleDir,
      presetId: preset.presetId,
      presetRevision: preset.revision,
      providerModelIds: [preset.modelId],
      status: "runtime_failure",
      exitCode: ExitCodes.runtime_failure,
      summary: `runtime error: ${msg}`,
      errorReason: msg,
      usage: totalUsage,
      structuredError,
    });
    try {
      await Bun.write(
        path.join(bundleDir, "result.json"),
        JSON.stringify(errOutcome.result, null, 2) + "\n",
      );
    } catch {
      /* best effort */
    }
    return errOutcome;
  } finally {
    clearInterval(startupWatchdogTimer);
    process.removeListener("SIGTERM", handleAbortSignal);
    process.removeListener("SIGINT", handleAbortSignal);
    await cleanupJobManager(runId);
    await sink.close();
  }
}

async function readStdin(): Promise<string> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of Bun.stdin.stream()) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function appendixKeyFor(
  preset: LoadedPreset,
): "openai-gpt-5.4" | "anthropic-sonnet-4.6" | "anthropic-opus-4.6" | "anthropic-opus-4.7" {
  if (preset.provider === "openai") return "openai-gpt-5.4";
  if (preset.modelId.includes("sonnet-4-6")) return "anthropic-sonnet-4.6";
  if (preset.modelId.includes("opus-4-7")) return "anthropic-opus-4.7";
  return "anthropic-opus-4.6";
}

function positiveEnvNumber(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function executionMaxTurnsForRun(
  args: AutonomousArgs,
  preset: LoadedPreset,
  benchmarkMode: boolean,
): number {
  if (args.maxTurns !== undefined) return args.maxTurns;
  void benchmarkMode;
  // Benchmark watchdogs are harness-internal crash containment; they must not
  // shrink the model's normal execution budget. Presets own the turn budget
  // unless the user explicitly passes --max-turns.
  return preset.maxTurns;
}

export function executionReExploreTurnForRun(preset: LoadedPreset, benchmarkMode: boolean): number {
  if (benchmarkMode && preset.provider === "anthropic" && /opus/i.test(preset.modelId)) {
    return 12;
  }
  return 20;
}

function phaseEventPhase(event: PhaseEngineEvent): string {
  if (event.type === "turn_runner_event") return `turn:${event.event.type}`;
  if (event.type === "subagent_lane_timed_out") return "gather";
  if ("phase" in event && typeof event.phase === "string") return event.phase;
  if (event.type.startsWith("mutation_validation")) return "validate";
  if (event.type.startsWith("verifier")) return "verifier";
  if (event.type.startsWith("subagent_json")) return "subagent_json";
  if (event.type === "recovery_decision") return "recover";
  if (event.type === "re_explore_started") return "re_explore";
  if (event.type === "validation_started") return "validate";
  return event.type;
}

function phaseEventRole(event: PhaseEngineEvent): string | undefined {
  if ("role" in event && typeof event.role === "string") return event.role;
  if (event.type === "turn_runner_event" && event.event.type === "tool_called") {
    return event.event.call.name;
  }
  return undefined;
}

function appendAssistantToAtif(writer: AtifWriter, item: HistoryItem, modelId: string): void {
  const text = extractPlainText(item.content);
  const toolCalls = extractToolCalls(item.content);
  const step: Parameters<AtifWriter["appendStep"]>[0] = {
    source: "agent",
    model_name: modelId,
    message: text,
  };
  if (toolCalls.length > 0) step.tool_calls = toolCalls;
  writer.appendStep(step);
}

function appendToolResultToAtif(
  writer: AtifWriter,
  result: import("@open-apex/core").ToolResult,
): void {
  writer.appendStep({
    source: "system",
    message: "",
    observation: {
      results: [
        {
          content:
            typeof result.content === "string"
              ? result.content
              : JSON.stringify(result.content).slice(0, 8192),
        },
      ],
    },
  });
}

function extractPlainText(content: HistoryItem["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

function extractToolCalls(
  content: HistoryItem["content"],
): Array<{ tool_call_id: string; function_name: string; arguments: Record<string, unknown> }> {
  if (typeof content === "string") return [];
  return content
    .filter(
      (p): p is Extract<(typeof content)[number], { type: "tool_use" }> => p.type === "tool_use",
    )
    .map((p) => ({
      tool_call_id: p.toolCallId,
      function_name: p.name,
      arguments:
        typeof p.arguments === "string"
          ? ({ _raw: p.arguments } as Record<string, unknown>)
          : (p.arguments as Record<string, unknown>),
    }));
}

function countTools(calls: Array<{ call: { name: string } }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const { call } of calls) out[call.name] = (out[call.name] ?? 0) + 1;
  return out;
}

function buildReplayMarkdown(
  runId: string,
  preset: LoadedPreset,
  runResult: TurnRunnerResult,
  validation: ValidationResult,
  summary: string,
  instruction: string,
  costUsd: number,
): string {
  const terminationLine =
    runResult.terminationReason === "hallucinated_tool_loop"
      ? `**Termination**: hallucinated_tool_loop (${runResult.hallucinationStrikes} consecutive strikes)`
      : `**Termination**: ${runResult.terminationReason}`;
  const lines: string[] = [
    `# open-apex run ${runId}`,
    "",
    `Preset: \`${preset.presetId}\` (revision \`${preset.revision}\`)`,
    `Model: \`${preset.modelId}\``,
    `Turns: ${runResult.turnsRun}${runResult.maxTurnsHit ? " (maxTurns hit)" : ""}`,
    `Tool calls: ${runResult.toolCalls.length}`,
    `Usage: in=${runResult.usage.inputTokens} out=${runResult.usage.outputTokens}${runResult.usage.cachedInputTokens ? " cached=" + runResult.usage.cachedInputTokens : ""} cost≈$${costUsd.toFixed(4)}`,
    terminationLine,
    "",
    "## Task",
    "",
    instruction.trim(),
    "",
    "## Validation",
    "",
  ];
  if (validation.validatorsRun.length === 0) {
    lines.push("*No validators discovered.*");
  } else {
    for (const v of validation.validatorsRun) {
      lines.push(
        `- \`${v.validator.command}\` — **${v.validatorStatus}** (exit=${v.exitCode ?? "–"}, ${v.wallMs}ms)`,
      );
    }
  }
  lines.push("", `**Outcome**: ${summary}`, "");
  if (runResult.finalAssistant) {
    const split = splitByPhase(runResult.finalAssistant);
    if (split.commentary) {
      lines.push("## Commentary", "", split.commentary, "");
    }
    if (split.finalAnswer) {
      lines.push("## Final answer", "", split.finalAnswer, "");
    } else if (!split.commentary) {
      // Fallback: no phase info, dump the raw text.
      const raw = extractPlainText(runResult.finalAssistant.content);
      if (raw) lines.push("## Final answer", "", raw, "");
    }
  }
  return lines.join("\n");
}

async function mirrorCheckpointArtifacts(
  toolCalls: Array<{ call: ToolCallRequest; result: ToolResult }>,
  bundleDir: string,
): Promise<number> {
  const seen = new Set<string>();
  const manifestDir = path.join(bundleDir, "checkpoints", "manifest");
  await mkdir(manifestDir, { recursive: true });

  for (const tc of toolCalls) {
    if (tc.call.name !== "checkpoint_save" || tc.result.status !== "ok") continue;
    const checkpoint = parseCheckpointSaveContent(tc.result.content);
    if (!checkpoint?.commitSha) continue;
    seen.add(checkpoint.commitSha);
    if (!checkpoint.manifestPath) continue;
    try {
      await copyFile(
        checkpoint.manifestPath,
        path.join(manifestDir, `${checkpoint.commitSha}.json`),
      );
    } catch {
      // Best-effort artifact mirroring only. The checkpoint itself already
      // succeeded; a missing/cross-container manifest path should not fail
      // the autonomous run.
    }
  }

  return seen.size;
}

function parseCheckpointSaveContent(
  content: unknown,
): { commitSha: string; manifestPath?: string } | null {
  let obj: unknown = content;
  if (typeof content === "string") {
    try {
      obj = JSON.parse(content);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return null;
  const rec = obj as Record<string, unknown>;
  if (typeof rec.commitSha !== "string" || rec.commitSha.length === 0) return null;
  return {
    commitSha: rec.commitSha,
    ...(typeof rec.manifestPath === "string" && rec.manifestPath.length > 0
      ? { manifestPath: rec.manifestPath }
      : {}),
  };
}

/**
 * Split an assistant HistoryItem's text content by OpenAI phase markers.
 * Anthropic currently doesn't carry a `phase` field — its output all falls
 * under `finalAnswer`. On OpenAI, `phase: "commentary"` is preamble text the
 * model emits before tool calls; `phase: "final_answer"` is the closing text.
 */
function splitByPhase(item: HistoryItem): { commentary: string; finalAnswer: string } {
  const text = extractPlainText(item.content);
  if (!text) return { commentary: "", finalAnswer: "" };
  if (item.phase === "commentary") return { commentary: text, finalAnswer: "" };
  return { commentary: "", finalAnswer: text };
}

interface BuildOutcomeOpts {
  runId: string;
  bundleDir: string;
  presetId: string;
  presetRevision: string;
  providerModelIds?: string[];
  status: OpenApexStatus;
  exitCode: ExitCode;
  summary: string;
  validationStatus?: "passed" | "failed" | "unknown";
  usage?: TokenUsage;
  costUsd?: number;
  providerId?: "openai" | "anthropic";
  checkpointCount?: number;
}

function buildOutcome(opts: BuildOutcomeOpts): AutonomousOutcome {
  const usage = opts.usage ?? { inputTokens: 0, outputTokens: 0 };
  const costUsd = opts.costUsd ?? 0;
  const byProvider: Record<string, TokenUsage> = {};
  if (opts.providerId) byProvider[opts.providerId] = usage;
  const result: OpenApexResult = {
    schema_version: "open-apex-result.v1",
    run_id: opts.runId,
    status: opts.status,
    exit_status: opts.exitCode,
    validation_status: opts.validationStatus ?? "unknown",
    summary: opts.summary,
    artifact_paths: {
      result: path.join(opts.bundleDir, "result.json"),
      trajectory: path.join(opts.bundleDir, "trajectory.json"),
      events: path.join(opts.bundleDir, "events.jsonl"),
      replay: path.join(opts.bundleDir, "replay.md"),
      summary: path.join(opts.bundleDir, "summary.json"),
      checkpoints_dir: path.join(opts.bundleDir, "checkpoints"),
      logs_dir: path.join(opts.bundleDir, "logs"),
    },
    usage: {
      total_input_tokens: usage.inputTokens,
      total_output_tokens: usage.outputTokens,
      total_cached_tokens: usage.cachedInputTokens ?? 0,
      total_cost_usd: costUsd,
      by_provider: byProvider,
    },
    checkpoint_count: opts.checkpointCount ?? 0,
    preset_id: opts.presetId,
    preset_revision: opts.presetRevision,
    provider_model_ids: opts.providerModelIds ?? [],
    overrides_applied: [],
  };
  return { exitCode: opts.exitCode, result };
}

function buildErrorOutcome(
  opts: BuildOutcomeOpts & { errorReason: string; structuredError?: OpenApexError },
): AutonomousOutcome {
  const out = buildOutcome(opts);
  out.result.error = opts.structuredError ?? { kind: "config", reason: opts.errorReason };
  return out;
}

/**
 * Format a thrown value for the stderr log + `summary` string.
 *
 * Precedence:
 *   1. `HttpError` literal (plain object w/ httpStatus) — surface
 *      `httpStatus`, `providerCode`, and a tail of `rawMessage`. This is
 *      critical: when Anthropic returns a 400 on a strict-incompatible tool
 *      schema, the adapter throws an HttpError object literal and
 *      `(err as Error).message` evaluates to `undefined`, hiding the API's
 *      actual response. Without this helper, you see "runtime error:
 *      undefined" in the logs and have to reproduce the failure live to
 *      diagnose it.
 *   2. `Error` instance — use `.message`.
 *   3. Anything else — serialize, capped at 800 chars.
 */
export function formatThrowable(err: unknown): string {
  if (isHttpError(err)) {
    const status = err.httpStatus;
    const code = err.providerCode ? ` ${err.providerCode}` : "";
    const raw = err.rawMessage ? `: ${err.rawMessage.slice(0, 800)}` : "";
    return `http ${status}${code}${raw}`;
  }
  if (err instanceof Error) {
    return err.message || err.name || "(no message)";
  }
  try {
    return JSON.stringify(err).slice(0, 800);
  } catch {
    return String(err);
  }
}

function toProviderError(err: HttpError, providerId: "openai" | "anthropic"): OpenApexError {
  const provErr: OpenApexError = {
    kind: "provider",
    providerId,
    retryable: err.transient ?? false,
    rawMessage: err.rawMessage ?? "",
  };
  if (err.httpStatus !== undefined)
    (provErr as { httpStatus?: number }).httpStatus = err.httpStatus;
  if (err.providerCode)
    (provErr as { providerErrorCode?: string }).providerErrorCode = err.providerCode;
  if (err.retryAfterMs !== undefined) {
    (provErr as { retryAfterMs?: number }).retryAfterMs = err.retryAfterMs;
  }
  return provErr;
}
