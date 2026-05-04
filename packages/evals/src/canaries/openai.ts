/**
 * OpenAI canary matrix (§5.4).
 *
 * Ships: plain response, streaming, tool round-trip, previous_response_id
 * continuity, phase preservation, allowed_tools restriction, reasoning.effort
 * levels, token counting.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";

import type { AgentRequest, StreamEvent, ToolDefinitionPayload } from "@open-apex/core";
import { OpenAiAdapter } from "@open-apex/provider-openai";
import {
  applyPatchTool,
  checkpointRestoreTool,
  checkpointSaveTool,
  listTreeTool,
  readFileTool,
  runShellTool,
  searchReplaceTool,
  searchTextTool,
  writeFileTool,
} from "@open-apex/tools";

import type { CanaryResult, CanarySpec } from "./types.ts";

const DOCS_IMAGE_PDF_ROOT = path.resolve(import.meta.dir, "..", "..", "fixtures", "docs-image-pdf");

function needsKey(): string | undefined {
  return process.env.OPENAI_API_KEY;
}

function skip(reason: string, started: number): CanaryResult {
  return { outcome: "skip", reason, wallMs: Date.now() - started };
}

function pass(evidence: Record<string, unknown>, started: number): CanaryResult {
  return { outcome: "pass", evidence, wallMs: Date.now() - started };
}

function fail(reason: string, started: number): CanaryResult {
  return { outcome: "fail", reason, wallMs: Date.now() - started };
}

async function adapt(): Promise<OpenAiAdapter | null> {
  if (!needsKey()) return null;
  return new OpenAiAdapter({ modelId: "gpt-5.4" });
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

const TOOL_WEATHER: ToolDefinitionPayload = {
  name: "get_weather",
  description: "Get the current weather for a city",
  parameters: {
    type: "object",
    required: ["city"],
    properties: { city: { type: "string" } },
  },
};

const TOOL_TIME: ToolDefinitionPayload = {
  name: "get_time",
  description: "Get the current time in a timezone",
  parameters: {
    type: "object",
    required: ["tz"],
    properties: { tz: { type: "string" } },
  },
};

/**
 * The real 9-tool manifest Open-Apex ships to the model in autonomous mode.
 * Mirrors the mapping done in apps/cli/src/autonomous.ts (name + description
 * + parameters, no `strict` flag — that's applied by the request-builder).
 * Used by `*-production-tool-manifest` canaries to guard against schema
 * regressions where a tool's parameters become strict-incompatible.
 */
const PRODUCTION_TOOL_MANIFEST: ToolDefinitionPayload[] = [
  readFileTool,
  listTreeTool,
  searchTextTool,
  runShellTool,
  writeFileTool,
  applyPatchTool,
  searchReplaceTool,
  checkpointSaveTool,
  checkpointRestoreTool,
].map((t) => ({
  name: t.name,
  description: t.description,
  parameters: t.parameters as Record<string, unknown>,
}));

