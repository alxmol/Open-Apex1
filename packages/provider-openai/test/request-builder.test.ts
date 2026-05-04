import { describe, expect, test } from "bun:test";

import type { AgentRequest, Message, RequestOptions } from "@open-apex/core";

import { buildRequest, toStrictSchema } from "../src/request-builder.ts";

describe("OpenAI request-builder", () => {
  const baseReq: AgentRequest = {
    systemPrompt: "You are a helper.",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
  };

  test("maps text content into input_text", () => {
    const p = buildRequest(
      baseReq,
      {},
      {
        modelId: "gpt-5.4",
        systemPrompt: baseReq.systemPrompt,
      },
    );
    expect(p.model).toBe("gpt-5.4");
    expect(p.instructions).toBe("You are a helper.");
    expect(p.input[0]).toMatchObject({
      role: "user",
      content: [{ type: "input_text", text: "hi" }],
    });
  });

  test("renders tool_use / tool_result pairs as function_call + function_call_output", () => {
    const msg: Message = {
      role: "assistant",
      content: [
        { type: "text", text: "calling" },
        {
          type: "tool_use",
          toolCallId: "call_1",
          name: "read_file",
          arguments: { path: "a.ts" },
        },
      ],
    };
    const resultMsg: Message = {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolCallId: "call_1",
          content: "file contents",
        },
      ],
    };
    const req: AgentRequest = {
      ...baseReq,
      messages: [...baseReq.messages, msg, resultMsg],
    };
    const p = buildRequest(
      req,
      {},
      {
        modelId: "gpt-5.4",
        systemPrompt: req.systemPrompt,
      },
    );
    expect(p.input.some((i) => "type" in i && i.type === "function_call")).toBe(true);
    expect(p.input.some((i) => "type" in i && i.type === "function_call_output")).toBe(true);
  });

  test("preserves assistant phase metadata on replayed messages", () => {
    const req: AgentRequest = {
      ...baseReq,
      messages: [
        ...baseReq.messages,
        {
          role: "assistant",
          content: [{ type: "text", text: "thinking about this" }],
          phase: "commentary",
        },
      ],
    };
    const p = buildRequest(
      req,
      {},
      {
        modelId: "gpt-5.4",
        systemPrompt: req.systemPrompt,
      },
    );
    const asst = p.input.find((i) => "role" in i && i.role === "assistant") as
      | { phase?: string }
      | undefined;
    expect(asst?.phase).toBe("commentary");
  });

  test("RequestOptions.allowedTools maps to tool_choice=allowed_tools", () => {
    const req: AgentRequest = {
      ...baseReq,
      tools: [
        {
          name: "read_file",
          description: "",
          parameters: { type: "object", properties: {} },
        },
        {
          name: "write_file",
          description: "",
          parameters: { type: "object", properties: {} },
        },
      ],
      toolChoice: { type: "auto" },
    };
    const opts: RequestOptions = { allowedTools: ["read_file"] };
    const p = buildRequest(req, opts, {
      modelId: "gpt-5.4",
      systemPrompt: req.systemPrompt,
    });
    expect(p.tool_choice).toMatchObject({
      type: "allowed_tools",
      mode: "auto",
      tools: [{ type: "function", name: "read_file" }],
    });
  });

  test("reasoning.effort + summary + text.verbosity + previous_response_id forwarded", () => {
    const p = buildRequest(
      baseReq,
      { effort: "high", reasoningSummary: "concise", verbosity: "medium" },
      {
        modelId: "gpt-5.4",
        systemPrompt: baseReq.systemPrompt,
        previousResponseId: "resp_prior",
      },
    );
    expect(p.reasoning?.effort).toBe("high");
    expect(p.reasoning?.summary).toBe("concise");
    expect(p.text?.verbosity).toBe("medium");
    expect(p.previous_response_id).toBe("resp_prior");
  });

  test("structured output maps to Responses text.format json_schema", () => {
    const p = buildRequest(
      baseReq,
      {
        structuredOutput: {
          type: "json_schema",
          name: "execution_context",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            required: ["chosenApproach"],
            properties: { chosenApproach: { type: "string" } },
          },
        },
      },
      {
        modelId: "gpt-5.4",
        systemPrompt: baseReq.systemPrompt,
      },
    );
    expect(p.text?.format).toEqual({
      type: "json_schema",
      name: "execution_context",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["chosenApproach"],
        properties: { chosenApproach: { type: "string" } },
      },
    });
  });

  test("custom tool with CFG grammar forwarded", () => {
    const req: AgentRequest = {
      ...baseReq,
      tools: [
        {
          name: "apply_patch",
          description: "",
          parameters: {},
          custom: { format: { type: "grammar", grammar: "start: ANY" } },
        },
      ],
    };
    const p = buildRequest(
      req,
      {},
      {
        modelId: "gpt-5.4",
        systemPrompt: req.systemPrompt,
      },
    );
    expect(p.tools?.[0]).toMatchObject({
      type: "custom",
      name: "apply_patch",
      format: { type: "grammar", grammar: "start: ANY" },
    });
  });

  test("default: function tools tagged strict:true with lifted schema (nullable optionals)", () => {
    const req: AgentRequest = {
      ...baseReq,
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
              encoding: { type: "string" },
            },
          },
        },
      ],
    };
    const p = buildRequest(req, {}, { modelId: "gpt-5.4", systemPrompt: req.systemPrompt });
    const tool = p.tools?.[0] as {
      type: string;
      strict?: boolean;
      parameters?: Record<string, unknown>;
    };
    expect(tool.type).toBe("function");
    expect(tool.strict).toBe(true);
    const params = tool.parameters as {
      required: string[];
      additionalProperties: boolean;
      properties: Record<string, { type: unknown }>;
    };
    // All property keys now in required (OpenAI strict rule).
    expect(params.required.sort()).toEqual(["encoding", "endLine", "path", "startLine"]);
    expect(params.additionalProperties).toBe(false);
    // Originally-required `path` stays single-type.
    expect(params.properties.path?.type).toBe("string");
    // Optionals widened to union with null.
    expect(params.properties.startLine?.type).toEqual(["integer", "null"]);
    expect(params.properties.endLine?.type).toEqual(["integer", "null"]);
    expect(params.properties.encoding?.type).toEqual(["string", "null"]);
  });

  test("strict lift strips unsupported keywords (minLength, minimum, maximum, minItems)", () => {
    const req: AgentRequest = {
      ...baseReq,
      tools: [
        {
          name: "apply_patch",
          description: "",
          parameters: {
            type: "object",
            required: ["patch"],
            additionalProperties: false,
            properties: { patch: { type: "string", minLength: 10 } },
          },
        },
      ],
    };
    const p = buildRequest(req, {}, { modelId: "gpt-5.4", systemPrompt: req.systemPrompt });
    const props = (
      p.tools?.[0] as unknown as { parameters: { properties: Record<string, unknown> } }
    ).parameters.properties;
    expect(props.patch).toEqual({ type: "string" });
  });

  test("strict lift returns null (tool emitted without strict) when schema has open additionalProperties", () => {
    // run_shell's `env: {type: "object", additionalProperties: {type: "string"}}`
    // is not expressible under OpenAI strict — lifter should decline and we
    // emit the tool without strict:true so the request still validates.
    const req: AgentRequest = {
      ...baseReq,
      tools: [
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
      ],
    };
    const p = buildRequest(req, {}, { modelId: "gpt-5.4", systemPrompt: req.systemPrompt });
    const tool = p.tools?.[0] as { strict?: boolean; parameters: Record<string, unknown> };
    expect(tool.strict).toBeUndefined();
    // Original schema preserved (not mutated by lifter).
    expect(tool.parameters).toEqual(req.tools[0]!.parameters);
  });

  test("strictTools:false globally disables strict even on representable schemas", () => {
    const req: AgentRequest = {
      ...baseReq,
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
    const p = buildRequest(
      req,
      {},
      {
        modelId: "gpt-5.4",
        systemPrompt: req.systemPrompt,
        strictTools: false,
      },
    );
    expect((p.tools?.[0] as { strict?: boolean }).strict).toBeUndefined();
  });

  test("toStrictSchema recurses into nested object properties + arrays", () => {
    const lifted = toStrictSchema({
      type: "object",
      required: ["outer"],
      additionalProperties: false,
      properties: {
        outer: {
          type: "object",
          additionalProperties: false,
          properties: {
            a: { type: "string", minLength: 2 },
            b: { type: "integer" },
          },
          required: ["a"],
        },
        items: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: { id: { type: "string" } },
            required: ["id"],
          },
        },
      },
    });
    expect(lifted).not.toBeNull();
    const outer = (
      lifted!.properties as Record<
        string,
        { required: string[]; properties: Record<string, { type: unknown }> }
      >
    ).outer!;
    expect(outer.required.sort()).toEqual(["a", "b"]);
    expect(outer.properties.a?.type).toBe("string");
    expect(outer.properties.b?.type).toEqual(["integer", "null"]);
    // minLength stripped.
    expect((outer.properties.a as Record<string, unknown>).minLength).toBeUndefined();
  });

  test("toStrictSchema returns null on open additionalProperties at any depth", () => {
    const lifted = toStrictSchema({
      type: "object",
      additionalProperties: false,
      properties: {
        bag: { type: "object", additionalProperties: { type: "string" } },
      },
      required: ["bag"],
    });
    expect(lifted).toBeNull();
  });

  test("thinking blocks (Anthropic) are stripped (not forwarded to OpenAI)", () => {
    const req: AgentRequest = {
      ...baseReq,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "thinking", text: "internal", signature: "sig" },
            { type: "text", text: "external" },
          ],
        },
      ],
    };
    const p = buildRequest(
      req,
      {},
      {
        modelId: "gpt-5.4",
        systemPrompt: req.systemPrompt,
      },
    );
    const asst = p.input.find((i) => "role" in i && i.role === "assistant") as
      | { content?: Array<{ type: string; text?: string }> }
      | undefined;
    expect(asst?.content).toEqual([{ type: "output_text", text: "external" }]);
  });
});
