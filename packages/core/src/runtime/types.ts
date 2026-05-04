/**
 * Orchestrator / Runner / RunEvent / Agent / Handoff.
 * Locked per §3.4.11 and §3.4.12.
 *
 * All Open-Apex-authored — we do NOT import `@anthropic-ai/claude-agent-sdk`
 * or `@openai/agents` at runtime (§1.1 boundary). These types are inspired by
 * SDK shapes but are our own.
 */

import type {
  EffortLevel,
  ProviderContinuationHandle,
  RequestOptions,
} from "../provider/adapter.ts";
import type { HistoryItem } from "../provider/message.ts";
import type { TokenUsage } from "../provider/stream.ts";
import type { AutonomyLevel } from "../error/types.ts";
import type {
  CanUseTool,
  PermissionDecision,
  ToolCallRequest,
  ToolDefinition,
  ToolResult,
} from "../tool/types.ts";

// ─── Run configuration and options ───────────────────────────────────────────

export interface ModelSettings {
  model?: string;
  effort?: EffortLevel;
  verbosity?: "low" | "medium" | "high";
  maxOutputTokens?: number;
  thinkingDisplay?: "summarized" | "omitted";
  reasoningSummary?: "auto" | "concise" | "detailed";
}

export type PermissionMode = AutonomyLevel;

export interface RunConfig {
  defaultModel?: string;
  defaultModelSettings?: ModelSettings;
  /** Hard ceiling on model calls per run. Default 100. */
  maxTurns?: number;
  /** Optional budget; telemetry-only by default. */
  maxBudgetUsd?: number;
  tracingDisabled?: boolean;
  workflowName?: string;
  toolErrorFormatter?: (args: { toolName: string; error: Error }) => string;
}

export interface RunOptions<TContext = unknown> {
  context?: TContext;
  maxTurns?: number;
  signal?: AbortSignal;
  hooks?: RunHooks<TContext>;
  canUseTool?: CanUseTool;
  permissionMode?: PermissionMode;
  previousResponseId?: string;
  conversationId?: string;
  modelOverride?: string;
  modelSettings?: ModelSettings;
  /** Whether the call is streaming; affects Runner.run overload selection. */
  stream?: boolean;
}

export interface Session {
  id: string;
  /** Optional handle for provider continuation. */
  providerHandle?: ProviderContinuationHandle;
}

// ─── Agent / Handoff / Hooks ─────────────────────────────────────────────────

export interface Agent<TContext = unknown, TOutput = string> {
  name: string;
  description?: string;
  instructions:
    | string
    | ((ctx: RunContext<TContext>, agent: Agent<TContext, TOutput>) => Promise<string>);
  model?: string;
  modelSettings?: ModelSettings;
  tools?: ToolDefinition[];
  handoffs?: Array<Agent<any, any> | Handoff<TContext>>;
  inputGuardrails?: Guardrail<TContext>[];
  outputGuardrails?: Guardrail<TContext>[];
  toolUseBehavior?: "run_llm_again" | "stop_on_first_tool" | { stopAtToolNames: string[] };
  hooks?: Partial<RunHooks<TContext>>;
  effort?: EffortLevel;
  permissionMode?: PermissionMode;
  maxTurns?: number;
}

export interface Handoff<TContext = unknown> {
  toolName: string;
  toolDescription: string;
  inputSchema?: Record<string, unknown>;
  onInvoke(ctx: RunContext<TContext>, argsJson: string): Promise<Agent<TContext, any>>;
  inputFilter?: (data: HandoffInputData) => Promise<HandoffInputData>;
}

export interface HandoffInputData {
  history: HistoryItem[];
  /** Context carried forward through the handoff. */
  context: unknown;
}

export interface Guardrail<TContext = unknown> {
  name: string;
  check(input: unknown, ctx: RunContext<TContext>): Promise<GuardrailResult>;
}

export type GuardrailResult = { pass: true } | { pass: false; reason: string };

export interface RunHooks<TContext = unknown> {
  onRunStart?(ctx: RunContext<TContext>, agent: Agent<TContext, any>): Promise<void>;
  onTurnStart?(ctx: RunContext<TContext>, agent: Agent<TContext, any>, turn: number): Promise<void>;
  onBeforeModel?(
    ctx: RunContext<TContext>,
    prepared: PreparedModelCall,
  ): Promise<void | PreparedModelCall>;
  onAfterModel?(ctx: RunContext<TContext>, response: ModelResponse): Promise<void>;
  onBeforeToolCall?(
    ctx: RunContext<TContext>,
    call: ToolCallRequest,
  ): Promise<void | { skipWithResult: ToolResult }>;
  onAfterToolCall?(
    ctx: RunContext<TContext>,
    call: ToolCallRequest,
    result: ToolResult,
  ): Promise<void>;
  onHandoff?(
    ctx: RunContext<TContext>,
    from: Agent<TContext, any>,
    to: Agent<TContext, any>,
  ): Promise<void>;
  onFinalOutput?(ctx: RunContext<TContext>, output: unknown): Promise<void>;
  onRunEnd?(ctx: RunContext<TContext>, result: RunResult<TContext>): Promise<void>;
}

