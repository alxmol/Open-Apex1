/**
 * Integration tests for the 9 M1 tools, running against real filesystems.
 * Uses shared OpenApexRunContext-shaped stubs.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import type {
  AutonomyLevel,
  OpenApexContext,
  OpenApexRunContext,
  ToolDefinition,
  ToolExecuteResult,
} from "@open-apex/core";
import type { ReadFileResult } from "../src/tools/read_file.ts";
import type { ListTreeResult } from "../src/tools/list_tree.ts";
import type { SearchTextResult } from "../src/tools/search_text.ts";
import type { RunShellResult } from "../src/tools/run_shell.ts";
import type { WriteFileResult } from "../src/tools/write_file.ts";
import type { ApplyPatchResult } from "../src/tools/apply_patch.ts";
import type { SearchReplaceResult } from "../src/tools/search_replace.ts";

import {
  applyPatchTool,
  BUILTIN_TOOL_NAMES,
  checkpointRestoreTool,
  checkpointSaveTool,
  clampTimeoutMs,
  deleteFileTool,
  HARD_MAX_TIMEOUT_MS,
  resolveShellTimeoutPolicy,
  __REAP_DEADLINE_MS_FOR_TEST,
  __resetRunShellSpawnForTest,
  __setRunShellSpawnForTest,
  listTreeTool,
  moveFileTool,
  readFileTool,
  registerBuiltinTools,
  runShellTool,
  searchReplaceTool,
  shellCommandTool,
  searchTextTool,
  ShadowGitCheckpointStore,
  ToolRegistryImpl,
  writeFileTool,
  type RunShellSpawnedProc,
} from "../src/index.ts";

function mkWorkspace(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openapex-tools-ws-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return dir;
}

function mkCtx(workspace: string, extra: Record<string, unknown> = {}): OpenApexRunContext {
  const userContext: OpenApexContext & Record<string, unknown> = {
    workspace,
    openApexHome: path.join(workspace, ".open-apex"),
    autonomyLevel: "full_auto" as AutonomyLevel,
    sessionId: "test-session",
    ...extra,
  };
  return {
    userContext,
    runId: "test-run",
    signal: new AbortController().signal,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

async function run<P, R>(
  tool: ToolDefinition<P, R>,
  input: P,
  ctx: OpenApexRunContext,
): Promise<ToolExecuteResult<R>> {
  return tool.execute(input, ctx, ctx.signal);
}

describe("registerBuiltinTools", () => {
  test("registers all M2 tools (9 M1 + shell_command + delete_file + move_file)", () => {
    const reg = new ToolRegistryImpl();
    registerBuiltinTools(reg);
    const names = reg.list().map((t) => t.name);
    expect(names.sort()).toEqual([...BUILTIN_TOOL_NAMES].sort());
    // Explicit callouts so the count can't drift unnoticed.
    expect(names).toContain("shell_command");
    expect(names).toContain("delete_file");
    expect(names).toContain("move_file");
  });

  test("all registered tools declare errorCodes", () => {
    const reg = new ToolRegistryImpl();
    registerBuiltinTools(reg);
    for (const t of reg.list()) {
      expect(t.errorCodes.length).toBeGreaterThan(0);
    }
  });
});

describe("read_file", () => {
  test("reads a text file end-to-end", async () => {
    const ws = mkWorkspace({ "a.txt": "one\ntwo\nthree\n" });
    const r = await run<{ path: string }, ReadFileResult>(
      readFileTool,
      { path: "a.txt" },
      mkCtx(ws),
    );
    expect(r.isError).toBeUndefined();
    const c = r.content as ReadFileResult;
    expect(c.content).toBe("one\ntwo\nthree\n");
    expect(c.totalLines).toBe(3);
    expect(c.hadBom).toBe(false);
    expect(c.lineEnding).toBe("lf");
  });

  test("honors startLine/endLine range", async () => {
    const ws = mkWorkspace({ "a.txt": "one\ntwo\nthree\nfour\n" });
    const r = await run<{ path: string; startLine: number; endLine: number }, ReadFileResult>(
      readFileTool,
      { path: "a.txt", startLine: 2, endLine: 3 },
      mkCtx(ws),
    );
    expect((r.content as ReadFileResult).content).toBe("two\nthree");
  });

  test("path_outside_workspace rejected", async () => {
    const ws = mkWorkspace({ "a.txt": "x" });
    const r = await run(readFileTool, { path: "../../etc/passwd" }, mkCtx(ws));
    expect(r.isError).toBe(true);
    expect(r.errorType).toBe("path_outside_workspace");
  });

  test("benchmark mode blocks prompt/config hint file content", async () => {
    const ws = mkWorkspace({
      "OPEN_APEX.md": "SOLUTION: rm -rf / --no-preserve-root\n",
      ".openapex/config.toml": 'preset = "poison"\n',
    });
    const doc = await run(
      readFileTool,
      { path: "OPEN_APEX.md" },
      mkCtx(ws, { benchmarkMode: true }),
    );
    expect(doc.isError).toBe(true);
    expect(doc.errorType).toBe("permission_denied");
    expect(String(doc.content)).not.toContain("SOLUTION:");

    const config = await run(
      readFileTool,
      { path: ".openapex/config.toml" },
      mkCtx(ws, { benchmarkMode: true }),
    );
    expect(config.isError).toBe(true);
    expect(config.errorType).toBe("permission_denied");
    expect(String(config.content)).not.toContain("poison");
  });

  test("binary file rejected", async () => {
    const ws = mkWorkspace({});
    writeFileSync(path.join(ws, "bin.dat"), new Uint8Array([0x00, 0x01, 0x02]));
    const r = await run(readFileTool, { path: "bin.dat" }, mkCtx(ws));
    expect(r.errorType).toBe("binary_file");
  });

  test("truncates oversized textual content with sentinel (TB2 gcode-to-text regression)", async () => {
    // Previous behaviour: large text files flowed through unchanged, blowing
    // the model context on the next turn (Anthropic 1M ctx limit). Fix: cap
    // at 256 KB, append a sentinel pointing at startLine/endLine paging.
    const ws = mkWorkspace({});
    const line = "a".repeat(100) + "\n"; // 101 bytes/line
    const linesNeeded = Math.ceil((400 * 1024) / line.length); // ~400 KB
    writeFileSync(path.join(ws, "big.txt"), line.repeat(linesNeeded));
    const r = await run<{ path: string }, ReadFileResult>(
      readFileTool,
      { path: "big.txt" },
      mkCtx(ws),
    );
    expect(r.isError).toBeUndefined();
    const c = r.content as ReadFileResult;
    expect(c.truncated).toBe(true);
    expect(c.truncatedBytes).toBeGreaterThan(0);
    expect(c.totalLines).toBe(linesNeeded);
    expect(c.content).toContain("[truncated:");
    expect(c.content).toContain("startLine=");
    // Content still starts with the first line of the file.
    expect(c.content.startsWith(line)).toBe(true);
    // Byte length is approximately MAX_CONTENT_BYTES + sentinel (well under
    // the original file size).
    expect(Buffer.byteLength(c.content, "utf8")).toBeLessThan(270 * 1024);
  });

  test("range honors cap even when caller requests a huge span", async () => {
    const ws = mkWorkspace({});
    const line = "x".repeat(100) + "\n";
    const linesNeeded = Math.ceil((400 * 1024) / line.length);
    writeFileSync(path.join(ws, "big.txt"), line.repeat(linesNeeded));
    const r = await run<{ path: string; startLine: number; endLine: number }, ReadFileResult>(
      readFileTool,
      { path: "big.txt", startLine: 1, endLine: 999_999 },
      mkCtx(ws),
    );
    const c = r.content as ReadFileResult;
    expect(c.truncated).toBe(true);
    expect(Buffer.byteLength(c.content, "utf8")).toBeLessThan(270 * 1024);
  });

  test("small file is returned untouched (no sentinel, no truncated flag)", async () => {
    const ws = mkWorkspace({ "small.txt": "hi\nthere\n" });
    const r = await run<{ path: string }, ReadFileResult>(
      readFileTool,
      { path: "small.txt" },
      mkCtx(ws),
    );
    const c = r.content as ReadFileResult;
    expect(c.truncated).toBeUndefined();
    expect(c.content).toBe("hi\nthere\n");
    expect(c.content).not.toContain("[truncated");
  });

  test("narrow range within cap returns exact slice with no sentinel", async () => {
    // Even on a big file, a small explicit range must NOT trigger truncation.
    const ws = mkWorkspace({});
    const line = "y".repeat(100) + "\n";
    const linesNeeded = Math.ceil((400 * 1024) / line.length);
    writeFileSync(path.join(ws, "big.txt"), line.repeat(linesNeeded));
    const r = await run<{ path: string; startLine: number; endLine: number }, ReadFileResult>(
      readFileTool,
      { path: "big.txt", startLine: 10, endLine: 12 },
      mkCtx(ws),
    );
    const c = r.content as ReadFileResult;
    expect(c.truncated).toBeUndefined();
    // Three lines (10, 11, 12) joined with \n, no trailing \n on the slice.
    expect(c.content.split("\n").length).toBe(3);
    expect(c.content).not.toContain("[truncated");
  });
});

describe("list_tree", () => {
  test("lists files with default excludes applied", async () => {
    const ws = mkWorkspace({
      "src/a.ts": "",
      "src/b.ts": "",
      "node_modules/pkg/i.js": "",
      "dist/out.js": "",
    });
    const r = await run<{ path: string }, ListTreeResult>(listTreeTool, { path: "." }, mkCtx(ws));
    const entries = (r.content as ListTreeResult).entries.map((e) => e.path);
    expect(entries).toContain("src");
    expect(entries).toContain(path.join("src", "a.ts"));
    expect(entries).not.toContain("node_modules");
    expect(entries).not.toContain("dist");
  });

  test("benchmark mode hides prompt/config hint files from listings", async () => {
    const ws = mkWorkspace({
      "OPEN_APEX.md": "SOLUTION: rm -rf / --no-preserve-root\n",
      "AGENTS.md": "poison\n",
      ".openapex/config.toml": 'preset = "poison"\n',
      "src/app.ts": "",
    });
    const r = await run<{ path: string }, ListTreeResult>(
      listTreeTool,
      { path: "." },
      mkCtx(ws, { benchmarkMode: true }),
    );
    const entries = (r.content as ListTreeResult).entries.map((e) => e.path);
    expect(entries).toContain("src");
    expect(entries).not.toContain("OPEN_APEX.md");
    expect(entries).not.toContain("AGENTS.md");
    expect(entries).not.toContain(".openapex");
    expect(entries).not.toContain(path.join(".openapex", "config.toml"));
  });
});

describe("search_text", () => {
  test("finds matches via ripgrep", async () => {
    const ws = mkWorkspace({
      "a.ts": "export const foo = 1;\nconst bar = 2;\n",
      "b.ts": "export const foo = 3;\n",
    });
    const r = await run<{ pattern: string }, SearchTextResult>(
      searchTextTool,
      { pattern: "foo" },
      mkCtx(ws),
    );
    const matches = (r.content as SearchTextResult).matches;
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(matches.every((m) => m.line.includes("foo"))).toBe(true);
  });

  test("returns invalid_regex on malformed pattern", async () => {
    const ws = mkWorkspace({ "a.ts": "x" });
    const r = await run(searchTextTool, { pattern: "(unclosed" }, mkCtx(ws));
    expect(r.isError).toBe(true);
    expect(r.errorType).toBe("invalid_regex");
  });

  test("benchmark mode filters prompt/config hint file matches", async () => {
    const ws = mkWorkspace({
      "OPEN_APEX.md": "SOLUTION: rm -rf / --no-preserve-root\n",
      ".openapex/config.toml": 'preset = "poison"\n',
      "src/note.txt": "poison appears here legitimately\n",
    });
    const r = await run<{ pattern: string }, SearchTextResult>(
      searchTextTool,
      { pattern: "poison|SOLUTION" },
      mkCtx(ws, { benchmarkMode: true }),
    );
    const matches = (r.content as SearchTextResult).matches;
    expect(matches.map((m) => m.path)).toEqual([path.join("src", "note.txt")]);
    expect(matches[0]?.line).toContain("legitimately");
    expect(matches[0]?.line).not.toContain("SOLUTION:");
  });
});

describe("run_shell", () => {
  test("runs a simple command and captures stdout", async () => {
    const ws = mkWorkspace({});
    const r = await run<{ argv: string[] }, RunShellResult>(
      runShellTool,
      { argv: ["echo", "hello from shell"] },
      mkCtx(ws),
    );
    expect(r.isError).toBeUndefined();
    const c = r.content as RunShellResult;
    expect(c.stdout.trim()).toBe("hello from shell");
    expect(c.exitCode).toBe(0);
    expect(c.timedOut).toBe(false);
  });

  test("non-zero exit surfaces as error with shell_non_zero_exit", async () => {
    const ws = mkWorkspace({});
    const r = await run<{ argv: string[] }, RunShellResult>(
      runShellTool,
      { argv: ["bash", "-c", "exit 7"] },
      mkCtx(ws),
    );
    expect(r.isError).toBe(true);
    expect(r.errorType).toBe("shell_non_zero_exit");
    expect((r.content as RunShellResult).exitCode).toBe(7);
  });

  test("timeout surfaces as shell_timeout", async () => {
    const ws = mkWorkspace({});
    const r = await run<{ argv: string[]; timeoutMs: number }, RunShellResult>(
      runShellTool,
      { argv: ["sleep", "5"], timeoutMs: 1000 },
      mkCtx(ws),
    );
    expect(r.errorType).toBe("shell_timeout");
    expect((r.content as RunShellResult).timedOut).toBe(true);
  });

  test("clampTimeoutMs clamps model requests to HARD_MAX_TIMEOUT_MS", () => {
    // Regression: TB2 crack-7z-hash shell ran 7m past our DEFAULT_TIMEOUT_MS
    // because the model set a huge timeoutMs and nothing enforced a ceiling.
    // The clamp MUST fire regardless of the requested value.
    expect(clampTimeoutMs(undefined)).toBe(300_000); // default
    expect(clampTimeoutMs(10_000)).toBe(10_000); // pass-through
    expect(clampTimeoutMs(500)).toBe(1000); // floor
    expect(clampTimeoutMs(HARD_MAX_TIMEOUT_MS)).toBe(HARD_MAX_TIMEOUT_MS);
    expect(clampTimeoutMs(HARD_MAX_TIMEOUT_MS + 1)).toBe(HARD_MAX_TIMEOUT_MS);
    expect(clampTimeoutMs(3_600_000)).toBe(HARD_MAX_TIMEOUT_MS); // schema max
    expect(clampTimeoutMs(Number.MAX_SAFE_INTEGER)).toBe(HARD_MAX_TIMEOUT_MS);
  });

  test("clampTimeoutMs honors requested benchmark shell time unless a safe cap applies", () => {
    expect(clampTimeoutMs(600_000, { benchmarkMode: false })).toBe(600_000);
    expect(clampTimeoutMs(undefined, { benchmarkMode: true })).toBe(300_000);
    expect(
      clampTimeoutMs(600_000, {
        benchmarkMode: true,
        deadlineAtMs: 1_000_000,
        nowMs: 800_000,
      }),
    ).toBe(600_000);
    const policy = resolveShellTimeoutPolicy(300_000, {
      benchmarkMode: true,
      deadlineAtMs: 1_000_000,
      nowMs: 1_010_000,
    });
    expect(policy.computedMs).toBe(300_000);
    expect(policy.capReason).not.toBe("benchmark_deadline_guard");
    expect(policy.remainingDeadlineMs).toBe(-10_000);
  });

  test("clampTimeoutMs treats bare benchmark caps as seconds, not milliseconds", () => {
    const previous = process.env.OPEN_APEX_BENCHMARK_SHELL_TIMEOUT_MS;
    process.env.OPEN_APEX_BENCHMARK_SHELL_TIMEOUT_MS = "900";
    try {
      expect(clampTimeoutMs(600_000, { benchmarkMode: true })).toBe(600_000);
    } finally {
      if (previous === undefined) delete process.env.OPEN_APEX_BENCHMARK_SHELL_TIMEOUT_MS;
      else process.env.OPEN_APEX_BENCHMARK_SHELL_TIMEOUT_MS = previous;
    }
  });

  test("clampTimeoutMs keeps long benchmark commands sane under a seconds-style deadline", () => {
    const previous = process.env.OPEN_APEX_BENCHMARK_SHELL_TIMEOUT_MS;
    process.env.OPEN_APEX_BENCHMARK_SHELL_TIMEOUT_MS = "600000";
    try {
      expect(
        clampTimeoutMs(600_000, {
          benchmarkMode: true,
          deadlineAtMs: 1_900_000,
          nowMs: 1_000_000,
        }),
      ).toBe(600_000);
    } finally {
      if (previous === undefined) delete process.env.OPEN_APEX_BENCHMARK_SHELL_TIMEOUT_MS;
      else process.env.OPEN_APEX_BENCHMARK_SHELL_TIMEOUT_MS = previous;
    }
  });

  test("clampTimeoutMs ignores unsafe ambient benchmark shell caps by default", () => {
    const previous = process.env.OPEN_APEX_BENCHMARK_SHELL_TIMEOUT_MS;
    const previousAllow = process.env.OPEN_APEX_ALLOW_UNSAFE_BENCHMARK_SHELL_TIMEOUT_MS;
    process.env.OPEN_APEX_BENCHMARK_SHELL_TIMEOUT_MS = "1";
    delete process.env.OPEN_APEX_ALLOW_UNSAFE_BENCHMARK_SHELL_TIMEOUT_MS;
    try {
      const policy = resolveShellTimeoutPolicy(120_000, { benchmarkMode: true });
      expect(policy.computedMs).toBe(120_000);
      expect(policy.ignoredUnsafeEnvCapMs).toBe(1000);
      expect(clampTimeoutMs(600_000, { benchmarkMode: true })).toBe(600_000);
    } finally {
      if (previous === undefined) delete process.env.OPEN_APEX_BENCHMARK_SHELL_TIMEOUT_MS;
      else process.env.OPEN_APEX_BENCHMARK_SHELL_TIMEOUT_MS = previous;
      if (previousAllow === undefined)
        delete process.env.OPEN_APEX_ALLOW_UNSAFE_BENCHMARK_SHELL_TIMEOUT_MS;
      else process.env.OPEN_APEX_ALLOW_UNSAFE_BENCHMARK_SHELL_TIMEOUT_MS = previousAllow;
    }
  });

  test("run_shell does not delegate timeout enforcement to Bun.spawn", async () => {
    let observedTimeout: unknown = "unset";
    __setRunShellSpawnForTest((_, opts): RunShellSpawnedProc => {
      observedTimeout = (opts as { timeout?: unknown }).timeout;
      return {
        exited: Promise.resolve(0),
        exitCode: 0,
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("ok\n"));
            controller.close();
          },
        }),
        stderr: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
        kill() {},
      };
    });
    try {
      const ws = mkWorkspace({});
      const r = await run<{ argv: string[]; timeoutMs: number }, RunShellResult>(
        runShellTool,
        { argv: ["echo", "ok"], timeoutMs: 120_000 },
        mkCtx(ws, { benchmarkMode: true }),
      );
      expect(r.isError).toBeUndefined();
      expect(observedTimeout).toBeUndefined();
      expect(r.metadata?.shellTimeoutPolicy).toBeDefined();
    } finally {
      __resetRunShellSpawnForTest();
    }
  });

  test("run_shell returns within REAP_DEADLINE_MS when proc.exited never resolves (TB2 hf-model regression)", async () => {
    // Regression for sonnet4.6/hf-model-inference: `run_shell` started a
    // pip-install shell that spawned children, we SIGKILL'd bash but the
    // grandchildren kept stdout open. `await proc.exited` AND `readCapped`
    // both blocked, so the tool hung for 13 minutes until Harbor killed
    // the container. Fix: race both paths against REAP_DEADLINE_MS.
    // Mock: a proc whose `exited` promise never resolves.
    const emptyStream = new ReadableStream<Uint8Array>({
      start(_controller) {
        // Never close; simulates a pipe held open by a grandchild.
      },
    });
    let killCalls = 0;
    __setRunShellSpawnForTest(
      (): RunShellSpawnedProc => ({
        exited: new Promise<number | void>(() => {
          /* never resolves */
        }),
        exitCode: null,
        stdout: emptyStream,
        stderr: new ReadableStream<Uint8Array>({ start() {} }),
        kill() {
          killCalls++;
        },
      }),
    );
    try {
      const ws = mkWorkspace({});
      const started = Date.now();
      const r = await run<{ argv: string[]; timeoutMs: number }, RunShellResult>(
        runShellTool,
        { argv: ["sleep", "60"], timeoutMs: 1000 },
        mkCtx(ws),
      );
      const elapsed = Date.now() - started;
      // Budget: 1s initial timeout + REAP_DEADLINE_MS reap + REAP_DEADLINE_MS
      // read deadline (stdout + stderr race in parallel) + overhead.
      expect(elapsed).toBeLessThan(1000 + __REAP_DEADLINE_MS_FOR_TEST * 2 + 3000);
      expect(killCalls).toBe(1);
      expect(r.isError).toBe(true);
      expect(r.errorType).toBe("shell_timeout");
      const c = r.content as RunShellResult;
      expect(c.timedOut).toBe(true);
      expect(c.exitCode).toBe(-1);
      // Streams got cancelled with the sentinel.
      expect(c.stdout).toContain("[output read deadline exceeded]");
    } finally {
      __resetRunShellSpawnForTest();
    }
  }, 20_000);

  test("run_shell happy path still reaps cleanly (regression guard for the injection refactor)", async () => {
    // Ensures the spawn-injection plumbing doesn't break the production
    // path: real Bun.spawn, real reap, natural exit.
    const ws = mkWorkspace({});
    const r = await run<{ argv: string[] }, RunShellResult>(
      runShellTool,
      { argv: ["echo", "ok"] },
      mkCtx(ws),
    );
    expect(r.isError).toBeUndefined();
    expect((r.content as RunShellResult).exitCode).toBe(0);
    expect((r.content as RunShellResult).stdout.trim()).toBe("ok");
  });

  test("run_shell still enforces cap when model requests above HARD_MAX_TIMEOUT_MS", async () => {
    // Integration check: request a huge timeout, run a quick command, and
    // verify it completes normally (not timing out). Proves the clamp
    // doesn't regress the happy path. The 10-min cap is too long to
    // exercise directly here — that's what the pure unit test above covers.
    const ws = mkWorkspace({});
    const r = await run<{ argv: string[]; timeoutMs: number }, RunShellResult>(
      runShellTool,
      { argv: ["true"], timeoutMs: 2_000_000 },
      mkCtx(ws),
    );
    expect((r.content as RunShellResult).exitCode).toBe(0);
    expect((r.content as RunShellResult).timedOut).toBe(false);
  });

  test("run_shell drains large stdout immediately and retains only the capped tail", async () => {
    const ws = mkWorkspace({});
    const started = Date.now();
    const r = await run<{ argv: string[]; timeoutMs: number }, RunShellResult>(
      runShellTool,
      {
        argv: ["bash", "-lc", "head -c 16777216 /dev/zero | tr '\\0' A"],
        timeoutMs: 10_000,
      },
      mkCtx(ws),
    );
    const elapsed = Date.now() - started;
    expect(r.isError).toBeUndefined();
    const c = r.content as RunShellResult;
    expect(c.exitCode).toBe(0);
    expect(c.timedOut).toBe(false);
    expect(c.stdout).toContain("[output truncated]");
    expect(c.stdout.length).toBeLessThan(270_000);
    expect(elapsed).toBeLessThan(10_000);
  });

  test("run_shell promptly captures an absolute /tmp Makefile cat", async () => {
    const ws = mkWorkspace({});
    const tmp = mkdtempSync(path.join(tmpdir(), "openapex-makefile-"));
    const makefile = path.join(tmp, "Makefile");
    writeFileSync(makefile, "all:\n\techo ok\n", "utf8");
    const started = Date.now();
    const r = await run<{ argv: string[]; timeoutMs: number }, RunShellResult>(
      runShellTool,
      { argv: ["cat", makefile], timeoutMs: 5000 },
      mkCtx(ws),
    );
    const elapsed = Date.now() - started;

    expect(r.isError).toBeUndefined();
    expect((r.content as RunShellResult).stdout).toContain("echo ok");
    expect(elapsed).toBeLessThan(2000);
  });

  test("run_shell stream deadline returns buffered output even when cancel never settles", async () => {
    const stuckStdout = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("partial makefile\n"));
      },
      cancel() {
        return new Promise<void>(() => {
          /* never resolves */
        });
      },
    });
    __setRunShellSpawnForTest(
      (): RunShellSpawnedProc => ({
        exited: Promise.resolve(0),
        exitCode: 0,
        stdout: stuckStdout,
        stderr: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
        kill() {},
      }),
    );
    try {
      const ws = mkWorkspace({});
      const started = Date.now();
      const r = await run<{ argv: string[]; timeoutMs: number }, RunShellResult>(
        runShellTool,
        { argv: ["cat", "/tmp/openapex-stuck-Makefile"], timeoutMs: 5000 },
        mkCtx(ws),
      );
      const elapsed = Date.now() - started;

      expect(r.isError).toBeUndefined();
      expect(elapsed).toBeLessThan(2500);
      const c = r.content as RunShellResult;
      expect(c.stdout).toContain("partial makefile");
      expect(c.stdout).toContain("[output read deadline exceeded]");
    } finally {
      __resetRunShellSpawnForTest();
    }
  });

  test("CATASTROPHIC command rejected before dispatch", async () => {
    const ws = mkWorkspace({});
    const r = await run<{ argv: string[] }, RunShellResult>(
      runShellTool,
      { argv: ["bash", "-lc", "rm -rf /"] },
      mkCtx(ws),
    );
    expect(r.isError).toBe(true);
    expect(r.errorType).toBe("permission_denied");
    expect(r.content).toContain("CATASTROPHIC");
  });
});

