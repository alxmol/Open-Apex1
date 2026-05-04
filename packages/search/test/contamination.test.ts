import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
  applyContaminationBlocklist,
  loadContaminationBlocklist,
  __resetContaminationCacheForTest,
  type ContaminationBlocklist,
} from "../src/contamination.ts";
import type { SearchResult } from "../src/types.ts";

function result(partial: Partial<SearchResult>): SearchResult {
  return {
    query: "test",
    url: "https://example.com/",
    title: "Example",
    snippet: "An example.",
    fetchStatus: "ok",
    rankScore: 0.5,
    sourceTier: "other",
    provenance: { provider: "serper", fetchedAt: new Date().toISOString() },
    ...partial,
  };
}

let blocklist: ContaminationBlocklist;

beforeEach(async () => {
  __resetContaminationCacheForTest();
  blocklist = await loadContaminationBlocklist();
});

describe("loadContaminationBlocklist (§7.6.4)", () => {
  test("loads all required fields and 89 TB2 task ids", async () => {
    expect(blocklist.schema_version).toBe("1");
    expect(blocklist.denied_task_ids).toHaveLength(89);
    expect(blocklist.denied_task_ids).toContain("fix-git");
    expect(blocklist.denied_task_ids).toContain("hf-model-inference");
    expect(blocklist.denied_domains).toContain("tbench.ai");
  });
  test("is cached per-process", async () => {
    const a = await loadContaminationBlocklist();
    const b = await loadContaminationBlocklist();
    expect(a).toBe(b);
  });

  test("loads from OPEN_APEX_CONTAMINATION_BLOCKLIST before bundled path", async () => {
    const oldExplicit = process.env.OPEN_APEX_CONTAMINATION_BLOCKLIST;
    const oldConfigDir = process.env.OPEN_APEX_CONFIG_DIR;
    const dir = mkdtempSync(path.join(tmpdir(), "openapex-blocklist-"));
    const file = path.join(dir, "custom.json");
    writeFileSync(file, JSON.stringify({ ...blocklist, denied_task_ids: ["custom-task"] }));
    try {
      process.env.OPEN_APEX_CONTAMINATION_BLOCKLIST = file;
      delete process.env.OPEN_APEX_CONFIG_DIR;
      __resetContaminationCacheForTest();
      const loaded = await loadContaminationBlocklist();
      expect(loaded.denied_task_ids).toEqual(["custom-task"]);
    } finally {
      if (oldExplicit === undefined) delete process.env.OPEN_APEX_CONTAMINATION_BLOCKLIST;
      else process.env.OPEN_APEX_CONTAMINATION_BLOCKLIST = oldExplicit;
      if (oldConfigDir === undefined) delete process.env.OPEN_APEX_CONFIG_DIR;
      else process.env.OPEN_APEX_CONFIG_DIR = oldConfigDir;
      __resetContaminationCacheForTest();
    }
  });

  test("loads from OPEN_APEX_CONFIG_DIR/contamination-blocklist.v1.json", async () => {
    const oldExplicit = process.env.OPEN_APEX_CONTAMINATION_BLOCKLIST;
    const oldConfigDir = process.env.OPEN_APEX_CONFIG_DIR;
    const dir = mkdtempSync(path.join(tmpdir(), "openapex-config-"));
    writeFileSync(
      path.join(dir, "contamination-blocklist.v1.json"),
      JSON.stringify({ ...blocklist, denied_domains: ["blocked.example"] }),
    );
    try {
      delete process.env.OPEN_APEX_CONTAMINATION_BLOCKLIST;
      process.env.OPEN_APEX_CONFIG_DIR = dir;
      __resetContaminationCacheForTest();
      const loaded = await loadContaminationBlocklist();
      expect(loaded.denied_domains).toEqual(["blocked.example"]);
    } finally {
      if (oldExplicit === undefined) delete process.env.OPEN_APEX_CONTAMINATION_BLOCKLIST;
      else process.env.OPEN_APEX_CONTAMINATION_BLOCKLIST = oldExplicit;
      if (oldConfigDir === undefined) delete process.env.OPEN_APEX_CONFIG_DIR;
      else process.env.OPEN_APEX_CONFIG_DIR = oldConfigDir;
      __resetContaminationCacheForTest();
    }
  });
});

describe("applyContaminationBlocklist", () => {
  test("dev mode passes through untouched", () => {
    const input = [result({ url: "https://tbench.ai/leaderboard/terminal-bench/2.0" })];
    const outcome = applyContaminationBlocklist(input, { blocklist, mode: "dev" });
    expect(outcome.kept).toHaveLength(1);
    expect(outcome.removed).toHaveLength(0);
  });

  test("blocks denied domain in benchmark mode", () => {
    const input = [result({ url: "https://www.tbench.ai/leaderboard/terminal-bench/2.0" })];
    const outcome = applyContaminationBlocklist(input, { blocklist, mode: "benchmark" });
    expect(outcome.kept).toHaveLength(0);
    expect(outcome.removed[0]!.reason).toMatch(/^denied_domain:/);
  });

  test("blocks denied URL substring (laude-institute repo)", () => {
    const input = [
      result({
        url: "https://github.com/laude-institute/terminal-bench/blob/main/README.md",
      }),
    ];
    const outcome = applyContaminationBlocklist(input, { blocklist, mode: "benchmark" });
    expect(outcome.removed[0]!.reason).toMatch(/^denied_url_substring:/);
  });

  test("blocks denied title substring", () => {
    const input = [
      result({
        url: "https://random.blog/post",
        title: "My Terminal-Bench solution writeup",
      }),
    ];
    const outcome = applyContaminationBlocklist(input, { blocklist, mode: "benchmark" });
    expect(outcome.removed[0]!.reason).toMatch(/^denied_title_substring:/);
  });

  test("blocks a snippet that mentions a specific TB2 task id", () => {
    const input = [
      result({
        url: "https://blog.example.com/p/1",
        title: "Solving this puzzle",
        snippet: "Here's how I solved hf-model-inference last week.",
      }),
    ];
    const outcome = applyContaminationBlocklist(input, { blocklist, mode: "benchmark" });
    expect(outcome.removed[0]!.reason).toMatch(/^denied_task_id:hf-model-inference/);
  });

  test("task-id matching is word-boundary safe (avoids false positives on substrings)", () => {
    // `build-pmars` must not match in `prebuild-pmars-style` or `build-pmars2` unrelated words.
    const input = [
      result({
        url: "https://blog.example.com/p/2",
        title: "unrelated",
        snippet: "prebuildpmarsextra context with no dashes",
      }),
    ];
    const outcome = applyContaminationBlocklist(input, { blocklist, mode: "benchmark" });
    expect(outcome.kept).toHaveLength(1);
  });

  test("unrelated results survive the filter", () => {
    const input = [
      result({
        url: "https://docs.python.org/3/library/asyncio.html",
        title: "asyncio — Asynchronous I/O",
        snippet: "asyncio is a library to write concurrent code...",
      }),
    ];
    const outcome = applyContaminationBlocklist(input, { blocklist, mode: "benchmark" });
    expect(outcome.kept).toHaveLength(1);
    expect(outcome.removed).toHaveLength(0);
  });
});
