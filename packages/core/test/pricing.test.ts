import { describe, expect, test } from "bun:test";

import { estimateCostUsd, isKnownModel } from "../src/pricing.ts";

describe("estimateCostUsd", () => {
  test("gpt-5.4 input + output is non-zero for a real-sized run", () => {
    const c = estimateCostUsd("gpt-5.4", {
      inputTokens: 10_000,
      outputTokens: 2_000,
    });
    expect(c.inputUsd).toBeGreaterThan(0);
    expect(c.outputUsd).toBeGreaterThan(0);
    expect(c.totalUsd).toBe(c.inputUsd + c.outputUsd + c.cachedInputUsd);
  });

  test("cached input tokens are priced lower than fresh input", () => {
    const cached = estimateCostUsd("gpt-5.4", {
      inputTokens: 10_000,
      outputTokens: 0,
      cachedInputTokens: 10_000,
    });
    const uncached = estimateCostUsd("gpt-5.4", {
      inputTokens: 10_000,
      outputTokens: 0,
      cachedInputTokens: 0,
    });
    expect(cached.cachedInputUsd).toBeGreaterThan(0);
    expect(cached.inputUsd).toBe(0);
    expect(cached.totalUsd).toBeLessThan(uncached.totalUsd);
  });

  test("unknown modelId returns zeros (no crash)", () => {
    const c = estimateCostUsd("unknown-model-xyz", {
      inputTokens: 100,
      outputTokens: 100,
    });
    expect(c.totalUsd).toBe(0);
  });

  test("isKnownModel covers the four benchmark presets", () => {
    expect(isKnownModel("gpt-5.4")).toBe(true);
    expect(isKnownModel("claude-sonnet-4-6")).toBe(true);
    expect(isKnownModel("claude-opus-4-6")).toBe(true);
    expect(isKnownModel("claude-opus-4-7")).toBe(true);
    expect(isKnownModel("gpt-9000")).toBe(false);
  });
});