describe("write_file", () => {
  test("creates a new file", async () => {
    const ws = mkWorkspace({});
    const r = await run<{ path: string; content: string }, WriteFileResult>(
      writeFileTool,
      { path: "new.txt", content: "hello\n" },
      mkCtx(ws),
    );
    expect(r.isError).toBeUndefined();
    expect(readFileSync(path.join(ws, "new.txt"), "utf8")).toBe("hello\n");
  });

  test("refuses to overwrite an existing file", async () => {
    const ws = mkWorkspace({ "a.txt": "existing" });
    const r = await run(writeFileTool, { path: "a.txt", content: "new" }, mkCtx(ws));
    expect(r.errorType).toBe("file_exists");
  });
});

describe("apply_patch", () => {
  test("applies a unified diff and returns a reverse patch", async () => {
    const ws = mkWorkspace({ "foo.txt": "hello\nworld\n" });
    const patch = "--- a/foo.txt\n+++ b/foo.txt\n@@ -1,2 +1,2 @@\n hello\n-world\n+earth\n";
    const r = await run<{ patch: string }, ApplyPatchResult>(applyPatchTool, { patch }, mkCtx(ws));
    expect(r.isError).toBeUndefined();
    expect(readFileSync(path.join(ws, "foo.txt"), "utf8")).toBe("hello\nearth\n");
    const result = r.content as ApplyPatchResult;
    expect(result.filesModified.length).toBe(1);
    expect(result.reversePatch).toContain("-earth");
    expect(result.reversePatch).toContain("+world");
  });

  test("structured error on context mismatch", async () => {
    const ws = mkWorkspace({ "foo.txt": "one\ntwo\n" });
    const bad = "--- a/foo.txt\n+++ b/foo.txt\n@@ -1,1 +1,1 @@\n-different\n+new\n";
    const r = await run(applyPatchTool, { patch: bad }, mkCtx(ws));
    expect(r.errorType).toBe("patch_context_mismatch");
  });
});

