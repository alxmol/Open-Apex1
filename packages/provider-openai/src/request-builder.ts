/**
 * OpenAI Responses API request builder.
 *
 * Flattens the normalized AgentRequest + RequestOptions into the
 * POST /v1/responses payload shape.
 *
 * Spec references:
 *   - §3.4.1 AgentRequest + RequestOptions (normalized inputs)
 *   - §1.2 "Effort policy": reasoning.effort + text.verbosity
 *   - §1.2 "Tools and editing": allowed_tools in tool_choice
 *   - §1.2 Provider strategy: previous_response_id as default continuation
 */

import type {
  AgentRequest,
  ContentPart,
  Message,
  RequestOptions,
  ToolChoice,
  ToolDefinitionPayload,
} from "@open-apex/core";

export interface OpenAiRequestPayload {
  model: string;
  instructions: string;
  input: OpenAiInputItemPayload[];
  tools?: OpenAiTool[];
  tool_choice?: OpenAiToolChoice;
  reasoning?: { effort?: string; summary?: "auto" | "concise" | "detailed" };
  text?: {
    verbosity?: "low" | "medium" | "high";
    format?: {
      type: "json_schema";
      name: string;
      strict: boolean;
      schema: Record<string, unknown>;
    };
  };
  max_output_tokens?: number;
  previous_response_id?: string;
  stream?: boolean;
  parallel_tool_calls?: boolean;
  context_management?: Array<{ type: "compaction"; compact_threshold: number }>;
  store?: boolean;
  conversation?: string;
  background?: boolean;
}

export type OpenAiInputItem =
  | {
      role: "user" | "system" | "developer";
      content: OpenAiInputContent[];
    }
  | {
      role: "assistant";
      content: OpenAiOutputContent[];
      phase?: "commentary" | "final_answer";
    }
  | {
      type: "function_call";
      call_id: string;
      name: string;
      arguments: string; // JSON-encoded per Responses API
    }
  | {
      type: "function_call_output";
      call_id: string;
      output: string | OpenAiInputContent[];
    };

export type OpenAiInputItemPayload = OpenAiInputItem | Record<string, unknown>;

export type OpenAiInputContent =
  | { type: "input_text"; text: string }
  | { type: "input_image"; image_url: string; detail?: "auto" | "low" | "high" }
  | {
      type: "input_file";
      file_id?: string;
      file_url?: string;
      file_data?: string;
      filename?: string;
    };

export type OpenAiOutputContent =
  | { type: "output_text"; text: string }
  | { type: "refusal"; refusal: string };

export type OpenAiTool =
  | {
      type: "function";
      name: string;
      description: string;
      parameters: Record<string, unknown>;
      strict?: boolean;
    }
  | {
      type: "custom";
      name: string;
      description: string;
      format?: { type: "grammar"; grammar: string };
    };

export type OpenAiToolChoice =
  | "auto"
  | "none"
  | "required"
  | { type: "function"; name: string }
  | {
      type: "allowed_tools";
      mode: "required" | "auto";
      tools: Array<{ type: "function"; name: string }>;
    };

export interface BuildRequestOptions {
  modelId: string;
  systemPrompt: string;
  previousResponseId?: string;
  /** If false, the request is non-streaming. Default true. */
  stream?: boolean;
  /**
   * When true (default), tools are tagged with `strict: true` using
   * grammar-constrained sampling (OpenAI's anti-hallucination primitive —
   * docs/guides/function-calling#strict-mode). Schemas that OpenAI strict
   * can't represent (e.g., open `additionalProperties` on nested objects)
   * are auto-downgraded per-tool rather than failing the whole request.
   * Set false to debug strict rejections.
   */
  strictTools?: boolean;
  /** Opaque compacted Responses output items to pass forward as-is. */
  inputPrefix?: unknown[];
}

