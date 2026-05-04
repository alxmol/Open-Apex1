/**
 * Tool scheduler — §3.4.13.
 *
 * Partitions tool calls into:
 *   - function-kind: run in parallel via Promise.all
 *   - editor / shell / apply_patch: run serially to preserve workspace safety
 *
 * Per-tool lifecycle: validate_args → classify → gate_approval → dispatch →
 * execute → flush_events.
 *
 * M2 wires the full \u00a77.6.1 classifier into shell-like argv calls. M3 extends
 * the same classify+gate path to every tool via its `permissionClass`, with
 * special network classification for `fetch_url`.
 */

import {
  classifyNetworkInvocation,
  classifyCommand,
  gateDecision,
  type ClassifierTier,
  type ClassifierResult,
  type GateDecision,
} from "@open-apex/tools";

import { statSync } from "node:fs";
import * as path from "node:path";

import type {
  JsonSchema,
  OpenApexRunContext,
  ToolCallRequest,
  ToolDefinition,
  ToolResult,
} from "@open-apex/core";

export interface ScheduleOptions {
  /** Per-batch cancellation. */
  abort?: AbortSignal;
  /**
   * Exact tool names sent on the provider request for this turn. Providers can
   * occasionally replay or emit a tool that was suppressed from the current
   * manifest; this runtime allowlist keeps request-side restrictions honest.
   */
  activeToolNames?: Iterable<string>;
  /** Observer for telemetry. */
  onEvent?: (ev: SchedulerEvent) => void;
  /**
   * Runtime approval callback. Called after the classifier + autonomy gate
   * when the gate returns `prompt` or `sandbox`. Default (autonomous mode,
   * full_auto) auto-allows everything the gate didn't reject. Chat-mode
   * callbacks can surface a confirmation card and return `{ kind: "deny" }`.
   *
   * `reject` decisions from the gate (CATASTROPHIC) never reach this
   * callback — they are denied before dispatch.
   */
  canUseTool?: (args: CanUseToolArgs) => Promise<CanUseToolDecision>;
  /**
   * Runtime-owned patch-recovery escape hatch. When a path is present here,
   * one write_file call for that exact workspace-relative path may overwrite
   * an existing file; the scheduler injects the hidden __recovery flag.
   */
  recoveryWriteFileOpenFor?: Set<string>;
}

export interface CanUseToolArgs {
  call: ToolCallRequest;
  tool: ToolDefinition;
  ctx: OpenApexRunContext;
  classification: ClassifierResult;
  gate: GateDecision;
}

export type CanUseToolDecision = { kind: "allow" } | { kind: "deny"; reason: string };

export type SchedulerEvent =
  | { type: "tool_called"; call: ToolCallRequest }
  | { type: "tool_output"; result: ToolResult }
  | {
      type: "tool_unavailable_this_turn";
      call: ToolCallRequest;
      availableTools: string[];
    }
  | {
      type: "permission_decision";
      callId: string;
      tool: string;
      classification: ClassifierResult;
      gate: GateDecision;
      outcome: "allow" | "deny";
      reason?: string;
    };

/**
 * Execute a batch of tool calls. Returns results in the same order as input.
 */
