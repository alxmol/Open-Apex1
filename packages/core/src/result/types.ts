/**
 * Artifact bundle + OpenApexResult.
 * Locked per §3.4.10.
 *
 * Every autonomous run emits a versioned bundle rooted at `--output-dir`:
 *   <run_id>/
 *     result.json         — OpenApexResult (stdout payload)
 *     summary.json        — human-oriented summary
 *     events.jsonl        — normalized event log (append-only)
 *     replay.md           — human-readable replay
 *     trajectory.json     — ATIF-v1.6
 *     checkpoints/manifest/<sha>.json
 *     logs/orchestrator.log, logs/provider.log, logs/tools/<tool>/<call_id>.log
 *     subagents/<role>/<session_id>/trajectory.json
 */

import type { McpServerConfig } from "../benchmark/adapter.ts";
import type { OpenApexError } from "../error/types.ts";
import type { ExitCode } from "../exit/codes.ts";
import type { TokenUsage } from "../provider/stream.ts";

export type OpenApexStatus =
  | "success"
  | "task_failure"
  | "validation_unknown"
  | "permission_refusal_unrecovered"
  | "runtime_failure"
  | "config_error"
  | "benchmark_contamination_detected"
  | "timeout_approaching"
  | "cancelled_by_user";

export type ValidationStatusSummary = "passed" | "failed" | "unknown";

export interface OpenApexResultUsage {
  total_input_tokens: number;
  total_output_tokens: number;
  total_cached_tokens: number;
  total_cost_usd: number;
  by_provider: Record<string, TokenUsage>;
}

export interface OpenApexResultArtifactPaths {
  result: string;
  trajectory: string;
  events: string;
  replay: string;
  summary: string;
  checkpoints_dir: string;
  logs_dir: string;
}

export interface OpenApexResult {
  schema_version: "open-apex-result.v1";
  run_id: string;
  status: OpenApexStatus;
  exit_status: ExitCode;
  validation_status: ValidationStatusSummary;
  summary: string;
  artifact_paths: OpenApexResultArtifactPaths;
  usage: OpenApexResultUsage;
  checkpoint_count: number;
  preset_id: string;
  preset_revision: string;
  /** Ordered list of model IDs used (primary first). */
  provider_model_ids: string[];
  /** §1.2 benchmark-safe override registry — ids that actually fired. */
  overrides_applied: string[];
  /**
   * §2 non-goals: declared MCP servers that were logged-and-ignored. Mirrored
   * onto AtifAgent.extra.mcp_servers_ignored.
   */
  mcp_servers_ignored?: Array<
    Pick<McpServerConfig, "name" | "transport"> & {
      command?: string;
      url?: string;
    }
  >;
  error?: OpenApexError;
}
