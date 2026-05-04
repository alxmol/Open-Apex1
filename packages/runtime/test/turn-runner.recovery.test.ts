/**
 * Aggressive recovery regression tests.
 *
 * After TB2 smoke showed GPT-5.4 falling into prose-only hallucinated-tool
 * loops on turns 2+ (e.g., emitting `to=multi_tool_use.parallel ...` as plain
 * text), the turn-runner gained a 3-strike detector:
 *   - strike 1: nudge + `tool_choice: "required"` on the next call
 *   - strike 2: stricter nudge + `tool_choice: "required"` again
 *   - strike 3: terminate with TerminationReason = "hallucinated_tool_loop"
 *     so the autonomous CLI can route to runtime_failure (exit 4) instead
 *     of masquerading as validation_unknown (exit 2).
 *
 * Real tool calls reset the strike counter.
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
} from "@open-apex/core";
import { MockOpenAiAdapter } from "@open-apex/provider-openai";
import { readFileTool } from "@open-apex/tools";

import { containsHallucinatedToolSyntax, runAgenticTurns } from "../src/turn-runner.ts";

function mkCtx(): OpenApexRunContext {
  const ws = mkdtempSync(path.join(tmpdir(), "oa-recovery-"));
  const userContext: OpenApexContext = {
    workspace: ws,
    openApexHome: path.join(ws, ".open-apex"),
    autonomyLevel: "full_auto" as AutonomyLevel,
    sessionId: "recovery-test",
  };
  return {
    userContext,
    runId: "recovery-test-run",
    signal: new AbortController().signal,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

/** Turn that emits hallucinated ChatGPT microsyntax as plain text. */
const hallucinatedTurn = (idx: number) => ({
  events: [
    {
      type: "text_delta" as const,
      delta: `to=functions.run_shell {"argv":["ls"]}`,
    },
    {
      type: "usage_update" as const,
      usage: { inputTokens: 5, outputTokens: 3 },
      cacheHit: false,
    },
    {
      type: "done" as const,
      stopReason: "end_turn" as const,
      providerHandle: {
        kind: "openai_response" as const,
        responseId: `resp_t${idx}`,
        reasoningItemsIncluded: false,
      },
    },
  ],
});

describe("containsHallucinatedToolSyntax", () => {
  test("detects `to=functions.X`", () => {
    expect(containsHallucinatedToolSyntax('to=functions.run_shell {"argv":["ls"]}')).toBe(true);
  });
  test("detects multi_tool_use.parallel", () => {
    expect(containsHallucinatedToolSyntax('to=multi_tool_use.parallel {"tool_uses":[...]}')).toBe(
      true,
    );
  });
  test("detects recipient_name", () => {
    expect(
      containsHallucinatedToolSyntax('{"recipient_name":"functions.run_shell","parameters":{}}'),
    ).toBe(true);
  });
  test("detects <assistant recipient=...>", () => {
    expect(
      containsHallucinatedToolSyntax('<assistant recipient="functions.run_shell">{}</assistant>'),
    ).toBe(true);
  });
  test("detects Chinese trigger-token leakage", () => {
    expect(containsHallucinatedToolSyntax("something 天天中彩票 json")).toBe(true);
  });
  test("healthy text is not flagged", () => {
    expect(containsHallucinatedToolSyntax("I'll read the file now.")).toBe(false);
  });
});

describe("3-strike hallucinated-tool recovery (§benchmark-mode only)", () => {
  test("3 consecutive hallucinated turns → terminationReason = hallucinated_tool_loop", async () => {
    const adapter = new MockOpenAiAdapter({
      script: {
        turns: [hallucinatedTurn(1), hallucinatedTurn(2), hallucinatedTurn(3)],
      },
    });
    const tools: ToolDefinition[] = [readFileTool as unknown as ToolDefinition];
    const registry = new Map<string, ToolDefinition>(tools.map((t) => [t.name, t]));
    const result = await runAgenticTurns({
      adapter,
      systemPrompt: "sys",
      initialMessages: [{ role: "user", content: "Please fix the bug in src/a.ts" }],
      tools,
      toolRegistry: registry,
      ctx: mkCtx(),
      options: { benchmarkMode: true },
    });
    expect(result.terminationReason).toBe("hallucinated_tool_loop");
    expect(result.hallucinationStrikes).toBeGreaterThanOrEqual(3);
    expect(result.toolCalls).toHaveLength(0);
  });

  test("forceToolChoice is threaded into the next request after strike 1", async () => {
    const adapter = new MockOpenAiAdapter({
      script: {
        turns: [hallucinatedTurn(1), hallucinatedTurn(2), hallucinatedTurn(3)],
      },
    });
    const tools: ToolDefinition[] = [readFileTool as unknown as ToolDefinition];
    const registry = new Map<string, ToolDefinition>(tools.map((t) => [t.name, t]));
    await runAgenticTurns({
      adapter,
      systemPrompt: "sys",
      initialMessages: [{ role: "user", content: "Please fix the bug in src/a.ts" }],
      tools,
      toolRegistry: registry,
      ctx: mkCtx(),
      options: { benchmarkMode: true },
    });
    // Recovery kicks in on subsequent resume() calls. Inspect opts passed to
    // each adapter call after the first hallucinated turn.
    const resumeCalls = adapter.recordedCalls.filter((c) => c.method === "resume");
    expect(resumeCalls.length).toBeGreaterThanOrEqual(1);
    const forced = resumeCalls.some(
      (c) =>
        (c.payload as { opts: { forceToolChoice?: string } }).opts.forceToolChoice === "required",
    );
    expect(forced).toBe(true);
  });

  test("nudge_fired + recovery_strike events are emitted", async () => {
    const adapter = new MockOpenAiAdapter({
      script: {
        turns: [hallucinatedTurn(1), hallucinatedTurn(2), hallucinatedTurn(3)],
      },
    });
    const tools: ToolDefinition[] = [readFileTool as unknown as ToolDefinition];
    const registry = new Map<string, ToolDefinition>(tools.map((t) => [t.name, t]));
    const events: string[] = [];
    await runAgenticTurns({
      adapter,
      systemPrompt: "sys",
      initialMessages: [{ role: "user", content: "Please fix the bug in src/a.ts" }],
      tools,
      toolRegistry: registry,
      ctx: mkCtx(),
      options: {
        benchmarkMode: true,
        onEvent: (ev) => events.push(ev.type),
      },
    });
    expect(events).toContain("nudge_fired");
    expect(events).toContain("recovery_strike");
  });

  test("non-benchmark mode does NOT fire nudges (M1 scope)", async () => {
    const adapter = new MockOpenAiAdapter({
      script: {
        turns: [hallucinatedTurn(1)],
      },
    });
    const tools: ToolDefinition[] = [readFileTool as unknown as ToolDefinition];
    const registry = new Map<string, ToolDefinition>(tools.map((t) => [t.name, t]));
    const result = await runAgenticTurns({
      adapter,
      systemPrompt: "sys",
      initialMessages: [{ role: "user", content: "please fix X" }],
      tools,
      toolRegistry: registry,
      ctx: mkCtx(),
      // benchmarkMode: false (default)
    });
    expect(result.terminationReason).toBe("end_turn");
    expect(result.hallucinationStrikes).toBe(0);
  });
});