export function buildRequest(
  req: AgentRequest,
  opts: RequestOptions,
  build: BuildRequestOptions,
): OpenAiRequestPayload {
  if (build.previousResponseId && opts.conversationId) {
    throw new Error(
      "OpenAI Responses request cannot include both previous_response_id and conversation",
    );
  }
  const payload: OpenAiRequestPayload = {
    model: build.modelId,
    instructions: req.systemPrompt,
    input: [
      ...(build.inputPrefix ?? []),
      ...req.messages.flatMap(messageToInputItems),
    ] as OpenAiInputItemPayload[],
  };
  if (req.tools.length > 0) {
    const strict = build.strictTools !== false;
    payload.tools = req.tools.map((t) => toolToOpenAi(t, strict));
    // §1.2: parallel tool calling is a required capability for the benchmark
    // presets. Always-on when tools are registered; providers gracefully
    // ignore when only one tool call is emitted per turn.
    payload.parallel_tool_calls = true;
  }
  // `forceToolChoice` (recovery path) trumps the caller's toolChoice.
  if (opts.forceToolChoice === "required" && req.tools.length > 0) {
    payload.tool_choice = "required";
  } else if (req.toolChoice) {
    payload.tool_choice = mapToolChoice(req.toolChoice, opts);
  }
  if (opts.effort && opts.effort !== "max") {
    payload.reasoning ??= {};
    payload.reasoning.effort = opts.effort;
  }
  if (opts.reasoningSummary) {
    payload.reasoning ??= {};
    payload.reasoning.summary = opts.reasoningSummary;
  }
  if (opts.verbosity) payload.text = { ...(payload.text ?? {}), verbosity: opts.verbosity };
  if (opts.structuredOutput?.type === "json_schema") {
    // M4 synthesis uses Responses native structured outputs. Keep this generic
    // on RequestOptions so other orchestrator calls can ask for schema-shaped
    // final text without learning OpenAI's wire field name.
    payload.text = {
      ...(payload.text ?? {}),
      format: {
        type: "json_schema",
        name: opts.structuredOutput.name,
        strict: opts.structuredOutput.strict !== false,
        schema: opts.structuredOutput.schema,
      },
    };
  }
  if (opts.maxOutputTokens !== undefined) {
    payload.max_output_tokens = opts.maxOutputTokens;
  }
  if (build.previousResponseId) {
    payload.previous_response_id = build.previousResponseId;
  }
  if (opts.contextManagement?.compactThreshold !== undefined) {
    // OpenAI server-side compaction is request-level. With
    // previous_response_id chaining the runtime must NOT prune local deltas;
    // the opaque provider compaction item is carried by the response id.
    payload.context_management = [
      {
        type: "compaction",
        compact_threshold: opts.contextManagement.compactThreshold,
      },
    ];
  }
  if (opts.store !== undefined) {
    payload.store = opts.store;
  }
  if (opts.conversationId !== undefined) {
    payload.conversation = opts.conversationId;
    if (payload.store === undefined) payload.store = true;
  }
  if (opts.background === true) {
    payload.background = true;
    // Background Responses require provider storage. Make this explicit so
    // chat-mode long-running model calls work while benchmark mode can keep
    // background disabled entirely.
    payload.store = true;
  }
  if (build.stream !== false) payload.stream = true;
  return payload;
}

export function messageToInputItems(m: Message): OpenAiInputItem[] {
  const items: OpenAiInputItem[] = [];
  const parts: ContentPart[] =
    typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;

  const tool_calls: OpenAiInputItem[] = [];
  const tool_results: OpenAiInputItem[] = [];
  const inputContent: OpenAiInputContent[] = [];
  const assistantContent: OpenAiOutputContent[] = [];

  for (const p of parts) {
    if (p.type === "tool_use") {
      tool_calls.push({
        type: "function_call",
        call_id: p.toolCallId,
        name: p.name,
        arguments: typeof p.arguments === "string" ? p.arguments : JSON.stringify(p.arguments),
      });
    } else if (p.type === "tool_result") {
      tool_results.push({
        type: "function_call_output",
        call_id: p.toolCallId,
        output:
          typeof p.content === "string" ? p.content : contentPartsToOpenAiToolOutput(p.content),
      });
    } else if (p.type === "text") {
      if (m.role === "assistant") {
        assistantContent.push({ type: "output_text", text: p.text });
      } else {
        inputContent.push({ type: "input_text", text: p.text });
      }
    } else if (p.type === "image") {
      if (m.role === "user" || m.role === "system" || m.role === "developer") {
        const url = imagePartToUrl(p);
        if (url !== null) inputContent.push({ type: "input_image", image_url: url });
      }
    } else if (p.type === "reasoning") {
      // Reasoning items are owned by the Responses server via
      // previous_response_id — we do not echo them back through input[].
      continue;
    } else if (p.type === "thinking") {
      // Anthropic thinking blocks don't belong in OpenAI payloads.
      continue;
    } else if (p.type === "search_result") {
      // Render as fenced text block so the model can still cite with
      // provenance. Responses has no native search_result block.
      if (m.role === "user") {
        inputContent.push({
          type: "input_text",
          text: renderSearchResultForOpenAi(p),
        });
      }
    } else if (p.type === "pdf") {
      // §M3: support base64 PDF via input_file + file_data + filename
      // (Responses API accepts data:application/pdf;base64,... via file_data
      // with a required `filename`). Path + URL cases are deferred — the
      // runtime's read_asset tool always emits base64.
      if (m.role === "user" || m.role === "system" || m.role === "developer") {
        if (p.source.kind === "base64") {
          const filename = collectFilenameTrailer(parts) ?? "document.pdf";
          inputContent.push({
            type: "input_file",
            file_data: `data:application/pdf;base64,${p.source.data}`,
            filename,
          });
        } else if (p.source.kind === "url") {
          inputContent.push({ type: "input_file", file_url: p.source.url });
        }
      }
    }
  }

  if (m.role === "assistant" && assistantContent.length > 0) {
    const asst: OpenAiInputItem = {
      role: "assistant",
      content: assistantContent,
    };
    if (m.phase) (asst as { phase?: typeof m.phase }).phase = m.phase;
    items.push(asst);
  } else if (
    (m.role === "user" || m.role === "system" || m.role === "developer") &&
    inputContent.length > 0
  ) {
    items.push({ role: m.role, content: inputContent });
  }
  items.push(...tool_calls);
  items.push(...tool_results);
  return items;
}

