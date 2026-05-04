/**
 * Anthropic Messages API request builder.
 *
 * Maps the normalized AgentRequest + RequestOptions into the POST /v1/messages
 * payload. Key concerns:
 *   - adaptive thinking (§1.2): thinking: { type: "adaptive" }
 *   - output_config.effort: low/medium/high/max/xhigh
 *   - cache_control breakpoints at system-prompt-end and tools-end
 *   - context_management beta header (clear_tool_uses + clear_thinking)
 *   - compact beta header
 *   - thinking blocks with signature round-trip through assistant.content
 *   - multi tool_result blocks per single user message
 */

import type { AgentRequest, ContentPart, Message, RequestOptions } from "@open-apex/core";

export interface AnthropicRequestPayload {
  model: string;
  max_tokens: number;
  cache_control?: { type: "ephemeral"; ttl?: "1h" };
  system?: string | AnthropicSystemBlock[];
  messages: AnthropicMessage[];
  tools?: AnthropicTool[];
  tool_choice?: AnthropicToolChoice;
  stream?: boolean;
  thinking?: { type: "adaptive" | "enabled" | "disabled"; budget_tokens?: number };
  output_config?: {
    effort?: "low" | "medium" | "high" | "max" | "xhigh";
    format?: {
      type: "json_schema";
      schema: Record<string, unknown>;
    };
  };
  context_management?: Record<string, unknown>;
}

export interface AnthropicSystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: AnthropicContentBlock[];
}

export type AnthropicContentBlock =
  | { type: "text"; text: string; cache_control?: { type: "ephemeral" } }
  | {
      type: "image";
      source: { type: "base64"; media_type: string; data: string } | { type: "url"; url: string };
    }
  | {
      type: "document";
      source: { type: "base64"; media_type: "application/pdf"; data: string };
    }
  | {
      type: "thinking";
      thinking: string;
      signature?: string;
    }
  | {
      type: "tool_use";
      id: string;
      name: string;
      input: unknown;
    }
  | {
      type: "tool_result";
      tool_use_id: string;
      content: string | AnthropicContentBlock[];
      is_error?: boolean;
    }
  | {
      type: "search_result";
      source: string;
      title: string;
      content: Array<{ type: "text"; text: string }>;
      citations?: { enabled: true };
    };

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
  /**
   * When true, grammar-constrained sampling guarantees `input` matches
   * `input_schema` exactly — Anthropic's native anti-hallucination primitive
   * (docs: agents-and-tools/tool-use/strict-tool-use). Requires
   * `additionalProperties: false` + a `required` list; optional fields are
   * allowed (unlike OpenAI strict, which requires every key to be required).
   */
  strict?: boolean;
  cache_control?: { type: "ephemeral" };
}

export type AnthropicToolChoice =
  | { type: "auto" }
  | { type: "any" }
  | { type: "tool"; name: string }
  | { type: "none" };

export interface BuildAnthropicRequestOptions {
  modelId: string;
  /** Default max_tokens. Anthropic requires this to be set. */
  defaultMaxTokens: number;
  /** When true, apply top-level automatic prompt caching. */
  automaticPromptCaching: boolean;
  /** When true, the system prompt becomes an AnthropicSystemBlock[] with cache_control at end. */
  systemPromptCacheable: boolean;
  /** When true, tools receive cache_control on the last entry. */
  toolsCacheable: boolean;
  /**
   * When true (default), tag every emitted tool with `strict: true` so Claude
   * uses grammar-constrained sampling on `input`. Our M1 tools all satisfy
   * Anthropic's strict schema requirements (`additionalProperties: false` +
   * a `required` list). Set false to debug hallucination vs strict rejection.
   */
  strictTools?: boolean;
  stream?: boolean;
}

const EFFORT_MAP: Record<string, "low" | "medium" | "high" | "max" | "xhigh"> = {
  low: "low",
  medium: "medium",
  high: "high",
  max: "max",
  xhigh: "xhigh",
};
const MAX_STRICT_TOOLS = 20;
const MAX_STRICT_OPTIONAL_PARAMS = 24;
const STRICT_TOOL_PRIORITY = new Map(
  ["apply_patch", "write_file", "search_replace", "shell_command", "run_shell"].map((name, i) => [
    name,
    i,
  ]),
);