export async function executeToolBatch(
  calls: ToolCallRequest[],
  tools: Map<string, ToolDefinition>,
  ctx: OpenApexRunContext,
  opts: ScheduleOptions = {},
): Promise<ToolResult[]> {
  const results = new Array<ToolResult>(calls.length);
  const pending: Array<Promise<void>> = [];
  const assetBudget = { count: 0, bytes: 0 };
  const activeToolNames = opts.activeToolNames !== undefined ? new Set(opts.activeToolNames) : null;
  const availableTools = activeToolNames ? [...activeToolNames].sort() : [];

  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]!;
    if (activeToolNames && !activeToolNames.has(call.name)) {
      const now = Date.now();
      const r: ToolResult = {
        toolCallId: call.id,
        status: "error",
        content: `tool_unavailable_this_turn: ${call.name} was not offered in this turn. Use one of: ${availableTools.join(", ")}`,
        errorType: "bad_args",
        metadata: {
          toolUnavailableThisTurn: true,
          availableTools,
        },
        startedAt: now,
        endedAt: now,
      };
      results[i] = r;
      opts.onEvent?.({ type: "tool_called", call });
      opts.onEvent?.({ type: "tool_unavailable_this_turn", call, availableTools });
      opts.onEvent?.({ type: "tool_output", result: r });
      continue;
    }
    const tool = tools.get(call.name);
    if (!tool) {
      results[i] = {
        toolCallId: call.id,
        status: "error",
        content: `unknown tool: ${call.name}`,
        errorType: "bad_args",
        startedAt: Date.now(),
        endedAt: Date.now(),
      };
      continue;
    }

    // Parse arguments once so both classifier + execute see the same shape.
    let input =
      typeof call.arguments === "string"
        ? (safeJson(call.arguments) ?? call.arguments)
        : call.arguments;

    const inputErrors = validateToolInput(tool, input);
    if (inputErrors.length > 0) {
      const now = Date.now();
      const r: ToolResult = {
        toolCallId: call.id,
        status: "error",
        content: `bad_args: ${inputErrors.join("; ")}`,
        errorType: "bad_args",
        startedAt: now,
        endedAt: now,
      };
      results[i] = r;
      opts.onEvent?.({ type: "tool_called", call });
      opts.onEvent?.({ type: "tool_output", result: r });
      continue;
    }

    const recoveryWriteRel = maybeOpenRecoveryWrite(call.name, input, ctx, opts);
    if (recoveryWriteRel !== null && input && typeof input === "object" && !Array.isArray(input)) {
      input = { ...(input as Record<string, unknown>), __recovery: true };
    }

    const assetBudgetError = maybeReserveReadAssetBudget(call, input, ctx, assetBudget);
    if (assetBudgetError) {
      results[i] = assetBudgetError;
      opts.onEvent?.({ type: "tool_called", call });
      opts.onEvent?.({ type: "tool_output", result: assetBudgetError });
      continue;
    }

    const preflight = preflightToolCall(call, input);
    if (preflight) {
      results[i] = preflight;
      opts.onEvent?.({ type: "tool_called", call });
      opts.onEvent?.({ type: "tool_output", result: preflight });
      continue;
    }

    // ─── Classify + gate_approval (sequential per \u00a73.4.13) ─────────────
    const classification = classifyToolCall(call, tool, input, ctx);
    const autonomyLevel = ctx.userContext.autonomyLevel ?? "full_auto";
    const gate = gateDecision(classification.tier, autonomyLevel, {
      sandboxAvailable:
        (ctx.userContext as { sandboxAvailable?: boolean }).sandboxAvailable === true,
    });

    // Reject gate outcome → structured permission_denied result; never reach
    // execute. No callback opportunity; CATASTROPHIC is absolute.
    if (gate.kind === "reject") {
      const reason =
        classification.reason ?? `tool rejected by classifier (tier=${classification.tier})`;
      const r: ToolResult = {
        toolCallId: call.id,
        status: "denied",
        content: `permission_denied (${classification.tier}): ${reason}`,
        errorType: "permission_denied",
        startedAt: Date.now(),
        endedAt: Date.now(),
      };
      results[i] = r;
      // Emit `tool_called` BEFORE the deny pair so telemetry sinks that bind
      // tool names by call_id record the correct tool on the resulting event.
      opts.onEvent?.({ type: "tool_called", call });
      opts.onEvent?.({
        type: "permission_decision",
        callId: call.id,
        tool: call.name,
        classification,
        gate,
        outcome: "deny",
        reason,
      });
      opts.onEvent?.({ type: "tool_output", result: r });
      continue;
    }

    // Prompt/sandbox → callback required. In autonomous/noninteractive mode,
    // no callback means deny; UNKNOWN must not silently auto-run.
    if (gate.kind !== "auto") {
      const decision = opts.canUseTool
        ? await opts.canUseTool({ call, tool, ctx, classification, gate })
        : ({
            kind: "deny",
            reason: gate.reason,
          } as CanUseToolDecision);
      if (decision.kind === "deny") {
        const r: ToolResult = {
          toolCallId: call.id,
          status: "denied",
          content: `permission_denied (${classification.tier}): ${decision.reason}`,
          errorType: "permission_denied",
          startedAt: Date.now(),
          endedAt: Date.now(),
        };
        results[i] = r;
        // Same deny-sequence ordering as the gate-reject branch:
        // tool_called → permission_decision → tool_output.
        opts.onEvent?.({ type: "tool_called", call });
        opts.onEvent?.({
          type: "permission_decision",
          callId: call.id,
          tool: call.name,
          classification,
          gate,
          outcome: "deny",
          reason: decision.reason,
        });
        opts.onEvent?.({ type: "tool_output", result: r });
        continue;
      }
      opts.onEvent?.({
        type: "permission_decision",
        callId: call.id,
        tool: call.name,
        classification,
        gate,
        outcome: "allow",
      });
    } else {
      opts.onEvent?.({
        type: "permission_decision",
        callId: call.id,
        tool: call.name,
        classification,
        gate,
        outcome: "allow",
      });
    }

    const runOne = async () => {
      const started = Date.now();
      opts.onEvent?.({ type: "tool_called", call });
      try {
        const out = await tool.execute(input, ctx, opts.abort ?? ctx.signal);
        const r: ToolResult = {
          toolCallId: call.id,
          status: out.isError ? "error" : "ok",
          content: out.content,
          startedAt: started,
          endedAt: Date.now(),
        };
        if (out.errorType !== undefined) r.errorType = out.errorType;
        if (out.metadata !== undefined) r.metadata = out.metadata;
        results[i] = r;
        opts.onEvent?.({ type: "tool_output", result: r });
      } catch (err) {
        const r: ToolResult = {
          toolCallId: call.id,
          status: "error",
          content: (err as Error).message ?? String(err),
          startedAt: started,
          endedAt: Date.now(),
        };
        results[i] = r;
        opts.onEvent?.({ type: "tool_output", result: r });
      } finally {
        if (recoveryWriteRel !== null) {
          opts.recoveryWriteFileOpenFor?.delete(recoveryWriteRel);
        }
      }
    };

    if (tool.kind === "function") {
      // Parallel-safe: kick off immediately.
      pending.push(runOne());
    } else {
      // Serial: await any in-flight parallel batch first, then this one.
      await Promise.all(pending.splice(0, pending.length));
      await runOne();
    }
  }
  await Promise.all(pending);
  return results;
}

