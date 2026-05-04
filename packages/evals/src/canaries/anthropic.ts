/**
 * Anthropic canary matrix (§5.4).
 *
 * Ships: plain response, streaming, tool round-trip, adaptive thinking +
 * effort, signature round-trip, multi-tool-result, prompt caching (verify
 * cache_read > 0 on repeat), context editing hook, compaction hook.
 */

import { readFileSync } from "node:fs";
import * as path from "node:path";

import type {
  AgentRequest,
  ContentPart,
  HistoryItem,
  StreamEvent,
  ToolDefinitionPayload,
} from "@open-apex/core";
import { AnthropicAdapter } from "@open-apex/provider-anthropic";
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
  return process.env.ANTHROPIC_API_KEY;
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

async function adapter(): Promise<AnthropicAdapter | null> {
  if (!needsKey()) return null;
  return new AnthropicAdapter({
    modelId: "claude-opus-4-6",
    defaultMaxTokens: 1024,
  });
}

async function collect(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const ev of stream) out.push(ev);
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const TOOL_WEATHER: ToolDefinitionPayload = {
  name: "get_weather",
  description: "Get current weather",
  parameters: {
    type: "object",
    required: ["city"],
    properties: { city: { type: "string" } },
  },
};

const TOOL_TIME: ToolDefinitionPayload = {
  name: "get_time",
  description: "Get current time",
  parameters: {
    type: "object",
    required: ["tz"],
    properties: { tz: { type: "string" } },
  },
};

