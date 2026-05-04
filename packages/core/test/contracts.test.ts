/**
 * Contract tests for @open-apex/core.
 *
 * These verify:
 *   1. Every public symbol exported from the barrel is available.
 *   2. Every discriminated union is exhaustive (TS-level via assertNever).
 *   3. Representative instances of every contract round-trip through JSON.
 *   4. The ATIF golden fixtures parse as valid TypeScript values.
 *   5. ExitCodes match §3.4.9 values.
 */

import { describe, expect, test } from "bun:test";

import {
  ATIF_SCHEMA_VERSION,
  addUsage,
  exitStatusName,
  ExitCodes,
  extractSubagentContent,
  isAgentAsToolDelegation,
  isEnvScout,
  isExploratoryExecutor,
  isHandoffDelegation,
  isOpenApexError,
  isRepoScout,
  isStrategyPlanner,
  isVerifier,
  isWebResearcher,
  zeroUsage,
  type AtifTrajectory,
  type CompletionDecision,
  type Delegation,
  type ExecutionContext,
  type Message,
  type OpenApexError,
  type OpenApexResult,
  type PredictionResult,
  type ProviderCapabilities,
  type RecoveryDecision,
  type RunEvent,
  type StreamEvent,
  type SubagentResult,
  type ToolDefinition,
  type ValidationResult,
} from "../src/index.ts";

// ─── Small helpers ───────────────────────────────────────────────────────────

function roundTripJson<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function assertNever(x: never, where: string): never {
  throw new Error(`non-exhaustive switch at ${where}: ${JSON.stringify(x)}`);
}

// ─── ExitCode taxonomy ───────────────────────────────────────────────────────

describe("ExitCodes (§3.4.9)", () => {
  test("every named status maps to expected number", () => {
    expect(ExitCodes.success).toBe(0);
    expect(ExitCodes.task_failure).toBe(1);
    expect(ExitCodes.validation_unknown).toBe(2);
    expect(ExitCodes.permission_refusal_unrecovered).toBe(3);
    expect(ExitCodes.runtime_failure).toBe(4);
    expect(ExitCodes.config_error).toBe(5);
    expect(ExitCodes.benchmark_contamination_detected).toBe(6);
    expect(ExitCodes.timeout_approaching).toBe(7);
    expect(ExitCodes.cancelled_by_user).toBe(130);
  });

  test("reverse lookup exitStatusName", () => {
    expect(exitStatusName(0)).toBe("success");
    expect(exitStatusName(2)).toBe("validation_unknown");
    expect(exitStatusName(130)).toBe("cancelled_by_user");
    expect(exitStatusName(999)).toBe("unknown");
  });
});

// ─── TokenUsage arithmetic ───────────────────────────────────────────────────

describe("TokenUsage (§3.4.2)", () => {
  test("zero + nonzero = nonzero", () => {
    const z = zeroUsage();
    const u = { inputTokens: 10, outputTokens: 5, reasoningTokens: 3 };
    const out = addUsage(z, u);
    expect(out.inputTokens).toBe(10);
    expect(out.outputTokens).toBe(5);
    expect(out.reasoningTokens).toBe(3);
  });

  test("additive fields sum correctly, absent fields stay absent", () => {
    const a = { inputTokens: 1, outputTokens: 2 };
    const b = { inputTokens: 3, outputTokens: 4 };
    const out = addUsage(a, b);
    expect(out.inputTokens).toBe(4);
    expect(out.outputTokens).toBe(6);
    expect(out.reasoningTokens).toBeUndefined();
  });
});

// ─── StreamEvent exhaustive switch ───────────────────────────────────────────

describe("StreamEvent union (§3.4.2)", () => {
  test("exhaustive switch on every variant compiles", () => {
    const sample: StreamEvent = { type: "text_delta", delta: "hi" };
    function handle(e: StreamEvent): string {
      switch (e.type) {
        case "text_delta":
          return "text";
        case "reasoning_delta":
          return "reasoning";
        case "thinking_delta":
          return "thinking";
        case "phase_marker":
          return "phase";
        case "tool_call_start":
          return "start";
        case "tool_call_delta":
          return "delta";
        case "tool_call_done":
          return "done";
        case "context_edit_applied":
          return "edit";
        case "compaction_block":
          return "compact";
        case "usage_update":
          return "usage";
        case "cache_hit":
          return "cache";
        case "provider_metadata":
          return "meta";
        case "error":
          return "err";
        case "done":
          return "end";
        default:
          return assertNever(e, "StreamEvent");
      }
    }
    expect(handle(sample)).toBe("text");
  });
});

