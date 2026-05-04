import { describe, expect, test } from "bun:test";

import { openAiCapabilities } from "../src/index.ts";

describe("OpenAI capability matrix (§3.6)", () => {
  test("gpt-5.4 has required orchestrator flags", () => {
    const c = openAiCapabilities("gpt-5.4");
    expect(c.providerId).toBe("openai");
    expect(c.supportsPreviousResponseId).toBe(true);
    expect(c.supportsPhaseMetadata).toBe(true);
    expect(c.supportsAllowedTools).toBe(true);
    expect(c.supportsParallelToolCalls).toBe(true);
    expect(c.supportsEffortXhigh).toBe(true);
    expect(c.supportsServerCompaction).toBe(true);
    expect(c.contextWindowTokens).toBe(1_050_000);
  });

  test("gpt-4 (older) does NOT get xhigh/phase/native compaction", () => {
    const c = openAiCapabilities("gpt-4o");
    expect(c.supportsEffortXhigh).toBe(false);
    expect(c.supportsNativeCompaction).toBe(false);
    expect(c.supportsPhaseMetadata).toBe(false);
  });

  test("adaptive thinking NEVER set for OpenAI", () => {
    const c = openAiCapabilities("gpt-5.4");
    expect(c.supportsAdaptiveThinking).toBe(false);
    // `max` effort is Anthropic-only.
    expect(c.supportsEffortMax).toBe(false);
  });
});
