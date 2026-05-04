import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import type { AtifTrajectory } from "@open-apex/core";

import { AtifWriter, validateAtifTrajectory } from "../src/atif-writer.ts";

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), "openapex-atif-"));
}

describe("AtifWriter invariants (§3.4.6)", () => {
  test("assigns sequential step_ids automatically", () => {
    const dir = tmp();
    const w = new AtifWriter({
      sessionId: "s1",
      agent: { name: "open-apex", version: "0.0.1" },
      outputPath: path.join(dir, "trajectory.json"),
      redactOnWrite: false,
    });
    w.appendStep({ source: "user", message: "first" });
    w.appendStep({ source: "agent", message: "second" });
    const t = w.buildTrajectory();
    expect(t.steps.map((s) => s.step_id)).toEqual([1, 2]);
  });

  test("rejects out-of-order step_id", () => {
    const w = new AtifWriter({
      sessionId: "s1",
      agent: { name: "open-apex", version: "0.0.1" },
      outputPath: "/tmp/nope",
    });
    expect(() => w.appendStep({ step_id: 5, source: "user", message: "bad" })).toThrow(/step_id/);
  });

  test("rejects agent-only fields on non-agent steps", () => {
    const w = new AtifWriter({
      sessionId: "s1",
      agent: { name: "open-apex", version: "0.0.1" },
      outputPath: "/tmp/nope",
    });
    expect(() =>
      w.appendStep({
        source: "user",
        message: "hi",
        model_name: "gpt-5.4",
      } as any),
    ).toThrow(/agent-only/);
  });

  test("writes a valid JSON file and validates clean", async () => {
    const dir = tmp();
    const outPath = path.join(dir, "trajectory.json");
    const w = new AtifWriter({
      sessionId: "s_roundtrip",
      agent: { name: "open-apex", version: "0.0.1" },
      outputPath: outPath,
      redactOnWrite: false,
    });
    w.appendStep({ source: "user", message: "ping" });
    w.appendStep({
      source: "agent",
      model_name: "claude-opus-4-6",
      message: "pong",
      metrics: { prompt_tokens: 3, completion_tokens: 1 },
    });
    w.setFinalMetrics({
      total_prompt_tokens: 3,
      total_completion_tokens: 1,
      total_steps: 2,
    });
    const p = await w.flush();
    const t = (await Bun.file(p).json()) as AtifTrajectory;
    expect(t.schema_version).toBe("ATIF-v1.6");
    expect(validateAtifTrajectory(t)).toEqual([]);
  });

  test("redaction applied at write time by default", async () => {
    const dir = tmp();
    const outPath = path.join(dir, "trajectory.json");
    const w = new AtifWriter({
      sessionId: "s_secret",
      agent: { name: "open-apex", version: "0.0.1" },
      outputPath: outPath,
    });
    // User message embeds a fake OpenAI-shape key.
    const key = ["sk", "proj", "abcdef0123456789abcdefghij"].join("-");
    w.appendStep({
      source: "user",
      message: `OPENAI_API_KEY=${key}`,
    });
    const p = await w.flush();
    const text = await Bun.file(p).text();
    expect(text).toContain("<REDACTED:openai>");
    expect(text).not.toContain(["sk", "proj", "abcdef"].join("-"));
  });

  test("partial: true writes sentinel step when empty (Harbor timeout path)", async () => {
    const dir = tmp();
    const outPath = path.join(dir, "trajectory.json");
    const w = new AtifWriter({
      sessionId: "s_partial",
      agent: { name: "open-apex", version: "0.0.1" },
      outputPath: outPath,
      redactOnWrite: false,
    });
    const p = await w.flush({ partial: true });
    const t = (await Bun.file(p).json()) as AtifTrajectory;
    expect(t.steps.length).toBe(1);
    expect(t.extra?.partial).toBe(true);
  });

  test("markPending writes a pending-only trajectory before any appendStep (turn-start breadcrumb)", async () => {
    const dir = tmp();
    const outPath = path.join(dir, "trajectory.json");
    const w = new AtifWriter({
      sessionId: "s_pending",
      agent: { name: "open-apex", version: "0.0.1" },
      outputPath: outPath,
      redactOnWrite: false,
    });
    // No appendStep — just a pending marker.
    w.markPending("turn 1 started; awaiting model response from gpt-5.4");
    await new Promise((r) => setTimeout(r, 30));

    expect(await Bun.file(outPath).exists()).toBe(true);
    const t = (await Bun.file(outPath).json()) as AtifTrajectory;
    // A sentinel step must exist so Harbor's validator accepts the file.
    expect(t.steps.length).toBe(1);
    expect(t.steps[0]!.source).toBe("system");
    expect((t.steps[0]!.message as string).toLowerCase()).toContain("awaiting");
    expect(t.extra?.partial).toBe(true);
    expect(t.extra?.pending_step).toBeDefined();
    const pending = t.extra?.pending_step as { label: string; since: string };
    expect(pending.label).toContain("turn 1 started");
    expect(typeof pending.since).toBe("string");
  });

  test("appendStep supersedes the pending marker; final flush has no pending or partial", async () => {
    const dir = tmp();
    const outPath = path.join(dir, "trajectory.json");
    const w = new AtifWriter({
      sessionId: "s_super",
      agent: { name: "open-apex", version: "0.0.1" },
      outputPath: outPath,
      redactOnWrite: false,
    });
    w.markPending("turn 1 awaiting response");
    await new Promise((r) => setTimeout(r, 20));

    w.appendStep({ source: "user", message: "hello" });
    w.appendStep({
      source: "agent",
      model_name: "gpt-5.4",
      message: "hi back",
    });
    await new Promise((r) => setTimeout(r, 20));

    const partial = (await Bun.file(outPath).json()) as AtifTrajectory;
    expect(partial.steps.length).toBe(2);
    expect(partial.extra?.pending_step).toBeUndefined();
    expect(partial.extra?.partial).toBe(true);

    await w.flush();
    const finalTraj = (await Bun.file(outPath).json()) as AtifTrajectory;
    expect(finalTraj.steps.length).toBe(2);
    expect(finalTraj.extra?.partial).toBeUndefined();
    expect(finalTraj.extra?.pending_step).toBeUndefined();
  });

  test("clearPending() drops the marker without any appendStep", async () => {
    const dir = tmp();
    const outPath = path.join(dir, "trajectory.json");
    const w = new AtifWriter({
      sessionId: "s_clear",
      agent: { name: "open-apex", version: "0.0.1" },
      outputPath: outPath,
      redactOnWrite: false,
    });
    w.markPending("turn 1 awaiting response");
    await new Promise((r) => setTimeout(r, 10));
    w.clearPending();
    // Need at least one step to build a final trajectory for comparison.
    w.appendStep({ source: "user", message: "hi" });
    await new Promise((r) => setTimeout(r, 20));
    const t = (await Bun.file(outPath).json()) as AtifTrajectory;
    expect(t.extra?.pending_step).toBeUndefined();
  });

  test("incremental flush: trajectory.json exists and grows after every appendStep", async () => {
    const dir = tmp();
    const outPath = path.join(dir, "trajectory.json");
    const w = new AtifWriter({
      sessionId: "s_incr",
      agent: { name: "open-apex", version: "0.0.1" },
      outputPath: outPath,
      redactOnWrite: false,
    });
    // After step 1, file should exist on disk.
    w.appendStep({ source: "user", message: "first" });
    // Yield to let the best-effort async write land.
    await new Promise((r) => setTimeout(r, 30));
    expect(await Bun.file(outPath).exists()).toBe(true);
    const t1 = (await Bun.file(outPath).json()) as AtifTrajectory;
    expect(t1.steps.length).toBe(1);
    expect(t1.extra?.partial).toBe(true);

    w.appendStep({ source: "agent", model_name: "gpt-5.4", message: "second" });
    await new Promise((r) => setTimeout(r, 30));
    const t2 = (await Bun.file(outPath).json()) as AtifTrajectory;
    expect(t2.steps.length).toBe(2);
    expect(t2.extra?.partial).toBe(true);

    // Final flush clears the partial marker.
    await w.flush();
    const t3 = (await Bun.file(outPath).json()) as AtifTrajectory;
    expect(t3.steps.length).toBe(2);
    expect(t3.extra?.partial).toBeUndefined();
  });
});