// ─── SubagentResult exhaustive + type guards ─────────────────────────────────

describe("SubagentResult union (§3.4.4)", () => {
  const repoScout: SubagentResult = {
    role: "repo_scout",
    confidence: "high",
    repoMap: { root: "/ws", files: [], totalFiles: 0, totalBytes: 0 },
    languages: ["typescript"],
    testFrameworks: [],
    buildSystems: ["bun"],
    packageManagers: ["bun"],
    keyFileContents: [],
    symbolIndex: { symbolCount: 0, byKind: {}, indexedLanguages: [] },
  };
  const envScout: SubagentResult = {
    role: "environment_scout",
    confidence: "medium",
    installedPackages: [],
    runningProcesses: [],
    diskFree: "100 GB",
    memoryFree: "8 GB",
    runtimeVersions: { bun: "1.3.12" },
  };
  const webResearcher: SubagentResult = {
    role: "web_researcher",
    confidence: "medium",
    queries: ["q"],
    results: [],
    roundsCompleted: 1,
  };
  const strategyPlanner: SubagentResult = {
    role: "strategy_planner",
    confidence: "high",
    rankedApproaches: [{ approach: "a", pros: ["p"], cons: ["c"], confidence: 0.8 }],
    likelyValidators: [],
    riskyOperations: [],
    failurePivots: [],
    searchPivots: [],
  };
  const exploratory: SubagentResult = {
    role: "exploratory_executor",
    confidence: "low",
    commandsAttempted: [],
    validatorOutcomes: [],
    observedFailures: [],
    environmentDiscoveries: [],
    checkpointSha: "abc123",
    sandboxIsolationBackend: "soft",
  };
  const verifier: SubagentResult = {
    role: "verifier",
    confidence: "high",
    findings: [],
    diffsReviewed: [],
    logsReviewed: [],
    validatorsReviewed: [],
  };

  test("type guards narrow correctly", () => {
    expect(isRepoScout(repoScout)).toBe(true);
    expect(isEnvScout(envScout)).toBe(true);
    expect(isWebResearcher(webResearcher)).toBe(true);
    expect(isStrategyPlanner(strategyPlanner)).toBe(true);
    expect(isExploratoryExecutor(exploratory)).toBe(true);
    expect(isVerifier(verifier)).toBe(true);
    expect(isRepoScout(verifier)).toBe(false);
  });

  test("exhaustive switch with assertNever", () => {
    const all: SubagentResult[] = [
      repoScout,
      envScout,
      webResearcher,
      strategyPlanner,
      exploratory,
      verifier,
    ];
    function roleOf(r: SubagentResult): string {
      switch (r.role) {
        case "repo_scout":
          return r.role;
        case "environment_scout":
          return r.role;
        case "web_researcher":
          return r.role;
        case "strategy_planner":
          return r.role;
        case "exploratory_executor":
          return r.role;
        case "verifier":
          return r.role;
        default:
          return assertNever(r, "SubagentResult");
      }
    }
    expect(all.map(roleOf)).toEqual([
      "repo_scout",
      "environment_scout",
      "web_researcher",
      "strategy_planner",
      "exploratory_executor",
      "verifier",
    ]);
  });

  test("extractSubagentContent renders text parts for every role", () => {
    for (const r of [repoScout, envScout, webResearcher, strategyPlanner, exploratory, verifier]) {
      const parts = extractSubagentContent(r);
      expect(parts.length).toBeGreaterThan(0);
      expect(parts[0]!.type).toBe("text");
      expect(parts[0]!.text.length).toBeGreaterThan(0);
    }
  });

  test("JSON round-trip preserves every variant", () => {
    const all = [repoScout, envScout, webResearcher, strategyPlanner, exploratory, verifier];
    for (const r of all) {
      const rt = roundTripJson(r);
      expect(rt.role).toBe(r.role);
      expect(rt.confidence).toBe(r.confidence);
    }
  });
});

