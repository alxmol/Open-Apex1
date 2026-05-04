/**
 * Tool contracts.
 * Locked per §7.6.12 "Tool inventory reference" + §3.4.13 scheduler.
 *
 * Every tool lives in `packages/tools/src/<name>.ts` and registers via
 * a single `ToolRegistry`.
 */

import type { ContentPart } from "../provider/message.ts";
import type { RunContext } from "../runtime/types.ts";

export type ToolKind = "function" | "editor" | "shell" | "apply_patch";

/**
 * Permission-class hint. `CLASSIFIED` means defer to the §7.6.1 runtime
 * classifier — the classifier inspects argv and returns the real tier.
 */
export type PermissionClassHint =
  | "READ_ONLY"
  | "READ_ONLY_NETWORK"
  | "REVERSIBLE"
  | "MUTATING"
  | "DESTRUCTIVE"
  | "CATASTROPHIC"
  | "CLASSIFIED";

/** JSON Schema draft-2020-12. */
export type JsonSchema = Record<string, unknown>;

/**
 * Open-Apex-specific fields that tools read from `RunContext.userContext`.
 * The runtime populates a concrete `RunContext<OpenApexContext>` for the
 * tool loop; subagent child runs get their own context of the same shape.
 */
export interface OpenApexContext {
  /** Absolute workspace path; enforced by runtime. */
  workspace: string;
  /** $OPEN_APEX_HOME */
  openApexHome: string;
  /** Current autonomy level for this session. */
  autonomyLevel: import("../error/types.ts").AutonomyLevel;
  /** Telemetry sink handle. Nullable so unit tests can skip wiring. */
  telemetry?: import("../storage/telemetry.ts").TelemetrySink;
  /** Session id for correlation in logs and ATIF observations. */
  sessionId: string;
}

/** Convenience alias: the RunContext shape every Open-Apex tool receives. */
export type OpenApexRunContext = RunContext<OpenApexContext>;

export interface ToolCallRequest {
  /** Unique call id for the turn. */
  id: string;
  name: string;
  arguments: Record<string, unknown> | string;
}

export interface ToolExecuteResult<TResult = unknown> {
  /** Structured tool output. */
  content: string | ContentPart[] | TResult;
  /** True when the tool ran but returned an error condition (not a thrown exception). */
  isError?: boolean;
  errorType?: import("../error/types.ts").ToolErrorType;
  /** Arbitrary structured metadata for telemetry. */
  metadata?: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  status: "ok" | "error" | "denied";
  content: string | ContentPart[] | unknown;
  errorType?: import("../error/types.ts").ToolErrorType;
  /** Tool-owned diagnostics for telemetry; not rendered back to the model. */
  metadata?: Record<string, unknown>;
  startedAt: number;
  endedAt: number;
}

/**
 * Approval callback type used by the orchestrator.
 * Returns a decision; a null return is treated as deny+interrupt.
 */
export type CanUseTool = (
  call: ToolCallRequest,
  ctx: OpenApexRunContext,
) => Promise<PermissionDecision>;

export type PermissionDecision =
  | { kind: "allow" }
  | { kind: "allow_with_modifications"; updatedInput: Record<string, unknown> }
  | { kind: "deny"; reason: string; interrupt?: boolean };

export interface ToolDefinition<TParams = unknown, TResult = unknown> {
  /** Unique across registry. */
  name: string;
  /** Rendered into system prompt (§7.6.11 position 4). */
  description: string;
  kind: ToolKind;
  parameters: JsonSchema;
  permissionClass: PermissionClassHint;
  /**
   * Sometimes needs-approval is dynamic (e.g., shell command classifier).
   * Static boolean or predicate.
   */
  needsApproval?: boolean | ((input: TParams, ctx: OpenApexRunContext) => Promise<boolean>);
  execute(
    input: TParams,
    ctx: OpenApexRunContext,
    signal: AbortSignal,
  ): Promise<ToolExecuteResult<TResult>>;
  /** Enumerable set of error-type strings this tool may emit. */
  errorCodes: readonly string[];
}

/** Tool registry — single source of truth for available tools. */
export interface ToolRegistry {
  register<TParams, TResult>(tool: ToolDefinition<TParams, TResult>): void;
  get(name: string): ToolDefinition | undefined;
  list(): ToolDefinition[];
  /** Tools filtered per-turn based on preset `enabled` + `allowedTools`. */
  listAllowed(allowed: string[] | undefined, excluded: string[] | undefined): ToolDefinition[];
}
