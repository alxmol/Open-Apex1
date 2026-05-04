import { describe, expect, test } from "bun:test";

import { anthropicCapabilities } from "../src/index.ts";

describe("Anthropic capability matrix (§3.6 + user directive on parity)", () => {
  test("sonnet-4-6, opus-4-6, opus-4-7 share core flags (user directive)", () => {
    const sonnet = anthropicCapabilities("claude-sonnet-4-6");
    const opus46 = anthropicCapabilities("claude-opus-4-6");
    const opus47 = anthropicCapabilities("claude-opus-4-7");
    const sharedFlags = [
      "supportsAdaptiveThinking",
      "supportsContextEditingToolUses",
      "supportsContextEditingThinking",
      "supportsServerCompaction",
      "supportsSearchResultBlocks",
      "supportsPromptCaching",
      "supportsParallelToolCalls",
      "supportsMultimodalImages",
      "supportsMultimodalPdfs",
    ] as const;
    for (const f of sharedFlags) {
      expect(sonnet[f]).toBe(opus46[f]);
      expect(opus46[f]).toBe(opus47[f]);
    }
  });

  test("xhigh effort is Opus 4.7 only", () => {
    expect(anthropicCapabilities("claude-sonnet-4-6").supportsEffortXhigh).toBe(false);
    expect(anthropicCapabilities("claude-opus-4-6").supportsEffortXhigh).toBe(false);
    expect(anthropicCapabilities("claude-opus-4-7").supportsEffortXhigh).toBe(true);
  });

  test("max effort is 4.6 family only", () => {
    expect(anthropicCapabilities("claude-sonnet-4-6").supportsEffortMax).toBe(true);
    expect(anthropicCapabilities("claude-opus-4-6").supportsEffortMax).toBe(true);
    expect(anthropicCapabilities("claude-opus-4-7").supportsEffortMax).toBe(false);
  });

  test("current 4.6/4.7 benchmark models expose 1M context windows", () => {
    expect(anthropicCapabilities("claude-sonnet-4-6").contextWindowTokens).toBe(1_000_000);
    expect(anthropicCapabilities("claude-opus-4-6").contextWindowTokens).toBe(1_000_000);
    expect(anthropicCapabilities("claude-opus-4-7").contextWindowTokens).toBe(1_000_000);
  });

  test("allowed_tools + phase metadata NEVER set for Anthropic", () => {
    const c = anthropicCapabilities("claude-opus-4-6");
    expect(c.supportsAllowedTools).toBe(false);
    expect(c.supportsPhaseMetadata).toBe(false);
    expect(c.supportsPreviousResponseId).toBe(false);
  });
});
