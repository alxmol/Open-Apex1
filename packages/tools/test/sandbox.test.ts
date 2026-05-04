/**
 * §M2 sandbox probe + restricted-shell factory tests.
 *
 * Covers the block-list coverage (layer 2) + the probe cache. Landlock
 * activation is not exercised here — that's integration territory
 * reserved for M4 when the exploratory executor lands.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import type { AutonomyLevel, OpenApexContext, OpenApexRunContext } from "@open-apex/core";

import {
  __resetSandboxBackendCache,
  createRestrictedRunShell,
  restrictedShellBlocks,
  sandboxBackend,
} from "../src/permissions/index.ts";

function mkWs(): string {
  return mkdtempSync(path.join(tmpdir(), "oa-sandbox-"));
}

function mkCtx(workspace: string): OpenApexRunContext {
  const userContext: OpenApexContext = {
    workspace,
    openApexHome: path.join(workspace, ".open-apex"),
    autonomyLevel: "full_auto" as AutonomyLevel,
    sessionId: "sandbox-test",
  };
  return {
    userContext,
    runId: "sandbox",
    signal: new AbortController().signal,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

describe("restrictedShellBlocks (\u00a7M2 layer 2)", () => {
  const worktree = "/tmp/worktree";
  test.each([
    [["ls", "-la", "/tmp/worktree/foo"], null],
    [["cat", "relative.txt"], null],
    [["sudo", "ls"], "sudo / chroot / namespace escape not allowed in restricted shell"],
    [["chroot", "/tmp"], "sudo / chroot / namespace escape not allowed in restricted shell"],
    [
      ["env", "GIT_DIR=/tmp/x", "git", "status"],
      "env override of GIT_DIR / GIT_WORK_TREE / HOME not allowed",
    ],
    [["bash", "-lc", "cd /etc && ls"], "cd outside worktree (/etc)"],
    [["bash", "-lc", "cd .. && ls"], "cd to parent / - not allowed in restricted shell"],
    [["bash", "-lc", "echo hi > /tmp/out.txt"], "redirect to outside worktree (/tmp/out.txt)"],
    [["bash", "-lc", "echo hi > /tmp/worktree/out.txt"], null],
    [["ls", "/etc/passwd"], "absolute path outside worktree: /etc/passwd"],
    [["ls", "/usr/lib/foo"], null], // read-only system path allowlisted
    [["ls", "/dev/null"], null],
  ])("blocks %o → %s", (argv, expected) => {
    expect(restrictedShellBlocks(argv as string[], worktree)).toBe(expected as string | null);
  });
});

describe("sandboxBackend probe", () => {
  test("forceBackend override bypasses detection", () => {
    __resetSandboxBackendCache();
    expect(sandboxBackend({ forceBackend: "landlock" })).toBe("landlock");
    expect(sandboxBackend({ forceBackend: "seatbelt" })).toBe("seatbelt");
    expect(sandboxBackend({ forceBackend: "soft" })).toBe("soft");
  });
  test("result is cached across calls without refresh", () => {
    __resetSandboxBackendCache();
    const first = sandboxBackend();
    const second = sandboxBackend();
    expect(second).toBe(first);
  });
  test("refresh: true re-probes", () => {
    __resetSandboxBackendCache();
    // Force to seatbelt once via override, then clear cache and probe fresh.
    sandboxBackend({ forceBackend: "seatbelt" });
    __resetSandboxBackendCache();
    const fresh = sandboxBackend();
    expect(["landlock", "seatbelt", "soft"]).toContain(fresh);
  });
});

describe("createRestrictedRunShell factory (no live consumer at M2)", () => {
  test("rejects argv that violates the block list before dispatch", async () => {
    const ws = mkWs();
    const tool = createRestrictedRunShell({ worktree: ws, sandboxBackend: "soft" });
    const r = await tool.execute({ argv: ["sudo", "ls"] }, mkCtx(ws), new AbortController().signal);
    expect(r.isError).toBe(true);
    expect(r.errorType).toBe("permission_denied");
    expect(String(r.content)).toContain("shell_command_rejected");
  });

  test("passes through allowed argv to executeShell (happy path)", async () => {
    const ws = mkWs();
    writeFileSync(path.join(ws, "hello.txt"), "hi\n");
    const tool = createRestrictedRunShell({ worktree: ws, sandboxBackend: "soft" });
    const r = await tool.execute(
      { argv: ["cat", "hello.txt"] },
      mkCtx(ws),
      new AbortController().signal,
    );
    expect(r.isError).toBeUndefined();
  });
});