const MAX_READ_ASSET_PER_TURN = 4;
const MAX_READ_ASSET_BYTES_PER_TURN = 20 * 1024 * 1024;

function maybeReserveReadAssetBudget(
  call: ToolCallRequest,
  input: unknown,
  ctx: OpenApexRunContext,
  budget: { count: number; bytes: number },
): ToolResult | null {
  if (call.name !== "read_asset") return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const rawPath = (input as Record<string, unknown>).path;
  if (typeof rawPath !== "string") return null;
  const ws = path.resolve(ctx.userContext.workspace);
  const abs = path.resolve(ws, rawPath);
  if (abs !== ws && !abs.startsWith(ws + path.sep)) return null;
  let size = 0;
  try {
    size = statSync(abs).size;
  } catch {
    return null;
  }
  if (
    budget.count >= MAX_READ_ASSET_PER_TURN ||
    budget.bytes + size > MAX_READ_ASSET_BYTES_PER_TURN
  ) {
    return immediateError(
      call.id,
      "asset_budget_exceeded",
      `read_asset turn budget exceeded: max ${MAX_READ_ASSET_PER_TURN} assets / ${MAX_READ_ASSET_BYTES_PER_TURN} bytes. Inspect assets selectively over multiple turns instead of attaching entire document folders.`,
    );
  }
  budget.count++;
  budget.bytes += size;
  return null;
}