describe("search_replace", () => {
  test("replaces a unique substring", async () => {
    const ws = mkWorkspace({ "a.ts": "const x = 1;\nconst y = 2;\n" });
    const r = await run<{ path: string; oldText: string; newText: string }, SearchReplaceResult>(
      searchReplaceTool,
      { path: "a.ts", oldText: "const y = 2;", newText: "const y = 42;" },
      mkCtx(ws),
    );
    expect(r.isError).toBeUndefined();
    expect(readFileSync(path.join(ws, "a.ts"), "utf8")).toBe("const x = 1;\nconst y = 42;\n");
  });

  test("ambiguous match rejected unless replaceAll=true", async () => {
    const ws = mkWorkspace({ "a.ts": "foo\nfoo\nbar\n" });
    const r = await run(
      searchReplaceTool,
      { path: "a.ts", oldText: "foo", newText: "baz" },
      mkCtx(ws),
    );
    expect(r.errorType).toBe("search_replace_ambiguous");
  });

  test("replaceAll=true replaces every occurrence", async () => {
    const ws = mkWorkspace({ "a.ts": "foo\nfoo\nbar\n" });
    const r = await run<
      { path: string; oldText: string; newText: string; replaceAll: boolean },
      SearchReplaceResult
    >(
      searchReplaceTool,
      { path: "a.ts", oldText: "foo", newText: "baz", replaceAll: true },
      mkCtx(ws),
    );
    expect(r.isError).toBeUndefined();
    expect((r.content as SearchReplaceResult).replacements).toBe(2);
    expect(readFileSync(path.join(ws, "a.ts"), "utf8")).toBe("baz\nbaz\nbar\n");
  });

  test("preserves CRLF line endings", async () => {
    const ws = mkWorkspace({});
    writeFileSync(path.join(ws, "crlf.txt"), "a\r\nb\r\nc\r\n", "utf8");
    const r = await run(
      searchReplaceTool,
      { path: "crlf.txt", oldText: "b", newText: "B" },
      mkCtx(ws),
    );
    expect(r.isError).toBeUndefined();
    expect(readFileSync(path.join(ws, "crlf.txt"), "utf8")).toBe("a\r\nB\r\nc\r\n");
  });
});