export function buildRequest(
  req: AgentRequest,
  opts: RequestOptions,
  build: BuildAnthropicRequestOptions,
): AnthropicRequestPayload {
  const payload: AnthropicRequestPayload = {
    model: build.modelId,
    max_tokens: opts.maxOutputTokens ?? build.defaultMaxTokens,
    messages: foldMessages(req.messages),
    thinking: { type: "adaptive" },
  };

  if (build.automaticPromptCaching) {
    payload.cache_control = { type: "ephemeral" };
  }

  if (req.systemPrompt) {
    if (build.systemPromptCacheable) {
      payload.system = [
        {
          type: "text",
          text: req.systemPrompt,
          cache_control: { type: "ephemeral" },
        },
      ];
    } else {
      payload.system = req.systemPrompt;
    }
  }

  if (req.tools.length > 0) {
    const strictTools = build.strictTools !== false;
    let strictToolCount = 0;
    let strictOptionalParamCount = 0;
    const candidates = req.tools.map((t, i) => {
      // Anthropic strict (grammar-constrained tool_use) shares the JSON
      // Schema subset with structured outputs. Open-dict fields such as env
      // are not representable, so a few critical mutating/execution tools get
      // an Anthropic-only model-facing projection that omits optional
      // convenience fields while leaving the runtime executor unchanged.
      const liftedSchema = strictTools ? toAnthropicStrictToolSchema(t.name, t.parameters) : null;
      return {
        tool: t,
        index: i,
        liftedSchema,
        optionalParamCount: liftedSchema !== null ? countOptionalObjectProperties(liftedSchema) : 0,
        strictEligible: false,
      };
    });
    const strictSelectionOrder = [...candidates].sort((a, b) => {
      const aPriority = STRICT_TOOL_PRIORITY.get(a.tool.name) ?? Number.POSITIVE_INFINITY;
      const bPriority = STRICT_TOOL_PRIORITY.get(b.tool.name) ?? Number.POSITIVE_INFINITY;
      return aPriority - bPriority || a.index - b.index;
    });
    for (const candidate of strictSelectionOrder) {
      if (candidate.liftedSchema === null) continue;
      if (strictToolCount >= MAX_STRICT_TOOLS) continue;
      if (strictOptionalParamCount + candidate.optionalParamCount > MAX_STRICT_OPTIONAL_PARAMS) {
        continue;
      }
      candidate.strictEligible = true;
      strictToolCount++;
      strictOptionalParamCount += candidate.optionalParamCount;
    }

    payload.tools = candidates.map((candidate, i) => {
      const t = candidate.tool;
      const at: AnthropicTool = {
        name: t.name,
        description: t.description,
        input_schema: candidate.strictEligible ? candidate.liftedSchema! : t.parameters,
      };
      if (candidate.strictEligible) {
        at.strict = true;
      }
      if (build.toolsCacheable && i === req.tools.length - 1) {
        at.cache_control = { type: "ephemeral" };
      }
      return at;
    });
  }

  // Allowed-tools restriction: Anthropic doesn't have a server-side
  // `tool_choice.allowed_tools`, so we filter client-side to honor the
  // same intent (§3.4.1 RequestOptions.allowedTools).
  if (opts.allowedTools && opts.allowedTools.length > 0 && payload.tools) {
    const allow = new Set(opts.allowedTools);
    payload.tools = payload.tools.filter((t) => allow.has(t.name));
  }

  // tool_choice mapping. `forceToolChoice` (recovery path) trumps caller's.
  let forcesToolUse = false;
  if (opts.forceToolChoice === "required" && payload.tools && payload.tools.length > 0) {
    payload.tool_choice = { type: "any" };
    forcesToolUse = true;
  } else if (req.toolChoice) {
    if (req.toolChoice.type === "none") payload.tool_choice = { type: "none" };
    else if (req.toolChoice.type === "required") {
      payload.tool_choice = { type: "any" };
      forcesToolUse = true;
    } else if (req.toolChoice.type === "specific") {
      payload.tool_choice = { type: "tool", name: req.toolChoice.toolName };
      forcesToolUse = true;
    } else if (req.toolChoice.type === "auto") payload.tool_choice = { type: "auto" };
  }

  // Anthropic constraint: extended thinking is incompatible with forced
  // tool_choice (`any` / specific `tool`). The API returns 400
  // "Thinking may not be enabled when tool_choice forces tool use." See
  // https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools
  // (Extended thinking section). Observed on tb2-12 opus/overfull-hbox:
  // the hallucination-recovery path sets forceToolChoice="required" and
  // the default adaptive-thinking config triggered the 400. Disable
  // thinking narrowly on this one request — the turn-runner consumes
  // `forceToolChoiceNext` once, so subsequent turns resume adaptive thinking.
  if (forcesToolUse) {
    payload.thinking = { type: "disabled" };
  }

  if (opts.effort) {
    const mapped = EFFORT_MAP[opts.effort];
    if (mapped !== undefined)
      payload.output_config = { ...(payload.output_config ?? {}), effort: mapped };
  }

  if (opts.structuredOutput?.type === "json_schema") {
    // Claude Opus/Sonnet structured outputs use output_config.format for the
    // final assistant text. This keeps planner/verifier results schema-bound
    // without forcing a terminal emit-tool call, which would also force us to
    // disable thinking on that request.
    payload.output_config = {
      ...(payload.output_config ?? {}),
      format: {
        type: "json_schema",
        schema: opts.structuredOutput.schema,
      },
    };
  }

  if (opts.contextManagement) {
    const cm = opts.contextManagement;
    const edits: unknown[] = [];
    if (cm.triggerInputTokens !== undefined || cm.keepToolUses !== undefined) {
      const edit: Record<string, unknown> = {
        type: "clear_tool_uses_20250919",
      };
      if (cm.triggerInputTokens !== undefined) {
        edit.trigger = { type: "input_tokens", value: cm.triggerInputTokens };
      }
      if (cm.keepToolUses !== undefined) {
        edit.keep = { type: "tool_uses", value: cm.keepToolUses };
      }
      if (cm.clearAtLeastTokens !== undefined) {
        edit.clear_at_least = {
          type: "input_tokens",
          value: cm.clearAtLeastTokens,
        };
      }
      if (cm.excludeTools && cm.excludeTools.length > 0) {
        edit.exclude_tools = cm.excludeTools;
      }
      if (cm.clearToolInputs) edit.clear_tool_inputs = true;
      edits.push(edit);
    }
    if (cm.keepThinking !== undefined) {
      edits.push({
        type: "clear_thinking_20251015",
        keep: { type: "turns", value: cm.keepThinking },
      });
    }
    if (cm.compactThreshold !== undefined) {
      const edit: Record<string, unknown> = {
        type: "compact_20260112",
        trigger: { type: "input_tokens", value: cm.compactThreshold },
      };
      if (cm.pauseAfterCompaction) edit.pause_after_compaction = true;
      if (cm.compactionInstructions) edit.instructions = cm.compactionInstructions;
      edits.push(edit);
    }
    if (edits.length > 0) payload.context_management = { edits };
  }

  if (build.stream !== false) payload.stream = true;
  return payload;
}

