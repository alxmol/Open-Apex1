import { describe, expect, test } from "bun:test";

import type { StreamEvent } from "@open-apex/core";
import { simpleTextScript } from "@open-apex/core";

import { MockAnthropicAdapter } from "../src/index.ts";

describe("MockAnthropicAdapter — script replay", () => {
  test("replays a single-turn simpleTextScript", async () => {
    const adapter = new MockAnthropicAdapter({
      script: simpleTextScript("howdy", "anthropic"),
    });
    const events: StreamEvent[] = [];
    for await (const ev of adapter.generate({ systemPrompt: "", messages: [], tools: [] }, {})) {
      events.push(ev);
    }
    expect(events.map((e) => e.type)).toEqual(["text_delta", "usage_update", "done"]);
  });

  test("compact() remains 'not applicable' in the mock, mirroring the real adapter", async () => {
    const adapter = new MockAnthropicAdapter({
      script: simpleTextScript("", "anthropic"),
    });
    const r = await adapter.compact(
      { kind: "anthropic_messages", messages: [], betaHeaders: [] },
      {},
    );
    expect(r.applicable).toBe(false);
  });

  test("base capability matrix reflects Sonnet 4.6 parity flags", () => {
    const adapter = new MockAnthropicAdapter({
      modelId: "claude-sonnet-4-6",
      script: { turns: [] },
    });
    const caps = adapter.getCapabilities();
    expect(caps.supportsAdaptiveThinking).toBe(true);
    expect(caps.supportsContextEditingToolUses).toBe(true);
    expect(caps.supportsEffortMax).toBe(true);
    expect(caps.supportsEffortXhigh).toBe(false);
  });
});
