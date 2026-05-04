/**
 * Regression: the outbound Responses API payload on resume must carry fresh
 * `instructions` + `tools`. This was the single highest-value M1 bug — the
 * original resume path sent `instructions: ""` and no tools, which is why
 * GPT-5.4 fell back to ChatGPT microsyntax on turn 2+ during TB2 smoke.
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

describe("OpenAI buildRequest — resume payload contract", () => {
  test("resume payload carries instructions + tools even when previous_response_id is set", () => {
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
        modelId: "gpt-5.4",
        systemPrompt: "You are Open-Apex.",
        previousResponseId: "resp_prior",
      },
    );
    expect(payload.instructions).toBe("You are Open-Apex.");
    expect(payload.tools).toBeDefined();
    expect(payload.tools?.length).toBe(2);
    expect(payload.previous_response_id).toBe("resp_prior");
    expect(payload.parallel_tool_calls).toBe(true);
  });

  test("forceToolChoice='required' overrides the caller toolChoice", () => {
    const req: AgentRequest = {
      systemPrompt: "sys",
      messages: [{ role: "user", content: "go" }],
      tools: TOOLS,
      toolChoice: { type: "auto" },
    };
    const payload = buildRequest(
      req,
      { forceToolChoice: "required" },
      { modelId: "gpt-5.4", systemPrompt: "sys" },
    );
    expect(payload.tool_choice).toBe("required");
  });

  test("parallel_tool_calls omitted when no tools are registered", () => {
    const req: AgentRequest = {
      systemPrompt: "sys",
      messages: [{ role: "user", content: "go" }],
      tools: [],
    };
    const payload = buildRequest(req, {}, { modelId: "gpt-5.4", systemPrompt: "sys" });
    expect(payload.parallel_tool_calls).toBeUndefined();
    expect(payload.tools).toBeUndefined();
  });
});
