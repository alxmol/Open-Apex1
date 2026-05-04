/**
 * Telemetry contracts.
 * Locked per §3.4.5 + §5.5 + §3.5.4 (redaction) + §3.5.5 (retention).
 *
 * Every autonomous run must emit: full event timeline, model request/response
 * metadata, tool call details, token usage, cost estimates, errors, retries,
 * permission decisions, checkpoints, ATIF file, replay log, summary JSON.
 */

import type { AtifTrajectory } from "../atif/types.ts";
import type { AutonomyLevel } from "../error/types.ts";
import type { TokenUsage } from "../provider/stream.ts";
import type { ValidatorStatus } from "../orchestration/types.ts";

// ─── Events ──────────────────────────────────────────────────────────────────

export interface EventBase {
  /** Monotonic sequence within a run. */
  seq: number;
  /** ISO 8601 */
  ts: string;
  /** Session id for cross-reference. */
  session_id: string;
}

export interface ToolEvent extends EventBase {
  type: "tool_event";
  tool: string;
  call_id: string;
  action: "start" | "end" | "error";
  input?: Record<string, unknown>;
  output_summary?: string;
  status?: "ok" | "error" | "denied";
  error_type?: string;
  duration_ms?: number;
}

export interface ModelEvent extends EventBase {
  type: "model_event";
  provider: "openai" | "anthropic";
  model: string;
  stage:
    | "request_start"
    | "stream_first_byte"
    | "stream_text_delta"
    | "stream_tool_call"
    | "stream_done"
    | "retry"
    | "error"
    // Emitted by autonomous-mode startup watchdog when the first turn
    // has not begun within the stall threshold — signals that
    // checkpoint init, prompt assembly, or env-context render is
    // blocked. Paired with the `markPending` breadcrumb that records
    // which specific startup phase was pending.
    | "startup_stall"
    // Emitted when the pre-execute M4 phase graph is making progress for
    // longer than the startup threshold, so tbench artifacts do not confuse
    // active gather/synthesis work with a dead startup path.
    | "pre_execute_phase_long"
    // Best-effort breadcrumb emitted when a parent abort/timeout path writes a
    // partial result bundle before normal autonomous finalization can run.
    | "partial_timeout_result_written";
  details?: Record<string, unknown>;
}

export interface UsageEvent extends EventBase {
  type: "usage";
  provider: "openai" | "anthropic";
  model: string;
  phase?: "prediction" | "gather" | "synthesis" | "execute" | "validate" | "recover";
  usage: TokenUsage;
  cost_usd: number;
}

export interface PermissionDecisionEvent extends EventBase {
  type: "permission_decision";
  command?: string;
  call_id?: string;
  tool?: string;
  classification: unknown;
  gate?: unknown;
  autonomyLevel?: AutonomyLevel;
  decision?: "auto_allow" | "auto_deny" | "prompt_allow" | "prompt_deny" | "sandboxed";
  outcome?: "allow" | "deny";
  reason?: string;
}

export interface SearchAdviceEvent extends EventBase {
  type: "search_advice_injected";
  reason: "web_search_threshold" | "fetch_url_threshold" | "duplicate_queries";
  web_search_calls: number;
  fetch_url_calls: number;
}

export interface CheckpointEvent extends EventBase {
  type: "checkpoint";
  action: "save" | "restore" | "verify";
  commit_sha: string;
  reason?: string;
  wall_ms?: number;
}

export interface ValidationEvent extends EventBase {
  type: "validation";
  validator: string;
  status: ValidatorStatus;
  exit_code: number | null;
  stderr_tail?: string;
  wall_ms: number;
}

export interface SandboxEvent extends EventBase {
  type: "sandbox";
  action:
    | "landlock_probe"
    | "landlock_available"
    | "landlock_unavailable"
    | "sandbox_violation"
    | "shell_command_rejected"
    | "worktree_teardown";
  backend?: "landlock" | "seatbelt" | "soft";
  details?: Record<string, unknown>;
}

export interface McpIgnoredEvent extends EventBase {
  type: "mcp_server_declared_but_ignored";
  name: string;
  transport: "stdio" | "http" | "sse" | "tcp";
  command?: string;
  url?: string;
}

export interface FinalizeEvent extends EventBase {
  type: "finalize";
  reason: "normal" | "timeout_approaching" | "error" | "cancelled";
}

export type OpenApexEvent =
  | ToolEvent
  | ModelEvent
  | UsageEvent
  | PermissionDecisionEvent
  | SearchAdviceEvent
  | CheckpointEvent
  | ValidationEvent
  | SandboxEvent
  | McpIgnoredEvent
  | FinalizeEvent;

// ─── Summary JSON ─────────────────────────────────────────────────────────────

export interface SummaryJson {
  schema_version: "open-apex-summary.v1";
  run_id: string;
  status: string;
  /** Elapsed wall time in seconds. */
  duration_sec: number;
  /** Count of tool calls grouped by name. */
  tools_used: Record<string, number>;
  /** Count of permission decisions by outcome. */
  permissions: Record<
    "auto_allow" | "auto_deny" | "prompt_allow" | "prompt_deny" | "sandboxed",
    number
  >;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cached_tokens: number;
    cost_usd: number;
  };
  checkpoints: number;
  final_summary: string;
}

// ─── TelemetrySink ────────────────────────────────────────────────────────────

export interface TelemetrySink {
  /** Stream-append one event. Flushed to disk per-tool-call per §5.5. */
  emit(event: OpenApexEvent): Promise<void>;

  /** Force flush all pending writes. `partial` = true on timeout-approaching path. */
  flush(opts?: { partial: boolean }): Promise<void>;

  /** Write the final ATIF trajectory; returns the path written. */
  writeAtif(trajectory: AtifTrajectory): Promise<string>;

  /** Write the replay log (human-readable Markdown). */
  writeReplayLog(markdown: string): Promise<string>;

  /** Write the run summary JSON. */
  writeSummary(summary: SummaryJson): Promise<string>;

  /** Close the sink (flush, close file descriptors). */
  close(): Promise<void>;
}
