import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import { JsonlSqliteSessionStore } from "@open-apex/runtime";

import {
  createDefaultCommandRegistry,
  parseCommandLine,
  type ChatCommandContext,
} from "../src/commands.ts";

function root(): string {
  return mkdtempSync(path.join(tmpdir(), "open-apex-commands-"));
}

async function context(): Promise<{ ctx: ChatCommandContext; close: () => void }> {
  const r = root();
  const sessionStore = new JsonlSqliteSessionStore({
    sessionsDir: path.join(r, "sessions"),
    sqliteHome: path.join(r, "sqlite"),
  });
  const session = await sessionStore.openSession({
    workspace: r,
    presetId: "tb2-gpt54",
    agentName: "test",
  });
  let autonomy = "medium";
  return {
    ctx: {
      runId: "run_cmd",
      workspace: r,
      session,
      sessionStore,
      history: [],
      usage: { inputTokens: 3, outputTokens: 4, cachedInputTokens: 1 },
      preset: {
        presetId: "tb2-gpt54",
        revision: "r-test",
        provider: "openai",
        modelId: "gpt-5.4",
        kind: "benchmark",
        enabled: {} as never,
        effort: "high",
        gatherFanout: 5,
        searchAggressiveness: "selective",
        maxTurns: 150,
        permissionDefaults: "full_auto",
        networkEnabled: true,
        benchmarkMode: true,
        verifiedOn: "2026-04-27",
        sourcePath: path.join(r, "preset.json"),
      } as never,
      autonomyLevel: autonomy,
      setAutonomyLevel(level) {
        autonomy = level;
        this.autonomyLevel = level;
      },
      resetConversation() {
        this.history.length = 0;
      },
    },
    close: () => sessionStore.close(),
  };
}

describe("M5 command registry", () => {
  test("parses commands and --json", () => {
    expect(parseCommandLine("/tokens --json")).toEqual({
      name: "tokens",
      args: [],
      json: true,
    });
  });

  test("runs token and timeline commands", async () => {
    const { ctx, close } = await context();
    const registry = createDefaultCommandRegistry();
    const tokens = await registry.execute("/tokens --json", ctx);
    expect(tokens.text).toContain("input=3");
    const timeline = await registry.execute("/timeline", ctx);
    expect(timeline.text).toContain("Timeline");
    expect(timeline.json).toMatchObject({
      session_id: ctx.session.sessionId,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    close();
  });

  test("/cost uses the pricing estimator", async () => {
    const { ctx, close } = await context();
    ctx.usage = { inputTokens: 10_000, outputTokens: 2_000, cachedInputTokens: 1_000 };
    const registry = createDefaultCommandRegistry();
    const cost = await registry.execute("/cost --json", ctx);
    expect(cost.text).toContain("Estimated cost:");
    expect((cost.json as { total_cost_usd: number }).total_cost_usd).toBeGreaterThan(0);
    close();
  });

  test("/new resets conversation history", async () => {
    const { ctx, close } = await context();
    ctx.history.push({
      id: "u1",
      createdAt: new Date().toISOString(),
      role: "user",
      content: "hello",
    });
    const registry = createDefaultCommandRegistry();
    await registry.execute("/new", ctx);
    expect(ctx.history).toHaveLength(0);
    close();
  });

  test("/permissions changes autonomy level", async () => {
    const { ctx, close } = await context();
    const registry = createDefaultCommandRegistry();
    const result = await registry.execute("/permissions high", ctx);
    expect(result.text).toBe("Permissions: high");
    expect(result.json).toEqual({ autonomyLevel: "high" });
    close();
  });

  test("/compact delegates to active chat controller when available", async () => {
    const { ctx, close } = await context();
    ctx.compactSession = async () => ({ text: "compacted", json: { ok: true } });
    const registry = createDefaultCommandRegistry();
    const result = await registry.execute("/compact", ctx);
    expect(result.text).toBe("compacted");
    expect(result.json).toEqual({ ok: true });
    close();
  });

  test("/checkpoint and /undo route through checkpoint hooks", async () => {
    const { ctx, close } = await context();
    ctx.checkpointSave = async (name) => `sha-123${name ? ` (${name})` : ""}`;
    ctx.checkpointRestoreLatest = async () => "Restored sha-123; verified=true";
    const registry = createDefaultCommandRegistry();
    expect((await registry.execute("/checkpoint baseline", ctx)).text).toBe(
      "Checkpoint saved: sha-123 (baseline)",
    );
    expect((await registry.execute("/undo", ctx)).text).toBe("Restored sha-123; verified=true");
    close();
  });

  test("/resume parses deterministic divergence modes", async () => {
    const { ctx, close } = await context();
    const seen: Array<{ sessionId: string; mode: string }> = [];
    ctx.resumeSession = async (sessionId, mode) => {
      seen.push({ sessionId, mode });
      return { text: `${sessionId}:${mode}` };
    };
    const registry = createDefaultCommandRegistry();
    expect((await registry.execute("/resume s_1", ctx)).text).toBe("s_1:auto");
    expect((await registry.execute("/resume s_1 --continue-current", ctx)).text).toBe(
      "s_1:continue-current",
    );
    expect((await registry.execute("/resume s_1 --restore-checkpoint", ctx)).text).toBe(
      "s_1:restore-checkpoint",
    );
    expect((await registry.execute("/resume s_1 --abort", ctx)).text).toBe("s_1:abort");
    expect(seen).toHaveLength(4);
    close();
  });

  test("/model and /effort route changes through controller hooks", async () => {
    const { ctx, close } = await context();
    ctx.switchPreset = async (presetId) => ({ text: `switched:${presetId}` });
    ctx.setEffort = (effort) => ({ text: `effort:${effort}` });
    const registry = createDefaultCommandRegistry();
    expect((await registry.execute("/model chat-gpt54", ctx)).text).toBe("switched:chat-gpt54");
    expect((await registry.execute("/effort xhigh", ctx)).text).toBe("effort:xhigh");
    close();
  });
});
