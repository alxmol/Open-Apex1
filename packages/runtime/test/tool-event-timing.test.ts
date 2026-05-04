/**
 * Regression: tool_output RunEvent carries startedAt/endedAt so the
 * autonomous CLI can emit `tool_event action=end duration_ms=N` alongside
 * the existing `action=start`. Previously we only logged starts, which made
 * diagnosing 11-minute gaps in gcode-to-text impossible.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import type {
  AutonomyLevel,
  OpenApexContext,
  OpenApexRunContext,
  ToolDefinition,
  ToolResult,
} from "@open-apex/core";
import { MockOpenAiAdapter } from "@open-apex/provider-openai";
import { readFileTool } from "@open-apex/tools";

import { runAgenticTurns } from "../src/turn-runner.ts";

function mkCtx(): OpenApexRunContext {
  const ws = mkdtempSync(path.join(tmpdir(), "oa-toolevent-"));
  const userContext: OpenApexContext = {
    workspace: ws,
    openApexHome: path.join(ws, ".open-apex"),
    autonomyLevel: "full_auto" as AutonomyLevel,
    sessionId: "tool-event-test",
  };
  return {
    userContext,
    runId: "tool-event-test-run",
    signal: new AbortController().signal,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

describe("ToolResult timing (supports tool_event action=end emission)", () => {
  test("tool_output event carries startedAt + endedAt; endedAt >= startedAt", async () => {
    const ws = mkdtempSync(path.join(tmpdir(), "oa-toolevent-ws-"));
    await Bun.write(path.join(ws, "a.ts"), "hello\n");
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
                usage: { inputTokens: 5, outputTokens: 1 },
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
          {
            events: [
              { type: "text_delta", delta: "done" },
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
    const ctx = { ...mkCtx(), userContext: { ...mkCtx().userContext, workspace: ws } };
    const toolOutputs: ToolResult[] = [];
    await runAgenticTurns({
      adapter,
      systemPrompt: "sys",
      initialMessages: [{ role: "user", content: "read a.ts" }],
      tools,
      toolRegistry: registry,
      ctx,
      options: {
        onEvent: (ev) => {
          if (ev.type === "tool_output") toolOutputs.push(ev.result);
        },
      },
    });
    expect(toolOutputs.length).toBe(1);
    const r = toolOutputs[0]!;
    expect(typeof r.startedAt).toBe("number");
    expect(typeof r.endedAt).toBe("number");
    expect(r.endedAt).toBeGreaterThanOrEqual(r.startedAt);
    expect(r.status).toBe("ok");
    expect(r.toolCallId).toBe("call_1");
  });
});
