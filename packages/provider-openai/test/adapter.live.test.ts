/**
 * Live OpenAI adapter smoke. Runs under RUN_LIVE=1 with OPENAI_API_KEY set.
 * Skips otherwise. Full canary matrix lives in packages/evals/src/canaries/.
 */

import { liveTest } from "../../core/test/setup.ts";

import type { AgentRequest, StreamEvent } from "@open-apex/core";

import { OpenAiAdapter } from "../src/adapter.ts";

liveTest(
  {
    keyName: "OPENAI_API_KEY",
    provider: "openai",
    canaryName: "adapter-plain-turn",
  },
  "adapter plain turn: generate → text_delta → done with response id",
  async () => {
    const adapter = new OpenAiAdapter({ modelId: "gpt-5.4" });
    const req: AgentRequest = {
      systemPrompt: "You are concise. Reply with just: ok",
      messages: [{ role: "user", content: "say ok" }],
      tools: [],
    };
    const events: StreamEvent[] = [];
    // On gpt-5.4, reasoning.effort=low consumes ~20 tokens for reasoning
    // before any visible text; keep max_output_tokens well above that floor.
    for await (const ev of adapter.generate(req, {
      effort: "low",
      maxOutputTokens: 256,
    })) {
      events.push(ev);
    }
    const done = events.find((e) => e.type === "done");
    if (!done || done.type !== "done") throw new Error("no done event");
    if (done.providerHandle.kind !== "openai_response") {
      throw new Error("wrong handle kind");
    }
    if (!done.providerHandle.responseId.startsWith("resp_")) {
      throw new Error(`unexpected response id: ${done.providerHandle.responseId}`);
    }
  },
);
