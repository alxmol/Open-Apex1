import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import type {
  AgentRequest,
  CompactionOptions,
  CompactionResult,
  OpenApexContext,
  OpenApexRunContext,
  Message,
  ProviderAdapter,
  ProviderContinuationHandle,
  RequestOptions,
  StreamEvent,
  TokenCount,
  ToolDefinition,
} from "@open-apex/core";
import { MockAdapterError } from "@open-apex/core";
import { MockAnthropicAdapter } from "@open-apex/provider-anthropic";
import { MockOpenAiAdapter, openAiCapabilities } from "@open-apex/provider-openai";
import { ToolRegistryImpl, readFileTool, runShellTool, writeFileTool } from "@open-apex/tools";

import {
  DEFAULT_REEXPLORE_TURN,
  classifyValidationActionability,
  runExploratoryExecutorForChild,
  runPhaseEngine,
} from "../src/phase-engine.ts";

function mkCtx(workspace: string): OpenApexRunContext {
  const userContext: OpenApexContext = {
    workspace,
    openApexHome: path.join(workspace, ".open-apex"),
    autonomyLevel: "full_auto",
    sessionId: "m4-phase-test",
  };
  return {
    userContext,
    runId: "m4-phase-test-run",
    signal: new AbortController().signal,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

function executionContextJson(): string {
  return JSON.stringify({
    chosenApproach: "inspect then patch",
    prioritizedFacts: ["repo scout found TypeScript"],
    executionPlan: [
      {
        id: "inspect",
        description: "Read the file",
        preconditions: [],
        expectedOutcome: "Bug location known",
        validatorHook: null,
      },
    ],
    filesToInspect: ["src/index.ts"],
    filesToChange: ["src/index.ts"],
    validators: [],
    riskGuards: ["avoid destructive commands"],
    searchPivotHooks: [],
    completionChecklist: ["validator passes"],
    evidenceRefs: [{ sourceRole: "repo_scout", artifactPath: null, quote: "TypeScript repo" }],
  });
}

function strategyJson(): string {
  return JSON.stringify({
    confidence: "high",
    rankedApproaches: [
      {
        approach: "model-ranked approach",
        pros: ["uses gathered facts"],
        cons: ["needs validation"],
        confidence: 0.91,
      },
    ],
    likelyValidators: [],
    riskyOperations: [],
    failurePivots: ["inspect stderr before retrying"],
    searchPivots: ["official docs"],
  });
}

function textTurn(text: string, responseId: string, usage = { inputTokens: 3, outputTokens: 5 }) {
  return {
    events: [
      { type: "text_delta" as const, delta: text },
      { type: "usage_update" as const, usage, cacheHit: false },
      {
        type: "done" as const,
        stopReason: "end_turn" as const,
        providerHandle: {
          kind: "openai_response" as const,
          responseId,
          reasoningItemsIncluded: false,
        },
      },
    ],
  };
}

function toolTurn(
  name: string,
  args: Record<string, unknown>,
  responseId: string,
  usage = { inputTokens: 3, outputTokens: 5 },
) {
  return {
    events: [
      {
        type: "tool_call_start" as const,
        callId: `${responseId}_call`,
        name,
        argsSchema: "json" as const,
      },
      { type: "tool_call_done" as const, callId: `${responseId}_call`, args },
      { type: "usage_update" as const, usage, cacheHit: false },
      {
        type: "done" as const,
        stopReason: "end_turn" as const,
        providerHandle: {
          kind: "openai_response" as const,
          responseId,
          reasoningItemsIncluded: false,
        },
      },
    ],
  };
}

function anthropicTextTurn(text: string, usage = { inputTokens: 3, outputTokens: 5 }) {
  return {
    events: [
      { type: "text_delta" as const, delta: text },
      { type: "usage_update" as const, usage, cacheHit: false },
      {
        type: "done" as const,
        stopReason: "end_turn" as const,
        providerHandle: {
          kind: "anthropic_messages" as const,
          messages: [],
          betaHeaders: [],
        },
      },
    ],
  };
}

function anthropicToolTurn(
  name: string,
  args: Record<string, unknown>,
  usage = { inputTokens: 3, outputTokens: 5 },
) {
  const callId = `anthropic_${name}_${Math.random().toString(16).slice(2)}`;
  return {
    events: [
      {
        type: "tool_call_start" as const,
        callId,
        name,
        argsSchema: "json" as const,
      },
      { type: "tool_call_done" as const, callId, args },
      { type: "usage_update" as const, usage, cacheHit: false },
      {
        type: "done" as const,
        stopReason: "tool_use" as const,
        providerHandle: {
          kind: "anthropic_messages" as const,
          messages: [],
          betaHeaders: [],
        },
      },
    ],
  };
}

function anthropicSynthesisTurn() {
  return anthropicToolTurn("emit_execution_context", {
    executionContext: JSON.parse(executionContextJson()),
  });
}

function emptyTurn(responseId: string, usage = { inputTokens: 3, outputTokens: 0 }) {
  return {
    events: [
      { type: "text_delta" as const, delta: "   " },
      { type: "usage_update" as const, usage, cacheHit: false },
      {
        type: "done" as const,
        stopReason: "end_turn" as const,
        providerHandle: {
          kind: "openai_response" as const,
          responseId,
          reasoningItemsIncluded: false,
        },
      },
    ],
  };
}

function verifierJson(): string {
  return JSON.stringify({
    confidence: "medium",
    findings: [
      {
        finding: "minimal safe fallback passed but does not prove task completion",
        evidence: "py_compile checks syntax only",
        severity: "warning",
      },
    ],
    diffsReviewed: [],
    logsReviewed: ["validation"],
    validatorsReviewed: ["py_compile"],
  });
}

class HangingStrategyAdapter implements ProviderAdapter {
  readonly recordedCalls: Array<{ req: AgentRequest; opts: RequestOptions }> = [];
  private cursor = 0;

  constructor(private readonly turns: StreamEvent[][]) {}

  async *generate(req: AgentRequest, opts: RequestOptions): AsyncIterable<StreamEvent> {
    this.recordedCalls.push({ req, opts });
    if (opts.structuredOutput?.name === "strategy_planner_result") {
      await new Promise((_resolve, reject) => {
        opts.signal?.addEventListener("abort", () => reject(new Error("strategy aborted")), {
          once: true,
        });
      });
      return;
    }
    yield* this.nextTurn();
  }

  async *resume(
    _handle: ProviderContinuationHandle,
    req: AgentRequest,
    opts: RequestOptions,
  ): AsyncIterable<StreamEvent> {
    yield* this.generate(req, opts);
  }

  async countTokens(_messages: Message[], _opts: RequestOptions): Promise<TokenCount> {
    return { inputTokens: 0 };
  }

  getCapabilities() {
    return openAiCapabilities("gpt-5.4");
  }

  async startConversation() {
    return { applicable: false as const, reason: "not needed" };
  }

  async compact(
    _handle: ProviderContinuationHandle,
    _opts: CompactionOptions,
  ): Promise<CompactionResult> {
    return { applicable: false, reason: "not needed" };
  }

  private async *nextTurn(): AsyncIterable<StreamEvent> {
    const events = this.turns[this.cursor++];
    if (!events) throw new MockAdapterError("HangingStrategyAdapter script exhausted");
    for (const event of events) yield event;
  }
}

describe("runPhaseEngine (§M4)", () => {
  test("defaults mid-execution re-exploration to turn 20", () => {
    expect(DEFAULT_REEXPLORE_TURN).toBe(20);
  });

  test("Opus threshold with successful shell progress skips expensive re-explore", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "oa-m4-opus-reexplore-skip-"));
    const fakeShell: ToolDefinition = {
      name: "shell_command",
      description: "fake shell",
      kind: "shell",
      parameters: {
        type: "object",
        required: ["command"],
        additionalProperties: false,
        properties: { command: { type: "string" } },
      },
      permissionClass: "CLASSIFIED",
      async execute() {
        return { content: { exitCode: 0, stdout: "progress\n", stderr: "", timedOut: false } };
      },
      errorCodes: [],
    };
    const adapter = new MockAnthropicAdapter({
      modelId: "claude-opus-4-6",
      script: {
        turns: [
          anthropicToolTurn("shell_command", { command: "echo progress" }),
          anthropicTextTurn("done"),
        ],
      },
    });
    const events: string[] = [];

    await runPhaseEngine({
      adapter,
      systemPrompt: "sys",
      synthesisPrompt: "synthesize",
      taskInstruction: "Make progress.",
      initialMessages: [{ role: "user", content: "Make progress." }],
      tools: [fakeShell],
      toolRegistry: new Map([["shell_command", fakeShell]]),
      ctx: mkCtx(workspace),
      maxTurns: 3,
      reExploreTurn: 1,
      benchmarkMode: true,
      skipValidation: true,
      enabled: {
        synthesis: false,
        strategyPlanner: false,
        exploratoryExecutor: false,
        verifierSubagent: false,
        webSearch: false,
        envProbe: false,
      },
      onEvent(event) {
        if (event.type === "re_explore_started") events.push("started");
        if (event.type === "re_explore_skipped_progressing") events.push(event.reason);
      },
    });

    expect(events).toEqual(["successful_serial_progress"]);
    expect(adapter.recordedCalls.length).toBe(2);
  });

  test("Opus threshold without useful progress still re-explores", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "oa-m4-opus-reexplore-start-"));
    const adapter = new MockAnthropicAdapter({
      modelId: "claude-opus-4-6",
      script: {
        turns: [
          anthropicToolTurn("write_file", {}),
          anthropicTextTurn(strategyJson()),
          anthropicSynthesisTurn(),
          anthropicTextTurn("done"),
        ],
      },
    });
    const events: string[] = [];

    await runPhaseEngine({
      adapter,
      systemPrompt: "sys",
      synthesisPrompt: "synthesize",
      taskInstruction: "Create a file.",
      initialMessages: [{ role: "user", content: "Create a file." }],
      tools: [writeFileTool as unknown as ToolDefinition],
      toolRegistry: new Map([["write_file", writeFileTool as unknown as ToolDefinition]]),
      ctx: mkCtx(workspace),
      maxTurns: 3,
      reExploreTurn: 1,
      benchmarkMode: true,
      skipValidation: true,
      enabled: {
        synthesis: false,
        strategyPlanner: false,
        exploratoryExecutor: false,
        verifierSubagent: false,
        webSearch: false,
        envProbe: false,
      },
      onEvent(event) {
        if (event.type === "re_explore_started") events.push("started");
        if (event.type === "re_explore_skipped_progressing") events.push("skipped");
      },
    });

    expect(events).toEqual(["started"]);
  });

  test("GPT threshold behavior still re-explores even after shell progress", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "oa-m4-gpt-reexplore-start-"));
    const fakeShell: ToolDefinition = {
      name: "shell_command",
      description: "fake shell",
      kind: "shell",
      parameters: {
        type: "object",
        required: ["command"],
        additionalProperties: false,
        properties: { command: { type: "string" } },
      },
      permissionClass: "CLASSIFIED",
      async execute() {
        return { content: { exitCode: 0, stdout: "progress\n", stderr: "", timedOut: false } };
      },
      errorCodes: [],
    };
    const adapter = new MockOpenAiAdapter({
      script: {
        turns: [
          toolTurn("shell_command", { command: "echo progress" }, "exec_1"),
          textTurn(strategyJson(), "strategy"),
          textTurn(executionContextJson(), "synth_update"),
          textTurn("done", "exec_2"),
        ],
      },
    });
    const events: string[] = [];

    await runPhaseEngine({
      adapter,
      systemPrompt: "sys",
      synthesisPrompt: "synthesize",
      taskInstruction: "Make progress.",
      initialMessages: [{ role: "user", content: "Make progress." }],
      tools: [fakeShell],
      toolRegistry: new Map([["shell_command", fakeShell]]),
      ctx: mkCtx(workspace),
      maxTurns: 3,
      reExploreTurn: 1,
      benchmarkMode: true,
      skipValidation: true,
      enabled: {
        synthesis: false,
        strategyPlanner: false,
        exploratoryExecutor: false,
        verifierSubagent: false,
        webSearch: false,
        envProbe: false,
      },
      onEvent(event) {
        if (event.type === "re_explore_started") events.push("started");
        if (event.type === "re_explore_skipped_progressing") events.push("skipped");
      },
    });

    expect(events).toEqual(["started"]);
  });

  test("runs predict → gather → synthesize → execute with structured ExecutionContext", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "oa-m4-phase-"));
    const adapter = new MockOpenAiAdapter({
      script: {
        turns: [
          textTurn(strategyJson(), "strategy", { inputTokens: 7, outputTokens: 11 }),
          textTurn(executionContextJson(), "synth", { inputTokens: 13, outputTokens: 17 }),
          textTurn("done", "exec", { inputTokens: 19, outputTokens: 23 }),
        ],
      },
    });
    const phases: string[] = [];
    const result = await runPhaseEngine({
      adapter,
      systemPrompt: "sys",
      synthesisPrompt: "synthesize",
      taskInstruction: "Fix the bug.",
      initialMessages: [{ role: "user", content: "Fix the bug." }],
      tools: [],
      toolRegistry: new Map(),
      ctx: mkCtx(workspace),
      skipValidation: true,
      enabled: {
        exploratoryExecutor: false,
        webSearch: false,
        envProbe: false,
      },
      onEvent(event) {
        if (event.type === "phase_started") phases.push(event.phase);
      },
    });

    expect(phases).toContain("predict");
    expect(phases).toContain("gather");
    expect(phases).toContain("synthesize");
    expect(phases).toContain("execute");
    expect(result.executionContext.chosenApproach).toBe("inspect then patch");
    expect(result.subagentResults.some((r) => r.role === "strategy_planner")).toBe(true);
    expect(result.runResult.finalAssistant).not.toBeNull();
    expect(result.usage.inputTokens).toBe(39);
    expect(result.usage.outputTokens).toBe(51);
    expect(adapter.recordedCalls.length).toBe(3);
    expect(
      (adapter.recordedCalls[0]!.payload as { opts: { structuredOutput?: { name: string } } }).opts
        .structuredOutput?.name,
    ).toBe("strategy_planner_result");
    expect(
      (adapter.recordedCalls[1]!.payload as { opts: { structuredOutput?: { name: string } } }).opts
        .structuredOutput?.name,
    ).toBe("execution_context");
  });

  test("strategy planner gathers with tools before a no-tool structured final turn", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "oa-m4-structured-final-"));
    const readFile: ToolDefinition = {
      name: "read_file",
      description: "read a file",
      kind: "function",
      parameters: {
        type: "object",
        required: ["path"],
        additionalProperties: false,
        properties: { path: { type: "string" } },
      },
      permissionClass: "READ_ONLY",
      async execute() {
        return { content: "file excerpt" };
      },
      errorCodes: [],
    };
    const adapter = new MockOpenAiAdapter({
      script: {
        turns: [
          toolTurn("read_file", { path: "src/index.ts" }, "strategy-tool", {
            inputTokens: 2,
            outputTokens: 3,
          }),
          textTurn("Observed the file and validator hints.", "strategy-notes", {
            inputTokens: 5,
            outputTokens: 7,
          }),
          textTurn(strategyJson(), "strategy-final", { inputTokens: 11, outputTokens: 13 }),
          textTurn(executionContextJson(), "synth", { inputTokens: 17, outputTokens: 19 }),
          textTurn("done", "exec", { inputTokens: 23, outputTokens: 29 }),
        ],
      },
    });

    const result = await runPhaseEngine({
      adapter,
      systemPrompt: "sys",
      synthesisPrompt: "synthesize",
      taskInstruction: "Fix the bug after reading src/index.ts.",
      initialMessages: [{ role: "user", content: "Fix the bug after reading src/index.ts." }],
      tools: [readFile],
      toolRegistry: new Map([["read_file", readFile]]),
      ctx: mkCtx(workspace),
      skipValidation: true,
      enabled: {
        exploratoryExecutor: false,
        webSearch: false,
        envProbe: false,
      },
    });

    expect(result.subagentResults.find((r) => r.role === "strategy_planner")?.confidence).toBe(
      "high",
    );
    const first = adapter.recordedCalls[0]!.payload as {
      req: { tools: unknown[] };
      opts: { structuredOutput?: { name: string } };
    };
    const final = adapter.recordedCalls[2]!.payload as {
      req: { tools: unknown[]; toolChoice?: { type: string } };
      opts: { structuredOutput?: { name: string } };
    };
    expect(first.req.tools.length).toBe(1);
    expect(first.opts.structuredOutput).toBeUndefined();
    expect(final.req.tools.length).toBe(0);
    expect(final.req.toolChoice?.type).toBe("none");
    expect(final.opts.structuredOutput?.name).toBe("strategy_planner_result");
  });

  test("runs verifier on low-confidence validator pass without promoting success", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "oa-m4-verifier-"));
    writeFileSync(path.join(workspace, "ok.py"), "print('ok')\n", "utf8");
    const adapter = new MockOpenAiAdapter({
      script: {
        turns: [
          textTurn(strategyJson(), "strategy", { inputTokens: 2, outputTokens: 3 }),
          textTurn(executionContextJson(), "synth", { inputTokens: 5, outputTokens: 7 }),
          textTurn("done", "exec", { inputTokens: 11, outputTokens: 13 }),
          textTurn(verifierJson(), "verifier", { inputTokens: 17, outputTokens: 19 }),
        ],
      },
    });
    const events: string[] = [];

    const result = await runPhaseEngine({
      adapter,
      systemPrompt: "sys",
      synthesisPrompt: "synthesize",
      taskInstruction: "Make the Python workspace correct.",
      initialMessages: [{ role: "user", content: "Make the Python workspace correct." }],
      tools: [],
      toolRegistry: new Map(),
      ctx: mkCtx(workspace),
      enabled: {
        exploratoryExecutor: false,
        webSearch: false,
        envProbe: false,
      },
      onEvent(event) {
        if (event.type === "verifier_triggered") events.push(event.reason);
      },
    });

    expect(events).toEqual(["low_confidence_pass"]);
    expect(result.verifierRuns).toBe(1);
    expect(result.subagentResults.some((r) => r.role === "verifier")).toBe(true);
    expect(result.routing.status).toBe("validation_unknown");
    expect(result.usage.inputTokens).toBe(35);
    expect(result.usage.outputTokens).toBe(42);
    expect(
      (adapter.recordedCalls[3]!.payload as { opts: { structuredOutput?: { name: string } } }).opts
        .structuredOutput?.name,
    ).toBe("verifier_result");
  });

  test("benchmark strategy planner timeout degrades to heuristic instead of stalling", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "oa-m4-timeout-"));
    const previous = process.env.OPEN_APEX_STRATEGY_PLANNER_TIMEOUT_MS;
    process.env.OPEN_APEX_STRATEGY_PLANNER_TIMEOUT_MS = "20ms";
    const adapter = new HangingStrategyAdapter([
      textTurn(executionContextJson(), "synth").events,
      textTurn("done", "exec").events,
    ]);
    const degraded: string[] = [];
    try {
      const result = await runPhaseEngine({
        adapter,
        systemPrompt: "sys",
        synthesisPrompt: "synthesize",
        taskInstruction: 'Verify the workspace with `node -e "console.log(1)"`.',
        initialMessages: [
          { role: "user", content: 'Verify the workspace with `node -e "console.log(1)"`.' },
        ],
        tools: [],
        toolRegistry: new Map(),
        ctx: mkCtx(workspace),
        benchmarkMode: true,
        skipValidation: true,
        enabled: {
          exploratoryExecutor: false,
          webSearch: false,
          envProbe: false,
        },
        onEvent(event) {
          if (event.type === "synthesis_degraded") degraded.push(event.reason);
        },
      });

      expect(degraded.some((reason) => reason.includes("strategy_planner timed out"))).toBe(true);
      expect(result.subagentResults.some((r) => r.role === "strategy_planner")).toBe(true);
      expect(result.executionContext.chosenApproach).toBe("inspect then patch");
    } finally {
      if (previous === undefined) delete process.env.OPEN_APEX_STRATEGY_PLANNER_TIMEOUT_MS;
      else process.env.OPEN_APEX_STRATEGY_PLANNER_TIMEOUT_MS = previous;
    }
  });

  test("empty structured planner response emits schema-empty telemetry and falls back", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "oa-m4-empty-json-"));
    const adapter = new MockOpenAiAdapter({
      script: {
        turns: [
          emptyTurn("strategy-empty"),
          emptyTurn("strategy-empty-2"),
          textTurn(executionContextJson(), "synth"),
          textTurn("done", "exec"),
        ],
      },
    });
    const events: string[] = [];

    const result = await runPhaseEngine({
      adapter,
      systemPrompt: "sys",
      synthesisPrompt: "synthesize",
      taskInstruction: "Fix the bug.",
      initialMessages: [{ role: "user", content: "Fix the bug." }],
      tools: [],
      toolRegistry: new Map(),
      ctx: mkCtx(workspace),
      skipValidation: true,
      enabled: {
        exploratoryExecutor: false,
        webSearch: false,
        envProbe: false,
      },
      onEvent(event) {
        if (event.type === "subagent_json_schema_empty") events.push(event.role);
        if (event.type === "synthesis_degraded") events.push(event.reason);
      },
    });

    expect(events).toContain("strategy_planner");
    expect(events.some((event) => event.includes("structured output empty"))).toBe(true);
    expect(result.subagentResults.find((r) => r.role === "strategy_planner")?.confidence).toBe(
      "medium",
    );
  });

  test("empty structured planner response retries once before fallback", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "oa-m4-json-retry-"));
    const adapter = new MockOpenAiAdapter({
      script: {
        turns: [
          emptyTurn("strategy-empty"),
          textTurn(strategyJson(), "strategy-retry"),
          textTurn(executionContextJson(), "synth"),
          textTurn("done", "exec"),
        ],
      },
    });
    const events: string[] = [];

    const result = await runPhaseEngine({
      adapter,
      systemPrompt: "sys",
      synthesisPrompt: "synthesize",
      taskInstruction: "Fix the bug.",
      initialMessages: [{ role: "user", content: "Fix the bug." }],
      tools: [],
      toolRegistry: new Map(),
      ctx: mkCtx(workspace),
      skipValidation: true,
      enabled: {
        exploratoryExecutor: false,
        webSearch: false,
        envProbe: false,
      },
      onEvent(event) {
        if (event.type === "subagent_json_retry") events.push(`${event.role}:${event.reason}`);
        if (event.type === "synthesis_degraded") events.push(event.reason);
      },
    });

    expect(events).toContain("strategy_planner:empty");
    expect(events.some((event) => event.includes("structured output empty"))).toBe(false);
    expect(result.subagentResults.find((r) => r.role === "strategy_planner")?.confidence).toBe(
      "high",
    );
  });

  test("structured planner retry is skipped near benchmark deadline", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "oa-m4-json-retry-skip-"));
    const adapter = new MockOpenAiAdapter({
      script: {
        turns: [
          emptyTurn("strategy-empty"),
          textTurn(executionContextJson(), "synth"),
          textTurn("done", "exec"),
        ],
      },
    });
    const events: string[] = [];

    const result = await runPhaseEngine({
      adapter,
      systemPrompt: "sys",
      synthesisPrompt: "synthesize",
      taskInstruction: "Fix the bug.",
      initialMessages: [{ role: "user", content: "Fix the bug." }],
      tools: [],
      toolRegistry: new Map(),
      ctx: mkCtx(workspace),
      benchmarkMode: true,
      deadlineAtMs: Date.now() + 5_000,
      skipValidation: true,
      enabled: {
        exploratoryExecutor: false,
        webSearch: false,
        envProbe: false,
      },
      onEvent(event) {
        if (event.type === "subagent_json_retry_skipped") events.push(event.role);
      },
    });

    expect(events).toEqual(["strategy_planner"]);
    expect(result.subagentResults.find((r) => r.role === "strategy_planner")?.confidence).toBe(
      "medium",
    );
  });

  test("phase timeout env supports duration suffixes", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "oa-m4-timeout-suffix-"));
    const previous = process.env.OPEN_APEX_WEB_RESEARCHER_TIMEOUT_MS;
    process.env.OPEN_APEX_WEB_RESEARCHER_TIMEOUT_MS = "1ms";
    const adapter = new MockOpenAiAdapter({
      script: {
        turns: [textTurn(executionContextJson(), "synth"), textTurn("done", "exec")],
      },
    });
    const hangingSearch: ToolDefinition = {
      name: "web_search",
      description: "hangs until lane timeout",
      kind: "function",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      permissionClass: "READ_ONLY_NETWORK",
      async execute(_input, _ctx, signal) {
        await new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("search aborted")), {
            once: true,
          });
        });
        return { content: [] };
      },
      errorCodes: [],
    };
    const events: string[] = [];
    try {
      await runPhaseEngine({
        adapter,
        systemPrompt: "sys",
        synthesisPrompt: "synthesize",
        taskInstruction: 'Verify the workspace with `node -e "console.log(1)"`.',
        initialMessages: [
          { role: "user", content: 'Verify the workspace with `node -e "console.log(1)"`.' },
        ],
        tools: [hangingSearch],
        toolRegistry: new Map([["web_search", hangingSearch]]),
        ctx: mkCtx(workspace),
        benchmarkMode: true,
        skipValidation: true,
        enabled: {
          strategyPlanner: false,
          exploratoryExecutor: false,
          envProbe: false,
        },
        onEvent(event) {
          if (event.type === "subagent_lane_timed_out") {
            events.push(`${event.role}:${event.timeoutMs}`);
          }
        },
      });
      expect(events).toEqual(["web_researcher:1"]);
    } finally {
      if (previous === undefined) delete process.env.OPEN_APEX_WEB_RESEARCHER_TIMEOUT_MS;
      else process.env.OPEN_APEX_WEB_RESEARCHER_TIMEOUT_MS = previous;
    }
  });

  test("benchmark gather lane timeout degrades the lane without blocking gather", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "oa-m4-lane-timeout-"));
    const previous = process.env.OPEN_APEX_WEB_RESEARCHER_TIMEOUT_MS;
    process.env.OPEN_APEX_WEB_RESEARCHER_TIMEOUT_MS = "20ms";
    const adapter = new MockOpenAiAdapter({
      script: {
        turns: [textTurn(executionContextJson(), "synth"), textTurn("done", "exec")],
      },
    });
    const hangingSearch: ToolDefinition = {
      name: "web_search",
      description: "hangs until lane timeout",
      kind: "function",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      permissionClass: "READ_ONLY_NETWORK",
      async execute(_input, _ctx, signal) {
        await new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new Error("search aborted")), {
            once: true,
          });
        });
        return { content: [] };
      },
      errorCodes: [],
    };
    const events: string[] = [];
    try {
      const result = await runPhaseEngine({
        adapter,
        systemPrompt: "sys",
        synthesisPrompt: "synthesize",
        taskInstruction: "Inspect repository health.",
        initialMessages: [{ role: "user", content: "Inspect repository health." }],
        tools: [hangingSearch],
        toolRegistry: new Map([["web_search", hangingSearch]]),
        ctx: mkCtx(workspace),
        maxTurns: 1,
        benchmarkMode: true,
        skipValidation: true,
        enabled: {
          strategyPlanner: false,
          exploratoryExecutor: false,
          envProbe: false,
        },
        onEvent(event) {
          if (event.type === "subagent_lane_timed_out") events.push(event.role);
        },
      });

      expect(events).toEqual(["web_researcher"]);
      expect(result.subagentResults.find((r) => r.role === "web_researcher")?.confidence).toBe(
        "low",
      );
      expect(result.runResult.finalAssistant).not.toBeNull();
    } finally {
      if (previous === undefined) delete process.env.OPEN_APEX_WEB_RESEARCHER_TIMEOUT_MS;
      else process.env.OPEN_APEX_WEB_RESEARCHER_TIMEOUT_MS = previous;
    }
  });

  test("benchmark exploratory child timeout degrades without blocking gather", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "oa-m4-explore-child-timeout-"));
    const runner = path.join(workspace, "hanging-exploratory-runner.mjs");
    writeFileSync(runner, "setInterval(() => {}, 1000);\n", "utf8");
    const previous = process.env.OPEN_APEX_EXPLORATORY_EXECUTOR_TIMEOUT_MS;
    process.env.OPEN_APEX_EXPLORATORY_EXECUTOR_TIMEOUT_MS = "20ms";
    const adapter = new MockOpenAiAdapter({
      script: {
        turns: [textTurn(executionContextJson(), "synth"), textTurn("done", "exec")],
      },
    });
    const events: string[] = [];
    try {
      const result = await runPhaseEngine({
        adapter,
        systemPrompt: "sys",
        synthesisPrompt: "synthesize",
        taskInstruction: 'Verify the workspace with `node -e "console.log(1)"`.',
        initialMessages: [
          { role: "user", content: 'Verify the workspace with `node -e "console.log(1)"`.' },
        ],
        tools: [],
        toolRegistry: new Map(),
        ctx: mkCtx(workspace),
        maxTurns: 1,
        benchmarkMode: true,
        skipValidation: true,
        exploratoryRunnerPath: runner,
        enabled: {
          strategyPlanner: false,
          envProbe: false,
          webSearch: false,
        },
        onEvent(event) {
          if (event.type === "subagent_lane_timed_out") events.push(event.role);
        },
      });

      expect(events).toContain("exploratory_executor");
      expect(
        result.subagentResults.find((r) => r.role === "exploratory_executor")?.confidence,
      ).toBe("low");
      expect(result.runResult.finalAssistant).not.toBeNull();
    } finally {
      if (previous === undefined) delete process.env.OPEN_APEX_EXPLORATORY_EXECUTOR_TIMEOUT_MS;
      else process.env.OPEN_APEX_EXPLORATORY_EXECUTOR_TIMEOUT_MS = previous;
    }
  }, 15_000);

  test("benchmark exploratory child returns JSON before lingering handles exhaust lane budget", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "oa-m4-explore-child-json-"));
    const runner = path.join(workspace, "json-then-hang-exploratory-runner.mjs");
    writeFileSync(
      runner,
      [
        "const result = {",
        '  role: "exploratory_executor",',
        '  confidence: "medium",',
        "  commandsAttempted: [],",
        "  validatorOutcomes: [],",
        '  observedFailures: ["child result arrived"],',
        "  environmentDiscoveries: [],",
        '  checkpointSha: "child",',
        '  sandboxIsolationBackend: "soft"',
        "};",
        "process.stdout.write(JSON.stringify(result) + '\\n');",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      "utf8",
    );
    const previous = process.env.OPEN_APEX_EXPLORATORY_EXECUTOR_TIMEOUT_MS;
    process.env.OPEN_APEX_EXPLORATORY_EXECUTOR_TIMEOUT_MS = "2s";
    const adapter = new MockOpenAiAdapter({
      script: {
        turns: [textTurn(executionContextJson(), "synth"), textTurn("done", "exec")],
      },
    });
    const events: string[] = [];
    try {
      const result = await runPhaseEngine({
        adapter,
        systemPrompt: "sys",
        synthesisPrompt: "synthesize",
        taskInstruction: 'Sanity check with `node -e "console.log(1)"`.',
        initialMessages: [
          { role: "user", content: 'Sanity check with `node -e "console.log(1)"`.' },
        ],
        tools: [],
        toolRegistry: new Map(),
        ctx: mkCtx(workspace),
        maxTurns: 1,
        benchmarkMode: true,
        skipValidation: true,
        exploratoryRunnerPath: runner,
        enabled: {
          strategyPlanner: false,
          envProbe: false,
          webSearch: false,
        },
        onEvent(event) {
          if (event.type === "exploratory_child_result_received") events.push("received");
          if (event.type === "exploratory_child_exit_lagged") events.push("lagged");
          if (event.type === "subagent_lane_timed_out") events.push("timeout");
        },
      });

      expect(events).toContain("received");
      expect(events).toContain("lagged");
      expect(events).not.toContain("timeout");
      expect(
        result.subagentResults.find((r) => r.role === "exploratory_executor")?.confidence,
      ).toBe("medium");
    } finally {
      if (previous === undefined) delete process.env.OPEN_APEX_EXPLORATORY_EXECUTOR_TIMEOUT_MS;
      else process.env.OPEN_APEX_EXPLORATORY_EXECUTOR_TIMEOUT_MS = previous;
    }
  }, 15_000);

  test("benchmark exploratory parent skips child when no substantive probe exists", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "oa-m4-explore-parent-skip-"));
    const runner = path.join(workspace, "should-not-run.mjs");
    writeFileSync(runner, "throw new Error('child should not start');\n", "utf8");
    const adapter = new MockOpenAiAdapter({
      script: {
        turns: [textTurn(executionContextJson(), "synth"), textTurn("done", "exec")],
      },
    });
    const result = await runPhaseEngine({
      adapter,
      systemPrompt: "sys",
      synthesisPrompt: "synthesize",
      taskInstruction: "Write the final answer to /app/out.txt.",
      initialMessages: [{ role: "user", content: "Write the final answer to /app/out.txt." }],
      tools: [],
      toolRegistry: new Map(),
      ctx: mkCtx(workspace),
      maxTurns: 1,
      benchmarkMode: true,
      skipValidation: true,
      exploratoryRunnerPath: runner,
      enabled: {
        strategyPlanner: false,
        envProbe: false,
        webSearch: false,
      },
    });

    expect(result.subagentResults.find((r) => r.role === "exploratory_executor")?.confidence).toBe(
      "low",
    );
  });

  test("exploratory executor skips quickly when no substantive probe exists", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "oa-m4-explore-skip-"));
    const adapter = new MockOpenAiAdapter({ script: { turns: [] } });
    const registry = new ToolRegistryImpl();
    const tools = Array.from(registry.list()) as unknown as ToolDefinition[];
    const result = await runExploratoryExecutorForChild({
      adapter,
      systemPrompt: "sys",
      synthesisPrompt: "synthesize",
      taskInstruction: "Write the final answer to /app/out.txt.",
      initialMessages: [{ role: "user", content: "Write the final answer to /app/out.txt." }],
      tools,
      toolRegistry: new Map(tools.map((tool) => [tool.name, tool])),
      ctx: mkCtx(workspace),
      maxTurns: 1,
      benchmarkMode: false,
      skipValidation: true,
    });

    expect(result.role).toBe("exploratory_executor");
    if (result.role !== "exploratory_executor") throw new Error("expected exploratory result");
    expect(result.confidence).toBe("low");
    expect(result.commandsAttempted).toHaveLength(0);
    expect(adapter.recordedCalls).toHaveLength(0);
  });

  test("exploratory probe uses read/search/shell tools but not editor tools", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "oa-m4-explore-probe-"));
    const adapter = new MockOpenAiAdapter({
      script: {
        turns: [textTurn("validator looks runnable", "explore")],
      },
    });
    const tools: ToolDefinition[] = [
      readFileTool as unknown as ToolDefinition,
      runShellTool as unknown as ToolDefinition,
      writeFileTool as unknown as ToolDefinition,
    ];
    const result = await runExploratoryExecutorForChild({
      adapter,
      systemPrompt: "sys",
      synthesisPrompt: "synthesize",
      taskInstruction: "Please verify the exploratory environment by running `pytest -q`.",
      initialMessages: [{ role: "user", content: "probe" }],
      tools,
      toolRegistry: new Map(tools.map((tool) => [tool.name, tool])),
      ctx: mkCtx(workspace),
      maxTurns: 1,
      benchmarkMode: false,
      skipValidation: true,
    });

    expect(result.role).toBe("exploratory_executor");
    if (result.role !== "exploratory_executor") throw new Error("expected exploratory result");
    const request = adapter.recordedCalls[0]!.payload as {
      req: { tools: Array<{ name: string }> };
    };
    const toolNames = request.req.tools.map((tool) => tool.name);
    expect(toolNames).toContain("read_file");
    expect(toolNames).toContain("run_shell");
    expect(toolNames).not.toContain("write_file");
    expect(result.commandsAttempted.some((entry) => entry.command.includes("pytest -q"))).toBe(
      true,
    );
  });

  test("Opus exploratory mode runs deterministic validator probes without a model probe by default", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "oa-m4-explore-opus-"));
    const adapter = new MockAnthropicAdapter({ script: { turns: [] }, modelId: "claude-opus-4-6" });
    const tools: ToolDefinition[] = [
      readFileTool as unknown as ToolDefinition,
      runShellTool as unknown as ToolDefinition,
      writeFileTool as unknown as ToolDefinition,
    ];
    const result = await runExploratoryExecutorForChild({
      adapter,
      systemPrompt: "sys",
      synthesisPrompt: "synthesize",
      taskInstruction:
        'Please verify the exploratory environment by running `node -e "console.log(1)"`.',
      initialMessages: [{ role: "user", content: "probe" }],
      tools,
      toolRegistry: new Map(tools.map((tool) => [tool.name, tool])),
      ctx: mkCtx(workspace),
      maxTurns: 1,
      benchmarkMode: false,
      skipValidation: true,
    });

    expect(adapter.recordedCalls).toHaveLength(0);
    expect(result.role).toBe("exploratory_executor");
    if (result.role !== "exploratory_executor") throw new Error("expected exploratory result");
    expect(result.commandsAttempted.some((entry) => entry.command.includes("node -e"))).toBe(true);
  });

  test("failing no-overfull validator is actionable even though passing overfull checks are insufficient", () => {
    const actionability = classifyValidationActionability(
      {
        passed: false,
        validatorsRun: [
          {
            validator: {
              command:
                "sh -c 'OUT=$(pdflatex main.tex 2>&1); echo \"$OUT\" | grep -qiE overfull && exit 1 || exit 0'",
              confidence: "medium",
              source: "task_instruction",
              justification: "prompt requires no overfull hbox warnings",
            },
            validatorStatus: "fail",
            exitCode: 1,
            signal: null,
            stdoutTail: "Overfull \\hbox",
            stderrTail: "",
            wallMs: 10,
          },
        ],
        incompleteReasons: [],
      },
      'Compile main.tex with pdflatex with no "overfull hbox" warnings.',
    );

    expect(actionability.kind).toBe("strong_task_failure");
  });
});