function classifyToolCall(
  call: ToolCallRequest,
  tool: ToolDefinition,
  input: unknown,
  ctx: OpenApexRunContext,
): ClassifierResult {
  const networkEnabled = (ctx.userContext as { networkEnabled?: boolean }).networkEnabled ?? false;
  const allowedDomains = (ctx.userContext as { allowedDomains?: string[] }).allowedDomains;
  if (tool.kind === "shell") {
    const argv = extractShellArgv(call.name, input);
    if (argv && argv.length > 0) {
      return classifyCommand(argv, {
        networkEnabled,
        workspaceRoot: ctx.userContext.workspace,
        ...(allowedDomains ? { allowedDomains } : {}),
      });
    }
    return {
      tier: "UNKNOWN",
      rule: "shell_unclassified",
      reason: `${call.name}: shell input shape could not be classified`,
    };
  }

  if (call.name === "fetch_url") {
    const i = input as Record<string, unknown>;
    const method = typeof i.method === "string" ? i.method : "GET";
    const url = typeof i.url === "string" ? i.url : "";
    return (
      classifyNetworkInvocation(["fetch", "-X", method, url], {
        networkEnabled,
        ...(allowedDomains ? { allowedDomains } : {}),
      }) ?? {
        tier: "MUTATING",
        rule: "fetch_url_unclassified",
        reason: `fetch_url ${method} ${url}: network request could not be classified`,
      }
    );
  }

  if (tool.permissionClass === "CLASSIFIED") {
    return {
      tier: "UNKNOWN",
      rule: "permission_class:classified",
      reason: `${call.name}: non-shell CLASSIFIED tool has no classifier-specific path`,
    };
  }

  return {
    tier: tool.permissionClass as ClassifierTier,
    rule: `permission_class:${tool.permissionClass}`,
    reason: `${call.name}: declared permissionClass=${tool.permissionClass}`,
  };
}

