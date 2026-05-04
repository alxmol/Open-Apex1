import { describe, expect, test } from "bun:test";

import { listPresets, loadPreset, validatePreset, type Preset } from "../src/index.ts";

function samplePreset(overrides: Partial<Preset> = {}): Preset {
  return {
    presetId: "test-preset",
    revision: "r1",
    kind: "benchmark",
    provider: "anthropic",
    modelId: "claude-opus-4-6",
    effort: "high",
    enabled: {
      subagentFanout: true,
      synthesis: true,
      midExecReExplore: true,
      exploratoryExecutor: true,
      strategyPlanner: true,
      verifierSubagent: true,
      landlockProbe: true,
      promptCaching: true,
      contextEditing: true,
      serverCompaction: true,
      toolSearch: false,
      backgroundMode: false,
      prediction: true,
      repoMap: true,
      symbolIndex: true,
      envProbe: true,
      webSearch: true,
      readAsset: true,
      contaminationBlocklist: true,
    },
    gatherFanout: 5,
    searchAggressiveness: "selective",
    maxTurns: 150,
    permissionDefaults: "full_auto",
    benchmarkMode: true,
    verifiedOn: "2026-04-19",
    ...overrides,
  };
}

describe("preset schema validation (§7.6.9)", () => {
  test("valid preset passes", () => {
    expect(validatePreset(samplePreset())).toEqual([]);
  });

  test("presetId must match /^[a-z0-9-]+$/", () => {
    const errs = validatePreset(samplePreset({ presetId: "BadCase" }));
    expect(errs.some((e) => e.path === "$.presetId")).toBe(true);
  });

  test("revision must match /^r[0-9]+$/", () => {
    const errs = validatePreset(samplePreset({ revision: "beta1" }));
    expect(errs.some((e) => e.path === "$.revision")).toBe(true);
  });

  test("gatherFanout out of range rejected", () => {
    const errs = validatePreset(samplePreset({ gatherFanout: 99 }));
    expect(errs.some((e) => e.path === "$.gatherFanout")).toBe(true);
  });

  test("unknown enabled key rejected (additionalProperties: false)", () => {
    const preset = {
      ...samplePreset(),
      enabled: { ...samplePreset().enabled, fictional: true },
    };
    const errs = validatePreset(preset);
    expect(errs.some((e) => e.path === "$.enabled.fictional")).toBe(true);
  });

  test("missing enabled sub-key rejected", () => {
    const { synthesis: _, ...rest } = samplePreset().enabled;
    const preset = { ...samplePreset(), enabled: rest };
    const errs = validatePreset(preset);
    expect(errs.some((e) => e.path === "$.enabled.synthesis")).toBe(true);
  });

  test("effort must be a known level", () => {
    const errs = validatePreset(samplePreset({ effort: "galaxy-brain" as never }));
    expect(errs.some((e) => e.path === "$.effort")).toBe(true);
  });

  test("compactThreshold must be >= 50000", () => {
    const errs = validatePreset(
      samplePreset({
        contextManagement: { compactThreshold: 1000 },
      }),
    );
    expect(errs.some((e) => e.path === "$.contextManagement.compactThreshold")).toBe(true);
  });

  test("verifiedOn must be ISO YYYY-MM-DD", () => {
    const errs = validatePreset(samplePreset({ verifiedOn: "last week" }));
    expect(errs.some((e) => e.path === "$.verifiedOn")).toBe(true);
  });
});

describe("preset files under packages/config/presets/ (§6 M0 exit criterion)", () => {
  test("every shipped preset file validates", async () => {
    const presets = await listPresets();
    expect(presets.length).toBe(5);
    const ids = presets.map((p) => p.presetId).sort();
    expect(ids).toEqual(["chat-gpt54", "tb2-gpt54", "tb2-opus46", "tb2-opus47", "tb2-sonnet46"]);
  });

  test("loadPreset returns full Preset shape", async () => {
    const p = await loadPreset("tb2-sonnet46");
    expect(p.presetId).toBe("tb2-sonnet46");
    expect(p.provider).toBe("anthropic");
    expect(p.modelId).toBe("claude-sonnet-4-6");
    expect(p.enabled.contextEditing).toBe(true);
    expect(p.benchmarkMode).toBe(true);
    expect(p.sourcePath.endsWith("tb2-sonnet46.json")).toBe(true);
  });

  test("all three Claude presets share identical Anthropic feature flags (user directive)", async () => {
    const [sonnet, opus46, opus47] = await Promise.all([
      loadPreset("tb2-sonnet46"),
      loadPreset("tb2-opus46"),
      loadPreset("tb2-opus47"),
    ]);
    // The user said: Sonnet/Opus 4.6/4.7 share the same capability surface.
    // These three presets MUST have the same `enabled` map.
    expect(opus46.enabled).toEqual(sonnet.enabled);
    expect(opus47.enabled).toEqual(sonnet.enabled);
  });

  test("GPT-5.4 preset differs from Claude presets only in provider-path flags", async () => {
    const gpt = await loadPreset("tb2-gpt54");
    const claude = await loadPreset("tb2-opus46");
    expect(gpt.provider).toBe("openai");
    expect(claude.provider).toBe("anthropic");
    // OpenAI doesn't do context editing / prompt caching via the same headers.
    expect(gpt.enabled.contextEditing).toBe(false);
    expect(gpt.enabled.promptCaching).toBe(false);
    expect(claude.enabled.contextEditing).toBe(true);
    expect(claude.enabled.promptCaching).toBe(true);
  });

  test("chat-gpt54 is the safe GPT-first product preset", async () => {
    const p = await loadPreset("chat-gpt54");
    expect(p.kind).toBe("chat");
    expect(p.provider).toBe("openai");
    expect(p.modelId).toBe("gpt-5.4");
    expect(p.permissionDefaults).toBe("medium");
    expect(p.benchmarkMode).toBe(false);
    expect(p.effort).toBe("high");
    expect(p.repairTurnEffort).toBe("xhigh");
    expect(p.enabled.serverCompaction).toBe(true);
  });

  test("tb2-gpt54 remains a full-auto benchmark preset with high repair effort", async () => {
    const p = await loadPreset("tb2-gpt54");
    expect(p.kind).toBe("benchmark");
    expect(p.permissionDefaults).toBe("full_auto");
    expect(p.benchmarkMode).toBe(true);
    expect(p.effort).toBe("high");
    expect(p.repairTurnEffort).toBe("xhigh");
  });

  test("no preset includes modelIdFallback (user directive: no backup model)", async () => {
    const presets = await listPresets();
    for (const p of presets) {
      expect(p.modelIdFallback).toBeUndefined();
    }
  });

  test("tb2-opus47 targets claude-opus-4-7 with xhigh repair escalation", async () => {
    const p = await loadPreset("tb2-opus47");
    expect(p.modelId).toBe("claude-opus-4-7");
    expect(p.repairTurnEffort).toBe("xhigh");
    expect(p.thinkingDisplay).toBe("omitted");
  });
});

describe("loadPreset error paths", () => {
  test("missing preset file → PresetLoadError", async () => {
    await expect(loadPreset("does-not-exist")).rejects.toThrow();
  });
});