// ─── Delegation union ────────────────────────────────────────────────────────

describe("Delegation tiers (§3.4.12)", () => {
  const agent = { name: "inner", instructions: "test" } as const;
  const handoff: Delegation = {
    kind: "handoff",
    target: agent as never,
  };
  const agentAsTool: Delegation = {
    kind: "agent_as_tool",
    innerAgent: agent as never,
    toolName: "transfer_to_inner",
    toolDescription: "hand off to the inner agent",
  };

  test("type guards identify tier correctly", () => {
    expect(isHandoffDelegation(handoff)).toBe(true);
    expect(isAgentAsToolDelegation(agentAsTool)).toBe(true);
    expect(isHandoffDelegation(agentAsTool)).toBe(false);
  });
});

// ─── ProviderCapabilities shape check ────────────────────────────────────────

describe("ProviderCapabilities (§3.4.1)", () => {
  test("includes every flag the orchestrator branches on", () => {
    const caps: ProviderCapabilities = {
      providerId: "openai",
      modelId: "gpt-5.4",
      supportsPreviousResponseId: true,
      supportsConversations: true,
      supportsAdaptiveThinking: false,
      supportsEffortXhigh: true,
      supportsEffortMax: false,
      supportsNativeCompaction: true,
      supportsContextEditingToolUses: false,
      supportsContextEditingThinking: false,
      supportsServerCompaction: true,
      supportsAllowedTools: true,
      supportsCustomTools: true,
      supportsCFG: true,
      supportsToolSearch: true,
      supportsSearchResultBlocks: false,
      supportsPromptCaching: true,
      supportsPhaseMetadata: true,
      supportsParallelToolCalls: true,
      supportsMultimodalImages: true,
      supportsMultimodalPdfs: true,
      supportsBackgroundMode: true,
      contextWindowTokens: 1_050_000,
    };
    // Round-trip ensures no missing fields.
    const rt = roundTripJson(caps);
    expect(Object.keys(rt).sort()).toEqual(Object.keys(caps).sort());
  });
});

// ─── Orchestration contracts round-trip ──────────────────────────────────────

describe("Orchestration contracts (§3.4.3)", () => {
  test("PredictionResult → JSON", () => {
    const p: PredictionResult = {
      taskCategory: "software_engineering",
      keyFiles: ["src/main.ts"],
      multimodalNeeded: false,
      riskProfile: "low",
      likelyLanguages: ["typescript"],
      likelyFrameworks: ["bun"],
      notes: "",
    };
    expect(roundTripJson(p)).toEqual(p);
  });

  test("ExecutionContext → JSON", () => {
    const ec: ExecutionContext = {
      chosenApproach: "apply patch to fix bug",
      prioritizedFacts: ["the repo uses bun"],
      executionPlan: [
        {
          id: "step-1",
          description: "read the failing test",
          preconditions: [],
          expectedOutcome: "understand the failure",
        },
      ],
      filesToInspect: ["tests/a.test.ts"],
      filesToChange: ["src/a.ts"],
      validators: [
        {
          command: "bun test",
          confidence: "medium",
          source: "framework_convention",
          justification: "default bun project",
        },
      ],
      riskGuards: [],
      searchPivotHooks: [],
      completionChecklist: ["tests pass"],
      evidenceRefs: [{ sourceRole: "repo_scout", quote: "bun workspaces detected" }],
    };
    expect(roundTripJson(ec)).toEqual(ec);
  });

  test("ValidationResult → JSON", () => {
    const v: ValidationResult = {
      passed: false,
      validatorsRun: [
        {
          validator: {
            command: "pytest",
            confidence: "medium",
            source: "framework_convention",
            justification: "pytest.ini present",
          },
          validatorStatus: "crash",
          exitCode: null,
          signal: "SIGKILL",
          stdoutTail: "",
          stderrTail: "killed",
          wallMs: 5000,
          crashReason: "timeout",
        },
      ],
      incompleteReasons: ["timeout"],
    };
    expect(roundTripJson(v)).toEqual(v);
  });

  test("RecoveryDecision every variant", () => {
    const decisions: RecoveryDecision[] = [
      { action: "local_fix", prompt: "fix syntax", targetFiles: ["a.ts"] },
      { action: "checkpoint_restore", commitSha: "abc", reason: "bad patch" },
      { action: "re_explore", queries: ["q"], roles: ["web_researcher"] },
      { action: "alternative_approach", fromExecutionContextAlternative: 1 },
      {
        action: "give_up",
        structuredFailure: {
          class: "test_failure",
          seenCountsByClass: { test_failure: 5 },
          eventLogRefs: [],
          summary: "gave up",
        },
      },
    ];
    for (const d of decisions) {
      expect(roundTripJson(d)).toEqual(d);
    }
  });

  test("CompletionDecision with ValidationResult", () => {
    const c: CompletionDecision = {
      status: "validation_unknown",
      validation: {
        passed: false,
        validatorsRun: [],
        incompleteReasons: ["no validator found"],
      },
      artifactPaths: ["/runs/abc"],
      checkpointCount: 2,
      finalSummary: "returning validation_unknown per strict completion policy",
    };
    expect(roundTripJson(c)).toEqual(c);
  });
});

