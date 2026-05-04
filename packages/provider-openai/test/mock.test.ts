import { describe, expect, test } from "bun:test";

import type { StreamEvent } from "@open-apex/core";
import { simpleTextScript } from "@open-apex/core";

import { MockOpenAiAdapter } from "../src/index.ts";

describe("MockOpenAiAdapter — script replay (§mock/live parity)", () => {
  test("replays a single-turn simpleTextScript", async () => {
    const adapter = new MockOpenAiAdapter({
      script: simpleTextScript("hello", "openai"),
    });
    const events: StreamEvent[] = [];
    for await (const ev of adapter.generate({ systemPrompt: "", messages: [], tools: [] }, {})) {
      events.push(ev);
    }
    expect(events.map((e) => e.type)).toEqual(["text_delta", "usage_update", "done"]);
    expect(adapter.recordedCalls).toHaveLength(1);
    expect(adapter.recordedCalls[0]!.method).toBe("generate");
  });

  test("consumes turns sequentially on repeated generate()", async () => {
    const adapter = new MockOpenAiAdapter({
      script: {
        turns: [
          {
            events: [
              { type: "text_delta", delta: "turn-1" },
              {
                type: "done",
                stopReason: "end_turn",
                providerHandle: {
                  kind: "openai_response",
                  responseId: "r1",
                  reasoningItemsIncluded: false,
                },
              },
            ],
          },
          {
            events: [
              { type: "text_delta", delta: "turn-2" },
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
    const texts: string[] = [];
    for (let t = 0; t < 2; t++) {
      for await (const ev of adapter.generate({ systemPrompt: "", messages: [], tools: [] }, {})) {
        if (ev.type === "text_delta") texts.push(ev.delta);
      }
    }
    expect(texts).toEqual(["turn-1", "turn-2"]);
    expect(adapter.recordedCalls).toHaveLength(2);
  });

  test("scripted throwError emits error event then throws", async () => {
    const adapter = new MockOpenAiAdapter({
      script: {
        turns: [
          {
            events: [],
            throwError: {
              code: "rate_limit_exceeded",
              message: "scripted 429",
              retryable: true,
              httpStatus: 429,
            },
          },
        ],
      },
    });
    const events: StreamEvent[] = [];
    let threw = false;
    try {
      for await (const ev of adapter.generate({ systemPrompt: "", messages: [], tools: [] }, {})) {
        events.push(ev);
      }
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    expect(events.map((e) => e.type)).toEqual(["error"]);
    if (events[0]!.type !== "error") throw new Error("unreachable");
    expect(events[0]!.code).toBe("rate_limit_exceeded");
    expect(events[0]!.retryable).toBe(true);
  });

  test("capabilityOverrides layer on the base matrix", () => {
    const adapter = new MockOpenAiAdapter({
      script: {
        turns: [],
        capabilityOverrides: { supportsEffortXhigh: false },
      },
    });
    const caps = adapter.getCapabilities();
    expect(caps.providerId).toBe("openai");
    expect(caps.supportsEffortXhigh).toBe(false);
    expect(caps.supportsPreviousResponseId).toBe(true); // base matrix preserved
  });

  test("resume() consumes the next turn just like generate()", async () => {
    const adapter = new MockOpenAiAdapter({
      script: simpleTextScript("resumed", "openai"),
    });
    const events: StreamEvent[] = [];
    for await (const ev of adapter.resume(
      { kind: "openai_response", responseId: "prior", reasoningItemsIncluded: false },
      { systemPrompt: "", messages: [], tools: [] },
      {},
    )) {
      events.push(ev);
    }
    expect(events.some((e) => e.type === "text_delta")).toBe(true);
    expect(adapter.recordedCalls[0]!.method).toBe("resume");
  });
});
