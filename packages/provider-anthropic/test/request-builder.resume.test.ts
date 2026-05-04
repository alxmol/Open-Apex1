/**
 * Regression: same resume-contract check as the OpenAI side.
 * Anthropic's Messages API requires `system` and `tools` on every request —
 * there is no server-side state. The M1 resume path was sending empty
 * defaults; fix restored them.
 */

import { describe, expect, test } from "bun:test";

import type { AgentRequest, ToolDefinitionPayload } from "@open-apex/core";

import { buildRequest } from "../src/request-builder.ts";

const TOOLS: ToolDefinitionPayload[] = [
  {
    name: "run_shell",
    description: "shell exec",
    parameters: { type: "object", properties: { argv: { type: "array" } } },
  },
  {
    name: "read_file",
    description: "read a file",
    parameters: { type: "object", properties: { path: { type: "string" } } },
  },
];

describe("Anthropic buildRequest — resume payload contract", () => {
  test("system + tools present on every call", () => {
    const req: AgentRequest = {
      systemPrompt: "You are Open-Apex.",
      messages: [{ role: "user", content: "continue" }],
      tools: TOOLS,
      toolChoice: { type: "auto" },
    };
    const payload = buildRequest(
      req,
      {},
      {
        modelId: "claude-opus-4-6",
        defaultMaxTokens: 4096,
        automaticPromptCaching: false,
        systemPromptCacheable: false,
        toolsCacheable: false,
      },
    );
    expect(payload.system).toBeDefined();
    expect(payload.tools).toBeDefined();
    expect(payload.tools?.length).toBe(2);
  });

  test("forceToolChoice='required' → tool_choice.any", () => {
    const req: AgentRequest = {
      systemPrompt: "sys",
      messages: [{ role: "user", content: "go" }],
      tools: TOOLS,
      toolChoice: { type: "auto" },
    };
    const payload = buildRequest(
      req,
      { forceToolChoice: "required" },
      {
        modelId: "claude-opus-4-6",
        defaultMaxTokens: 4096,
        automaticPromptCaching: false,
        systemPromptCacheable: false,
        toolsCacheable: false,
      },
    );
    expect(payload.tool_choice).toEqual({ type: "any" });
  });
});