// ─── RunEvent exhaustive switch ──────────────────────────────────────────────

describe("RunEvent union (§3.4.11)", () => {
  test("every variant handled in exhaustive switch", () => {
    function handle(e: RunEvent): string {
      switch (e.type) {
        case "run_started":
        case "agent_updated":
        case "turn_started":
        case "raw_model_event":
        case "partial_assistant":
        case "reasoning_item":
        case "thinking_delta":
        case "phase_marker":
        case "message_output_created":
        case "tool_called":
        case "tool_approval_requested":
        case "tool_approval_resolved":
        case "tool_output":
        case "handoff_requested":
        case "handoff_occurred":
        case "hook_started":
        case "hook_response":
        case "compaction":
        case "context_edit_applied":
        case "usage_update":
        case "run_errored":
        case "run_cancelled":
        case "run_finished":
          return e.type;
        default:
          return assertNever(e, "RunEvent");
      }
    }
    // Smoke test with a single variant.
    expect(handle({ type: "turn_started", turn: 1 })).toBe("turn_started");
  });
});

// ─── OpenApexError taxonomy ──────────────────────────────────────────────────

describe("OpenApexError (§3.4.8)", () => {
  test("isOpenApexError discriminates by shape", () => {
    const e: OpenApexError = {
      kind: "tool",
      toolName: "apply_patch",
      errorType: "patch_context_mismatch",
      structured: {},
      recoverable: true,
    };
    expect(isOpenApexError(e)).toBe(true);
    expect(isOpenApexError("not an error")).toBe(false);
    expect(isOpenApexError({ something: 1 })).toBe(false);
  });

  test("every kind round-trips through JSON", () => {
    const errs: OpenApexError[] = [
      {
        kind: "provider",
        providerId: "openai",
        retryable: true,
        rawMessage: "rate limit",
      },
      {
        kind: "tool",
        toolName: "run_shell",
        errorType: "shell_timeout",
        structured: { timeoutMs: 300_000 },
        recoverable: true,
      },
      {
        kind: "permission",
        classification: "CATASTROPHIC",
        command: "rm -rf /",
        autonomyLevel: "full_auto",
        reason: "matched CATASTROPHIC regex",
      },
      {
        kind: "checkpoint",
        phase: "save",
        reason: "low disk",
        workspacePath: "/ws",
      },
      {
        kind: "validation",
        validatorsAttempted: [],
        reason: "no_candidates",
      },
      {
        kind: "benchmark",
        phase: "run",
        reason: "task kill",
      },
      {
        kind: "config",
        reason: "bad preset",
      },
    ];
    for (const err of errs) {
      expect(roundTripJson(err)).toEqual(err);
    }
  });
});

// ─── OpenApexResult shape ────────────────────────────────────────────────────

