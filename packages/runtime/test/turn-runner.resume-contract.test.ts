/**
 * Resume-contract regression tests.
 *
 * These lock in the fix for the M1-patch smoking gun: `ProviderAdapter.resume()`
 * was passing `systemPrompt: ""` and `tools: []` to the provider on every turn
 * 2+, which made the model lose its guardrails (hallucinating ChatGPT-style
 * tool-call microsyntax) and its tool manifest (claiming "only list_tree is
 * available"). After the contract change, `resume()` takes a full
 * AgentRequest and the turn-runner sends:
 *   - fresh systemPrompt on EVERY turn, not just the first
 *   - fresh tools[] on EVERY turn
 *   - delta-only messages (only items appended since the last model call)
 *
 * The tests spy on `MockOpenAiAdapter.recordedCalls` and assert against the
 * payload the adapter actually received.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import type {
  AgentRequest,
  AutonomyLevel,
  OpenApexContext,
  OpenApexRunContext,
  ToolDefinition,
} from "@open-apex/core";
import { MockOpenAiAdapter } from "@open-apex/provider-openai";
import { readFileTool } from "@open-apex/tools";

import { runAgenticTurns } from "../src/turn-runner.ts";

function mkCtx(): OpenApexRunContext {
  const ws = mkdtempSync(path.join(tmpdir(), "oa-resume-contract-"));
  const userContext: OpenApexContext = {
    workspace: ws,
    openApexHome: path.join(ws, ".open-apex"),
    autonomyLevel: "full_auto" as AutonomyLevel,
    sessionId: "resume-contract-test",
  };
  return {
    userContext,
    runId: "resume-contract-test-run",
    signal: new AbortController().signal,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

const SYSTEM_PROMPT = "You are Open-Apex. Read files before you answer.";

const TOOL_CALL_THEN_ANSWER = {
  turns: [
    // Turn 1: emit a tool call
    {
      events: [
        {
          type: "tool_call_start" as const,
          callId: "call_1",
          name: "read_file",
          argsSchema: "json" as const,
        },
        {
          type: "tool_call_delta" as const,
          callId: "call_1",
          argsDelta: '{"path":"a.ts"}',
        },
        {
          type: "tool_call_done" as const,
          callId: "call_1",
          args: { path: "a.ts" },
        },
        {
          type: "usage_update" as const,
          usage: { inputTokens: 10, outputTokens: 5 },
          cacheHit: false,
        },
        {
          type: "done" as const,
          stopReason: "tool_use" as const,
          providerHandle: {
            kind: "openai_response" as const,
            responseId: "resp_t1",
            reasoningItemsIncluded: false,
          },
        },
      ],
    },
    // Turn 2: final text answer
    {
      events: [
        { type: "text_delta" as const, delta: "done" },
        {
          type: "usage_update" as const,
          usage: { inputTokens: 25, outputTokens: 2 },
          cacheHit: false,
        },
        {
          type: "done" as const,
          stopReason: "end_turn" as const,
          providerHandle: {
            kind: "openai_response" as const,
            responseId: "resp_t2",
            reasoningItemsIncluded: false,
          },
        },
      ],
    },
  ],
};

describe("resume contract: fresh systemPrompt + tools + delta messages", () => {
  test("turn 2 resume() receives full systemPrompt", async () => {
    const adapter = new MockOpenAiAdapter({ script: TOOL_CALL_THEN_ANSWER });
    const tools: ToolDefinition[] = [readFileTool as unknown as ToolDefinition];
    const registry = new Map<string, ToolDefinition>(tools.map((t) => [t.name, t]));
    // A workspace with the file the mocked tool call references.
    const ctx = mkCtx();
    await Bun.write(path.join(ctx.userContext.workspace, "a.ts"), "hello\n");

    await runAgenticTurns({
      adapter,
      systemPrompt: SYSTEM_PROMPT,
      initialMessages: [{ role: "user", content: "read a.ts" }],
      tools,
      toolRegistry: registry,
      ctx,
    });

    const resumeCall = adapter.recordedCalls.find((c) => c.method === "resume");
    expect(resumeCall).toBeDefined();
    const req = (resumeCall!.payload as { req: AgentRequest }).req;
    expect(req.systemPrompt).toBe(SYSTEM_PROMPT);
  });

  test("turn 2 resume() receives full tools[] (not an empty array)", async () => {
    const adapter = new MockOpenAiAdapter({ script: TOOL_CALL_THEN_ANSWER });
    const tools: ToolDefinition[] = [readFileTool as unknown as ToolDefinition];
    const registry = new Map<string, ToolDefinition>(tools.map((t) => [t.name, t]));
    const ctx = mkCtx();
    await Bun.write(path.join(ctx.userContext.workspace, "a.ts"), "hello\n");

    await runAgenticTurns({
      adapter,
      systemPrompt: SYSTEM_PROMPT,
      initialMessages: [{ role: "user", content: "read a.ts" }],
      tools,
      toolRegistry: registry,
      ctx,
    });

    const resumeCall = adapter.recordedCalls.find((c) => c.method === "resume");
    expect(resumeCall).toBeDefined();
    const req = (resumeCall!.payload as { req: AgentRequest }).req;
    expect(req.tools.length).toBe(1);
    expect(req.tools[0]?.name).toBe("read_file");
  });

  test("turn 2 resume() delta contains ONLY the new tool_result message, not the prior assistant output", async () => {
    const adapter = new MockOpenAiAdapter({ script: TOOL_CALL_THEN_ANSWER });
    const tools: ToolDefinition[] = [readFileTool as unknown as ToolDefinition];
    const registry = new Map<string, ToolDefinition>(tools.map((t) => [t.name, t]));
    const ctx = mkCtx();
    await Bun.write(path.join(ctx.userContext.workspace, "a.ts"), "hello\n");

    await runAgenticTurns({
      adapter,
      systemPrompt: SYSTEM_PROMPT,
      initialMessages: [{ role: "user", content: "read a.ts" }],
      tools,
      toolRegistry: registry,
      ctx,
    });

    const resumeCall = adapter.recordedCalls.find((c) => c.method === "resume");
    expect(resumeCall).toBeDefined();
    const req = (resumeCall!.payload as { req: AgentRequest }).req;
    // Delta should contain exactly one user-role message carrying tool_result(s).
    expect(req.messages.length).toBe(1);
    const m = req.messages[0]!;
    expect(m.role).toBe("user");
    const content = m.content;
    expect(Array.isArray(content)).toBe(true);
    const parts = content as Array<{ type: string }>;
    // No assistant tool_use items should leak into resume input — they're
    // server-side via previous_response_id (OpenAI) or replayed from the
    // handle (Anthropic).
    expect(parts.every((p) => p.type === "tool_result")).toBe(true);
    expect(parts.length).toBe(1);
  });

  test("turn 1 generate() also carries the full systemPrompt + tools (regression baseline)", async () => {
    const adapter = new MockOpenAiAdapter({ script: TOOL_CALL_THEN_ANSWER });
    const tools: ToolDefinition[] = [readFileTool as unknown as ToolDefinition];
    const registry = new Map<string, ToolDefinition>(tools.map((t) => [t.name, t]));
    const ctx = mkCtx();
    await Bun.write(path.join(ctx.userContext.workspace, "a.ts"), "hello\n");

    await runAgenticTurns({
      adapter,
      systemPrompt: SYSTEM_PROMPT,
      initialMessages: [{ role: "user", content: "read a.ts" }],
      tools,
      toolRegistry: registry,
      ctx,
    });

    const generateCall = adapter.recordedCalls.find((c) => c.method === "generate");
    expect(generateCall).toBeDefined();
    const req = (generateCall!.payload as { req: AgentRequest }).req;
    expect(req.systemPrompt).toBe(SYSTEM_PROMPT);
    expect(req.tools.length).toBe(1);
    expect(req.messages.length).toBe(1);
    expect(req.messages[0]?.role).toBe("user");
  });

  test("restored chat handle resumes with only the new user delta", async () => {
    const adapter = new MockOpenAiAdapter({
      script: {
        turns: [
          {
            events: [
              { type: "text_delta", delta: "continued" },
              {
                type: "usage_update",
                usage: { inputTokens: 5, outputTokens: 1 },
                cacheHit: false,
              },
              {
                type: "done",
                stopReason: "end_turn",
                providerHandle: {
                  kind: "openai_response",
                  responseId: "resp_after",
                  reasoningItemsIncluded: false,
                },
              },
            ],
          },
        ],
      },
    });
    const ctx = mkCtx();
    await runAgenticTurns({
      adapter,
      systemPrompt: SYSTEM_PROMPT,
      initialMessages: [
        { role: "user", content: "old question" },
        { role: "assistant", content: "old answer" },
        { role: "user", content: "new question" },
      ],
      tools: [],
      toolRegistry: new Map(),
      ctx,
      options: {
        startingProviderHandle: {
          kind: "openai_response",
          responseId: "resp_old",
          reasoningItemsIncluded: false,
        },
        startingDeliveredHistoryLength: 2,
      },
    });

    expect(adapter.recordedCalls.map((c) => c.method)).toEqual(["resume"]);
    const req = (adapter.recordedCalls[0]!.payload as { req: AgentRequest }).req;
    expect(req.messages).toEqual([{ role: "user", content: "new question" }]);
  });

  test("restored compacted OpenAI handle resumes with only the new user delta", async () => {
    const adapter = new MockOpenAiAdapter({
      script: {
        turns: [
          {
            events: [
              { type: "text_delta", delta: "continued from compacted state" },
              {
                type: "done",
                stopReason: "end_turn",
                providerHandle: {
                  kind: "openai_response",
                  responseId: "resp_after_compact",
                  reasoningItemsIncluded: false,
                },
              },
            ],
          },
        ],
      },
    });
    const ctx = mkCtx();
    await runAgenticTurns({
      adapter,
      systemPrompt: SYSTEM_PROMPT,
      initialMessages: [
        { role: "user", content: "old question" },
        { role: "assistant", content: "old answer" },
        { role: "user", content: "new question" },
      ],
      tools: [],
      toolRegistry: new Map(),
      ctx,
      options: {
        startingProviderHandle: {
          kind: "openai_compacted",
          input: [{ type: "message", role: "assistant", content: [] }],
          reasoningItemsIncluded: true,
          conversationId: "conv_compacted",
        },
        startingDeliveredHistoryLength: 2,
      },
    });

    expect(adapter.recordedCalls.map((c) => c.method)).toEqual(["resume"]);
    const call = adapter.recordedCalls[0]!.payload as {
      handle: { kind: string; conversationId?: string };
      req: AgentRequest;
    };
    expect(call.handle.kind).toBe("openai_compacted");
    expect(call.handle.conversationId).toBe("conv_compacted");
    expect(call.req.messages).toEqual([{ role: "user", content: "new question" }]);
  });

  test("stale previous_response_id retries via durable conversation before local replay", async () => {
    const adapter = new MockOpenAiAdapter({
      script: {
        turns: [
          {
            events: [],
            throwError: { code: "not_found", message: "previous response expired" },
          },
          {
            events: [
              { type: "text_delta", delta: "continued via conversation" },
              {
                type: "done",
                stopReason: "end_turn",
                providerHandle: {
                  kind: "openai_response",
                  responseId: "resp_conversation_after",
                  reasoningItemsIncluded: false,
                  conversationId: "conv_resume",
                },
              },
            ],
          },
        ],
      },
    });
    const ctx = mkCtx();
    await runAgenticTurns({
      adapter,
      systemPrompt: SYSTEM_PROMPT,
      initialMessages: [
        { role: "user", content: "old question" },
        { role: "assistant", content: "old answer" },
        { role: "user", content: "new question" },
      ],
      tools: [],
      toolRegistry: new Map(),
      ctx,
      options: {
        startingProviderHandle: {
          kind: "openai_response",
          responseId: "resp_expired",
          reasoningItemsIncluded: false,
          conversationId: "conv_resume",
        },
        startingDeliveredHistoryLength: 2,
        fallbackToLocalReplayOnResumeError: true,
      },
    });

    expect(adapter.recordedCalls.map((c) => c.method)).toEqual(["resume", "resume"]);
    const retry = adapter.recordedCalls[1]!.payload as {
      handle: { kind: string; conversationId?: string };
      req: AgentRequest;
    };
    expect(retry.handle).toEqual({ kind: "openai_conversation", conversationId: "conv_resume" });
    expect(retry.req.messages).toEqual([{ role: "user", content: "new question" }]);
  });

  test("multimodal new delta is preserved when resuming from provider state", async () => {
    const adapter = new MockOpenAiAdapter({
      script: {
        turns: [
          {
            events: [
              { type: "text_delta", delta: "saw image" },
              {
                type: "done",
                stopReason: "end_turn",
                providerHandle: {
                  kind: "openai_response",
                  responseId: "resp_after_image",
                  reasoningItemsIncluded: false,
                },
              },
            ],
          },
        ],
      },
    });
    const ctx = mkCtx();
    const multimodal = [
      { type: "text" as const, text: "describe this" },
      {
        type: "image" as const,
        source: { kind: "url" as const, url: "https://example.com/cat.png" },
      },
    ];
    await runAgenticTurns({
      adapter,
      systemPrompt: SYSTEM_PROMPT,
      initialMessages: [
        { role: "user", content: "old question" },
        { role: "assistant", content: "old answer" },
        { role: "user", content: multimodal },
      ],
      tools: [],
      toolRegistry: new Map(),
      ctx,
      options: {
        startingProviderHandle: {
          kind: "openai_response",
          responseId: "resp_old",
          reasoningItemsIncluded: false,
        },
        startingDeliveredHistoryLength: 2,
      },
    });

    const req = (adapter.recordedCalls[0]!.payload as { req: AgentRequest }).req;
    expect(req.messages).toEqual([{ role: "user", content: multimodal }]);
  });

  test("stale restored handle falls back to full local replay", async () => {
    const adapter = new MockOpenAiAdapter({
      script: {
        turns: [
          {
            events: [],
            throwError: { code: "not_found", message: "previous response expired" },
          },
          {
            events: [
              { type: "text_delta", delta: "replayed" },
              {
                type: "done",
                stopReason: "end_turn",
                providerHandle: {
                  kind: "openai_response",
                  responseId: "resp_replayed",
                  reasoningItemsIncluded: false,
                },
              },
            ],
          },
        ],
      },
    });
    const ctx = mkCtx();
    const result = await runAgenticTurns({
      adapter,
      systemPrompt: SYSTEM_PROMPT,
      initialMessages: [
        { role: "user", content: "old question" },
        { role: "assistant", content: "old answer" },
        { role: "user", content: "new question" },
      ],
      tools: [],
      toolRegistry: new Map(),
      ctx,
      options: {
        startingProviderHandle: {
          kind: "openai_response",
          responseId: "resp_expired",
          reasoningItemsIncluded: false,
        },
        startingDeliveredHistoryLength: 2,
        fallbackToLocalReplayOnResumeError: true,
      },
    });

    expect(result.finalAssistant && "content" in result.finalAssistant).toBe(true);
    expect(adapter.recordedCalls.map((c) => c.method)).toEqual(["resume", "generate"]);
    const replayReq = (adapter.recordedCalls[1]!.payload as { req: AgentRequest }).req;
    expect(replayReq.messages.map((m) => m.content)).toEqual([
      "old question",
      "old answer",
      "new question",
    ]);
  });
});