export interface RunContext<TContext = unknown> {
  userContext: TContext;
  runId: string;
  parentRunId?: string;
  signal: AbortSignal;
  usage: TokenUsage;
}

export interface PreparedModelCall {
  systemPrompt: string;
  messages: HistoryItem[];
  tools: ToolDefinition[];
  options: RequestOptions;
}

export interface ModelResponse {
  assistantItems: HistoryItem[];
  toolCalls: ToolCallRequest[];
  usage: TokenUsage;
  providerHandle: ProviderContinuationHandle;
}

// ─── Run state / result ──────────────────────────────────────────────────────

export type OrchestratorState =
  | "idle"
  | "preparing_turn"
  | "awaiting_model"
  | "processing_response"
  | "awaiting_permission"
  | "executing_tools"
  | "switching_agent"
  | "done_final"
  | "done_error"
  | "cancelled";

export interface RunState<TContext = unknown> {
  version: 1;
  runId: string;
  originalInput: string | HistoryItem[];
  currentAgent: { name: string };
  currentTurn: number;
  history: HistoryItem[];
  pendingApprovals: ToolCallRequest[];
  context: TContext;
  snapshotTimestamp: string;
}

export interface RunResult<TContext> {
  finalOutput: unknown;
  lastAgent: Agent<TContext, any>;
  history: HistoryItem[];
  usage: TokenUsage;
  runState: RunState<TContext>;
  /** Populated when terminal state is `done_error` + tool approval unreached. */
  interruptions?: ToolCallRequest[];
}

export interface RunError {
  kind:
    | "model"
    | "tool"
    | "guardrail"
    | "max_turns"
    | "budget"
    | "permission_interrupt"
    | "provider_fatal"
    | "unknown";
  message: string;
  cause?: unknown;
}

// ─── RunEvent ────────────────────────────────────────────────────────────────

export type RunEvent =
  | { type: "run_started"; runId: string; agent: Agent<any, any> }
  | {
      type: "agent_updated";
      agent: Agent<any, any>;
      reason: "start" | "handoff";
    }
  | { type: "turn_started"; turn: number }
  | { type: "raw_model_event"; data: unknown }
  | { type: "partial_assistant"; delta: string }
  | { type: "reasoning_item"; content: string }
  | { type: "thinking_delta"; delta: string; signature?: string }
  | { type: "phase_marker"; phase: "commentary" | "final_answer" }
  | { type: "message_output_created"; item: HistoryItem }
  | { type: "tool_called"; call: ToolCallRequest }
  | {
      type: "tool_approval_requested";
      call: ToolCallRequest;
      suggestions?: PermissionUpdate[];
    }
  | {
      type: "tool_approval_resolved";
      callId: string;
      decision: PermissionDecision;
    }
  | { type: "tool_output"; result: ToolResult }
  | { type: "handoff_requested"; to: string }
  | { type: "handoff_occurred"; from: string; to: string }
  | {
      type: "hook_started";
      name: string;
      toolUseId?: string;
    }
  | {
      type: "hook_response";
      name: string;
      toolUseId?: string;
      output: unknown;
    }
  | {
      type: "compaction";
      trigger: "manual" | "auto";
      preTokens: number;
      postTokens: number;
    }
  | {
      type: "context_edit_applied";
      editType: string;
      tokensCleared: number;
    }
  | {
      type: "usage_update";
      usage: TokenUsage;
      cacheHit: boolean;
    }
  | { type: "run_errored"; error: RunError }
  | { type: "run_cancelled" }
  | { type: "run_finished"; result: RunResult<unknown> };

export interface PermissionUpdate {
  field: string;
  suggestedValue: unknown;
  reason: string;
}

// ─── Orchestrator / Runner interfaces ────────────────────────────────────────

export interface ContextUsageBreakdown {
  categories: Array<{ name: string; tokens: number }>;
  totalTokens: number;
  maxTokens: number;
  percentage: number;
}

export interface Orchestrator<TContext = unknown> {
  readonly state: OrchestratorState;
  readonly currentTurn: number;

  run(
    agent: Agent<TContext, any>,
    input: string | HistoryItem[] | RunState<TContext>,
    options?: RunOptions<TContext>,
  ): AsyncIterable<RunEvent> & { readonly result: Promise<RunResult<TContext>> };

  resolveToolApproval(callId: string, decision: PermissionDecision): Promise<void>;

  interrupt(): Promise<void>;

  setPermissionMode(mode: PermissionMode): Promise<void>;
  setModel(model?: string): Promise<void>;

  getContextUsage(): Promise<ContextUsageBreakdown>;
  snapshotState(): RunState<TContext>;
}

export interface Runner {
  readonly config: Readonly<RunConfig>;

  run<TContext = unknown>(
    agent: Agent<TContext, any>,
    input: string | HistoryItem[] | RunState<TContext>,
    options?: RunOptions<TContext> & { stream?: false },
  ): Promise<RunResult<TContext>>;

  run<TContext = unknown>(
    agent: Agent<TContext, any>,
    input: string | HistoryItem[] | RunState<TContext>,
    options: RunOptions<TContext> & { stream: true },
  ): AsyncIterable<RunEvent> & { readonly result: Promise<RunResult<TContext>> };
}
