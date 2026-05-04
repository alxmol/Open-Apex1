/**
 * Regression: Anthropic resume() must ship a valid tool_use ↔ tool_result
 * pairing. Root cause of the Sonnet/Opus smoke-6 0/6 was that the Anthropic
 * handle emitted by the adapter contained only the REQUEST messages from
 * turn 1 (no assistant response), so when turn 2's resume call merged those
 * with the new tool_result delta, the tool_result referenced a tool_use_id
 * that wasn't in the conversation and Anthropic rejected the request.
 *
 * The fix now lives in the Anthropic adapter (and the matching
 * MockAnthropicAdapter): the translator accumulates the assistant's content
 * blocks as the stream emits and materializes them into
 * `providerHandle.messages` as `[...req.messages, assistantMessage]`.
 * Anthropic has no server-side continuation primitive (no
 * `previous_response_id` equivalent — see docs/agents-and-tools/tool-use/
 * handle-tool-calls), so the replay buffer MUST be owned by the adapter.
 * OpenAI's handle doesn't need this — its `previous_response_id` points at
 * server-side CoT + prior assistant items.
 *
 * This test covers the end-to-end behaviour: turn 2's resume() must see a
 * handle whose `messages` include the turn-1 assistant's tool_use block.
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
import { MockAnthropicAdapter } from "@open-apex/provider-anthropic";
import { readFileTool } from "@open-apex/tools";

import { runAgenticTurns } from "../src/turn-runner.ts";

function mkCtx(): OpenApexRunContext {
  const ws = mkdtempSync(path.join(tmpdir(), "oa-anthropic-handle-"));
  const userContext: OpenApexContext = {
    workspace: ws,
    openApexHome: path.join(ws, ".open-apex"),
    autonomyLevel: "full_auto" as AutonomyLevel,
    sessionId: "anthropic-handle-test",
  };
  return {
    userContext,
    runId: "anthropic-handle-test-run",
    signal: new AbortController().signal,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

describe("Anthropic resume handle enrichment", () => {
  test("turn 2 resume() receives merged [history-with-assistant + delta] messages", async () => {
    const ctx = mkCtx();
    await Bun.write(path.join(ctx.userContext.workspace, "a.ts"), "hello\n");

    const adapter = new MockAnthropicAdapter({
      script: {
        turns: [
          // Turn 1: emit a tool_call for read_file.
          {
            events: [
              {
                type: "tool_call_start",
                callId: "toolu_turn1",
                name: "read_file",
                argsSchema: "json",
              },
              {
                type: "tool_call_done",
                callId: "toolu_turn1",
                args: { path: "a.ts" },
              },
              {
                type: "usage_update",
                usage: { inputTokens: 10, outputTokens: 3 },
                cacheHit: false,
              },
              {
                type: "done",
                stopReason: "tool_use",
                // MockAnthropicAdapter stores whatever handle the script
                // specifies. Mirror the real adapter's shape: just the
                // request messages (no assistant response).
                providerHandle: {
                  kind: "anthropic_messages",
                  messages: [],
                  betaHeaders: [],
                },
              },
            ],
          },
          // Turn 2: closing text.
          {
            events: [
              { type: "text_delta", delta: "done" },
              {
                type: "usage_update",
                usage: { inputTokens: 20, outputTokens: 1 },
                cacheHit: false,
              },
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

    const tools: ToolDefinition[] = [readFileTool as unknown as ToolDefinition];
    const registry = new Map<string, ToolDefinition>(tools.map((t) => [t.name, t]));

    await runAgenticTurns({
      adapter,
      systemPrompt: "sys",
      initialMessages: [{ role: "user", content: "read a.ts" }],
      tools,
      toolRegistry: registry,
      ctx,
    });

    const resumeCall = adapter.recordedCalls.find((c) => c.method === "resume");
    expect(resumeCall).toBeDefined();
    const req = (resumeCall!.payload as { req: AgentRequest }).req;

    // Delta should be the single tool_result user message (turn-runner
    // slices messages since last assistant + the last assistant itself).
    expect(req.messages.length).toBe(1);
    expect(req.messages[0]?.role).toBe("user");

    // The resume handle's messages must include the assistant tool_use
    // block — enriched by the turn-runner after turn 1 completed.
    const handle = (resumeCall!.payload as { handle: { messages: unknown[] } }).handle;
    const handleMsgs = handle.messages as Array<{
      role: string;
      content: unknown;
    }>;
    expect(handleMsgs.length).toBeGreaterThan(0);
    // The last message in the handle must be an assistant message that
    // contains a tool_use block referencing `toolu_turn1`. Without this,
    // Anthropic would reject the subsequent tool_result as orphan.
    const lastAssistant = [...handleMsgs].reverse().find((m) => m.role === "assistant");
    expect(lastAssistant).toBeDefined();
    const content = lastAssistant!.content;
    expect(Array.isArray(content)).toBe(true);
    const parts = content as Array<{
      type: string;
      toolCallId?: string;
      name?: string;
    }>;
    const toolUsePart = parts.find((p) => p.type === "tool_use");
    expect(toolUsePart).toBeDefined();
    expect(toolUsePart?.toolCallId).toBe("toolu_turn1");
    expect(toolUsePart?.name).toBe("read_file");
  });
});
