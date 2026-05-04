/**
 * Live Anthropic adapter smoke. Runs under RUN_LIVE=1 with ANTHROPIC_API_KEY.
 */

import { liveTest } from "../../core/test/setup.ts";

import type { AgentRequest, StreamEvent } from "@open-apex/core";

import { AnthropicAdapter } from "../src/adapter.ts";

liveTest(
  {
    keyName: "ANTHROPIC_API_KEY",
    provider: "anthropic",
    canaryName: "adapter-plain-turn",
  },
  "adapter plain turn: generate → text_delta → done with thinking block",
  async () => {
    const adapter = new AnthropicAdapter({
      modelId: "claude-opus-4-6",
      defaultMaxTokens: 256,
    });
    const req: AgentRequest = {
      systemPrompt: "Reply with just: ok",
      messages: [{ role: "user", content: "say ok" }],
      tools: [],
    };
    const events: StreamEvent[] = [];
    for await (const ev of adapter.generate(req, { effort: "high" })) {
      events.push(ev);
    }
    const done = events.find((e) => e.type === "done");
    if (!done || done.type !== "done") throw new Error("no done");
    if (done.providerHandle.kind !== "anthropic_messages") {
      throw new Error("wrong handle kind");
    }
  },
);
