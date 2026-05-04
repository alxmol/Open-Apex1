import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import type { OpenApexEvent, SummaryJson } from "@open-apex/core";

import { FileSystemTelemetrySink } from "../src/sink.ts";

function tmp(): string {
  return mkdtempSync(path.join(tmpdir(), "openapex-sink-"));
}

describe("FileSystemTelemetrySink (§5.5 incremental flush)", () => {
  test("creates bundle directory structure per §3.4.10", async () => {
    const dir = tmp();
    const s = new FileSystemTelemetrySink({ outputDir: dir });
    const ev: OpenApexEvent = {
      type: "tool_event",
      seq: 0,
      ts: "2026-04-19T00:00:00Z",
      session_id: "s",
      tool: "read_file",
      call_id: "c1",
      action: "start",
    };
    await s.emit(ev);
    await s.close();
    expect(Bun.file(path.join(dir, "events.jsonl")).size).toBeGreaterThan(0);
    expect(Bun.file(path.join(dir, "checkpoints/manifest")).size).toBeDefined();
  });

  test("events.jsonl is valid JSONL with monotonic seq", async () => {
    const dir = tmp();
    const s = new FileSystemTelemetrySink({ outputDir: dir, redactOnWrite: false });
    const make = (i: number): OpenApexEvent => ({
      type: "tool_event",
      seq: 0, // will be assigned
      ts: `2026-04-19T00:00:0${i}Z`,
      session_id: "s",
      tool: "read_file",
      call_id: `c${i}`,
      action: "end",
      status: "ok",
    });
    for (let i = 0; i < 3; i++) await s.emit(make(i));
    await s.close();
    const lines = readFileSync(path.join(dir, "events.jsonl"), "utf8").trim().split("\n");
    expect(lines.length).toBe(3);
    const parsed = lines.map((l) => JSON.parse(l));
    expect(parsed.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  test("incremental flush: events on disk before close", async () => {
    const dir = tmp();
    const s = new FileSystemTelemetrySink({ outputDir: dir, redactOnWrite: false });
    await s.emit({
      type: "usage",
      seq: 0,
      ts: "2026-04-19T00:00:00Z",
      session_id: "s",
      provider: "openai",
      model: "gpt-5.4",
      usage: { inputTokens: 10, outputTokens: 3 },
      cost_usd: 0.001,
    });
    // Read BEFORE close.
    expect(Bun.file(path.join(dir, "events.jsonl")).size).toBeGreaterThan(0);
    await s.close();
  });

  test("pinned §3.4.10 log subpaths exist after first event (orchestrator.log, provider.log, tools/)", async () => {
    const dir = tmp();
    const s = new FileSystemTelemetrySink({ outputDir: dir, redactOnWrite: false });
    await s.emit({
      type: "tool_event",
      seq: 0,
      ts: "2026-04-19T00:00:00Z",
      session_id: "s",
      tool: "read_file",
      call_id: "c1",
      action: "start",
    });
    await s.close();
    expect(existsSync(path.join(dir, "logs", "orchestrator.log"))).toBe(true);
    expect(existsSync(path.join(dir, "logs", "provider.log"))).toBe(true);
    expect(existsSync(path.join(dir, "logs", "tools"))).toBe(true);
  });

  test("appendOrchestratorLog and appendProviderLog redact secrets by default", async () => {
    const dir = tmp();
    const s = new FileSystemTelemetrySink({ outputDir: dir });
    const openAiPrefix = ["sk", "proj"].join("-");
    await s.appendOrchestratorLog("start: OPENAI_API_KEY=" + openAiPrefix + "-" + "A".repeat(30));
    await s.appendProviderLog(
      "POST /v1/responses Authorization: Bearer " + openAiPrefix + "-" + "B".repeat(30),
    );
    await s.close();
    const orch = readFileSync(path.join(dir, "logs", "orchestrator.log"), "utf8");
    const prov = readFileSync(path.join(dir, "logs", "provider.log"), "utf8");
    expect(orch).toContain("<REDACTED:openai>");
    expect(prov).toContain("<REDACTED:openai>");
    expect(orch).not.toContain(["sk", "proj", "AAA"].join("-"));
    expect(prov).not.toContain(["sk", "proj", "BBB"].join("-"));
  });

  test("summary.json + replay.md + ATIF redact secrets in user-supplied strings", async () => {
    const dir = tmp();
    const s = new FileSystemTelemetrySink({ outputDir: dir });
    const summary: SummaryJson = {
      schema_version: "open-apex-summary.v1",
      run_id: "r1",
      status: "success",
      duration_sec: 10,
      tools_used: {},
      permissions: {
        auto_allow: 0,
        auto_deny: 0,
        prompt_allow: 0,
        prompt_deny: 0,
        sandboxed: 0,
      },
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cached_tokens: 0,
        cost_usd: 0,
      },
      checkpoints: 0,
      // Secret slipped into the final summary text — must be redacted.
      final_summary: "done. key=" + ["sk", "proj", "abcdefghijklmnopqrstuvwxyz"].join("-"),
    };
    const p = await s.writeSummary(summary);
    const text = await Bun.file(p).text();
    expect(text).toContain("<REDACTED:openai>");
    expect(text).not.toContain(["sk", "proj", "abcdefghijklmnopqrstuvwxyz"].join("-"));
    await s.close();
  });
});