/**
 * Fold our normalized Messages into Anthropic's user/assistant alternation.
 * Consecutive user messages are merged; their content arrays are concatenated.
 * Same for consecutive assistants. System-role messages are ignored (system
 * prompt is a top-level field).
 */
export function foldMessages(messages: Message[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = [];
  for (const m of messages) {
    if (m.role !== "user" && m.role !== "assistant") continue;
    const blocks = contentPartsToBlocks(m);
    if (blocks.length === 0) continue;
    const last = out.at(-1);
    if (last && last.role === m.role) {
      last.content.push(...blocks);
    } else {
      out.push({ role: m.role, content: blocks });
    }
  }
  return out;
}

/** Test helper: expose the internal content-block builder. */
export function __messageToContentBlocksForTest(m: Message): AnthropicContentBlock[] {
  return contentPartsToBlocks(m);
}

function contentPartsToBlocks(m: Message): AnthropicContentBlock[] {
  const parts: ContentPart[] =
    typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
  if (m.role === "user" && parts.some((p) => p.type === "tool_result")) {
    return userMessageWithToolResultsToBlocks(m, parts);
  }
  const out: AnthropicContentBlock[] = [];
  for (const p of parts) {
    out.push(...contentPartToBlocks(m, p));
  }
  return out;
}

function userMessageWithToolResultsToBlocks(
  m: Message,
  parts: ContentPart[],
): AnthropicContentBlock[] {
  const out: AnthropicContentBlock[] = [];
  const deferredDocuments: AnthropicContentBlock[] = [];
  const nonToolParts: ContentPart[] = [];

  for (const p of parts) {
    if (p.type !== "tool_result") {
      nonToolParts.push(p);
      continue;
    }
    if (typeof p.content === "string") {
      out.push({
        type: "tool_result",
        tool_use_id: p.toolCallId,
        content: p.content,
        ...(p.isError ? { is_error: true } : {}),
      });
      continue;
    }
    const nested: AnthropicContentBlock[] = [];
    for (const child of p.content) {
      if (child.type === "pdf") {
        deferredDocuments.push(...contentPartToBlocks(m, child));
      } else if (child.type === "text" || child.type === "image") {
        nested.push(...contentPartToBlocks(m, child));
      }
    }
    out.push({
      type: "tool_result",
      tool_use_id: p.toolCallId,
      content: nested.length > 0 ? nested : "",
      ...(p.isError ? { is_error: true } : {}),
    });
  }

  out.push(...deferredDocuments);
  for (const p of nonToolParts) out.push(...contentPartToBlocks(m, p));
  return out;
}

function contentPartToBlocks(m: Message, p: ContentPart): AnthropicContentBlock[] {
  switch (p.type) {
    case "text":
      return p.text.length > 0 ? [{ type: "text", text: p.text }] : [];
    case "image": {
      const block = imageToAnthropic(p);
      return block ? [block] : [];
    }
    case "pdf": {
      if (p.source.kind === "base64") {
        return [
          {
            type: "document",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: p.source.data,
            },
          },
        ];
      }
      return [];
    }
    case "tool_use":
      return [
        {
          type: "tool_use",
          id: p.toolCallId,
          name: p.name,
          input: normalizeToolUseInput(p.arguments),
        },
      ];
    case "tool_result":
      return [
        {
          type: "tool_result",
          tool_use_id: p.toolCallId,
          content:
            typeof p.content === "string"
              ? p.content
              : contentPartsToBlocks({ ...m, content: p.content } as Message),
          ...(p.isError ? { is_error: true } : {}),
        },
      ];
    case "thinking": {
      const tb: AnthropicContentBlock = { type: "thinking", thinking: p.text };
      if (p.signature !== undefined) (tb as { signature?: string }).signature = p.signature;
      return [tb];
    }
    case "reasoning":
      return [];
    case "search_result": {
      const body = p.content ?? p.snippet;
      return [
        {
          type: "search_result",
          source: p.url,
          title: p.title,
          content: [{ type: "text", text: body }],
          citations: { enabled: true },
        },
      ];
    }
  }
}