/**
 * The real 9-tool manifest Open-Apex ships to Anthropic in autonomous mode.
 * Mirrors the mapping done in apps/cli/src/autonomous.ts. Used by the
 * `anthropic-production-tool-manifest` canary to guard against strict-mode
 * schema regressions — the very class of bug that zero-scored Sonnet/Opus
 * in TB2 (`minimum`/`maxLength` keywords trip strict's 400 rejection).
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

export const ANTHROPIC_CANARIES: CanarySpec[] = [
  {
    id: "anthropic-plain-turn",
    provider: "anthropic",
    description: "plain response with adaptive thinking",
    capability: "anthropic.base",
    milestone: "M1",
    estimatedCostUsd: 0.008,
    async run(): Promise<CanaryResult> {
      const started = Date.now();
      const a = await adapter();
      if (!a) return skip("ANTHROPIC_API_KEY not set", started);
      const events = await collect(
        a.generate(
          {
            systemPrompt: "Reply: ok",
            messages: [{ role: "user", content: "go" }],
            tools: [],
          },
          { effort: "high" },
        ),
      );
      const done = events.find((e) => e.type === "done");
      if (!done) return fail("no done event", started);
      return pass({ events: events.length }, started);
    },
  },
  {
    id: "anthropic-streaming-with-thinking",
    provider: "anthropic",
    description: "streaming: thinking_delta + text_delta + done",
    capability: "anthropic.adaptive_thinking",
    milestone: "M1",
    estimatedCostUsd: 0.012,
    async run(): Promise<CanaryResult> {
      const started = Date.now();
      const a = await adapter();
      if (!a) return skip("ANTHROPIC_API_KEY not set", started);
      const events = await collect(
        a.generate(
          {
            systemPrompt: "",
            messages: [
              { role: "user", content: "Think: what is 7*8? Answer with just the number." },
            ],
            tools: [],
          },
          { effort: "high" },
        ),
      );
      const thinkingDeltas = events.filter((e) => e.type === "thinking_delta").length;
      const textDeltas = events.filter((e) => e.type === "text_delta").length;
      if (textDeltas < 1) return fail("no text_delta", started);
      return pass({ thinkingDeltas, textDeltas }, started);
    },
  },
  {
    id: "anthropic-tool-roundtrip",
    provider: "anthropic",
    description: "tool call round-trip",
    capability: "anthropic.tool_use",
    milestone: "M1",
    estimatedCostUsd: 0.012,
    async run(): Promise<CanaryResult> {
      const started = Date.now();
      const a = await adapter();
      if (!a) return skip("ANTHROPIC_API_KEY not set", started);
      const events = await collect(
        a.generate(
          {
            systemPrompt: "Call get_weather for Tokyo.",
            messages: [{ role: "user", content: "weather in Tokyo?" }],
            tools: [TOOL_WEATHER],
            toolChoice: { type: "auto" },
          },
          { effort: "high" },
        ),
      );
      const done = events.find((e) => e.type === "tool_call_done");
      if (!done) return fail("no tool_call_done", started);
      return pass({}, started);
    },
  },
  {
    id: "anthropic-signature-roundtrip",
    provider: "anthropic",
    description: "thinking-block signature echoes back cleanly in turn 2",
    capability: "anthropic.signature_roundtrip",
    milestone: "M1",
    estimatedCostUsd: 0.02,
    async run(): Promise<CanaryResult> {
      const started = Date.now();
      const a = await adapter();
      if (!a) return skip("ANTHROPIC_API_KEY not set", started);
      const turn1 = await collect(
        a.generate(
          {
            systemPrompt: "",
            messages: [{ role: "user", content: "Think about: 2+2. Answer with just the number." }],
            tools: [],
          },
          { effort: "high" },
        ),
      );
      const done1 = turn1.find((e) => e.type === "done");
      if (!done1 || done1.type !== "done") return fail("turn 1 no done", started);
      // Reconstruct the assistant message from the thinking/text deltas.
      const thinkingText = turn1
        .filter(
          (e): e is Extract<StreamEvent, { type: "thinking_delta" }> => e.type === "thinking_delta",
        )
        .map((e) => e.delta)
        .join("");
      const signature =
        turn1.find(
          (e): e is Extract<StreamEvent, { type: "thinking_delta" }> =>
            e.type === "thinking_delta" && e.signature !== undefined,
        )?.signature ?? undefined;
      const text = turn1
        .filter((e): e is Extract<StreamEvent, { type: "text_delta" }> => e.type === "text_delta")
        .map((e) => e.delta)
        .join("");
      if (!signature) return fail("no signature on thinking_delta", started);
      const assistantItems: HistoryItem[] = [
        {
          id: "a1",
          createdAt: new Date().toISOString(),
          role: "assistant",
          content: [
            { type: "thinking", text: thinkingText, signature } as ContentPart,
            { type: "text", text } as ContentPart,
          ],
        },
      ];
      if (done1.providerHandle.kind !== "anthropic_messages")
        return fail("bad handle kind", started);
      const handle = {
        ...done1.providerHandle,
        messages: [
          ...(done1.providerHandle.messages as unknown[]),
          ...assistantItems.map((h) => ({ role: h.role, content: h.content })),
        ],
      };
      const turn2 = await collect(
        a.resume(
          handle,
          {
            systemPrompt: "",
            messages: [{ role: "user", content: "Confirm your answer." }],
            tools: [],
          },
          { effort: "high" },
        ),
      );
      const done2 = turn2.find((e) => e.type === "done");
      if (!done2) return fail("turn 2 no done", started);
      return pass({ signatureLen: signature.length }, started);
    },
  },
  {
    id: "anthropic-prompt-caching",
    provider: "anthropic",
    description: "prompt caching: automatic caching reuses an identical prefix on the second call",
    capability: "anthropic.prompt_caching",
    milestone: "M1",
    estimatedCostUsd: 0.03,
    async run(): Promise<CanaryResult> {
      const started = Date.now();
      const a = await adapter();
      if (!a) return skip("ANTHROPIC_API_KEY not set", started);
      // Anthropic automatic caching caches the full prefix (tools, system,
      // messages) up to the last cacheable block. Keep the prompt well above
      // the caching minimum and reuse the exact same request. Include a unique
      // marker so previous live canary runs cannot turn the first call into a
      // cache read and make the creation assertion ambiguous.
      const marker = `open-apex-cache-canary-${Date.now()}`;
      const longSystem =
        "You are a thoughtful assistant. " +
        `Repeat the following rule to yourself before every answer (${marker}): be concise and accurate. `.repeat(
          500,
        );
      const req: AgentRequest = {
        systemPrompt: longSystem,
        messages: [{ role: "user", content: "say ok" }],
        tools: [],
      };
      const events1 = await collect(a.generate(req, { effort: "low" }));
      const usage1 = events1.find((e) => e.type === "usage_update");
      const created1 =
        usage1 && usage1.type === "usage_update" ? (usage1.usage.cacheCreationInputTokens ?? 0) : 0;
      const cached1 =
        usage1 && usage1.type === "usage_update" ? (usage1.usage.cachedInputTokens ?? 0) : 0;
      if (cached1 > 0) {
        return pass({ cached1, note: "prefix was already cached on first request" }, started);
      }
      if (created1 <= 0) {
        return fail("first request did not create a prompt cache entry", started);
      }
      await sleep(1500);
      // Second call should hit the cache.
      const events2 = await collect(a.generate(req, { effort: "low" }));
      const usage2 = events2.find((e) => e.type === "usage_update");
      if (!usage2 || usage2.type !== "usage_update")
        return fail("no usage event on 2nd call", started);
      const cached = usage2.usage.cachedInputTokens ?? 0;
      return cached > 0
        ? pass({ cached, created1 }, started)
        : fail(
            `cache_read_input_tokens was ${cached} (cache_creation on first call: ${created1})`,
            started,
          );
    },
  },
  {
    id: "anthropic-context-editing-beta",
    provider: "anthropic",
    description: "context-management beta header + clear_tool_uses edit config accepted",
    capability: "anthropic.context_management",
    milestone: "M1",
    estimatedCostUsd: 0.008,
    async run(): Promise<CanaryResult> {
      const started = Date.now();
      if (!needsKey()) return skip("ANTHROPIC_API_KEY not set", started);
      const a = new AnthropicAdapter({
        modelId: "claude-opus-4-6",
        defaultMaxTokens: 64,
        alwaysOnBetaHeaders: ["context-management-2025-06-27"],
      });
      const events = await collect(
        a.generate(
          {
            systemPrompt: "",
            messages: [{ role: "user", content: "say ok" }],
            tools: [],
          },
          {
            contextManagement: {
              triggerInputTokens: 100_000,
              keepToolUses: 4,
              clearAtLeastTokens: 10_000,
            },
          },
        ),
      );
      const done = events.find((e) => e.type === "done");
      if (!done) return fail("no done", started);
      return pass({}, started);
    },
  },
  {
    id: "anthropic-compact-beta",
    provider: "anthropic",
    description: "compact-2026-01-12 beta header accepted",
    capability: "anthropic.server_compaction",
    milestone: "M1",
    estimatedCostUsd: 0.008,
    async run(): Promise<CanaryResult> {
      const started = Date.now();
      if (!needsKey()) return skip("ANTHROPIC_API_KEY not set", started);
      const a = new AnthropicAdapter({
        modelId: "claude-opus-4-6",
        defaultMaxTokens: 64,
        alwaysOnBetaHeaders: ["compact-2026-01-12"],
      });
      const events = await collect(
        a.generate(
          {
            systemPrompt: "",
            messages: [{ role: "user", content: "say ok" }],
            tools: [],
          },
          { contextManagement: { compactThreshold: 100_000 } },
        ),
      );
      const done = events.find((e) => e.type === "done");
      if (!done) return fail("no done", started);
      return pass({}, started);
    },
  },
  {
    id: "anthropic-multi-tool-result",
    provider: "anthropic",
    description: "multiple tool_result blocks in a single user message accepted",
    capability: "anthropic.multi_tool_result",
    milestone: "M1",
    estimatedCostUsd: 0.01,
    async run(): Promise<CanaryResult> {
      const started = Date.now();
      const a = await adapter();
      if (!a) return skip("ANTHROPIC_API_KEY not set", started);
      const events = await collect(
        a.generate(
          {
            systemPrompt: "",
            messages: [
              { role: "user", content: "compare facts" },
              {
                role: "assistant",
                content: [
                  {
                    type: "tool_use",
                    toolCallId: "tu_1",
                    name: "get_weather",
                    arguments: { city: "Tokyo" },
                  },
                  {
                    type: "tool_use",
                    toolCallId: "tu_2",
                    name: "get_time",
                    arguments: { tz: "Europe/Paris" },
                  },
                ],
              },
              {
                role: "user",
                content: [
                  { type: "tool_result", toolCallId: "tu_1", content: "sunny 22C" },
                  { type: "tool_result", toolCallId: "tu_2", content: "14:00 CET" },
                ],
              },
            ],
            tools: [TOOL_WEATHER, TOOL_TIME],
          },
          { effort: "low" },
        ),
      );
      const done = events.find((e) => e.type === "done");
      if (!done) return fail("no done", started);
      return pass({}, started);
    },
  },
  {
    id: "anthropic-effort-max",
    provider: "anthropic",
    description: "output_config.effort=max accepted on Opus 4.6",
    capability: "anthropic.effort_max",
    milestone: "M1",
    estimatedCostUsd: 0.02,
    async run(): Promise<CanaryResult> {
      const started = Date.now();
      const a = await adapter();
      if (!a) return skip("ANTHROPIC_API_KEY not set", started);
      const events = await collect(
        a.generate(
          {
            systemPrompt: "Reply briefly.",
            messages: [{ role: "user", content: "what is 2+2?" }],
            tools: [],
          },
          { effort: "max" },
        ),
      );
      const done = events.find((e) => e.type === "done");
      if (!done) return fail("no done", started);
      return pass({}, started);
    },
  },
  {
    id: "anthropic-multimodal-image-pdf",
    provider: "anthropic",
    description:
      "multimodal: PDF + PNG attached via document/image content blocks, model cites canary string",
    capability: "anthropic.multimodal",
    milestone: "M3",
    estimatedCostUsd: 0.03,
    async run(): Promise<CanaryResult> {
      const started = Date.now();
      const a = await adapter();
      if (!a) return skip("ANTHROPIC_API_KEY not set", started);
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
                { type: "pdf", source: { kind: "base64", data: pdf64 } },
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
    id: "anthropic-search-result-block",
    provider: "anthropic",
    description:
      "native search_result content block round-trips; model cites the provided URL in the reply",
    capability: "anthropic.search_result_blocks",
    milestone: "M3",
    estimatedCostUsd: 0.02,
    async run(): Promise<CanaryResult> {
      const started = Date.now();
      const a = await adapter();
      if (!a) return skip("ANTHROPIC_API_KEY not set", started);
      try {
        const req: AgentRequest = {
          systemPrompt:
            "You are answering a question using the attached search result. Cite the exact URL you used from the search_result block.",
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "text",
                  text: "Using only the attached search result, what is the title of the asyncio docs page and what URL did it come from? Include the URL verbatim.",
                },
                {
                  type: "search_result",
                  title: "asyncio — Asynchronous I/O",
                  url: "https://docs.python.org/3/library/asyncio.html",
                  snippet:
                    "asyncio is a library to write concurrent code using async/await syntax.",
                  content:
                    "asyncio is a library to write concurrent code using the async/await syntax and is used as a foundation for multiple Python asynchronous frameworks.",
                },
              ],
            },
          ],
          tools: [],
        };
        const events = await collect(a.generate(req, { effort: "low", maxOutputTokens: 200 }));
        const text = events
          .filter((e) => e.type === "text_delta")
          .map((e) => (e as { delta: string }).delta)
          .join("");
        if (!text.includes("docs.python.org")) {
          return fail(`URL not echoed in response: ${text.slice(0, 200)}`, started);
        }
        return pass({ textLen: text.length }, started);
      } catch (err) {
        return fail((err as Error).message, started);
      }
    },
  },
  {
    id: "anthropic-production-tool-manifest",
    provider: "anthropic",
    description:
      "production 9-tool manifest passes strict schema validation (no 400 on real TB2 tools)",
    capability: "anthropic.production_tools",
    milestone: "M1",
    estimatedCostUsd: 0.02,
    async run(): Promise<CanaryResult> {
      // Direct regression guard for the Sonnet/Opus 0/6 TB2 run: a tool
      // schema containing `minimum` / `maxLength` / etc. kept request-time
      // with strict:true and the API returned 400 on turn 1. This canary
      // exercises the real 9-tool registry end-to-end so any future
      // strict-incompatible keyword surfaces immediately offline.
      const started = Date.now();
      const a = await adapter();
      if (!a) return skip("ANTHROPIC_API_KEY not set", started);
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