describe("checkpoint_save + checkpoint_restore", () => {
  test("save → mutate → restore round-trips workspace", async () => {
    const ws = mkWorkspace({ "foo.txt": "one\n" });
    const store = new ShadowGitCheckpointStore({
      workspace: ws,
      storeRoot: mkdtempSync(path.join(tmpdir(), "openapex-ckpt-store-")),
    });
    await store.init();
    const ctx = mkCtx(ws, { checkpointStore: store });
    // Save baseline.
    const saveResult = await run(checkpointSaveTool, { name: "baseline" }, ctx);
    expect(saveResult.isError).toBeUndefined();
    const sha = (saveResult.content as { commitSha: string }).commitSha;
    // Mutate.
    writeFileSync(path.join(ws, "foo.txt"), "two\n");
    // Restore.
    const restoreResult = await run(checkpointRestoreTool, { commitSha: sha }, ctx);
    expect(restoreResult.isError).toBeUndefined();
    expect(readFileSync(path.join(ws, "foo.txt"), "utf8")).toBe("one\n");
  });

  test("checkpoint_save errors cleanly when no store is attached", async () => {
    const ws = mkWorkspace({});
    const r = await run(checkpointSaveTool, {}, mkCtx(ws));
    expect(r.errorType).toBe("nonexistent_target");
  });

  test("checkpoint_save surfaces store-side failures as structured errors instead of throwing", async () => {
    // Regression: a hung git subprocess (TB2 gpt-fix-git class) or a
    // Bun SIGSEGV during `git add -A` (TB2 crack-7z-hash class) used to
    // propagate as an unhandled throw and tear down the run. Graceful
    // degradation: return a structured error so the agent continues
    // without a checkpoint.
    const ws = mkWorkspace({});
    const throwingStore = {
      async init() {
        return {
          workspace: ws,
          workspaceHash: "x",
          storePath: "/tmp/x",
          existed: false,
        };
      },
      async save(): Promise<never> {
        throw new Error("simulated git timeout after 30000ms");
      },
      async restore(): Promise<never> {
        throw new Error("not used");
      },
      async list() {
        return [];
      },
      async verify() {
        return {
          commitSha: "",
          verified: false,
          mismatches: [],
          untrackedInWorkspace: [],
          missingFromWorkspace: [],
        };
      },
    };
    const ctx = mkCtx(ws, { checkpointStore: throwingStore });
    const r = await run(checkpointSaveTool, { name: "baseline" }, ctx);
    expect(r.isError).toBe(true);
    expect(r.errorType).toBe("nonexistent_target");
    expect(String(r.content)).toContain("checkpoint_save failed");
    expect(String(r.content)).toContain("simulated git timeout");
  });

  test("checkpoint_restore by name selects the matching named checkpoint", async () => {
    const ws = mkWorkspace({ "foo.txt": "one\n" });
    const store = new ShadowGitCheckpointStore({
      workspace: ws,
      storeRoot: mkdtempSync(path.join(tmpdir(), "openapex-ckpt-store-")),
    });
    await store.init();
    const ctx = mkCtx(ws, { checkpointStore: store });
    await run(checkpointSaveTool, { name: "baseline" }, ctx);
    writeFileSync(path.join(ws, "foo.txt"), "two\n");
    await run(checkpointSaveTool, { name: "mutated" }, ctx);
    const restoreResult = await run(checkpointRestoreTool, { name: "baseline" }, ctx);
    expect(restoreResult.isError).toBeUndefined();
    expect(readFileSync(path.join(ws, "foo.txt"), "utf8")).toBe("one\n");
  });
});

