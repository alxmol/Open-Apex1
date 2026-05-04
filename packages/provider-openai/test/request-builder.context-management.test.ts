import { describe, expect, test } from "bun:test";

import type { AgentRequest } from "@open-apex/core";

import { buildRequest } from "../src/request-builder.ts";

describe("OpenAI request-builder M5 context management", () => {
  const req: AgentRequest = {
    systemPrompt: "You are Open-Apex.",
    messages: [{ role: "user", content: "continue" }],
    tools: [],
  };

  test("emits request-level server compaction threshold", () => {
    const payload = buildRequest(
      req,
      { contextManagement: { compactThreshold: 200_000 } },
      { modelId: "gpt-5.4", systemPrompt: req.systemPrompt },
    );
    expect(payload.context_management).toEqual([
      { type: "compaction", compact_threshold: 200_000 },
    ]);
  });

  test("emits conversation, store, and background fields only when requested", () => {
    const payload = buildRequest(
      req,
      { conversationId: "conv_123", background: true },
      { modelId: "gpt-5.4", systemPrompt: req.systemPrompt },
    );
    expect(payload.conversation).toBe("conv_123");
    expect(payload.background).toBe(true);
    expect(payload.store).toBe(true);
  });

  test("rejects mutually exclusive conversation and previous_response_id", () => {
    expect(() =>
      buildRequest(
        req,
        { conversationId: "conv_123" },
        {
          modelId: "gpt-5.4",
          systemPrompt: req.systemPrompt,
          previousResponseId: "resp_123",
        },
      ),
    ).toThrow("previous_response_id and conversation");
  });

  test("preserves explicit store=false for foreground responses", () => {
    const payload = buildRequest(
      req,
      { store: false },
      { modelId: "gpt-5.4", systemPrompt: req.systemPrompt },
    );
    expect(payload.store).toBe(false);
    expect(payload.background).toBeUndefined();
  });
});
