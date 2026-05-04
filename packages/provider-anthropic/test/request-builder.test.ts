import { describe, expect, test } from "bun:test";

import type { AgentRequest } from "@open-apex/core";
import { registerBuiltinTools, ToolRegistryImpl } from "@open-apex/tools";

import { buildRequest, foldMessages, toAnthropicStrictSchema } from "../src/request-builder.ts";

describe("Anthropic request-builder", () => {
  const baseBuild = {
    modelId: "claude-opus-4-6",
    defaultMaxTokens: 2048,
    automaticPromptCaching: true,
    systemPromptCacheable: true,
    toolsCacheable: true,
    stream: true,
  };

  test("emits adaptive thinking by default", () => {
    const req: AgentRequest = {
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    };
    const p = buildRequest(req, {}, baseBuild);
    expect(p.thinking).toEqual({ type: "adaptive" });
  });

  test("enables top-level automatic prompt caching", () => {
    const req: AgentRequest = {
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    };
    const p = buildRequest(req, {}, baseBuild);
    expect(p.cache_control).toEqual({ type: "ephemeral" });
  });

  test("structured output maps to output_config.format json_schema", () => {
    const req: AgentRequest = {
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    };
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["confidence"],
      properties: { confidence: { type: "string" } },
    };
    const p = buildRequest(
      req,
      {
        effort: "high",
        structuredOutput: {
          type: "json_schema",
          name: "verifier_result",
          strict: true,
          schema,
        },
      },
      baseBuild,
    );
    expect(p.output_config).toEqual({
      effort: "high",
      format: {
        type: "json_schema",
        schema,
      },
    });
  });

  test("places cache_control breakpoint at system-prompt end", () => {
    const req: AgentRequest = {
      systemPrompt: "system text",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    };
    const p = buildRequest(req, {}, baseBuild);
    expect(Array.isArray(p.system)).toBe(true);
    if (!Array.isArray(p.system)) throw new Error("unreachable");
    expect(p.system[0]).toMatchObject({
      type: "text",
      text: "system text",
      cache_control: { type: "ephemeral" },
    });
  });

  test("places cache_control on the last tool when toolsCacheable", () => {
    const req: AgentRequest = {
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { name: "a", description: "", parameters: {} },
        { name: "b", description: "", parameters: {} },
      ],
    };
    const p = buildRequest(req, {}, baseBuild);
    expect(p.tools?.[0]?.cache_control).toBeUndefined();
    expect(p.tools?.[1]?.cache_control).toEqual({ type: "ephemeral" });
  });

  test("tags every tool with strict:true by default (Anthropic grammar-constrained sampling)", () => {
    const req: AgentRequest = {
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          name: "read_file",
          description: "",
          parameters: {
            type: "object",
            required: ["path"],
            additionalProperties: false,
            properties: { path: { type: "string" } },
          },
        },
        {
          name: "run_shell",
          description: "",
          parameters: {
            type: "object",
            required: ["argv"],
            additionalProperties: false,
            properties: { argv: { type: "array", items: { type: "string" } } },
          },
        },
      ],
    };
    const p = buildRequest(req, {}, baseBuild);
    expect(p.tools?.[0]?.strict).toBe(true);
    expect(p.tools?.[1]?.strict).toBe(true);
  });

  test("strictTools:false opts out of strict mode (debug A/B)", () => {
    const req: AgentRequest = {
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          name: "read_file",
          description: "",
          parameters: {
            type: "object",
            required: ["path"],
            additionalProperties: false,
            properties: { path: { type: "string" } },
          },
        },
      ],
    };
    const p = buildRequest(req, {}, { ...baseBuild, strictTools: false });
    expect(p.tools?.[0]?.strict).toBeUndefined();
  });

  test("strict tool tagging is capped at 20 tools per Anthropic docs", () => {
    const tools = Array.from({ length: 21 }, (_, i) => ({
      name: `tool_${i}`,
      description: "",
      parameters: {
        type: "object",
        required: ["path"],
        additionalProperties: false,
        properties: { path: { type: "string" } },
      },
    }));
    const req: AgentRequest = {
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools,
    };
    const p = buildRequest(req, {}, baseBuild);
    expect(p.tools?.filter((t) => t.strict).length).toBe(20);
    expect(p.tools?.[20]?.strict).toBeUndefined();
  });

  test("production built-in tool manifest stays under Anthropic strict optional-param budget", () => {
    const registry = new ToolRegistryImpl();
    registerBuiltinTools(registry, {
      webSearch: true,
      repoMap: true,
      symbolIndex: true,
      readAsset: true,
    });
    const req: AgentRequest = {
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: registry.list().map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    };
    const p = buildRequest(req, {}, baseBuild);
    const strictTools = p.tools?.filter((t) => t.strict) ?? [];
    const strictOptionalParams = strictTools.reduce(
      (sum, t) => sum + countOptionalObjectProperties(t.input_schema),
      0,
    );
    expect(strictTools.length).toBeLessThanOrEqual(20);
    expect(strictOptionalParams).toBeLessThanOrEqual(24);
    expect(p.tools?.some((t) => t.strict === undefined)).toBe(true);
  });

  test("projects critical shell schemas instead of downgrading open env dicts", () => {
    const req: AgentRequest = {
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        // schema missing additionalProperties: false on root
        {
          name: "get_weather",
          description: "",
          parameters: {
            type: "object",
            required: ["city"],
            properties: { city: { type: "string" } },
          },
        },
        // schema with open env dict on nested
        {
          name: "run_shell",
          description: "",
          parameters: {
            type: "object",
            required: ["argv"],
            additionalProperties: false,
            properties: {
              argv: { type: "array", items: { type: "string" } },
              env: {
                type: "object",
                additionalProperties: { type: "string" },
              },
            },
          },
        },
        // fully strict-eligible
        {
          name: "read_file",
          description: "",
          parameters: {
            type: "object",
            required: ["path"],
            additionalProperties: false,
            properties: { path: { type: "string" } },
          },
        },
      ],
    };
    const p = buildRequest(req, {}, baseBuild);
    expect(p.tools?.[0]?.strict).toBe(true); // lifter auto-adds additionalProperties: false
    expect(p.tools?.[1]?.strict).toBe(true); // run_shell uses the Anthropic-only projection
    expect(p.tools?.[1]?.input_schema).toMatchObject({
      required: ["argv"],
      properties: {
        argv: { type: "array", items: { type: "string" } },
      },
    });
    expect(
      Object.keys((p.tools?.[1]?.input_schema.properties as Record<string, unknown>) ?? {}),
    ).not.toContain("env");
    expect(p.tools?.[2]?.strict).toBe(true); // fully closed
  });

  test("production Opus manifest strict-tags critical mutating and shell tools first", () => {
    const registry = new ToolRegistryImpl();
    registerBuiltinTools(registry, {
      webSearch: true,
      repoMap: true,
      symbolIndex: true,
      readAsset: true,
    });
    const req: AgentRequest = {
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: registry.list().map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
    };
    const p = buildRequest(req, {}, baseBuild);
    const byName = new Map((p.tools ?? []).map((tool) => [tool.name, tool]));
    for (const name of ["write_file", "shell_command", "run_shell"]) {
      expect(byName.get(name)?.strict).toBe(true);
    }
    expect(
      Object.keys((byName.get("write_file")?.input_schema.properties as object) ?? {}),
    ).toEqual(["path", "content"]);
    expect(
      Object.keys((byName.get("shell_command")?.input_schema.properties as object) ?? {}),
    ).not.toContain("env");
    expect(
      Object.keys((byName.get("run_shell")?.input_schema.properties as object) ?? {}),
    ).not.toContain("env");
  });

  test("strict budget pressure downgrades lower-priority tools before critical tools", () => {
    const genericTools = Array.from({ length: 20 }, (_, i) => ({
      name: `tool_${i}`,
      description: "",
      parameters: {
        type: "object",
        required: ["path"],
        additionalProperties: false,
        properties: { path: { type: "string" } },
      },
    }));
    const req: AgentRequest = {
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        ...genericTools,
        {
          name: "write_file",
          description: "",
          parameters: {
            type: "object",
            required: ["path", "content"],
            additionalProperties: false,
            properties: {
              path: { type: "string" },
              content: { type: "string" },
              encoding: { type: "string" },
            },
          },
        },
      ],
    };
    const p = buildRequest(req, {}, baseBuild);
    expect(p.tools?.filter((tool) => tool.strict).length).toBe(20);
    expect(p.tools?.find((tool) => tool.name === "write_file")?.strict).toBe(true);
    expect(p.tools?.find((tool) => tool.name === "tool_19")?.strict).toBeUndefined();
  });

  test("lifter strips Anthropic-unsupported keywords on strict-tagged tools (regression from TB2 0/6)", () => {
    // Every schema below contains at least one keyword the Anthropic API
    // would reject with 400: tools.0.custom: For '<type>' type, property
    // '<keyword>' is not supported. Pre-fix (eligibility check only), these
    // were sent through unchanged and the entire request died on turn 1.
    const req: AgentRequest = {
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          name: "read_file",
          description: "",
          parameters: {
            type: "object",
            required: ["path"],
            additionalProperties: false,
            properties: {
              path: { type: "string" },
              startLine: { type: "integer", minimum: 1 },
              endLine: { type: "integer", minimum: 1 },
            },
          },
        },
        {
          name: "apply_patch",
          description: "",
          parameters: {
            type: "object",
            required: ["patch"],
            additionalProperties: false,
            properties: {
              patch: { type: "string", minLength: 10, maxLength: 1_000_000 },
            },
          },
        },
        {
          name: "list_tree",
          description: "",
          parameters: {
            type: "object",
            required: ["path"],
            additionalProperties: false,
            properties: {
              path: { type: "string" },
              maxDepth: { type: "integer", minimum: 1, maximum: 20 },
            },
          },
        },
      ],
    };
    const p = buildRequest(req, {}, baseBuild);
    // All three should strict-tag AND carry the stripped schema.
    for (const tool of p.tools ?? []) {
      expect(tool.strict).toBe(true);
      const schema = tool.input_schema as Record<string, Record<string, unknown>>;
      const props = schema.properties as Record<string, Record<string, unknown>>;
      for (const v of Object.values(props)) {
        // Every stripped keyword must be gone.
        expect(v.minimum).toBeUndefined();
        expect(v.maximum).toBeUndefined();
        expect(v.minLength).toBeUndefined();
        expect(v.maxLength).toBeUndefined();
      }
    }
  });

  test("lifter preserves optional fields (Anthropic strict allows optionals unlike OpenAI)", () => {
    const lifted = toAnthropicStrictSchema({
      type: "object",
      required: ["path"],
      additionalProperties: false,
      properties: {
        path: { type: "string" },
        startLine: { type: "integer", minimum: 1 },
      },
    });
    expect(lifted).not.toBeNull();
    // Original `required` is preserved — optional fields NOT promoted to
    // required (differs from OpenAI strict where every key must be required).
    expect(lifted!.required).toEqual(["path"]);
    // Optional field schema stripped but type still scalar (no null union).
    const props = lifted!.properties as Record<string, Record<string, unknown>>;
    expect(props.startLine).toEqual({ type: "integer" });
  });

  test("lifter keeps supported `format` values, drops non-whitelisted ones", () => {
    const lifted = toAnthropicStrictSchema({
      type: "object",
      additionalProperties: false,
      properties: {
        createdAt: { type: "string", format: "date-time" }, // supported
        customField: { type: "string", format: "color-hex" }, // not in whitelist
      },
      required: [],
    });
    const props = lifted!.properties as Record<string, Record<string, unknown>>;
    expect(props.createdAt?.format).toBe("date-time");
    expect(props.customField?.format).toBeUndefined();
  });

  test("lifter keeps minItems 0 and 1, drops minItems > 1 and any maxItems", () => {
    const lifted = toAnthropicStrictSchema({
      type: "object",
      additionalProperties: false,
      properties: {
        argv: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 100 },
        big: { type: "array", items: { type: "string" }, minItems: 5 },
      },
      required: [],
    });
    const props = lifted!.properties as Record<string, Record<string, unknown>>;
    expect(props.argv?.minItems).toBe(1);
    expect(props.argv?.maxItems).toBeUndefined();
    expect(props.big?.minItems).toBeUndefined();
  });

  test("lifter drops `pattern`, `multipleOf`, `contentEncoding`, `contentMediaType`", () => {
    const lifted = toAnthropicStrictSchema({
      type: "object",
      additionalProperties: false,
      properties: {
        slug: { type: "string", pattern: "^[a-z0-9-]+$" },
        count: { type: "integer", multipleOf: 2 },
        blob: { type: "string", contentEncoding: "base64", contentMediaType: "image/png" },
      },
      required: [],
    });
    const props = lifted!.properties as Record<string, Record<string, unknown>>;
    expect(props.slug?.pattern).toBeUndefined();
    expect(props.count?.multipleOf).toBeUndefined();
    expect(props.blob?.contentEncoding).toBeUndefined();
    expect(props.blob?.contentMediaType).toBeUndefined();
  });

  test("lifter returns null for open additionalProperties (non-representable)", () => {
    const lifted = toAnthropicStrictSchema({
      type: "object",
      additionalProperties: false,
      properties: {
        env: { type: "object", additionalProperties: { type: "string" } },
      },
      required: [],
    });
    expect(lifted).toBeNull();
  });

  test("lifter recurses into items, anyOf, allOf, oneOf", () => {
    const lifted = toAnthropicStrictSchema({
      type: "object",
      additionalProperties: false,
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: { n: { type: "integer", minimum: 5 } },
            required: ["n"],
          },
        },
        choice: {
          anyOf: [
            { type: "string", minLength: 1 },
            { type: "integer", minimum: 0 },
          ],
        },
      },
      required: [],
    });
    expect(lifted).not.toBeNull();
    const props = lifted!.properties as Record<string, Record<string, unknown>>;
    const itemSchema = (props.items?.items as Record<string, Record<string, unknown>>)
      .properties as Record<string, Record<string, unknown>>;
    expect(itemSchema.n?.minimum).toBeUndefined();
    const choices = props.choice?.anyOf as Array<Record<string, unknown>>;
    expect(choices[0]?.minLength).toBeUndefined();
    expect(choices[1]?.minimum).toBeUndefined();
  });

  test("allowedTools filters tools client-side (Anthropic has no server filter)", () => {
    const req: AgentRequest = {
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: [
        { name: "read_file", description: "", parameters: {} },
        { name: "write_file", description: "", parameters: {} },
      ],
    };
    const p = buildRequest(req, { allowedTools: ["read_file"] }, baseBuild);
    expect(p.tools?.map((t) => t.name)).toEqual(["read_file"]);
  });

  test("effort maps to output_config.effort", () => {
    const req: AgentRequest = {
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    };
    const p = buildRequest(req, { effort: "high" }, baseBuild);
    expect(p.output_config?.effort).toBe("high");
  });

  test("contextManagement → context_management.edits (tool_uses + thinking + compact)", () => {
    const req: AgentRequest = {
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: [],
    };
    const p = buildRequest(
      req,
      {
        contextManagement: {
          triggerInputTokens: 60000,
          keepToolUses: 4,
          clearAtLeastTokens: 10000,
          excludeTools: ["web_search"],
          keepThinking: 1,
          compactThreshold: 150000,
        },
      },
      baseBuild,
    );
    const edits = p.context_management?.edits as Array<Record<string, unknown>>;
    expect(edits).toBeDefined();
    expect(edits.map((e) => e.type)).toEqual([
      "clear_tool_uses_20250919",
      "clear_thinking_20251015",
      "compact_20260112",
    ]);
  });

  test("thinking block with signature is forwarded as an assistant content block", () => {
    const req: AgentRequest = {
      systemPrompt: "sys",
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "considering", signature: "sig-42" },
            { type: "text", text: "done" },
          ],
        },
      ],
      tools: [],
    };
    const p = buildRequest(req, {}, baseBuild);
    expect(p.messages[0]?.content[0]).toMatchObject({
      type: "thinking",
      thinking: "considering",
      signature: "sig-42",
    });
  });

  test("foldMessages merges consecutive same-role messages", () => {
    const folded = foldMessages([
      { role: "user", content: "a" },
      { role: "user", content: "b" },
      { role: "assistant", content: "c" },
    ]);
    expect(folded.length).toBe(2);
    expect(folded[0]?.role).toBe("user");
    expect(folded[0]?.content.length).toBe(2);
  });

  test("tool_use + tool_result pair across user/assistant messages", () => {
    const req: AgentRequest = {
      systemPrompt: "sys",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              toolCallId: "tu_1",
              name: "read_file",
              arguments: { path: "a.ts" },
            },
          ],
        },
        {
          role: "user",
          content: [{ type: "tool_result", toolCallId: "tu_1", content: "contents" }],
        },
      ],
      tools: [],
    };
    const p = buildRequest(req, {}, baseBuild);
    expect(p.messages[0]?.content[0]).toMatchObject({
      type: "tool_use",
      id: "tu_1",
      name: "read_file",
    });
    expect(p.messages[1]?.content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tu_1",
    });
  });

  test("tool_result repair text stays after tool results in one user message", () => {
    const req: AgentRequest = {
      systemPrompt: "sys",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              toolCallId: "tu_bad",
              name: "write_file",
              arguments: {},
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolCallId: "tu_bad",
              content: "write_file.path is required string",
              isError: true,
            },
            { type: "text", text: "<tool_argument_repair>schema repair</tool_argument_repair>" },
          ],
        },
      ],
      tools: [],
    };
    const p = buildRequest(req, {}, baseBuild);
    expect(p.messages[1]?.content[0]).toMatchObject({
      type: "tool_result",
      tool_use_id: "tu_bad",
    });
    expect(p.messages[1]?.content[1]).toMatchObject({
      type: "text",
      text: "<tool_argument_repair>schema repair</tool_argument_repair>",
    });
  });

  test("tool_use input is always an object for Anthropic replay", () => {
    const req = {
      systemPrompt: "sys",
      messages: [
        {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              toolCallId: "tu_obj",
              name: "write_file",
              arguments: { path: "a" },
            },
            {
              type: "tool_use",
              toolCallId: "tu_undef",
              name: "write_file",
              arguments: undefined,
            },
            { type: "tool_use", toolCallId: "tu_null", name: "write_file", arguments: null },
            { type: "tool_use", toolCallId: "tu_array", name: "write_file", arguments: [] },
            {
              type: "tool_use",
              toolCallId: "tu_string",
              name: "write_file",
              arguments: "not-json",
            },
            {
              type: "tool_use",
              toolCallId: "tu_json_scalar",
              name: "write_file",
              arguments: '"scalar"',
            },
            {
              type: "tool_use",
              toolCallId: "tu_json_obj",
              name: "write_file",
              arguments: '{"path":"ok"}',
            },
          ],
        },
      ],
      tools: [],
    } as unknown as AgentRequest;
    const p = buildRequest(req, {}, baseBuild);
    const inputs = p.messages[0]!.content.filter((b) => b.type === "tool_use").map(
      (b) => (b as { input: unknown }).input,
    );

    expect(inputs).toEqual([{ path: "a" }, {}, {}, {}, {}, {}, { path: "ok" }]);
    for (const input of inputs) {
      expect(input).not.toBeNull();
      expect(typeof input).toBe("object");
      expect(Array.isArray(input)).toBe(false);
    }
  });

  describe("forced tool_choice disables thinking (tb2-12 regression: plan Fix B)", () => {
    // Anthropic rejects the combination "extended thinking + tool_choice
    // forces tool use" with HTTP 400 "Thinking may not be enabled when
    // tool_choice forces tool use." Observed on tb2-12 opus/overfull-hbox
    // where hallucination-recovery fires forceToolChoice="required"
    // alongside the default adaptive-thinking config. The request-builder
    // must switch thinking to disabled on those requests. Docs:
    // https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools
    const reqWithTool: AgentRequest = {
      systemPrompt: "sys",
      messages: [{ role: "user", content: "hi" }],
      tools: [{ name: "run_shell", description: "d", parameters: { type: "object" } }],
    };

    test("opts.forceToolChoice=required → tool_choice:any + thinking:disabled", () => {
      const p = buildRequest(reqWithTool, { forceToolChoice: "required" }, baseBuild);
      expect(p.tool_choice).toEqual({ type: "any" });
      expect(p.thinking).toEqual({ type: "disabled" });
    });

    test("req.toolChoice=required → same (tool_choice:any + thinking:disabled)", () => {
      const p = buildRequest({ ...reqWithTool, toolChoice: { type: "required" } }, {}, baseBuild);
      expect(p.tool_choice).toEqual({ type: "any" });
      expect(p.thinking).toEqual({ type: "disabled" });
    });

    test("req.toolChoice=specific → tool_choice:tool + thinking:disabled", () => {
      const p = buildRequest(
        { ...reqWithTool, toolChoice: { type: "specific", toolName: "run_shell" } },
        {},
        baseBuild,
      );
      expect(p.tool_choice).toEqual({ type: "tool", name: "run_shell" });
      expect(p.thinking).toEqual({ type: "disabled" });
    });

    test("req.toolChoice=auto keeps thinking adaptive (unchanged)", () => {
      const p = buildRequest({ ...reqWithTool, toolChoice: { type: "auto" } }, {}, baseBuild);
      expect(p.tool_choice).toEqual({ type: "auto" });
      expect(p.thinking).toEqual({ type: "adaptive" });
    });

    test("req.toolChoice=none keeps thinking adaptive", () => {
      const p = buildRequest({ ...reqWithTool, toolChoice: { type: "none" } }, {}, baseBuild);
      expect(p.tool_choice).toEqual({ type: "none" });
      expect(p.thinking).toEqual({ type: "adaptive" });
    });

    test("no toolChoice at all keeps thinking adaptive (unchanged default)", () => {
      const p = buildRequest(reqWithTool, {}, baseBuild);
      expect(p.thinking).toEqual({ type: "adaptive" });
    });

    test("forceToolChoice=required with no tools in manifest → NOT applied, thinking stays adaptive", () => {
      // Guard: when there are no tools, force-required is pointless and the
      // branch should not fire. thinking remains adaptive.
      const reqNoTools: AgentRequest = {
        systemPrompt: "sys",
        messages: [{ role: "user", content: "hi" }],
        tools: [],
      };
      const p = buildRequest(reqNoTools, { forceToolChoice: "required" }, baseBuild);
      expect(p.tool_choice).toBeUndefined();
      expect(p.thinking).toEqual({ type: "adaptive" });
    });
  });
});

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
  if (isPlainRecord(schema.items)) count += countOptionalObjectProperties(schema.items);
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