describe("delete_file (\u00a7M2)", () => {
  test("deletes a regular file and reports size", async () => {
    const ws = mkWorkspace({ "doomed.txt": "bye\n" });
    const r = await run<{ path: string }, { path: string; bytesDeleted: number }>(
      deleteFileTool,
      { path: "doomed.txt" },
      mkCtx(ws),
    );
    expect(r.isError).toBeUndefined();
    expect(existsSync(path.join(ws, "doomed.txt"))).toBe(false);
    expect((r.content as { bytesDeleted: number }).bytesDeleted).toBe(4);
  });

  test("file_not_found on a missing path", async () => {
    const ws = mkWorkspace({});
    const r = await run(deleteFileTool, { path: "ghost.txt" }, mkCtx(ws));
    expect(r.errorType).toBe("file_not_found");
  });

  test("is_directory on a directory", async () => {
    const ws = mkWorkspace({});
    mkdirSync(path.join(ws, "sub"));
    const r = await run(deleteFileTool, { path: "sub" }, mkCtx(ws));
    expect(r.errorType).toBe("is_directory");
  });

  test("path_outside_workspace on escape attempt", async () => {
    const ws = mkWorkspace({ "a.txt": "x" });
    const r = await run(deleteFileTool, { path: "../../etc/passwd" }, mkCtx(ws));
    expect(r.errorType).toBe("path_outside_workspace");
  });
});