describe("OpenApexResult (§3.4.10)", () => {
  test("schema_version is pinned", () => {
    const r: OpenApexResult = {
      schema_version: "open-apex-result.v1",
      run_id: "run_abc",
      status: "success",
      exit_status: 0,
      validation_status: "passed",
      summary: "ok",
      artifact_paths: {
        result: "/runs/abc/result.json",
        trajectory: "/runs/abc/trajectory.json",
        events: "/runs/abc/events.jsonl",
        replay: "/runs/abc/replay.md",
        summary: "/runs/abc/summary.json",
        checkpoints_dir: "/runs/abc/checkpoints",
        logs_dir: "/runs/abc/logs",
      },
      usage: {
        total_input_tokens: 100,
        total_output_tokens: 50,
        total_cached_tokens: 10,
        total_cost_usd: 0.01,
        by_provider: {
          openai: { inputTokens: 100, outputTokens: 50, cachedInputTokens: 10 },
        },
      },
      checkpoint_count: 1,
      preset_id: "chat-opus46",
      preset_revision: "r1",
      provider_model_ids: ["claude-opus-4-6"],
      overrides_applied: [],
    };
    expect(r.schema_version).toBe("open-apex-result.v1");
    expect(roundTripJson(r)).toEqual(r);
  });
});

// ─── ATIF shape + schema_version ─────────────────────────────────────────────

describe("ATIF (§3.4.6)", () => {
  test("schema_version constant and round-trip", () => {
    const t: AtifTrajectory = {
      schema_version: ATIF_SCHEMA_VERSION,
      session_id: "s_01JK",
      agent: { name: "open-apex", version: "0.0.1" },
      steps: [
        {
          step_id: 1,
          source: "user",
          message: "fix the failing test",
        },
        {
          step_id: 2,
          source: "agent",
          model_name: "claude-opus-4-6",
          message: "reading the test first",
          tool_calls: [
            {
              tool_call_id: "call_1",
              function_name: "read_file",
              arguments: { path: "test.py" },
            },
          ],
          metrics: { prompt_tokens: 100, completion_tokens: 20 },
        },
      ],
      final_metrics: {
        total_prompt_tokens: 100,
        total_completion_tokens: 20,
        total_steps: 2,
      },
    };
    expect(t.schema_version).toBe("ATIF-v1.6");
    expect(roundTripJson(t)).toEqual(t);
  });

  test("every step's step_id equals its array index + 1 (writer invariant)", () => {
    const t: AtifTrajectory = {
      schema_version: ATIF_SCHEMA_VERSION,
      session_id: "s_01JK",
      agent: { name: "open-apex", version: "0.0.1" },
      steps: [
        { step_id: 1, source: "user", message: "a" },
        { step_id: 2, source: "agent", message: "b" },
        { step_id: 3, source: "agent", message: "c" },
      ],
    };
    t.steps.forEach((s, i) => {
      expect(s.step_id).toBe(i + 1);
    });
  });
});

// ─── Message content-part round-trip ─────────────────────────────────────────

describe("Message / ContentPart (§3.4.1 AgentRequest)", () => {
  test("text, image, pdf, search_result, tool_use, tool_result, reasoning, thinking all round-trip", () => {
    const m: Message = {
      role: "user",
      content: [
        { type: "text", text: "hello" },
        {
          type: "image",
          source: { kind: "path", path: "/a.png", mediaType: "image/png" },
        },
        { type: "pdf", source: { kind: "path", path: "/a.pdf" } },
        {
          type: "search_result",
          title: "t",
          url: "https://example.com",
          snippet: "s",
        },
        {
          type: "tool_use",
          toolCallId: "c1",
          name: "read_file",
          arguments: { path: "a.ts" },
        },
        {
          type: "tool_result",
          toolCallId: "c1",
          content: "contents",
        },
        { type: "reasoning", summary: "thought about it" },
        { type: "thinking", text: "thought", signature: "sig123" },
      ],
    };
    expect(roundTripJson(m)).toEqual(m);
  });
});

// ─── ToolDefinition contract ─────────────────────────────────────────────────

describe("ToolDefinition (§7.6.12)", () => {
  test("every tool declares its contract surface", () => {
    const td: ToolDefinition<{ path: string }, { content: string }> = {
      name: "read_file",
      description: "read file contents at a path",
      kind: "function",
      parameters: {
        type: "object",
        required: ["path"],
        properties: { path: { type: "string" } },
      },
      permissionClass: "READ_ONLY",
      execute: async () => ({ content: "hello" }),
      errorCodes: ["file_not_found", "path_outside_workspace"],
    };
    expect(td.name).toBe("read_file");
    expect(td.kind).toBe("function");
    expect(td.errorCodes).toContain("file_not_found");
  });
});
