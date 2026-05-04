/**
 * Error taxonomy.
 * Locked per §3.4.8.
 *
 * All runtime errors serialize to one of these shapes. The CLI writes them
 * into `result.json.error` and the replay log.
 */

import type { ValidatorCandidate } from "../subagent/types.ts";

export type OpenApexError =
  | ProviderError
  | ToolError
  | PermissionError
  | CheckpointError
  | ValidationError
  | BenchmarkError
  | ConfigError;

export interface ProviderError {
  kind: "provider";
  providerId: "openai" | "anthropic";
  httpStatus?: number;
  providerErrorCode?: string;
  retryable: boolean;
  retryAfterMs?: number;
  rawMessage: string;
}

export type ToolErrorType =
  | "bad_args"
  | "file_not_found"
  | "file_exists"
  | "binary_file"
  | "patch_parse_error"
  | "patch_context_mismatch"
  | "path_missing"
  | "hunk_offset_exhausted"
  | "search_replace_ambiguous"
  | "search_replace_not_found"
  | "shell_timeout"
  | "shell_non_zero_exit"
  | "shell_not_found"
  | "path_outside_workspace"
  | "nonexistent_target"
  | "encoding_error"
  | "file_too_large"
  | "file_stale_read"
  | "is_directory"
  | "destination_exists"
  | "job_not_found"
  | "job_name_conflict"
  | "wait_timeout"
  | "symbol_not_found"
  | "invalid_regex"
  | "unsupported_format"
  | "asset_too_large"
  | "asset_budget_exceeded"
  | "multimodal_unavailable"
  | "http_error"
  | "blocked_domain"
  | "fetch_timeout"
  | "search_disabled"
  | "search_failed"
  | "permission_denied";

export interface ToolError {
  kind: "tool";
  toolName: string;
  errorType: ToolErrorType;
  structured: Record<string, unknown>;
  recoverable: boolean;
}

export type PermissionClassification =
  | "READ_ONLY"
  | "REVERSIBLE"
  | "MUTATING"
  | "DESTRUCTIVE"
  | "CATASTROPHIC"
  | "UNKNOWN";

export type AutonomyLevel = "readonly" | "low" | "medium" | "high" | "full_auto";

export interface PermissionError {
  kind: "permission";
  classification: PermissionClassification;
  command: string;
  autonomyLevel: AutonomyLevel;
  reason: string;
}

export interface CheckpointError {
  kind: "checkpoint";
  phase: "init" | "save" | "restore" | "verify";
  reason: string;
  workspacePath: string;
}

export interface ValidationError {
  kind: "validation";
  validatorsAttempted: ValidatorCandidate[];
  reason: "unknown_validator" | "validator_failed" | "timeout" | "no_candidates";
}

export interface BenchmarkError {
  kind: "benchmark";
  phase: "install" | "setup" | "run" | "finalize";
  harborTaskId?: string;
  reason: string;
}

export interface ConfigError {
  kind: "config";
  path?: string;
  field?: string;
  reason: string;
}

/** Type guard: anything matches `OpenApexError` shape. */
export function isOpenApexError(e: unknown): e is OpenApexError {
  return (
    typeof e === "object" &&
    e !== null &&
    "kind" in e &&
    typeof (e as { kind: unknown }).kind === "string"
  );
}