function imageToAnthropic(
  p: Extract<ContentPart, { type: "image" }>,
): AnthropicContentBlock | null {
  if (p.source.kind === "base64") {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: p.source.mediaType,
        data: p.source.data,
      },
    };
  }
  if (p.source.kind === "url") {
    return { type: "image", source: { type: "url", url: p.source.url } };
  }
  return null;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

function normalizeToolUseInput(input: unknown): Record<string, unknown> {
  const parsed = typeof input === "string" ? safeJson(input) : input;
  if (isPlainRecord(parsed)) return parsed;
  return {};
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}

/**
 * Lift a loose JSON Schema into Anthropic strict-mode-compliant shape, or
 * return null when un-transformable. Mirrors the OpenAI lifter but KEEPS the
 * caller's `required` as-is (Anthropic allows optional fields — unlike
 * OpenAI strict which requires every key to be in `required`).
 *
 * Drops:
 *   - numerical constraints: minimum, maximum, exclusiveMinimum/Maximum,
 *     multipleOf
 *   - string constraints: minLength, maxLength, pattern
 *   - non-whitelisted `format` values (keeps date-time, time, date,
 *     duration, email, hostname, uri, ipv4, ipv6, uuid)
 *   - array constraints: maxItems, minItems (when value > 1)
 *   - `contentEncoding`, `contentMediaType`, `default` (kept per docs —
 *     default IS supported, so we preserve it)
 *
 * Returns null when:
 *   - schema has `additionalProperties` set to anything other than `false`
 *     or absent (open dicts are not representable, e.g., run_shell.env)
 *   - nested property schema recursively fails
 */
export function toAnthropicStrictSchema(
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (!schema || typeof schema !== "object") return null;
  return transformStrict(schema);
}

function toAnthropicStrictToolSchema(
  toolName: string,
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  const projected = projectedStrictSchemaForCriticalTool(toolName, schema);
  if (projected) return projected;
  return toAnthropicStrictSchema(schema);
}