export const OPENAI_CANARIES: CanarySpec[] = [
  {
    id: "openai-plain-turn",
    provider: "openai",
    description: "plain response: user → text_delta → usage_update → done",
    capability: "openai.base",
    milestone: "M1",
    estimatedCostUsd: 0.005,
    async run(): Promise<CanaryResult> {
      const started = Date.now();
      const a = await adapt();
      if (!a) return skip("OPENAI_API_KEY not set", started);
      try {
        const req: AgentRequest = {
          systemPrompt: "Reply with just: ok",
          messages: [{ role: "user", content: "say ok" }],
          tools: [],
        };
        // NOTE: on gpt-5.4, reasoning.effort=low uses ~20 tokens for reasoning
        // before any visible text. Keep this well above the reasoning budget.
        const events = await collect(a.generate(req, { effort: "low", maxOutputTokens: 256 }));
        const done = events.find((e) => e.type === "done");
        if (!done || done.type !== "done") return fail("no done event", started);
        const usage = events.find((e) => e.type === "usage_update");
        return pass(
          {
            responseId:
              done.providerHandle.kind === "openai_response" ? done.providerHandle.responseId : "",
            hasUsage: usage !== undefined,
          },
          started,
        );
      } catch (err) {
        return fail((err as Error).message, started);
      }
    },
  },
  {
    id: "openai-streaming",
    provider: "openai",
    description: "streaming: confirm multiple text_delta events arrive before done",
    capability: "openai.streaming",
    milestone: "M1",
    estimatedCostUsd: 0.008,
    async run(): Promise<CanaryResult> {
      const started = Date.now();
      const a = await adapt();
      if (!a) return skip("OPENAI_API_KEY not set", started);
      try {
        const events = await collect(
          a.generate(
            {
              systemPrompt: "Reply with the ten digits from 1 to 10, one per line.",
              messages: [{ role: "user", content: "go" }],
              tools: [],
            },
            { effort: "low", maxOutputTokens: 512 },
          ),
        );
        const deltas = events.filter((e) => e.type === "text_delta").length;
        if (deltas < 1) return fail("expected ≥1 text_delta events", started);
        return pass({ textDeltas: deltas }, started);
      } catch (err) {
        return fail((err as Error).message, started);
      }
    },
  },
  {
    id: "openai-tool-roundtrip",
    provider: "openai",
    description: "tool call round-trip: model emits tool_call_done",
    capability: "openai.tool_use",
    milestone: "M1",
    estimatedCostUsd: 0.01,
    async run(): Promise<CanaryResult> {
      const started = Date.now();
      const a = await adapt();
      if (!a) return skip("OPENAI_API_KEY not set", started);
      try {
        const events = await collect(
          a.generate(
            {
              systemPrompt: "Call get_weather for Tokyo.",
              messages: [{ role: "user", content: "what's the weather in Tokyo?" }],
              tools: [TOOL_WEATHER],
              toolChoice: { type: "auto" },
            },
            { effort: "low", maxOutputTokens: 256 },
          ),
        );
        const done = events.find((e) => e.type === "tool_call_done");
        if (!done) return fail("no tool_call_done event", started);
        return pass(
          {
            callCount: events.filter((e) => e.type === "tool_call_done").length,
          },
          started,
        );
      } catch (err) {
        return fail((err as Error).message, started);
      }
    },
  },
  {
    id: "openai-previous-response-id",
    provider: "openai",
    description: "two-turn: turn 2 threads previous_response_id and gets 200",
    capability: "openai.previous_response_id",
    milestone: "M1",
    estimatedCostUsd: 0.01,
    async run(): Promise<CanaryResult> {
      const started = Date.now();
      const a = await adapt();
      if (!a) return skip("OPENAI_API_KEY not set", started);
      try {
        const e1 = await collect(
          a.generate(
            {
              systemPrompt: "Think of a fruit. Reply with just the fruit's name.",
              messages: [{ role: "user", content: "go" }],
              tools: [],
            },
            { effort: "low", maxOutputTokens: 256 },
          ),
        );
        const done1 = e1.find((e) => e.type === "done");
        if (!done1 || done1.type !== "done") return fail("no done on turn 1", started);
        const e2 = await collect(
          a.resume(
            done1.providerHandle,
            {
              systemPrompt: "Think of a fruit. Reply with just the fruit's name.",
              messages: [{ role: "user", content: "is it a fruit?" }],
              tools: [],
            },
            {
              effort: "low",
              maxOutputTokens: 256,
            },
          ),
        );
        const done2 = e2.find((e) => e.type === "done");
        if (!done2 || done2.type !== "done") return fail("no done on turn 2", started);
        return pass(
          {
            t1:
              done1.providerHandle.kind === "openai_response"
                ? done1.providerHandle.responseId
                : "",
            t2:
              done2.providerHandle.kind === "openai_response"
                ? done2.providerHandle.responseId
                : "",
          },
          started,
        );
      } catch (err) {
        return fail((err as Error).message, started);
      }
    },
  },
  {
    id: "openai-conversation-resume",
    provider: "openai",
    description: "Conversations API: create conversation and continue through conversation handle",
    capability: "openai.conversations",
    milestone: "M5",
    estimatedCostUsd: 0.01,
    async run(): Promise<CanaryResult> {
      const started = Date.now();
      const a = await adapt();
      if (!a) return skip("OPENAI_API_KEY not set", started);
      try {
        const startedConversation = await a.startConversation({
          metadata: { canary: "openai-conversation-resume" },
        });
        if (!startedConversation.applicable) {
          return fail(startedConversation.reason ?? "conversation start not applicable", started);
        }
        const events = await collect(
          a.resume(
            startedConversation.providerHandle,
            {
              systemPrompt: "Reply with just: ok",
              messages: [{ role: "user", content: "say ok" }],
              tools: [],
            },
            { effort: "low", maxOutputTokens: 256 },
          ),
        );
        const done = events.find((e) => e.type === "done");
        if (!done || done.type !== "done") return fail("no done event", started);
        return pass(
          {
            conversationId: startedConversation.providerHandle.conversationId,
            responseConversationId:
              done.providerHandle.kind === "openai_response"
                ? done.providerHandle.conversationId
                : null,
          },
          started,
        );
      } catch (err) {
        return fail((err as Error).message, started);
      }
    },
  },
  {
    id: "openai-conversation-response-resume",
    provider: "openai",
    description:
      "conversation-backed response handle resumes without previous_response_id conflict",
    capability: "openai.conversations",
    milestone: "M5",
    estimatedCostUsd: 0.015,
    async run(): Promise<CanaryResult> {
      const started = Date.now();
      const a = await adapt();
      if (!a) return skip("OPENAI_API_KEY not set", started);
      try {
        const startedConversation = await a.startConversation({
          metadata: { canary: "openai-conversation-response-resume" },
        });
        if (!startedConversation.applicable) {
          return fail(startedConversation.reason ?? "conversation start not applicable", started);
        }
        const e1 = await collect(
          a.generate(
            {
              systemPrompt: "Reply with just: ok",
              messages: [{ role: "user", content: "say ok" }],
              tools: [],
            },
            {
              conversationId: startedConversation.providerHandle.conversationId,
              store: true,
              effort: "low",
              maxOutputTokens: 256,
            },
          ),
        );
        const done1 = e1.find((e) => e.type === "done");
        if (!done1 || done1.type !== "done") return fail("no done on turn 1", started);
        if (done1.providerHandle.kind !== "openai_response") {
          return fail(`unexpected handle ${done1.providerHandle.kind}`, started);
        }
        if (
          done1.providerHandle.conversationId !== startedConversation.providerHandle.conversationId
        ) {
          return fail("turn 1 response handle did not retain conversation id", started);
        }
        const e2 = await collect(
          a.resume(
            done1.providerHandle,
            {
              systemPrompt: "Reply with just: ok",
              messages: [{ role: "user", content: "continue" }],
              tools: [],
            },
            { effort: "low", maxOutputTokens: 256 },
          ),
        );
        const done2 = e2.find((e) => e.type === "done");
        if (!done2 || done2.type !== "done") return fail("no done on turn 2", started);
        return pass(
          {
            conversationId: startedConversation.providerHandle.conversationId,
            t1: done1.providerHandle.responseId,
            t2:
              done2.providerHandle.kind === "openai_response"
                ? done2.providerHandle.responseId
                : "",
          },
          started,
        );
      } catch (err) {
        return fail((err as Error).message, started);
      }
    },
  },
  {
    id: "openai-compact-continuation",
    provider: "openai",
    description: "/responses/compact returns compacted output that can be passed forward",
    capability: "openai.compaction",
    milestone: "M5",
    estimatedCostUsd: 0.02,
    async run(): Promise<CanaryResult> {
      const started = Date.now();
      const a = await adapt();
      if (!a) return skip("OPENAI_API_KEY not set", started);
      try {
        const request: AgentRequest = {
          systemPrompt: "Reply briefly.",
          messages: [{ role: "user", content: "Remember the code word glacier." }],
          tools: [],
        };
        const e1 = await collect(a.generate(request, { effort: "low", maxOutputTokens: 256 }));
        const done1 = e1.find((e) => e.type === "done");
        if (!done1 || done1.type !== "done") return fail("no done before compact", started);
        const compacted = await a.compact(done1.providerHandle, {
          request,
          requestOptions: { effort: "low" },
        });
        if (!compacted.applicable || !compacted.providerHandle) {
          return fail(compacted.reason ?? "compact did not return provider handle", started);
        }
        const e2 = await collect(
          a.resume(
            compacted.providerHandle,
            {
              systemPrompt: "Reply briefly.",
              messages: [{ role: "user", content: "What code word did I ask you to remember?" }],
              tools: [],
            },
            { effort: "low", maxOutputTokens: 256 },
          ),
        );
        const done2 = e2.find((e) => e.type === "done");
        if (!done2 || done2.type !== "done") return fail("no done after compact", started);
        return pass(
          {
            compactHandle: compacted.providerHandle.kind,
            outputItems: compacted.output?.length ?? 0,
          },
          started,
        );
      } catch (err) {
        return fail((err as Error).message, started);
      }
    },
  },
  {
    id: "openai-multimodal-resume",
    provider: "openai",
    description: "multimodal first turn can continue through previous_response_id",
    capability: "openai.multimodal_resume",
    milestone: "M5",
    estimatedCostUsd: 0.02,
    async run(): Promise<CanaryResult> {
      const started = Date.now();
      const a = await adapt();
      if (!a) return skip("OPENAI_API_KEY not set", started);
      try {
        const pngBytes = readFileSync(path.join(DOCS_IMAGE_PDF_ROOT, "canary.png"));
        const png64 = pngBytes.toString("base64");
        const e1 = await collect(
          a.generate(
            {
              systemPrompt: "Reply with just: ok",
              messages: [
                {
                  role: "user",
                  content: [
                    { type: "text", text: "Look at this image and say ok." },
                    {
                      type: "image",
                      source: { kind: "base64", data: png64, mediaType: "image/png" },
                    },
                  ],
                },
              ],
              tools: [],
            },
            { effort: "low", maxOutputTokens: 256 },
          ),
        );
        const done1 = e1.find((e) => e.type === "done");
        if (!done1 || done1.type !== "done") return fail("no done on multimodal turn", started);
        const e2 = await collect(
          a.resume(
            done1.providerHandle,
            {
              systemPrompt: "Reply with just: ok",
              messages: [{ role: "user", content: "continue" }],
              tools: [],
            },
            { effort: "low", maxOutputTokens: 256 },
          ),
        );
        const done2 = e2.find((e) => e.type === "done");
        if (!done2 || done2.type !== "done")
          return fail("no done after multimodal resume", started);
        return pass({}, started);
      } catch (err) {
        return fail((err as Error).message, started);
      }
    },
  },
  {
    id: "openai-allowed-tools",
    provider: "openai",
    description: "allowed_tools restriction: tool_choice.allowed_tools accepted",
    capability: "openai.allowed_tools",
    milestone: "M1",
    estimatedCostUsd: 0.01,
    async run(): Promise<CanaryResult> {
      const started = Date.now();
      const a = await adapt();
      if (!a) return skip("OPENAI_API_KEY not set", started);
      try {
        const events = await collect(
          a.generate(
            {
              systemPrompt: "",
              messages: [{ role: "user", content: "weather in Paris?" }],
              tools: [TOOL_WEATHER, TOOL_TIME],
              toolChoice: { type: "auto" },
            },
            {
              allowedTools: ["get_weather"],
              effort: "low",
              maxOutputTokens: 256,
            },
          ),
        );
        const done = events.find((e) => e.type === "done");
        if (!done) return fail("no done", started);
        return pass({ events: events.length }, started);
      } catch (err) {
        return fail((err as Error).message, started);
      }
    },
  },
  {
    id: "openai-effort-high",
    provider: "openai",
    description: "reasoning.effort=high accepted",
    capability: "openai.reasoning.effort_high",
    milestone: "M1",
    estimatedCostUsd: 0.01,
    async run(): Promise<CanaryResult> {
      const started = Date.now();
      const a = await adapt();
      if (!a) return skip("OPENAI_API_KEY not set", started);
      try {
        const events = await collect(
          a.generate(
            {
              systemPrompt: "Reply briefly.",
              messages: [{ role: "user", content: "what is 2+2? reason then answer." }],
              tools: [],
            },
            // effort=high uses substantial reasoning tokens; need plenty of room.
            { effort: "high", maxOutputTokens: 2048 },
          ),
        );
        const done = events.find((e) => e.type === "done");
        if (!done) return fail("no done", started);
        return pass({}, started);
      } catch (err) {
        return fail((err as Error).message, started);
      }
    },
  },
  {
    id: "openai-count-tokens",
    provider: "openai",
    description: "POST /responses/input_tokens/count returns a count",
    capability: "openai.token_counting",
    milestone: "M1",
    estimatedCostUsd: 0.0,
    async run(): Promise<CanaryResult> {
      const started = Date.now();
      const a = await adapt();
      if (!a) return skip("OPENAI_API_KEY not set", started);
      try {
        const c = await a.countTokens([{ role: "user", content: "hello world" }], {});
        if (typeof c.inputTokens !== "number" || c.inputTokens <= 0) {
          return fail(`bad inputTokens: ${c.inputTokens}`, started);
        }
        return pass({ inputTokens: c.inputTokens }, started);
      } catch (err) {
        return fail((err as Error).message, started);
      }
    },
  },
  {
    id: "openai-phase-metadata",
    provider: "openai",
    description: "phase metadata round-trip on replayed input item",
    capability: "openai.phase_metadata",
    milestone: "M1",
    estimatedCostUsd: 0.008,
    async run(): Promise<CanaryResult> {
      const started = Date.now();
      const a = await adapt();
      if (!a) return skip("OPENAI_API_KEY not set", started);
      try {
        const events = await collect(
          a.generate(
            {
              systemPrompt: "",
              messages: [
                { role: "user", content: "continue this thought: 'The key insight is'" },
                {
                  role: "assistant",
                  content: [{ type: "text", text: "The key insight is" }],
                  phase: "commentary",
                },
              ],
              tools: [],
            },
            { effort: "low", maxOutputTokens: 256 },
          ),
        );
        const done = events.find((e) => e.type === "done");
        if (!done) return fail("no done", started);
        return pass({}, started);
      } catch (err) {
        return fail((err as Error).message, started);
      }
    },
  },
  {
    id: "openai-multimodal-image-pdf",
    provider: "openai",
    description:
      "multimodal: PDF + PNG attached via input_file/input_image round-trip, model cites canary string",
    capability: "openai.multimodal",
    milestone: "M3",
    estimatedCostUsd: 0.02,
    async run(): Promise<CanaryResult> {
      const started = Date.now();
      const a = await adapt();
      if (!a) return skip("OPENAI_API_KEY not set", started);
      try {
        const pngBytes = readFileSync(path.join(DOCS_IMAGE_PDF_ROOT, "canary.png"));
        const pdfBytes = readFileSync(path.join(DOCS_IMAGE_PDF_ROOT, "canary.pdf"));
        const png64 = pngBytes.toString("base64");
        const pdf64 = pdfBytes.toString("base64");
        const req: AgentRequest = {
          systemPrompt:
            "You are a careful assistant. Read attached documents and echo the distinctive canary string exactly, then one sentence describing the image.",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Read the attached PDF and image. Reply with the canary string in the PDF (on its own line), then describe the image briefly.",
                },
                {
                  type: "pdf",
                  source: { kind: "base64", data: pdf64 },
                },
                { type: "text", text: "filename:canary.pdf" },
                {
                  type: "image",
                  source: { kind: "base64", data: png64, mediaType: "image/png" },
                },
              ],
            },
          ],
          tools: [],
        };
        const events = await collect(a.generate(req, { effort: "low", maxOutputTokens: 256 }));
        const text = events
          .filter((e) => e.type === "text_delta")
          .map((e) => (e as { delta: string }).delta)
          .join("");
        const done = events.find((e) => e.type === "done");
        if (!done || done.type !== "done") return fail("no done event", started);
        if (!text.includes("OPEN-APEX-CANARY-2026-04-24")) {
          return fail(`canary string not found in response: ${text.slice(0, 200)}`, started);
        }
        return pass({ textLen: text.length }, started);
      } catch (err) {
        return fail((err as Error).message, started);
      }
    },
  },
  {
    id: "openai-production-tool-manifest",
    provider: "openai",
    description:
      "production 9-tool manifest passes strict schema validation (no 400 on real TB2 tools)",
    capability: "openai.production_tools",
    milestone: "M1",
    estimatedCostUsd: 0.02,
    async run(): Promise<CanaryResult> {
      // Regression guard for the TB2 Sonnet/Opus 0/6: a tool schema that
      // strict mode rejected (unsupported keyword, open additionalProperties,
      // etc.) would fail every real trial on turn 1. The live canary used
      // hand-crafted simple schemas and never exercised the real manifest.
      // This canary wires the production 9-tool registry end-to-end so any
      // future strict-incompatible schema surfaces offline.
      const started = Date.now();
      const a = await adapt();
      if (!a) return skip("OPENAI_API_KEY not set", started);
      try {
        const events = await collect(
          a.generate(
            {
              systemPrompt:
                "You are a helpful assistant running inside a sandbox. " +
                "When asked to inspect the workspace, call the appropriate tool.",
              messages: [
                { role: "user", content: "list the contents of /tmp using the list_tree tool" },
              ],
              tools: PRODUCTION_TOOL_MANIFEST,
              toolChoice: { type: "auto" },
            },
            { effort: "low", maxOutputTokens: 256 },
          ),
        );
        const done = events.find((e) => e.type === "done");
        if (!done || done.type !== "done") return fail("no done event", started);
        // What matters: no 400 rejection. Tool call is incidental but nice-
        // to-have evidence that the lifted schemas are actually usable.
        const toolCallDone = events.some((e) => e.type === "tool_call_done");
        return pass(
          {
            toolCount: PRODUCTION_TOOL_MANIFEST.length,
            emittedToolCall: toolCallDone,
            stopReason: done.stopReason,
          },
          started,
        );
      } catch (err) {
        // Surface httpStatus + rawMessage for HttpError literals (the very
        // class of error this canary is designed to detect).
        const asHttp = err as { httpStatus?: number; rawMessage?: string };
        if (typeof asHttp.httpStatus === "number") {
          return fail(
            `http ${asHttp.httpStatus}: ${(asHttp.rawMessage ?? "").slice(0, 400)}`,
            started,
          );
        }
        return fail((err as Error).message, started);
      }
    },
  },
];