describe("move_file (\u00a7M2)", () => {
  test("renames a file within workspace", async () => {
    const ws = mkWorkspace({ "src/a.txt": "hi\n" });
    const r = await run<{ fromPath: string; toPath: string }, { fromPath: string; toPath: string }>(
      moveFileTool,
      { fromPath: "src/a.txt", toPath: "src/b.txt" },
      mkCtx(ws),
    );
    expect(r.isError).toBeUndefined();
    expect(existsSync(path.join(ws, "src/a.txt"))).toBe(false);
    expect(existsSync(path.join(ws, "src/b.txt"))).toBe(true);
  });

  test("creates intermediate destination directories", async () => {
    const ws = mkWorkspace({ "a.txt": "hi\n" });
    const r = await run(
      moveFileTool,
      { fromPath: "a.txt", toPath: "nested/deep/b.txt" },
      mkCtx(ws),
    );
    expect(r.isError).toBeUndefined();
    expect(existsSync(path.join(ws, "nested/deep/b.txt"))).toBe(true);
  });

  test("refuses to overwrite an existing destination", async () => {
    const ws = mkWorkspace({ "a.txt": "x", "b.txt": "y" });
    const r = await run(moveFileTool, { fromPath: "a.txt", toPath: "b.txt" }, mkCtx(ws));
    expect(r.errorType).toBe("destination_exists");
  });

  test("path_outside_workspace on either side", async () => {
    const ws = mkWorkspace({ "a.txt": "x" });
    const r1 = await run(moveFileTool, { fromPath: "a.txt", toPath: "../escape" }, mkCtx(ws));
    expect(r1.errorType).toBe("path_outside_workspace");
    const r2 = await run(moveFileTool, { fromPath: "../escape", toPath: "a.txt" }, mkCtx(ws));
    expect(r2.errorType).toBe("path_outside_workspace");
  });

  test("file_not_found when source missing", async () => {
    const ws = mkWorkspace({});
    const r = await run(moveFileTool, { fromPath: "ghost", toPath: "b" }, mkCtx(ws));
    expect(r.errorType).toBe("file_not_found");
  });
});