function projectedStrictSchemaForCriticalTool(
  toolName: string,
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (!schema || typeof schema !== "object") return null;
  const properties = isPlainRecord(schema.properties)
    ? (schema.properties as Record<string, unknown>)
    : {};
  const pick = (required: string[], optional: string[] = []) => {
    const nextProps: Record<string, unknown> = {};
    for (const key of [...required, ...optional]) {
      const value = properties[key];
      if (isPlainRecord(value)) nextProps[key] = value;
    }
    if (!required.every((key) => nextProps[key] !== undefined)) return null;
    return toAnthropicStrictSchema({
      type: "object",
      required,
      additionalProperties: false,
      properties: nextProps,
    });
  };

  switch (toolName) {
    case "write_file":
      return pick(["path", "content"]);
    case "shell_command":
      return pick(["command"], ["cwd", "timeoutMs", "stdin"]);
    case "run_shell":
      return pick(["argv"], ["cwd", "timeoutMs", "stdin"]);
    default:
      return null;
  }
}

// Only keywords the API rejects outright — per
// build-with-claude/structured-outputs#json-schema-limitations.
const UNSUPPORTED_KEYWORDS = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "maxItems",
  "contentEncoding",
  "contentMediaType",
]);

// String formats Anthropic explicitly enumerates as supported.
const SUPPORTED_FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);

function transformStrict(schema: Record<string, unknown>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (UNSUPPORTED_KEYWORDS.has(k)) continue;
    if (k === "format") {
      if (typeof v === "string" && SUPPORTED_FORMATS.has(v)) out[k] = v;
      continue;
    }
    if (k === "minItems") {
      // Only values 0 and 1 are supported; drop otherwise.
      if (typeof v === "number" && (v === 0 || v === 1)) out[k] = v;
      continue;
    }
    out[k] = v;
  }

  const typeField = out.type;
  const isObject =
    typeField === "object" || (Array.isArray(typeField) && typeField.includes("object"));
  const isArray =
    typeField === "array" || (Array.isArray(typeField) && typeField.includes("array"));

  if (isObject || "properties" in out) {
    if ("additionalProperties" in out && out.additionalProperties !== false) {
      return null; // open dict — not representable under strict
    }
    out.additionalProperties = false;

    const props = (out.properties ?? {}) as Record<string, unknown>;
    const newProps: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(props)) {
      if (!val || typeof val !== "object") return null;
      const sub = transformStrict(val as Record<string, unknown>);
      if (sub === null) return null;
      newProps[key] = sub;
    }
    out.properties = newProps;
    // Preserve `required` exactly as the caller provided (optionals allowed).
  }

  if (isArray && "items" in out && out.items) {
    if (typeof out.items !== "object") return null;
    const items = transformStrict(out.items as Record<string, unknown>);
    if (items === null) return null;
    out.items = items;
  }

  for (const k of ["anyOf", "oneOf", "allOf"]) {
    if (Array.isArray(out[k])) {
      const arr = out[k] as unknown[];
      const next: unknown[] = [];
      for (const entry of arr) {
        if (!entry || typeof entry !== "object") return null;
        const sub = transformStrict(entry as Record<string, unknown>);
        if (sub === null) return null;
        next.push(sub);
      }
      out[k] = next;
    }
  }

  return out;
}

function countOptionalObjectProperties(schema: Record<string, unknown>): number {
  let count = 0;
  const typeField = schema.type;
  const isObject =
    typeField === "object" || (Array.isArray(typeField) && typeField.includes("object"));
  const props = isPlainRecord(schema.properties)
    ? (schema.properties as Record<string, unknown>)
    : {};
  if (isObject || Object.keys(props).length > 0) {
    const required = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((x): x is string => typeof x === "string")
        : [],
    );
    for (const [key, val] of Object.entries(props)) {
      if (!required.has(key)) count++;
      if (isPlainRecord(val)) count += countOptionalObjectProperties(val);
    }
  }

  if (isPlainRecord(schema.items)) {
    count += countOptionalObjectProperties(schema.items);
  }
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const arr = schema[key];
    if (Array.isArray(arr)) {
      for (const entry of arr) {
        if (isPlainRecord(entry)) count += countOptionalObjectProperties(entry);
      }
    }
  }
  return count;
}
