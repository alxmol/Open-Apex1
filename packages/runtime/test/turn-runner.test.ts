/**
 * Turn runner integration test using the MockProvider substrate.
 * Verifies:
 *   - single-turn text response
 *   - tool-call → tool-result → second turn loop
 *   - parallel function-kind tool calls run concurrently
 *   - serial editor-kind tool calls run in order
 *   - maxTurns ceiling honored
 */

import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import type {
  AutonomyLevel,
  ContentPart,
  HistoryItem,
  OpenApexContext,
  OpenApexRunContext,
  ToolCallRequest,
  StreamEvent,
  ToolDefinition,
} from "@open-apex/core";
import { MockAnthropicAdapter } from "@open-apex/provider-anthropic";
import { MockOpenAiAdapter } from "@open-apex/provider-openai";
import { ToolRegistryImpl, applyPatchTool, readFileTool, writeFileTool } from "@open-apex/tools";

import { runAgenticTurns } from "../src/turn-runner.ts";

function mkWorkspace(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openapex-runtime-ws-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return dir;
}

function mkCtx(workspace: string): OpenApexRunContext {
  const userContext: OpenApexContext = {
    workspace,
    openApexHome: path.join(workspace, ".open-apex"),
    autonomyLevel: "full_auto" as AutonomyLevel,
    sessionId: "runtime-test",
  };
  return {
    userContext,
    runId: "runtime-test-run",
    signal: new AbortController().signal,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

function historyContent(item: HistoryItem): string {
  if (typeof item.content === "string") return item.content;
  return item.content.map((p) => ("text" in p ? String(p.text) : "")).join("\n");
}

describe("runAgenticTurns — single-turn", () => {
  test("plain text response completes in one turn", async () => {
    const ws = mkWorkspace();
    const adapter = new MockOpenAiAdapter({
      script: {
        turns: [
          {
            events: [
              { type: "text_delta", delta: "hello" },
              {
                type: "usage_update",
                usage: { inputTokens: 10, outputTokens: 1 },
                cacheHit: false,
              },
              {
                type: "done",
                stopReason: "end_turn",
                providerHandle: {
                  kind: "openai_response",
                  responseId: "resp_1",
                  reasoningItemsIncluded: false,
                },
              },
            ],
          },
        ],
      },
    });
    const registry = new ToolRegistryImpl();
    const result = await runAgenticTurns({
      adapter,
      systemPrompt: "sys",
      initialMessages: [{ role: "user", content: "say hi" }],
      tools: [],
      toolRegistry: new Map(Array.from(registry.list(), (t) => [t.name, t])),
      ctx: mkCtx(ws),
    });
    expect(result.turnsRun).toBe(1);
    expect(result.finalAssistant).not.toBeNull();
    expect(result.usage.inputTokens).toBe(10);
    expect(result.usage.outputTokens).toBe(1);
    expect(result.toolCalls).toHaveLength(0);
  });
});

describe("runAgenticTurns — tool round-trip", () => {
  test("model asks for read_file, receives result, answers on turn 2", async () => {
    const ws = mkWorkspace({ "a.ts": "hello world\n" });
    const adapter = new MockOpenAiAdapter({
      script: {
        turns: [
          // Turn 1: model emits a read_file tool call.
          {
            events: [
              {
                type: "tool_call_start",
                callId: "call_1",
                name: "read_file",
                argsSchema: "json",
              },
              {
                type: "tool_call_delta",
                callId: "call_1",
                argsDelta: '{"path":"a.ts"}',
              },
              {
                type: "tool_call_done",
                callId: "call_1",
                args: { path: "a.ts" },
              },
              {
                type: "usage_update",
                usage: { inputTokens: 10, outputTokens: 5 },
                cacheHit: false,
              },
              {
                type: "done",
                stopReason: "tool_use",
                providerHandle: {
                  kind: "openai_response",
                  responseId: "resp_t1",
                  reasoningItemsIncluded: false,
                },
              },
            ],
          },
          // Turn 2: model responds with the answer.
          {
            events: [
              { type: "text_delta", delta: "file says hello world" },
              {
                type: "usage_update",
                usage: { inputTokens: 50, outputTokens: 7 },
                cacheHit: false,
              },
              {
                type: "done",
                stopReason: "end_turn",
                providerHandle: {
                  kind: "openai_response",
                  responseId: "resp_t2",
                  reasoningItemsIncluded: false,
                },
              },
            ],
          },
        ],
      },
    });
    const tools: ToolDefinition[] = [readFileTool as unknown as ToolDefinition];
    const registry = new Map<string, ToolDefinition>(tools.map((t) => [t.name, t]));
    const events: string[] = [];
    const result = await runAgenticTurns({
      adapter,
      systemPrompt: "you may read files",
      initialMessages: [{ role: "user", content: "what's in a.ts?" }],
      tools,
      toolRegistry: registry,
      ctx: mkCtx(ws),
      options: {
        onEvent: (ev) => events.push(ev.type),
      },
    });
    expect(result.turnsRun).toBe(2);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.call.name).toBe("read_file");
    expect(result.toolCalls[0]!.result.status).toBe("ok");
    expect(events).toContain("tool_called");
    expect(events).toContain("permission_decision");
    expect(events).toContain("tool_output");
  });

  test("mutation-batch feedback is injected before the next model turn", async () => {
    const ws = mkWorkspace();
    const adapter = new MockOpenAiAdapter({
      script: {
        turns: [
          {
            events: [
              {
                type: "tool_call_start",
                callId: "call_write",
                name: "write_file",
                argsSchema: "json",
              },
              {
                type: "tool_call_delta",
                callId: "call_write",
                argsDelta: '{"path":"a.txt","content":"bad"}',
              },
              {
                type: "tool_call_done",
                callId: "call_write",
                args: { path: "a.txt", content: "bad" },
              },
              {
                type: "usage_update",
                usage: { inputTokens: 1, outputTokens: 1 },
                cacheHit: false,
              },
              {
                type: "done",
                stopReason: "tool_use",
                providerHandle: {
                  kind: "openai_response",
                  responseId: "resp_write",
                  reasoningItemsIncluded: false,
                },
              },
            ],
          },
          {
            events: [
              { type: "text_delta", delta: "fixed after validation feedback" },
              {
                type: "usage_update",
                usage: { inputTokens: 1, outputTokens: 1 },
                cacheHit: false,
              },
              {
                type: "done",
                stopReason: "end_turn",
                providerHandle: {
                  kind: "openai_response",
                  responseId: "resp_final",
                  reasoningItemsIncluded: false,
                },
              },
            ],
          },
        ],
      },
    });
    const tools: ToolDefinition[] = [writeFileTool as unknown as ToolDefinition];
    const registry = new Map<string, ToolDefinition>(tools.map((t) => [t.name, t]));

    await runAgenticTurns({
      adapter,
      systemPrompt: "you may write files",
      initialMessages: [{ role: "user", content: "write a.txt" }],
      tools,
      toolRegistry: registry,
      ctx: mkCtx(ws),
      options: {
        onMutationBatch: (event) => {
          expect(event.tools).toEqual(["write_file"]);
          expect(event.calls[0]?.name).toBe("write_file");
          expect(event.results[0]?.status).toBe("ok");
          return {
            message: '<mutation_validation status="task_failure">fix it</mutation_validation>',
          };
        },
      },
    });

    const second = adapter.recordedCalls[1]!.payload as {
      req: { messages: Array<{ content: unknown }> };
    };
    expect(JSON.stringify(second.req.messages)).toContain("mutation_validation");
    expect(readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("bad");
  });

  test("mutation-batch strong validation success stops before another model turn", async () => {
    const ws = mkWorkspace();
    const adapter = new MockOpenAiAdapter({
      script: {
        turns: [
          {
            events: [
              {
                type: "tool_call_start",
                callId: "call_write",
                name: "write_file",
                argsSchema: "json",
              },
              {
                type: "tool_call_delta",
                callId: "call_write",
                argsDelta: '{"path":"a.txt","content":"good"}',
              },
              {
                type: "tool_call_done",
                callId: "call_write",
                args: { path: "a.txt", content: "good" },
              },
              {
                type: "done",
                stopReason: "tool_use",
                providerHandle: {
                  kind: "openai_response",
                  responseId: "resp_write",
                  reasoningItemsIncluded: false,
                },
              },
            ],
          },
        ],
      },
    });
    const tools: ToolDefinition[] = [writeFileTool as unknown as ToolDefinition];
    const registry = new Map<string, ToolDefinition>(tools.map((t) => [t.name, t]));

    const result = await runAgenticTurns({
      adapter,
      systemPrompt: "you may write files",
      initialMessages: [{ role: "user", content: "write a.txt" }],
      tools,
      toolRegistry: registry,
      ctx: mkCtx(ws),
      options: {
        onMutationBatch: () => ({
          message: '<mutation_validation status="success">passed</mutation_validation>',
          stop: true,
          reason: "strong_validation_success",
        }),
      },
    });

    expect(result.terminationReason).toBe("validation_success");
    expect(adapter.recordedCalls.length).toBe(1);
    expect(readFileSync(path.join(ws, "a.txt"), "utf8")).toBe("good");
  });

  test("repeated bad write_file args inject schema repair without mutation validation", async () => {
    const ws = mkWorkspace();
    const badWriteTurn = (id: string): { events: StreamEvent[] } => ({
      events: [
        { type: "tool_call_start", callId: id, name: "write_file", argsSchema: "json" },
        { type: "tool_call_done", callId: id, args: {} },
        {
          type: "done",
          stopReason: "tool_use",
          providerHandle: {
            kind: "openai_response",
            responseId: `resp_${id}`,
            reasoningItemsIncluded: false,
          },
        },
      ],
    });
    const adapter = new MockOpenAiAdapter({
      script: {
        turns: [
          badWriteTurn("bad_1"),
          badWriteTurn("bad_2"),
          {
            events: [
              { type: "text_delta", delta: "stopping" },
              {
                type: "done",
                stopReason: "end_turn",
                providerHandle: {
                  kind: "openai_response",
                  responseId: "resp_final",
                  reasoningItemsIncluded: false,
                },
              },
            ],
          },
        ],
      },
    });
    const tools: ToolDefinition[] = [writeFileTool as unknown as ToolDefinition];
    const registry = new Map<string, ToolDefinition>(tools.map((t) => [t.name, t]));
    let mutationValidations = 0;
    const events: string[] = [];

    await runAgenticTurns({
      adapter,
      systemPrompt: "you may write files",
      initialMessages: [{ role: "user", content: "write a file" }],
      tools,
      toolRegistry: registry,
      ctx: mkCtx(ws),
      options: {
        onMutationBatch: () => {
          mutationValidations++;
        },
        onEvent: (event) => {
          if (event.type === "tool_bad_args_recovery_injected") events.push(event.type);
        },
      },
    });

    expect(mutationValidations).toBe(0);
    expect(events).toEqual(["tool_bad_args_recovery_injected"]);
    const third = adapter.recordedCalls[2]!.payload as {
      req: { messages: Array<{ content: unknown }> };
    };
    expect(JSON.stringify(third.req.messages)).toContain("tool_argument_repair");
    expect(JSON.stringify(third.req.messages)).toContain("write_file.path is required string");
  });

  test("third repeated bad args suppresses only the broken tool for one turn", async () => {
    const ws = mkWorkspace();
    const badWriteTurn = (id: string): { events: StreamEvent[] } => ({
      events: [
        { type: "tool_call_start", callId: id, name: "write_file", argsSchema: "json" },
        { type: "tool_call_done", callId: id, args: {} },
        {
          type: "done",
          stopReason: "tool_use",
          providerHandle: {
            kind: "openai_response",
            responseId: `resp_${id}`,
            reasoningItemsIncluded: false,
          },
        },
      ],
    });
    const adapter = new MockOpenAiAdapter({
      script: {
        turns: [
          badWriteTurn("bad_1"),
          badWriteTurn("bad_2"),
          badWriteTurn("bad_3"),
          {
            events: [
              { type: "text_delta", delta: "done" },
              {
                type: "done",
                stopReason: "end_turn",
                providerHandle: {
                  kind: "openai_response",
                  responseId: "resp_final",
                  reasoningItemsIncluded: false,
                },
              },
            ],
          },
        ],
      },
    });
    const tools: ToolDefinition[] = [
      applyPatchTool as unknown as ToolDefinition,
      readFileTool as unknown as ToolDefinition,
      writeFileTool as unknown as ToolDefinition,
    ];
    const toolMap = new Map<string, ToolDefinition>(tools.map((t) => [t.name, t]));
    const suppressed: string[] = [];

    await runAgenticTurns({
      adapter,
      systemPrompt: "you may write files",
      initialMessages: [{ role: "user", content: "write a file" }],
      tools,
      toolRegistry: toolMap,
      ctx: mkCtx(ws),
      options: {
        onEvent: (event) => {
          if (event.type === "tool_temporarily_suppressed") suppressed.push(event.tool);
        },
      },
    });

    expect(suppressed).toEqual(["write_file"]);
    const fourth = adapter.recordedCalls[3]!.payload as {
      req: { tools: Array<{ name: string }> };
    };
    expect(fourth.req.tools.map((tool) => tool.name)).toContain("read_file");
    expect(fourth.req.tools.map((tool) => tool.name)).not.toContain("write_file");
  });

  test("Opus repeated empty args appends repair after tool results and suppresses earlier", async () => {
    const ws = mkWorkspace();
    const badWriteTurn = (id: string): { events: StreamEvent[] } => ({
      events: [
        { type: "tool_call_start", callId: id, name: "write_file", argsSchema: "json" },
        { type: "tool_call_done", callId: id, args: {} },
        {
          type: "done",
          stopReason: "tool_use",
          providerHandle: {
            kind: "anthropic_messages",
            messages: [],
            betaHeaders: [],
          },
        },
      ],
    });
    const adapter = new MockAnthropicAdapter({
      modelId: "claude-opus-4-6",
      script: {
        turns: [
          badWriteTurn("bad_1"),
          badWriteTurn("bad_2"),
          {
            events: [
              { type: "text_delta", delta: "done" },
              {
                type: "done",
                stopReason: "end_turn",
                providerHandle: {
                  kind: "anthropic_messages",
                  messages: [],
                  betaHeaders: [],
                },
              },
            ],
          },
        ],
      },
    });
    const tools: ToolDefinition[] = [
      applyPatchTool as unknown as ToolDefinition,
      readFileTool as unknown as ToolDefinition,
      writeFileTool as unknown as ToolDefinition,
    ];
    const toolMap = new Map<string, ToolDefinition>(tools.map((t) => [t.name, t]));
    const events: string[] = [];

    const result = await runAgenticTurns({
      adapter,
      systemPrompt: "you may write files",
      initialMessages: [{ role: "user", content: "write a file" }],
      tools,
      toolRegistry: toolMap,
      ctx: mkCtx(ws),
      options: {
        onEvent: (event) => {
          if (event.type === "bad_args_repair_appended") events.push(event.type);
          if (event.type === "tool_temporarily_suppressed") events.push(event.tool);
        },
      },
    });

    expect(events).toEqual(["bad_args_repair_appended", "write_file"]);
    const third = adapter.recordedCalls[2]!.payload as {
      req: { tools: Array<{ name: string }> };
      opts: { forceToolChoice?: string };
    };
    expect(third.req.tools.map((tool) => tool.name)).toContain("read_file");
    expect(third.req.tools.map((tool) => tool.name)).toContain("apply_patch");
    expect(third.req.tools.map((tool) => tool.name)).not.toContain("write_file");
    expect(third.opts.forceToolChoice).toBeUndefined();
    const repairMessage = result.history.find(
      (item) =>
        Array.isArray(item.content) &&
        item.content.some((part) => part.type === "tool_result") &&
        item.content.some(
          (part) => part.type === "text" && part.text.includes("tool_argument_repair"),
        ),
    );
    expect(repairMessage).toBeDefined();
    if (!repairMessage || !Array.isArray(repairMessage.content)) {
      throw new Error("expected repair content array");
    }
    expect(repairMessage.content[0]?.type).toBe("tool_result");
    expect(repairMessage.content.at(-1)?.type).toBe("text");
    expect(JSON.stringify(repairMessage.content)).toContain("apply_patch");
  });

  test("Opus suppressed tool emitted anyway is rejected before execution", async () => {
    const ws = mkWorkspace();
    const badWriteTurn = (id: string): { events: StreamEvent[] } => ({
      events: [
        { type: "tool_call_start", callId: id, name: "write_file", argsSchema: "json" },
        { type: "tool_call_done", callId: id, args: {} },
        {
          type: "done",
          stopReason: "tool_use",
          providerHandle: {
            kind: "anthropic_messages",
            messages: [],
            betaHeaders: [],
          },
        },
      ],
    });
    const adapter = new MockAnthropicAdapter({
      modelId: "claude-opus-4-6",
      script: {
        turns: [
          badWriteTurn("bad_1"),
          badWriteTurn("bad_2"),
          badWriteTurn("bad_3"),
          {
            events: [
              { type: "text_delta", delta: "done" },
              {
                type: "done",
                stopReason: "end_turn",
                providerHandle: {
                  kind: "anthropic_messages",
                  messages: [],
                  betaHeaders: [],
                },
              },
            ],
          },
        ],
      },
    });
    const tools: ToolDefinition[] = [
      applyPatchTool as unknown as ToolDefinition,
      readFileTool as unknown as ToolDefinition,
      writeFileTool as unknown as ToolDefinition,
    ];
    const toolMap = new Map<string, ToolDefinition>(tools.map((t) => [t.name, t]));
    let mutationValidations = 0;
    const unavailable: string[] = [];

    const result = await runAgenticTurns({
      adapter,
      systemPrompt: "you may write files",
      initialMessages: [{ role: "user", content: "write a file" }],
      tools,
      toolRegistry: toolMap,
      ctx: mkCtx(ws),
      options: {
        onMutationBatch: () => {
          mutationValidations++;
        },
        onEvent: (event) => {
          if (event.type === "tool_unavailable_this_turn") unavailable.push(event.tool);
        },
      },
    });

    expect(unavailable).toEqual(["write_file"]);
    expect(mutationValidations).toBe(0);
    expect(existsSync(path.join(ws, "ok.txt"))).toBe(false);
    expect(String(result.toolCalls.at(-1)?.result.content)).toContain("tool_unavailable_this_turn");
    expect(JSON.stringify(result.history)).toContain("write_file is unavailable for this turn");
    const third = adapter.recordedCalls[2]!.payload as {
      req: { tools: Array<{ name: string }> };
    };
    expect(third.req.tools.map((tool) => tool.name)).not.toContain("write_file");
  });

  test("valid tool call resets the bad-args streak", async () => {
    const ws = mkWorkspace();
    const badWriteTurn = (id: string): { events: StreamEvent[] } => ({
      events: [
        { type: "tool_call_start", callId: id, name: "write_file", argsSchema: "json" },
        { type: "tool_call_done", callId: id, args: {} },
        {
          type: "done",
          stopReason: "tool_use",
          providerHandle: {
            kind: "openai_response",
            responseId: `resp_${id}`,
            reasoningItemsIncluded: false,
          },
        },
      ],
    });
    const adapter = new MockOpenAiAdapter({
      script: {
        turns: [
          badWriteTurn("bad_1"),
          {
            events: [
              {
                type: "tool_call_start",
                callId: "good",
                name: "write_file",
                argsSchema: "json",
              },
              {
                type: "tool_call_done",
                callId: "good",
                args: { path: "ok.txt", content: "ok\n" },
              },
              {
                type: "done",
                stopReason: "tool_use",
                providerHandle: {
                  kind: "openai_response",
                  responseId: "resp_good",
                  reasoningItemsIncluded: false,
                },
              },
            ],
          },
          badWriteTurn("bad_2"),
          {
            events: [
              { type: "text_delta", delta: "done" },
              {
                type: "done",
                stopReason: "end_turn",
                providerHandle: {
                  kind: "openai_response",
                  responseId: "resp_final",
                  reasoningItemsIncluded: false,
                },
              },
            ],
          },
        ],
      },
    });
    const tools: ToolDefinition[] = [writeFileTool as unknown as ToolDefinition];
    const registry = new Map<string, ToolDefinition>(tools.map((t) => [t.name, t]));
    const repairEvents: string[] = [];

    await runAgenticTurns({
      adapter,
      systemPrompt: "you may write files",
      initialMessages: [{ role: "user", content: "write a file" }],
      tools,
      toolRegistry: registry,
      ctx: mkCtx(ws),
      options: {
        onEvent: (event) => {
          if (event.type === "tool_bad_args_recovery_injected") repairEvents.push(event.tool);
        },
      },
    });

    expect(repairEvents).toEqual([]);
    expect(readFileSync(path.join(ws, "ok.txt"), "utf8")).toBe("ok\n");
  });

  test("structured multimodal tool output is preserved in tool_result history", async () => {
    const ws = mkWorkspace();
    const multimodalTool: ToolDefinition = {
      name: "asset_like",
      description: "returns structured multimodal content",
      kind: "function",
      permissionClass: "READ_ONLY",
      parameters: {
        type: "object",
        required: [],
        additionalProperties: false,
        properties: {},
      },
      errorCodes: [],
      async execute() {
        const content: ContentPart[] = [
          { type: "text", text: "Attached asset: image.png" },
          {
            type: "image",
            source: { kind: "base64", data: "iVBORw0KGgo=", mediaType: "image/png" },
          },
        ];
        return { content };
      },
    };
    const adapter = new MockOpenAiAdapter({
      script: {
        turns: [
          {
            events: [
              {
                type: "tool_call_start",
                callId: "call_asset",
                name: "asset_like",
                argsSchema: "json",
              },
              { type: "tool_call_done", callId: "call_asset", args: {} },
              {
                type: "done",
                stopReason: "tool_use",
                providerHandle: {
                  kind: "openai_response",
                  responseId: "resp_t1",
                  reasoningItemsIncluded: false,
                },
              },
            ],
          },
          {
            events: [
              { type: "text_delta", delta: "saw it" },
              {
                type: "done",
                stopReason: "end_turn",
                providerHandle: {
                  kind: "openai_response",
                  responseId: "resp_t2",
                  reasoningItemsIncluded: false,
                },
              },
            ],
          },
        ],
      },
    });
    const result = await runAgenticTurns({
      adapter,
      systemPrompt: "",
      initialMessages: [{ role: "user", content: "read asset" }],
      tools: [multimodalTool],
      toolRegistry: new Map([[multimodalTool.name, multimodalTool]]),
      ctx: mkCtx(ws),
    });
    const toolResult = result.history
      .flatMap((h) => (Array.isArray(h.content) ? h.content : []))
      .find((p) => p.type === "tool_result");
    expect(toolResult).toBeDefined();
    expect(typeof toolResult?.content).not.toBe("string");
    expect(
      Array.isArray(toolResult?.content) && toolResult.content.some((p) => p.type === "image"),
    ).toBe(true);
  });
});

describe("runAgenticTurns — benchmark search soft guard", () => {
  function searchTool(name: "web_search" | "fetch_url"): ToolDefinition {
    return {
      name,
      description: `${name} mock`,
      kind: "function",
      permissionClass: "READ_ONLY_NETWORK",
      parameters: {
        type: "object",
        required: name === "web_search" ? ["query"] : ["url"],
        additionalProperties: false,
        properties:
          name === "web_search"
            ? { query: { type: "string" } }
            : { url: { type: "string" }, method: { enum: ["GET", "HEAD"] } },
      },
      errorCodes: [],
      async execute() {
        return { content: `${name} ok` };
      },
    } as unknown as ToolDefinition;
  }

  function toolTurn(call: ToolCallRequest): { events: StreamEvent[] } {
    return {
      events: [
        {
          type: "tool_call_start",
          callId: call.id,
          name: call.name,
          argsSchema: "json",
        },
        {
          type: "tool_call_delta",
          callId: call.id,
          argsDelta: JSON.stringify(call.arguments),
        },
        {
          type: "tool_call_done",
          callId: call.id,
          args: call.arguments as Record<string, unknown>,
        },
        {
          type: "done",
          stopReason: "tool_use",
          providerHandle: {
            kind: "openai_response",
            responseId: `resp_${call.id}`,
            reasoningItemsIncluded: false,
          },
        },
      ],
    };
  }

  const finalTurn = {
    events: [
      { type: "text_delta" as const, delta: "done" },
      {
        type: "done" as const,
        stopReason: "end_turn" as const,
        providerHandle: {
          kind: "openai_response" as const,
          responseId: "resp_final",
          reasoningItemsIncluded: false,
        },
      },
    ],
  };

  async function runSearchScript(calls: ToolCallRequest[], benchmarkMode: boolean) {
    const ws = mkWorkspace();
    const adapter = new MockOpenAiAdapter({
      script: { turns: [...calls.map(toolTurn), finalTurn] },
    });
    const tools = [searchTool("web_search"), searchTool("fetch_url")];
    const events: string[] = [];
    const result = await runAgenticTurns({
      adapter,
      systemPrompt: "sys",
      initialMessages: [{ role: "user", content: "use search as needed" }],
      tools,
      toolRegistry: new Map(tools.map((t) => [t.name, t])),
      ctx: mkCtx(ws),
      options: {
        benchmarkMode,
        maxTurns: calls.length + 2,
        onEvent: (ev) => events.push(ev.type),
      },
    });
    return { result, events };
  }

  test("injects one advisory after the benchmark web_search threshold without blocking search", async () => {
    const calls = Array.from({ length: 6 }, (_, i) => ({
      id: `s${i}`,
      name: "web_search",
      arguments: { query: `specific official docs query ${i}` },
    })) as ToolCallRequest[];
    const { result, events } = await runSearchScript(calls, true);
    expect(result.toolCalls.map((t) => t.call.name)).toEqual(Array(6).fill("web_search"));
    expect(events.filter((e) => e === "search_advice_injected")).toHaveLength(1);
    expect(result.history.some((h) => historyContent(h).includes("Search loop advisory"))).toBe(
      true,
    );
  });

  test("injects earlier for repeated near-duplicate benchmark web_search queries", async () => {
    const calls: ToolCallRequest[] = [
      {
        id: "d1",
        name: "web_search",
        arguments: { query: "Scandinavian MTEB leaderboard top model official" },
      },
      {
        id: "d2",
        name: "web_search",
        arguments: { query: "MTEB Scandinavian leaderboard best model docs" },
      },
      {
        id: "d3",
        name: "web_search",
        arguments: { query: "official Scandinavian MTEB leaderboard model results" },
      },
    ];
    const { result, events } = await runSearchScript(calls, true);
    expect(result.toolCalls).toHaveLength(3);
    expect(events.filter((e) => e === "search_advice_injected")).toHaveLength(1);
    expect(
      result.history.some((h) => historyContent(h).includes("Stop broad reformulations")),
    ).toBe(true);
  });

  test("does not warn for a few targeted benchmark searches", async () => {
    const calls: ToolCallRequest[] = [
      { id: "a", name: "web_search", arguments: { query: "PyStan 3 official stan build docs" } },
      {
        id: "b",
        name: "web_search",
        arguments: { query: "Caffe CIFAR-10 solver prototxt example" },
      },
      { id: "c", name: "fetch_url", arguments: { url: "https://example.com/docs" } },
    ];
    const { result, events } = await runSearchScript(calls, true);
    expect(result.toolCalls).toHaveLength(3);
    expect(events).not.toContain("search_advice_injected");
    expect(result.history.some((h) => historyContent(h).includes("Search loop advisory"))).toBe(
      false,
    );
  });

  test("injects one advisory after the benchmark fetch_url threshold", async () => {
    const calls = Array.from({ length: 12 }, (_, i) => ({
      id: `f${i}`,
      name: "fetch_url",
      arguments: { url: `https://example.com/docs/${i}` },
    })) as ToolCallRequest[];
    const { result, events } = await runSearchScript(calls, true);
    expect(result.toolCalls.map((t) => t.call.name)).toEqual(Array(12).fill("fetch_url"));
    expect(events.filter((e) => e === "search_advice_injected")).toHaveLength(1);
  });

  test("does not inject benchmark search advisory outside benchmark mode", async () => {
    const calls = Array.from({ length: 6 }, (_, i) => ({
      id: `s${i}`,
      name: "web_search",
      arguments: { query: `same broad query ${i}` },
    })) as ToolCallRequest[];
    const { result, events } = await runSearchScript(calls, false);
    expect(result.toolCalls).toHaveLength(6);
    expect(events).not.toContain("search_advice_injected");
    expect(result.history.some((h) => historyContent(h).includes("Search loop advisory"))).toBe(
      false,
    );
  });
});

describe("runAgenticTurns — parallel vs serial scheduling", () => {
  test("two function-kind tools run in parallel; an editor-kind runs after both", async () => {
    const ws = mkWorkspace({ "a.ts": "A\n", "b.ts": "B\n" });
    // Track ordering by timestamp.
    const order: string[] = [];
    const countingRead: ToolDefinition = {
      ...(readFileTool as unknown as ToolDefinition),
      name: "slow_read",
      kind: "function",
      async execute(input, ctx, signal) {
        await new Promise((r) => setTimeout(r, 50));
        order.push("slow_read:" + JSON.stringify(input));
        return readFileTool.execute(input as { path: string }, ctx, signal);
      },
    };
    const countingWrite: ToolDefinition = {
      ...(writeFileTool as unknown as ToolDefinition),
      name: "slow_write",
      kind: "editor",
      async execute(input, ctx, signal) {
        order.push("slow_write:" + JSON.stringify(input));
        return writeFileTool.execute(input as { path: string; content: string }, ctx, signal);
      },
    };
    const registry = new Map<string, ToolDefinition>([
      ["slow_read", countingRead],
      ["slow_write", countingWrite],
    ]);
    const adapter = new MockOpenAiAdapter({
      script: {
        turns: [
          {
            events: [
              {
                type: "tool_call_start",
                callId: "c1",
                name: "slow_read",
                argsSchema: "json",
              },
              {
                type: "tool_call_done",
                callId: "c1",
                args: { path: "a.ts" },
              },
              {
                type: "tool_call_start",
                callId: "c2",
                name: "slow_read",
                argsSchema: "json",
              },
              {
                type: "tool_call_done",
                callId: "c2",
                args: { path: "b.ts" },
              },
              {
                type: "tool_call_start",
                callId: "c3",
                name: "slow_write",
                argsSchema: "json",
              },
              {
                type: "tool_call_done",
                callId: "c3",
                args: { path: "new.txt", content: "X" },
              },
              {
                type: "usage_update",
                usage: { inputTokens: 1, outputTokens: 1 },
                cacheHit: false,
              },
              {
                type: "done",
                stopReason: "tool_use",
                providerHandle: {
                  kind: "openai_response",
                  responseId: "r",
                  reasoningItemsIncluded: false,
                },
              },
            ],
          },
          {
            events: [
              { type: "text_delta", delta: "done" },
              {
                type: "done",
                stopReason: "end_turn",
                providerHandle: {
                  kind: "openai_response",
                  responseId: "r2",
                  reasoningItemsIncluded: false,
                },
              },
            ],
          },
        ],
      },
    });
    const start = Date.now();
    await runAgenticTurns({
      adapter,
      systemPrompt: "",
      initialMessages: [{ role: "user", content: "go" }],
      tools: [countingRead, countingWrite],
      toolRegistry: registry,
      ctx: mkCtx(ws),
    });
    const elapsed = Date.now() - start;
    // Two parallel 50ms reads should run concurrently, so elapsed ≈ 50ms
    // plus the serial write (~0ms). If serialized, it would be ≥100ms.
    expect(elapsed).toBeLessThan(200);
    // The editor-kind write must land AFTER the two function reads.
    expect(order.includes("slow_write:" + JSON.stringify({ path: "new.txt", content: "X" }))).toBe(
      true,
    );
    expect(order.indexOf("slow_write:" + JSON.stringify({ path: "new.txt", content: "X" }))).toBe(
      2,
    );
    // File was written.
    expect(readFileSync(path.join(ws, "new.txt"), "utf8")).toBe("X");
  });
});

describe("runAgenticTurns — limits", () => {
  test("maxTurns ceiling stops the loop", async () => {
    const ws = mkWorkspace();
    // Adapter emits a tool call every turn, so without maxTurns this would
    // loop forever.
    const neverEnding = {
      events: [
        {
          type: "tool_call_start",
          callId: "c",
          name: "missing_tool",
          argsSchema: "json" as const,
        },
        { type: "tool_call_done" as const, callId: "c", args: {} },
        {
          type: "usage_update" as const,
          usage: { inputTokens: 1, outputTokens: 1 },
          cacheHit: false,
        },
        {
          type: "done" as const,
          stopReason: "tool_use" as const,
          providerHandle: {
            kind: "openai_response" as const,
            responseId: "r",
            reasoningItemsIncluded: false,
          },
        },
      ] as StreamEvent[],
    };
    const adapter = new MockOpenAiAdapter({
      script: {
        turns: [neverEnding, neverEnding, neverEnding, neverEnding],
      },
    });
    const result = await runAgenticTurns({
      adapter,
      systemPrompt: "",
      initialMessages: [{ role: "user", content: "go" }],
      tools: [],
      toolRegistry: new Map(),
      ctx: mkCtx(ws),
      options: { maxTurns: 2 },
    });
    expect(result.maxTurnsHit).toBe(true);
    expect(result.turnsRun).toBe(2);
  });
});

describe("runAgenticTurns — benchmark GPT nudges", () => {
  test("hallucinated tool syntax triggers a single benchmark reprompt", async () => {
    const ws = mkWorkspace({ "a.ts": "hello world\n" });
    const adapter = new MockOpenAiAdapter({
      script: {
        turns: [
          {
            events: [
              {
                type: "text_delta",
                delta:
                  "Next I will use functions.exec_command to inspect the file and then continue.",
              },
              {
                type: "done",
                stopReason: "end_turn",
                providerHandle: {
                  kind: "openai_response",
                  responseId: "resp_1",
                  reasoningItemsIncluded: false,
                },
              },
            ],
          },
          {
            events: [
              {
                type: "tool_call_start",
                callId: "call_1",
                name: "read_file",
                argsSchema: "json",
              },
              {
                type: "tool_call_done",
                callId: "call_1",
                args: { path: "a.ts" },
              },
              {
                type: "done",
                stopReason: "tool_use",
                providerHandle: {
                  kind: "openai_response",
                  responseId: "resp_2",
                  reasoningItemsIncluded: false,
                },
              },
            ],
          },
          {
            events: [
              { type: "text_delta", delta: "done" },
              {
                type: "done",
                stopReason: "end_turn",
                providerHandle: {
                  kind: "openai_response",
                  responseId: "resp_3",
                  reasoningItemsIncluded: false,
                },
              },
            ],
          },
        ],
      },
    });
    const tools: ToolDefinition[] = [readFileTool as unknown as ToolDefinition];
    const result = await runAgenticTurns({
      adapter,
      systemPrompt: "sys",
      initialMessages: [{ role: "user", content: "Fix the issue in a.ts" }],
      tools,
      toolRegistry: new Map(tools.map((t) => [t.name, t])),
      ctx: mkCtx(ws),
      options: { benchmarkMode: true },
    });
    expect(result.turnsRun).toBe(3);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.history.some((h) => h.id.startsWith("bench_nudge_"))).toBe(true);
  });

  test("prose-only operational response triggers a single benchmark reprompt", async () => {
    const ws = mkWorkspace({ "a.ts": "hello world\n" });
    const adapter = new MockOpenAiAdapter({
      script: {
        turns: [
          {
            events: [
              {
                type: "text_delta",
                delta: "Next I'll compile and then inspect the file before making edits.",
              },
              {
                type: "done",
                stopReason: "end_turn",
                providerHandle: {
                  kind: "openai_response",
                  responseId: "resp_1",
                  reasoningItemsIncluded: false,
                },
              },
            ],
          },
          {
            events: [
              { type: "text_delta", delta: "done" },
              {
                type: "done",
                stopReason: "end_turn",
                providerHandle: {
                  kind: "openai_response",
                  responseId: "resp_2",
                  reasoningItemsIncluded: false,
                },
              },
            ],
          },
        ],
      },
    });
    const result = await runAgenticTurns({
      adapter,
      systemPrompt: "sys",
      initialMessages: [{ role: "user", content: "Configure the project and ensure it works" }],
      tools: [],
      toolRegistry: new Map(),
      ctx: mkCtx(ws),
      options: { benchmarkMode: true },
    });
    expect(result.turnsRun).toBe(2);
    expect(result.history.some((h) => h.id.startsWith("bench_nudge_"))).toBe(true);
  });

  test("valid tool-calling turn does not trigger benchmark reprompt", async () => {
    const ws = mkWorkspace({ "a.ts": "hello world\n" });
    const adapter = new MockOpenAiAdapter({
      script: {
        turns: [
          {
            events: [
              {
                type: "tool_call_start",
                callId: "call_1",
                name: "read_file",
                argsSchema: "json",
              },
              {
                type: "tool_call_done",
                callId: "call_1",
                args: { path: "a.ts" },
              },
              {
                type: "done",
                stopReason: "tool_use",
                providerHandle: {
                  kind: "openai_response",
                  responseId: "resp_1",
                  reasoningItemsIncluded: false,
                },
              },
            ],
          },
          {
            events: [
              { type: "text_delta", delta: "done" },
              {
                type: "done",
                stopReason: "end_turn",
                providerHandle: {
                  kind: "openai_response",
                  responseId: "resp_2",
                  reasoningItemsIncluded: false,
                },
              },
            ],
          },
        ],
      },
    });
    const tools: ToolDefinition[] = [readFileTool as unknown as ToolDefinition];
    const result = await runAgenticTurns({
      adapter,
      systemPrompt: "sys",
      initialMessages: [{ role: "user", content: "Fix the issue in a.ts" }],
      tools,
      toolRegistry: new Map(tools.map((t) => [t.name, t])),
      ctx: mkCtx(ws),
      options: { benchmarkMode: true },
    });
    expect(result.history.some((h) => h.id.startsWith("bench_nudge_"))).toBe(false);
    expect(result.toolCalls).toHaveLength(1);
  });
});