function toolToOpenAi(t: ToolDefinitionPayload, strict: boolean): OpenAiTool {
  if (t.custom) {
    const out: OpenAiTool = {
      type: "custom",
      name: t.name,
      description: t.description,
    };
    if (t.custom.format) out.format = t.custom.format;
    return out;
  }
  // OpenAI strict (docs/guides/function-calling#strict-mode) requires:
  //   - every property key listed in `required`
  //   - `additionalProperties: false` on every object (no open dictionaries)
  //   - no numeric/string range keywords (minLength, minimum, etc.)
  //   - optional fields expressed as type unions with "null"
  // We lift a loose schema into that shape via `toStrictSchema`; if a tool
  // contains constructs strict cannot represent (e.g., run_shell's `env` open
  // dict) the transformer returns null and we emit the tool without strict:
  // partial strict beats none — function-tool hallucination disappears for
  // every tool we CAN tag.
  const strictParams = strict ? toStrictSchema(t.parameters) : null;
  const tool: OpenAiTool = {
    type: "function",
    name: t.name,
    description: t.description,
    parameters: strictParams ?? t.parameters,
  };
  if (strictParams !== null) tool.strict = true;
  return tool;
}

/**
 * Lift a loose JSON Schema into OpenAI strict-mode-compliant shape, or
 * return null when un-transformable. Rules:
 *   - drop unsupported keywords (minLength/maxLength/minimum/maximum/
 *     minItems/maxItems/pattern/format/multipleOf/default/minProperties/
 *     maxProperties)
 *   - every `properties` key is added to `required`; previously-optional
 *     fields get type union with "null"
 *   - `additionalProperties` must be literally false on every object; open
 *     dicts (e.g., `{additionalProperties: {type: "string"}}`) are NOT
 *     representable → return null for the whole tool
 *   - recurse into `properties`, `items`, `anyOf`, `oneOf`, `allOf`
 */
export function toStrictSchema(
  schema: Record<string, unknown> | undefined,
): Record<string, unknown> | null {
  if (!schema || typeof schema !== "object") return null;
  return transformStrict(schema);
}

const UNSUPPORTED_KEYWORDS = new Set([
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minItems",
  "maxItems",
  "minContains",
  "maxContains",
  "minProperties",
  "maxProperties",
  "pattern",
  "format",
  "multipleOf",
  "default",
  "contentEncoding",
  "contentMediaType",
]);

function transformStrict(schema: Record<string, unknown>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (UNSUPPORTED_KEYWORDS.has(k)) continue;
    out[k] = v;
  }

  const typeField = out.type;
  const isObject =
    typeField === "object" || (Array.isArray(typeField) && typeField.includes("object"));
  const isArray =
    typeField === "array" || (Array.isArray(typeField) && typeField.includes("array"));

  if (isObject || "properties" in out) {
    // Open additionalProperties (not false) isn't representable.
    if ("additionalProperties" in out && out.additionalProperties !== false) {
      return null;
    }
    out.additionalProperties = false;

    const props = (out.properties ?? {}) as Record<string, unknown>;
    const originalRequired = Array.isArray(out.required) ? (out.required as string[]) : [];
    const requiredSet = new Set(originalRequired);
    const allKeys = Object.keys(props);
    const newProps: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(props)) {
      if (!val || typeof val !== "object") {
        return null; // malformed sub-schema
      }
      const sub = transformStrict(val as Record<string, unknown>);
      if (sub === null) return null;
      newProps[key] = requiredSet.has(key) ? sub : makeNullable(sub);
    }
    out.properties = newProps;
    out.required = allKeys;
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