function preflightToolCall(call: ToolCallRequest, input: unknown): ToolResult | null {
  if (call.name !== "fetch_url") return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const rawUrl = (input as Record<string, unknown>).url;
  if (typeof rawUrl !== "string") return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return immediateError(call.id, "bad_args", `invalid url: ${rawUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return immediateError(call.id, "blocked_domain", `unsupported protocol: ${url.protocol}`);
  }
  return null;
}

function immediateError(
  callId: string,
  errorType: NonNullable<ToolResult["errorType"]>,
  content: string,
): ToolResult {
  const now = Date.now();
  return {
    toolCallId: callId,
    status: "error",
    content,
    errorType,
    startedAt: now,
    endedAt: now,
  };
}

function maybeOpenRecoveryWrite(
  toolName: string,
  input: unknown,
  ctx: OpenApexRunContext,
  opts: ScheduleOptions,
): string | null {
  if (toolName !== "write_file") return null;
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const rawPath = (input as Record<string, unknown>).path;
  if (typeof rawPath !== "string") return null;
  const rel = normalizeWorkspaceRelative(ctx.userContext.workspace, rawPath);
  if (rel === null) return null;
  return opts.recoveryWriteFileOpenFor?.has(rel) ? rel : null;
}

function normalizeWorkspaceRelative(workspace: string, candidate: string): string | null {
  const ws = path.resolve(workspace);
  const abs = path.resolve(ws, candidate);
  if (abs !== ws && !abs.startsWith(ws + path.sep)) return null;
  const rel = path.relative(ws, abs);
  return rel.split(path.sep).join("/");
}

/**
 * Extract the argv to hand to the classifier based on the shell tool's
 * input shape. `run_shell` uses `{ argv: string[] }`; `shell_command` uses
 * `{ command: string }` which we wrap into the user's login shell. Returns
 * null when the input shape is unfamiliar — caller skips classification
 * (safe default: the tool's own internal checks handle the rest).
 */
function extractShellArgv(toolName: string, input: unknown): string[] | null {
  if (!input || typeof input !== "object") return null;
  const i = input as Record<string, unknown>;
  if (toolName === "shell_command" && typeof i.command === "string") {
    return [loginShell(), "-lc", i.command];
  }
  if (Array.isArray(i.argv) && i.argv.every((x) => typeof x === "string")) {
    return i.argv as string[];
  }
  return null;
}

function loginShell(): string {
  const shell = process.env.SHELL;
  if (shell && /\/(?:bash|zsh|sh|ksh|dash|fish)$/.test(shell)) return shell;
  return "/bin/bash";
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function validateToolInput(tool: ToolDefinition, input: unknown): string[] {
  return validateSchema(input, tool.parameters, tool.name);
}

function validateSchema(value: unknown, schema: JsonSchema, pathLabel: string): string[] {
  const errors: string[] = [];
  const type = schema.type;
  const types = Array.isArray(type) ? type : typeof type === "string" ? [type] : [];

  if (types.length > 0 && !types.some((t) => matchesType(value, t))) {
    errors.push(`${pathLabel} must be ${types.join(" or ")}`);
    return errors;
  }

  if (types.includes("object") || hasObjectKeywords(schema)) {
    if (!isPlainObject(value)) {
      errors.push(`${pathLabel} must be object`);
      return errors;
    }
    const obj = value as Record<string, unknown>;
    const properties = isPlainObject(schema.properties)
      ? (schema.properties as Record<string, JsonSchema>)
      : {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((x): x is string => typeof x === "string")
      : [];

    for (const key of required) {
      if (!(key in obj)) {
        const propSchema = properties[key];
        const kind = propSchema && typeof propSchema.type === "string" ? ` ${propSchema.type}` : "";
        errors.push(`${pathLabel}.${key} is required${kind}`);
      }
    }

    for (const [key, child] of Object.entries(properties)) {
      if (key in obj) {
        errors.push(...validateSchema(obj[key], child, `${pathLabel}.${key}`));
      }
    }

    const additional = schema.additionalProperties;
    for (const key of Object.keys(obj)) {
      if (key in properties) continue;
      if (additional === false) {
        errors.push(`${pathLabel}.${key} is not allowed`);
      } else if (isPlainObject(additional)) {
        errors.push(...validateSchema(obj[key], additional as JsonSchema, `${pathLabel}.${key}`));
      }
    }
  }

  if (types.includes("array")) {
    if (!Array.isArray(value)) {
      errors.push(`${pathLabel} must be array`);
      return errors;
    }
    if (typeof schema.minItems === "number" && value.length < schema.minItems) {
      errors.push(`${pathLabel} must contain at least ${schema.minItems} item(s)`);
    }
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) {
      errors.push(`${pathLabel} must contain at most ${schema.maxItems} item(s)`);
    }
    if (isPlainObject(schema.items)) {
      value.forEach((item, idx) => {
        errors.push(...validateSchema(item, schema.items as JsonSchema, `${pathLabel}[${idx}]`));
      });
    }
  }

  if (
    (types.includes("number") || types.includes("integer")) &&
    typeof value === "number" &&
    Number.isFinite(value)
  ) {
    if (typeof schema.minimum === "number" && value < schema.minimum) {
      errors.push(`${pathLabel} must be >= ${schema.minimum}`);
    }
    if (typeof schema.maximum === "number" && value > schema.maximum) {
      errors.push(`${pathLabel} must be <= ${schema.maximum}`);
    }
  }

  if (types.includes("string") && typeof value === "string") {
    if (typeof schema.minLength === "number" && value.length < schema.minLength) {
      errors.push(`${pathLabel} must be at least ${schema.minLength} character(s)`);
    }
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) {
      errors.push(`${pathLabel} must be at most ${schema.maxLength} character(s)`);
    }
  }

  return errors;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return Number.isInteger(value);
    case "null":
      return value === null;
    default:
      return true;
  }
}

function hasObjectKeywords(schema: JsonSchema): boolean {
  return "properties" in schema || "required" in schema || "additionalProperties" in schema;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