describe("shell_command (\u00a7M2)", () => {
  test("runs a single command via login shell", async () => {
    const ws = mkWorkspace({});
    const r = await run<{ command: string }, RunShellResult>(
      shellCommandTool,
      { command: "echo hello" },
      mkCtx(ws),
    );
    expect(r.isError).toBeUndefined();
    expect((r.content as RunShellResult).stdout.trim()).toBe("hello");
  });

  test("routes through the same executeShell primitive (CATASTROPHIC pre-check fires)", async () => {
    // This is the belt-and-suspenders check inside executeShell — the
    // scheduler gate catches it first in the end-to-end flow, but direct
    // tool invocation should still refuse.
    const ws = mkWorkspace({});
    const r = await run<{ command: string }, RunShellResult>(
      shellCommandTool,
      { command: "rm -rf /" },
      mkCtx(ws),
    );
    expect(r.isError).toBe(true);
    expect(r.errorType).toBe("permission_denied");
  });

  test("honors timeoutMs (clamped at HARD_MAX_TIMEOUT_MS)", async () => {
    const ws = mkWorkspace({});
    const r = await run<{ command: string; timeoutMs: number }, RunShellResult>(
      shellCommandTool,
      { command: "sleep 5", timeoutMs: 1000 },
      mkCtx(ws),
    );
    expect(r.errorType).toBe("shell_timeout");
    expect((r.content as RunShellResult).timedOut).toBe(true);
  });

  test("background nohup command returns promptly", async () => {
    const ws = mkWorkspace({});
    const started = Date.now();
    const r = await run<{ command: string; timeoutMs: number }, RunShellResult>(
      shellCommandTool,
      {
        command: "nohup sh -c 'sleep 5' > bg.log 2>&1 & echo PID=$!",
        timeoutMs: 1500,
      },
      mkCtx(ws),
    );
    const elapsed = Date.now() - started;
    expect(r.isError).toBeUndefined();
    expect((r.content as RunShellResult).timedOut).toBe(false);
    expect((r.content as RunShellResult).stdout.trim()).toMatch(/^PID=\d+$/);
    expect(elapsed).toBeLessThan(1500);
  });

  test("background command with inherited pipe fd is cut off after post-exit grace", async () => {
    const ws = mkWorkspace({});
    const started = Date.now();
    const r = await run<{ command: string; timeoutMs: number }, RunShellResult>(
      shellCommandTool,
      {
        command: "nohup sh -c 'sleep 5' & echo PID=$!",
        timeoutMs: 3000,
      },
      mkCtx(ws),
    );
    const elapsed = Date.now() - started;
    expect(r.isError).toBeUndefined();
    expect((r.content as RunShellResult).timedOut).toBe(false);
    expect((r.content as RunShellResult).stdout).toContain("PID=");
    expect(elapsed).toBeLessThan(2500);
  });
});

// Quiet unused imports.
void existsSync;