function makeNullable(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...schema };
  const type = out.type;
  if (typeof type === "string") {
    out.type = type === "null" ? type : [type, "null"];
  } else if (Array.isArray(type)) {
    if (!type.includes("null")) {
      out.type = [...type, "null"];
    }
  } else if (type === undefined) {
    // Schema with no explicit type (e.g., just `enum`). OpenAI strict still
    // needs something expressible; add an anyOf wrap with explicit null.
    out.anyOf = [{ ...schema }, { type: "null" }];
    // Remove original scalar constructs from top-level to avoid conflict.
    delete out.enum;
    delete out.const;
  }
  return out;
}

function mapToolChoice(choice: ToolChoice, opts: RequestOptions): OpenAiToolChoice {
  if (opts.allowedTools && opts.allowedTools.length > 0) {
    return {
      type: "allowed_tools",
      mode: "auto",
      tools: opts.allowedTools.map((name) => ({ type: "function", name })),
    };
  }
  switch (choice.type) {
    case "auto":
      return "auto";
    case "none":
      return "none";
    case "required":
      return "required";
    case "specific":
      return { type: "function", name: choice.toolName };
    case "allowed_tools":
      return {
        type: "allowed_tools",
        mode: choice.mode,
        tools: choice.tools.map((name) => ({ type: "function", name })),
      };
  }
}

function contentPartsToPlainText(parts: ContentPart[]): string {
  return parts
    .filter((p): p is Extract<ContentPart, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

function contentPartsToOpenAiToolOutput(parts: ContentPart[]): OpenAiInputContent[] {
  const out: OpenAiInputContent[] = [];
  for (const p of parts) {
    if (p.type === "text") {
      out.push({ type: "input_text", text: p.text });
    } else if (p.type === "image") {
      const url = imagePartToUrl(p);
      if (url !== null) out.push({ type: "input_image", image_url: url });
    } else if (p.type === "pdf") {
      if (p.source.kind === "base64") {
        out.push({
          type: "input_file",
          file_data: `data:application/pdf;base64,${p.source.data}`,
          filename: collectFilenameTrailer(parts) ?? "document.pdf",
        });
      } else if (p.source.kind === "url") {
        out.push({ type: "input_file", file_url: p.source.url });
      }
    }
  }
  return out.length > 0 ? out : [{ type: "input_text", text: contentPartsToPlainText(parts) }];
}

function renderSearchResultForOpenAi(p: Extract<ContentPart, { type: "search_result" }>): string {
  const metadata = p.metadata ?? {};
  const attrs = [
    ["source", p.url],
    ["title", p.title],
    ["tier", stringMeta(metadata.sourceTier)],
    ["provider", stringMeta(metadata.provider)],
    ["rank", numberMeta(metadata.rankScore)],
    ["fetched_at", stringMeta(metadata.fetchedAt)],
  ]
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([key, value]) => `${key}="${escapeAttr(value)}"`)
    .join(" ");
  const body = (p.content ?? p.snippet).trim();
  return `<search_result ${attrs}>\n${body}\n</search_result>`;
}

function stringMeta(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function numberMeta(v: unknown): string | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v.toFixed(2) : undefined;
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function imagePartToUrl(p: Extract<ContentPart, { type: "image" }>): string | null {
  if (p.source.kind === "url") return p.source.url;
  if (p.source.kind === "base64") {
    return `data:${p.source.mediaType};base64,${p.source.data}`;
  }
  // path-based: upload through the Files API is §M5 work; read_asset tool
  // emits base64 shapes today so this branch isn't hit in the normal flow.
  return null;
}

/**
 * Find a `filename:<basename>` text trailer emitted by `read_asset` so the
 * OpenAI `input_file.filename` field is populated for base64 PDFs.
 */
function collectFilenameTrailer(parts: readonly ContentPart[]): string | null {
  for (const p of parts) {
    if (p.type === "text" && p.text.startsWith("filename:")) {
      return p.text.slice("filename:".length).trim() || null;
    }
  }
  return null;
}