describe("validateAtifTrajectory (§3.4.6 invariants)", () => {
  test("golden fixture validates clean", async () => {
    const p = new URL("./golden/trajectory-minimal.json", import.meta.url).pathname;
    const t = (await Bun.file(p).json()) as AtifTrajectory;
    expect(validateAtifTrajectory(t)).toEqual([]);
  });

  test("out-of-order step_ids flagged", () => {
    const t: AtifTrajectory = {
      schema_version: "ATIF-v1.6",
      session_id: "s",
      agent: { name: "open-apex", version: "0.0.1" },
      steps: [
        { step_id: 1, source: "user", message: "a" },
        { step_id: 3, source: "agent", message: "b" }, // gap
      ],
    };
    const errs = validateAtifTrajectory(t);
    expect(errs.some((e) => e.path === "steps[1].step_id")).toBe(true);
  });

  test("agent-only field on non-agent step flagged", () => {
    const t: AtifTrajectory = {
      schema_version: "ATIF-v1.6",
      session_id: "s",
      agent: { name: "open-apex", version: "0.0.1" },
      steps: [
        {
          step_id: 1,
          source: "user",
          message: "a",
          model_name: "gpt-5.4",
        } as any,
      ],
    };
    const errs = validateAtifTrajectory(t);
    expect(errs.some((e) => e.path === "steps[0].model_name")).toBe(true);
  });
});
