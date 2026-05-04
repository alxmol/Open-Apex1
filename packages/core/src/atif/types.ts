/**
 * ATIF (Agent Trajectory Interchange Format) v1.6 contracts.
 * Locked per §3.4.6 and §5.5.
 *
 * TypeScript mirror of Harbor's Pydantic models. Every Harbor model is
 * `extra="forbid"` — unknown fields fail validation. The writer MUST pass
 * `python -m harbor.utils.trajectory_validator` on every emitted trajectory.
 *
 * Schema version is pinned at v1.6 (current Harbor default as of 2026-04-18).
 * The writer can optionally downgrade to v1.4/v1.5 via
 * `--trajectory-schema-version` for older Harbor consumers. Downgrades drop
 * `is_copied_context`, `tool_definitions`, multimodal ContentPart.
 */

export const ATIF_SCHEMA_VERSION = "ATIF-v1.6" as const;
export type AtifSchemaVersion = "ATIF-v1.4" | "ATIF-v1.5" | "ATIF-v1.6";

export type AtifSource = "system" | "user" | "agent";

// ─── Content parts ────────────────────────────────────────────────────────────

export type AtifContentPart =
  | { type: "text"; text: string }
  | {
      type: "image";
      source: {
        media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
        path: string;
      };
    };

// ─── Tool calls and observations ──────────────────────────────────────────────

export interface AtifToolCall {
  tool_call_id: string;
  function_name: string;
  /** May be {}. */
  arguments: Record<string, unknown>;
}

export interface AtifSubagentTrajectoryRef {
  session_id: string;
  trajectory_path?: string | null;
  extra?: Record<string, unknown>;
}

export interface AtifObservationResult {
  source_call_id?: string | null;
  content?: string | AtifContentPart[] | null;
  subagent_trajectory_ref?: AtifSubagentTrajectoryRef[] | null;
}

export interface AtifObservation {
  results: AtifObservationResult[];
}

// ─── Metrics ──────────────────────────────────────────────────────────────────

export interface AtifMetrics {
  prompt_tokens?: number;
  completion_tokens?: number;
  cached_tokens?: number;
  cost_usd?: number;
  /** v1.4+ */
  prompt_token_ids?: number[];
  /** v1.3+ */
  completion_token_ids?: number[];
  logprobs?: number[];
  /** Reserved bucket for provider-specific extras (reasoning_tokens etc.). */
  extra?: Record<string, unknown>;
}

export interface AtifFinalMetrics {
  total_prompt_tokens?: number;
  total_completion_tokens?: number;
  total_cached_tokens?: number;
  total_cost_usd?: number;
  total_steps?: number;
  extra?: Record<string, unknown>;
}

// ─── Steps ────────────────────────────────────────────────────────────────────

export interface AtifStep {
  /** Must equal array index + 1. */
  step_id: number;
  /** ISO 8601. */
  timestamp?: string;
  source: AtifSource;
  /** agent-only */
  model_name?: string;
  /** agent-only */
  reasoning_effort?: string | number;
  message: string | AtifContentPart[];
  /** agent-only */
  reasoning_content?: string;
  /** agent-only */
  tool_calls?: AtifToolCall[];
  observation?: AtifObservation;
  /** agent-only */
  metrics?: AtifMetrics;
  /** v1.5+ */
  is_copied_context?: boolean;
  extra?: Record<string, unknown>;
}

// ─── Agent metadata ───────────────────────────────────────────────────────────

export interface AtifAgent {
  name: string;
  version: string;
  model_name?: string;
  /** v1.5+ */
  tool_definitions?: Array<Record<string, unknown>>;
  extra?: Record<string, unknown>;
}

// ─── Trajectory ──────────────────────────────────────────────────────────────

export interface AtifTrajectory {
  schema_version: AtifSchemaVersion;
  session_id: string;
  agent: AtifAgent;
  /** min length 1. */
  steps: AtifStep[];
  notes?: string;
  final_metrics?: AtifFinalMetrics;
  continued_trajectory_ref?: string;
  extra?: Record<string, unknown>;
}

// ─── Agent-only fields (used by validator to enforce source-based invariants) ─

export const AGENT_ONLY_STEP_FIELDS = [
  "model_name",
  "reasoning_effort",
  "reasoning_content",
  "tool_calls",
  "metrics",
] as const satisfies readonly (keyof AtifStep)[];

export type AgentOnlyStepField = (typeof AGENT_ONLY_STEP_FIELDS)[number];
