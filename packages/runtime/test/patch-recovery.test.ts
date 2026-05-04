/**
 * §1.2 patch-failure recovery tests.
 *
 * Covers:
 *   - On apply_patch context-mismatch, `maybeInjectPatchRecovery` emits a
 *     synthetic read_file-style history item with fresh file content and
 *     adds the path to `writeFileOpenFor`.
 *   - On second consecutive failure of the same path, the path graduates
 *     to `exhausted` and `patch_apply_failed` fires.
 *   - On successful apply_patch, the failure counter + write_file-open
 *     flag are cleared for that path.
 *   - Unrelated paths are not affected by one path's failure.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import type {
  OpenApexContext,
  OpenApexRunContext,
  ToolCallRequest,
  ToolDefinition,
  ToolResult,
} from "@open-apex/core";

import { maybeInjectPatchRecovery, newPatchRecoveryState } from "../src/patch-recovery.ts";
import { executeToolBatch } from "../src/tool-loop.ts";
import { writeFileTool } from "@open-apex/tools";

function mkWs(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "oa-patch-rec-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

function applyPatchCall(id: string, patch: string): ToolCallRequest {
  return { id, name: "apply_patch", arguments: { patch } };
}

function applyPatchErrorResult(id: string, errorType: string, content: string): ToolResult {
  const r: ToolResult = {
    toolCallId: id,
    status: "error",
    content,
    startedAt: 0,
    endedAt: 1,
  };
  r.errorType = errorType as NonNullable<ToolResult["errorType"]>;
  return r;
}

function mkCtx(workspace: string): OpenApexRunContext {
  const userContext: OpenApexContext = {
    workspace,
    openApexHome: path.join(workspace, ".open-apex"),
    autonomyLevel: "full_auto",
    sessionId: "patch-recovery-test",
  };
  return {
    userContext,
    runId: "patch-recovery",
    signal: new AbortController().signal,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

function writeFileToolMap(): Map<string, ToolDefinition> {
  return new Map([["write_file", writeFileTool as unknown as ToolDefinition]]);
}

describe("maybeInjectPatchRecovery (§1.2)", () => {
  test("first context-mismatch injects synthetic read_file + opens write_file", () => {
    const ws = mkWs({ "src/foo.ts": "line1\nline2\nline3\nline4\n" });
    const state = newPatchRecoveryState();
    const calls = [applyPatchCall("p1", "... patch body")];
    const results = [
      applyPatchErrorResult(
        "p1",
        "patch_context_mismatch",
        "hunk 1 context mismatch in src/foo.ts at line 2",
      ),
    ];
    const r = maybeInjectPatchRecovery(calls, results, state, ws, 1);
    expect(r.inject.length).toBe(1);
    const body =
      typeof r.inject[0]!.content === "string"
        ? r.inject[0]!.content
        : JSON.stringify(r.inject[0]!.content);
    expect(body).toContain("apply_patch failed on src/foo.ts");
    expect(body).toContain("line1"); // fresh content snippet
    expect(r.writeFileOpen).toEqual(["src/foo.ts"]);
    expect(r.exhausted).toEqual([]);
    expect(state.failureCount.get("src/foo.ts")).toBe(1);
    expect(state.writeFileOpenFor.has("src/foo.ts")).toBe(true);
  });

  test("second consecutive failure on same path injects another read; third fails to exhausted", () => {
    const ws = mkWs({ "foo.ts": "content\n" });
    const state = newPatchRecoveryState();

    // Turn 1 fail.
    maybeInjectPatchRecovery(
      [applyPatchCall("p1", "x")],
      [
        applyPatchErrorResult(
          "p1",
          "patch_context_mismatch",
          "hunk 1 context mismatch in foo.ts at line 1",
        ),
      ],
      state,
      ws,
      1,
    );
    // Turn 2 fail.
    const r2 = maybeInjectPatchRecovery(
      [applyPatchCall("p2", "x")],
      [
        applyPatchErrorResult(
          "p2",
          "patch_context_mismatch",
          "hunk 1 context mismatch in foo.ts at line 1",
        ),
      ],
      state,
      ws,
      2,
    );
    expect(r2.inject.length).toBe(1); // still injecting (attempt=2)
    expect(r2.exhausted).toEqual([]);
    expect(state.failureCount.get("foo.ts")).toBe(2);

    // Turn 3 fail → exhausted.
    const r3 = maybeInjectPatchRecovery(
      [applyPatchCall("p3", "x")],
      [
        applyPatchErrorResult(
          "p3",
          "patch_context_mismatch",
          "hunk 1 context mismatch in foo.ts at line 1",
        ),
      ],
      state,
      ws,
      3,
    );
    expect(r3.exhausted).toEqual(["foo.ts"]);
    expect(r3.inject.length).toBe(0);
    expect(state.writeFileOpenFor.has("foo.ts")).toBe(false);
  });

  test("successful apply_patch clears failure counter + write_file-open flag", () => {
    const ws = mkWs({ "foo.ts": "a\n" });
    const state = newPatchRecoveryState();
    // Seed state with a prior failure.
    maybeInjectPatchRecovery(
      [applyPatchCall("p1", "x")],
      [
        applyPatchErrorResult(
          "p1",
          "patch_context_mismatch",
          "hunk 1 context mismatch in foo.ts at line 1",
        ),
      ],
      state,
      ws,
      1,
    );
    expect(state.writeFileOpenFor.has("foo.ts")).toBe(true);

    // Success: result shape mirrors apply_patch.ts happy path.
    const okResult: ToolResult = {
      toolCallId: "p2",
      status: "ok",
      content: {
        filesModified: [{ path: "foo.ts", action: "modify" }],
        reversePatch: "...",
      },
      startedAt: 0,
      endedAt: 1,
    };
    maybeInjectPatchRecovery([applyPatchCall("p2", "x")], [okResult], state, ws, 2);
    expect(state.failureCount.has("foo.ts")).toBe(false);
    expect(state.writeFileOpenFor.has("foo.ts")).toBe(false);
  });

  test("failure on path A does NOT open write_file for path B", () => {
    const ws = mkWs({ "a.ts": "a\n", "b.ts": "b\n" });
    const state = newPatchRecoveryState();
    const r = maybeInjectPatchRecovery(
      [applyPatchCall("p1", "x")],
      [
        applyPatchErrorResult(
          "p1",
          "patch_context_mismatch",
          "hunk 1 context mismatch in a.ts at line 1",
        ),
      ],
      state,
      ws,
      1,
    );
    expect(r.writeFileOpen).toEqual(["a.ts"]);
    expect(state.writeFileOpenFor.has("b.ts")).toBe(false);
  });

  test("non-apply_patch calls are ignored", () => {
    const ws = mkWs({});
    const state = newPatchRecoveryState();
    const r = maybeInjectPatchRecovery(
      [{ id: "s1", name: "run_shell", arguments: { argv: ["ls"] } }],
      [
        {
          toolCallId: "s1",
          status: "ok",
          content: "ok",
          startedAt: 0,
          endedAt: 1,
        },
      ],
      state,
      ws,
      1,
    );
    expect(r.inject).toEqual([]);
    expect(r.writeFileOpen).toEqual([]);
    expect(r.exhausted).toEqual([]);
  });

  test("runtime scheduler consumes write_file-open for exactly the recovered path", async () => {
    const ws = mkWs({ "foo.ts": "old\n", "bar.ts": "bar\n" });
    const state = newPatchRecoveryState();
    maybeInjectPatchRecovery(
      [applyPatchCall("p1", "x")],
      [
        applyPatchErrorResult(
          "p1",
          "patch_context_mismatch",
          "hunk 1 context mismatch in foo.ts at line 1",
        ),
      ],
      state,
      ws,
      1,
    );

    const wrong = await executeToolBatch(
      [{ id: "w0", name: "write_file", arguments: { path: "bar.ts", content: "wrong\n" } }],
      writeFileToolMap(),
      mkCtx(ws),
      { recoveryWriteFileOpenFor: state.writeFileOpenFor },
    );
    expect(wrong[0]?.status).toBe("error");
    expect(wrong[0]?.errorType).toBe("file_exists");
    expect(state.writeFileOpenFor.has("foo.ts")).toBe(true);

    const ok = await executeToolBatch(
      [{ id: "w1", name: "write_file", arguments: { path: "foo.ts", content: "new\n" } }],
      writeFileToolMap(),
      mkCtx(ws),
      { recoveryWriteFileOpenFor: state.writeFileOpenFor },
    );
    expect(ok[0]?.status).toBe("ok");
    expect(readFileSync(path.join(ws, "foo.ts"), "utf8")).toBe("new\n");
    expect(state.writeFileOpenFor.has("foo.ts")).toBe(false);

    const normalOverwrite = await executeToolBatch(
      [{ id: "w2", name: "write_file", arguments: { path: "foo.ts", content: "again\n" } }],
      writeFileToolMap(),
      mkCtx(ws),
    );
    expect(normalOverwrite[0]?.status).toBe("error");
    expect(normalOverwrite[0]?.errorType).toBe("file_exists");
  });

  test("error with no extractable path (patch_parse_error on raw body) does NOT inject", () => {
    const ws = mkWs({});
    const state = newPatchRecoveryState();
    const r = maybeInjectPatchRecovery(
      [applyPatchCall("p1", "x")],
      [
        applyPatchErrorResult(
          "p1",
          "patch_parse_error",
          "patch_parse_error: file diff has no old or new path",
        ),
      ],
      state,
      ws,
      1,
    );
    // No matching path → no injection.
    expect(r.inject).toEqual([]);
    expect(r.writeFileOpen).toEqual([]);
  });
});
