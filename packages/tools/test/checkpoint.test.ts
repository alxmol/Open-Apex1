/**
 * Shadow-git CheckpointStore tests (M1 minimal).
 * Full §7.6.7 tests (manifest hash-verify, LFS, submodules, empty-dirs)
 * land in M2.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import {
  ShadowGitCheckpointStore,
  ShadowGitError,
  __GIT_CMD_TIMEOUT_MS_FOR_TEST,
  __resetShadowGitSaveChildSpawnForTest,
  __resetShadowGitSpawnForTest,
  __setShadowGitSaveChildSpawnForTest,
  __setShadowGitSpawnForTest,
  type ShadowGitSpawnedProc,
} from "../src/checkpoint/index.ts";

function mkWorkspace(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openapex-ckpt-ws-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return dir;
}

function mkStoreRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "openapex-ckpt-store-"));
}

describe("ShadowGitCheckpointStore (M1 minimal)", () => {
  test("init creates shadow .git + manifest dir", async () => {
    const ws = mkWorkspace({ "README.md": "hi\n" });
    const store = new ShadowGitCheckpointStore({
      workspace: ws,
      storeRoot: mkStoreRoot(),
    });
    const handle = await store.init();
    expect(handle.existed).toBe(false);
    expect(existsSync(path.join(handle.storePath, ".git"))).toBe(true);
    expect(existsSync(path.join(handle.storePath, "manifest"))).toBe(true);
    expect(handle.disabledReason).toBeUndefined();
  });

  test("save → restore round-trips a single-file change", async () => {
    const ws = mkWorkspace({ "foo.txt": "one\n" });
    const store = new ShadowGitCheckpointStore({
      workspace: ws,
      storeRoot: mkStoreRoot(),
    });
    await store.init();
    const c1 = await store.save("user_named", "sess_1", 1, { name: "start" });
    writeFileSync(path.join(ws, "foo.txt"), "two\n", "utf8");
    const c2 = await store.save("pre_tool_batch", "sess_1", 2);
    expect(c1.commitSha).not.toBe(c2.commitSha);
    // Restore to c1 → foo.txt should be "one\n".
    const report = await store.restore(c1.commitSha);
    expect(report.verified).toBe(true);
    expect(report.preRestoreCommit).not.toBe(c2.commitSha); // new pre_restore checkpoint
    expect(readFileSync(path.join(ws, "foo.txt"), "utf8")).toBe("one\n");
  });

  test("restore emits pre-restore checkpoint (self-undo)", async () => {
    const ws = mkWorkspace({ f: "A\n" });
    const store = new ShadowGitCheckpointStore({
      workspace: ws,
      storeRoot: mkStoreRoot(),
    });
    await store.init();
    const c1 = await store.save("user_named", "s", 1);
    writeFileSync(path.join(ws, "f"), "B\n");
    const beforeRestore = readFileSync(path.join(ws, "f"), "utf8");
    const r = await store.restore(c1.commitSha);
    // pre_restore commit must exist and is distinct.
    expect(r.preRestoreCommit).not.toBe(c1.commitSha);
    // After restore, file matches c1.
    expect(readFileSync(path.join(ws, "f"), "utf8")).toBe("A\n");
    // The pre_restore snapshot still references state "B\n" — we can roll
    // forward by restoring to it.
    const forward = await store.restore(r.preRestoreCommit);
    expect(forward.verified).toBe(true);
    expect(readFileSync(path.join(ws, "f"), "utf8")).toBe(beforeRestore);
  });

  test("restore wipes untracked files (git clean -fdx)", async () => {
    const ws = mkWorkspace({ "tracked.txt": "kept\n" });
    const store = new ShadowGitCheckpointStore({
      workspace: ws,
      storeRoot: mkStoreRoot(),
    });
    await store.init();
    const c1 = await store.save("user_named", "s", 1);
    writeFileSync(path.join(ws, "untracked.txt"), "temp\n");
    expect(existsSync(path.join(ws, "untracked.txt"))).toBe(true);
    await store.restore(c1.commitSha);
    expect(existsSync(path.join(ws, "untracked.txt"))).toBe(false);
    expect(readFileSync(path.join(ws, "tracked.txt"), "utf8")).toBe("kept\n");
  });

  test("list returns checkpoints for the session", async () => {
    const ws = mkWorkspace({ a: "1\n" });
    const store = new ShadowGitCheckpointStore({
      workspace: ws,
      storeRoot: mkStoreRoot(),
    });
    await store.init();
    await store.save("user_named", "sess_x", 1, { name: "first" });
    writeFileSync(path.join(ws, "a"), "2\n");
    await store.save("pre_tool_batch", "sess_x", 2);
    const list = await store.list("sess_x");
    expect(list.length).toBe(2);
    expect(list.map((c) => c.reason).sort()).toEqual(["pre_tool_batch", "user_named"]);
    expect(list.find((c) => c.reason === "user_named")?.name).toBe("first");
  });

  test("verify returns false for unknown sha", async () => {
    const ws = mkWorkspace({ a: "1" });
    const store = new ShadowGitCheckpointStore({
      workspace: ws,
      storeRoot: mkStoreRoot(),
    });
    await store.init();
    const report = await store.verify("deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
    expect(report.verified).toBe(false);
  });

  test("refuses to init on a protected path", async () => {
    const store = new ShadowGitCheckpointStore({
      workspace: "/tmp",
      storeRoot: mkStoreRoot(),
    });
    const handle = await store.init();
    expect(handle.disabledReason).toBe("protected_path");
  });

  test("save writes a manifest JSON file", async () => {
    const ws = mkWorkspace({ a: "1" });
    const store = new ShadowGitCheckpointStore({
      workspace: ws,
      storeRoot: mkStoreRoot(),
    });
    await store.init();
    const c = await store.save("user_named", "s", 1);
    expect(existsSync(c.manifestPath)).toBe(true);
    const m = JSON.parse(readFileSync(c.manifestPath, "utf8"));
    expect(m.schema_version).toBe(1);
    expect(m.commit_sha).toBe(c.commitSha);
    expect(m.reason).toBe("user_named");
    expect(m.session_id).toBe("s");
  });

  test("runGit throws ShadowGitError when a git subprocess hangs past GIT_CMD_TIMEOUT_MS (TB2 gpt-fix-git regression)", async () => {
    // TB2 gpt-fix-git hung 900 s with zero events — the shadow-git
    // init's 14 sequential `git config` calls never made progress past
    // the first one. Without a per-command timeout, a hung Bun.spawn
    // stalls the whole run.
    // Override the constant via env so we don't wait 30 s in tests.
    // Instead, we use a mock that never resolves `exited` and verify
    // the timeout path fires. Timeout itself is the hardcoded
    // GIT_CMD_TIMEOUT_MS; we override at test boundary via a smaller
    // mock window is NOT possible without plumbing an option, so we
    // assert the test timeout itself bounds correctly.
    // Simpler: just verify the timeout path executes by mocking a proc
    // whose exited never resolves, then asserting the test completes
    // within GIT_CMD_TIMEOUT_MS + slack.
    let killCalls = 0;
    __setShadowGitSpawnForTest(
      (): ShadowGitSpawnedProc => ({
        exited: new Promise<number | void>(() => {
          /* never */
        }),
        exitCode: null,
        stdout: new ReadableStream<Uint8Array>({ start() {} }),
        stderr: new ReadableStream<Uint8Array>({ start() {} }),
        kill() {
          killCalls++;
        },
      }),
    );
    try {
      const ws = mkWorkspace({ a: "1" });
      const store = new ShadowGitCheckpointStore({
        workspace: ws,
        storeRoot: mkStoreRoot(),
      });
      const started = Date.now();
      let caught: unknown;
      try {
        await store.init();
      } catch (err) {
        caught = err;
      }
      const elapsed = Date.now() - started;
      expect(caught).toBeInstanceOf(ShadowGitError);
      const e = caught as ShadowGitError;
      expect(e.message).toContain("timed out");
      expect(e.exitCode).toBe(-1);
      expect(killCalls).toBeGreaterThanOrEqual(1);
      // Elapsed should be around GIT_CMD_TIMEOUT_MS + reap deadline.
      // We can't wait the full 30s in CI reliably, so just assert it's
      // bounded (< 2x the timeout).
      expect(elapsed).toBeLessThan(__GIT_CMD_TIMEOUT_MS_FOR_TEST * 2);
    } finally {
      __resetShadowGitSpawnForTest();
    }
  }, 60_000);
});

describe("ShadowGitCheckpointStore (\u00a77.6.7 full manifest)", () => {
  test("manifest includes sha256-hashed tree entries with mode + size", async () => {
    const ws = mkWorkspace({ "a.txt": "hello\n", "bin/run": "#!/bin/sh\necho hi\n" });
    const store = new ShadowGitCheckpointStore({
      workspace: ws,
      storeRoot: mkStoreRoot(),
    });
    await store.init();
    // Make bin/run executable so we can assert mode capture.
    const { chmodSync } = await import("node:fs");
    chmodSync(path.join(ws, "bin/run"), 0o755);
    const c = await store.save("user_named", "s", 1);
    const m = JSON.parse(readFileSync(c.manifestPath, "utf8"));
    expect(Array.isArray(m.tree)).toBe(true);
    expect(m.tree.length).toBeGreaterThanOrEqual(2);
    const a = m.tree.find((t: { path: string }) => t.path === "a.txt");
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.mode).toBe("100644");
    expect(a.size).toBe(6);
    const run = m.tree.find((t: { path: string }) => t.path === "bin/run");
    expect(run.mode).toBe("100755");
    expect(m.stats.file_count).toBe(m.tree.length);
    expect(m.host.os).toMatch(/^(?:linux|darwin|win32)$/);
  });

  test("restore with mismatched sha256 rolls back + RestoreReport.modeMismatch populated", async () => {
    const ws = mkWorkspace({ "a.txt": "original\n" });
    const store = new ShadowGitCheckpointStore({
      workspace: ws,
      storeRoot: mkStoreRoot(),
    });
    await store.init();
    const cp = await store.save("user_named", "s", 1);
    // Tamper the manifest so restore will detect a mismatch.
    const manifest = JSON.parse(readFileSync(cp.manifestPath, "utf8"));
    manifest.tree.find((t: { path: string }) => t.path === "a.txt").sha256 = "0".repeat(64);
    writeFileSync(cp.manifestPath, JSON.stringify(manifest, null, 2));

    // Mutate workspace then restore: git reset --hard succeeds but hash
    // verify finds the fake mismatch → rollback + modeMismatch.
    writeFileSync(path.join(ws, "a.txt"), "mutated\n");
    const report = await store.restore(cp.commitSha);
    expect(report.verified).toBe(false);
    expect(report.modeMismatch).toContain("a.txt");
    // Workspace should have rolled back to the pre_restore snapshot.
    expect(existsSync(path.join(ws, "a.txt"))).toBe(true);
  });

  test("session jsonl log is appended on every save", async () => {
    const ws = mkWorkspace({ "a.txt": "x" });
    const storeRoot = mkStoreRoot();
    const store = new ShadowGitCheckpointStore({ workspace: ws, storeRoot });
    await store.init();
    await store.save("user_named", "sess_A", 1);
    writeFileSync(path.join(ws, "a.txt"), "y");
    await store.save("pre_tool_batch", "sess_A", 2);
    const hash = (await import("node:crypto"))
      .createHash("sha256")
      .update(path.resolve(ws))
      .digest("hex")
      .slice(0, 16);
    const sessionFile = path.join(storeRoot, hash, "sessions", "sess_A.jsonl");
    expect(existsSync(sessionFile)).toBe(true);
    const lines = readFileSync(sessionFile, "utf8").trim().split("\n");
    expect(lines.length).toBe(2);
    for (const ln of lines) {
      const j = JSON.parse(ln);
      expect(j.commit).toMatch(/^[0-9a-f]{40}$/);
    }
  });

  test("statvfs preflight: init with very high minFreeDiskBytes disables with reason=low_disk", async () => {
    const ws = mkWorkspace({ "a.txt": "x" });
    const store = new ShadowGitCheckpointStore({
      workspace: ws,
      storeRoot: mkStoreRoot(),
      minFreeDiskBytes: Number.MAX_SAFE_INTEGER,
    });
    const handle = await store.init();
    expect(handle.disabledReason).toBe("low_disk");
  });

  test("LFS-tracked paths appear in .git/info/exclude after init", async () => {
    const ws = mkWorkspace({
      ".gitattributes": "*.bin filter=lfs diff=lfs merge=lfs -text\n",
      "a.txt": "x",
    });
    const storeRoot = mkStoreRoot();
    const store = new ShadowGitCheckpointStore({ workspace: ws, storeRoot });
    await store.init();
    const hash = (await import("node:crypto"))
      .createHash("sha256")
      .update(path.resolve(ws))
      .digest("hex")
      .slice(0, 16);
    const exclude = readFileSync(path.join(storeRoot, hash, ".git", "info", "exclude"), "utf8");
    expect(exclude).toContain("*.bin");
  });
});

describe("ShadowGitCheckpointStore init — single-config-write path (tb2-smoke regression: plan Fix 3)", () => {
  // tb2-smoke run sonnet4.6/hf-model-inference died during init with
  // `git config commit.gpgSign false timed out after 30000ms`. We now
  // write .git/config directly instead of invoking `git config` 13 times
  // — one subprocess instead of 14, one failure surface instead of 14.

  test("init spawns only `git init` (+ `git --version` probe); no `git config` subprocesses", async () => {
    const argvSeen: string[][] = [];
    __setShadowGitSpawnForTest((argv: string[]): ShadowGitSpawnedProc => {
      argvSeen.push([...argv]);
      // Return a fast-exit stub; we don't need real git semantics here
      // because the config file write bypasses git entirely.
      return {
        exited: Promise.resolve(0),
        exitCode: 0,
        stdout: new ReadableStream<Uint8Array>({
          start(c) {
            c.close();
          },
        }),
        stderr: new ReadableStream<Uint8Array>({
          start(c) {
            c.close();
          },
        }),
        kill() {},
      };
    });
    try {
      const ws = mkWorkspace({ a: "1" });
      const store = new ShadowGitCheckpointStore({
        workspace: ws,
        storeRoot: mkStoreRoot(),
      });
      await store.init();
      // Filter to just `git`-exec invocations; there should be exactly 1
      // `init` + optionally the `--version` probe from getGitVersion() on
      // demand. Crucially: zero `config` subcommands.
      const gitArgs = argvSeen
        .map((a) => (a[0]?.endsWith("git") ? a.slice(1) : null))
        .filter((a): a is string[] => a !== null);
      const initCalls = gitArgs.filter((a) => a[0] === "init").length;
      const configCalls = gitArgs.filter((a) => a[0] === "config").length;
      expect(initCalls).toBe(1);
      expect(configCalls).toBe(0);
    } finally {
      __resetShadowGitSpawnForTest();
    }
  });

  test("init writes .git/config with every required key (worktree, commit, tag, gc, user)", async () => {
    const ws = mkWorkspace({ a: "1" });
    const storeRoot = mkStoreRoot();
    const store = new ShadowGitCheckpointStore({ workspace: ws, storeRoot });
    await store.init();
    const hash = (await import("node:crypto"))
      .createHash("sha256")
      .update(path.resolve(ws))
      .digest("hex")
      .slice(0, 16);
    const config = readFileSync(path.join(storeRoot, hash, ".git", "config"), "utf8");
    // Check all keys we need are present with the right values.
    expect(config).toContain("[core]");
    expect(config).toContain(`worktree = ${path.resolve(ws)}`);
    expect(config).toMatch(/symlinks\s*=\s*true/);
    expect(config).toMatch(/autocrlf\s*=\s*false/);
    expect(config).toMatch(/fileMode\s*=\s*true/);
    expect(config).toContain("[commit]");
    expect(config).toMatch(/gpgSign\s*=\s*false/);
    expect(config).toContain("[tag]");
    expect(config).toContain("[gc]");
    expect(config).toMatch(/auto\s*=\s*0/);
    expect(config).toContain("[user]");
    expect(config).toMatch(/name\s*=\s*Open-Apex/);
    expect(config).toMatch(/email\s*=\s*checkpoint@open-apex\.local/);
  });

  test("values survive round-trip through real git (save + rev-parse)", async () => {
    // Smoke: after init, a normal save must succeed. If our config
    // file were malformed git would error out here.
    const ws = mkWorkspace({ a: "1" });
    const store = new ShadowGitCheckpointStore({
      workspace: ws,
      storeRoot: mkStoreRoot(),
    });
    await store.init();
    const cp = await store.save("user_named", "s", 1);
    expect(cp.commitSha).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("ShadowGitCheckpointStore manifest byte-budget (tb2-12 regression: plan Fix C.1)", () => {
  // tb2-12 sonnet4.6/build-cython-ext hit Bun SIGSEGV during/after a
  // 35-second checkpoint_save — the sha256 pass over pyknotid's source
  // tree drove Bun past some internal threshold. The byte-budget cap
  // switches later files to LFS-style placeholders (mode + size only, no
  // sha256) once aggregate hashed bytes exceed MANIFEST_MAX_TOTAL_BYTES,
  // keeping the save bounded in both CPU and memory.

  test("small workspace under budget: every file is sha256-hashed, stats.partial=false", async () => {
    const ws = mkWorkspace({
      "a.txt": "alpha\n",
      "src/b.py": "print('hi')\n",
      "docs/c.md": "# hello\n",
    });
    const store = new ShadowGitCheckpointStore({
      workspace: ws,
      storeRoot: mkStoreRoot(),
    });
    await store.init();
    const cp = await store.save("user_named", "s", 1);
    const m = JSON.parse(readFileSync(cp.manifestPath, "utf8"));
    expect(m.stats.partial).toBe(false);
    // Every regular-file entry has a real sha256 and NO hash_skipped_reason.
    const regulars = (
      m.tree as Array<{ mode: string; sha256: string; hash_skipped_reason?: string }>
    ).filter((t) => t.mode !== "120000");
    for (const t of regulars) {
      expect(t.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(t.hash_skipped_reason).toBeUndefined();
    }
    expect(m.stats.hashed_bytes).toBeGreaterThan(0);
  });

  test("workspace over aggregate budget: later files are LFS placeholders with budget_exhausted", async () => {
    // Generate enough content to exceed MANIFEST_MAX_TOTAL_BYTES (50 MB).
    // We use 70 files of 1 MB each = 70 MB total; the walk should hash
    // ~50 of them and place the rest as budget_exhausted placeholders.
    const bigChunk = "x".repeat(1024 * 1024); // 1 MB
    const files: Record<string, string> = {};
    for (let i = 0; i < 70; i++) {
      files[`data/f${String(i).padStart(3, "0")}.txt`] = bigChunk;
    }
    const ws = mkWorkspace(files);
    const store = new ShadowGitCheckpointStore({
      workspace: ws,
      storeRoot: mkStoreRoot(),
    });
    await store.init();
    const cp = await store.save("user_named", "s", 1);
    const m = JSON.parse(readFileSync(cp.manifestPath, "utf8"));

    expect(m.stats.partial).toBe(true);
    // hashed_bytes must be <= 50 MB + tiny slack for the last accepted file.
    expect(m.stats.hashed_bytes).toBeGreaterThan(40 * 1024 * 1024);
    expect(m.stats.hashed_bytes).toBeLessThanOrEqual(50 * 1024 * 1024);

    const entries = m.tree as Array<{
      sha256: string;
      lfs?: boolean;
      hash_skipped_reason?: string;
    }>;
    const hashed = entries.filter((e) => e.sha256 !== "");
    const placeholders = entries.filter((e) => e.hash_skipped_reason === "budget_exhausted");
    expect(hashed.length).toBeGreaterThan(0);
    expect(placeholders.length).toBeGreaterThan(0);
    // Placeholders are marked lfs=true so restore verify skips them.
    for (const p of placeholders) {
      expect(p.lfs).toBe(true);
      expect(p.sha256).toBe("");
    }
  }, 60_000);

  test("restore skips sha256 verify for budget_exhausted entries", async () => {
    // Setup: save an over-budget workspace, then tamper with one of the
    // placeholder files. Restore should still verify: the placeholder
    // was never hashed, so a content change doesn't flip modeMismatch.
    const bigChunk = "y".repeat(1024 * 1024);
    const files: Record<string, string> = {};
    for (let i = 0; i < 60; i++) {
      files[`data/f${String(i).padStart(3, "0")}.txt`] = bigChunk;
    }
    const ws = mkWorkspace(files);
    const store = new ShadowGitCheckpointStore({
      workspace: ws,
      storeRoot: mkStoreRoot(),
    });
    await store.init();
    const cp = await store.save("user_named", "s", 1);
    const m = JSON.parse(readFileSync(cp.manifestPath, "utf8"));
    const placeholder = (m.tree as Array<{ path: string; hash_skipped_reason?: string }>).find(
      (t) => t.hash_skipped_reason === "budget_exhausted",
    );
    expect(placeholder).toBeDefined();

    // Mutate the file that's recorded as a placeholder.
    writeFileSync(path.join(ws, placeholder!.path), "tampered\n");
    const report = await store.restore(cp.commitSha);
    // The placeholder entry should NOT be counted as a mismatch since its
    // sha256 wasn't recorded. Verified restore just re-syncs from git.
    expect(report.modeMismatch).not.toContain(placeholder!.path);
  }, 60_000);

  test("verify reports extra workspace files not present in the manifest", async () => {
    const ws = mkWorkspace({ "a.txt": "x" });
    const store = new ShadowGitCheckpointStore({
      workspace: ws,
      storeRoot: mkStoreRoot(),
    });
    await store.init();
    const cp = await store.save("user_named", "s", 1);
    writeFileSync(path.join(ws, "extra.txt"), "extra\n");
    const report = await store.verify(cp.commitSha);
    expect(report.verified).toBe(false);
    expect(report.untrackedInWorkspace).toContain("extra.txt");
  });
});

describe("ShadowGitCheckpointStore save — child-process isolation (tb2-12 regression: plan Fix C.2)", () => {
  // When OPEN_APEX_CHECKPOINT_ISOLATION=1 is set, save() routes through a
  // child Bun process via the save-runner entrypoint. A SIGSEGV or other
  // crash in the child must NOT kill the parent agent run — instead the
  // parent throws ShadowGitError which checkpoint_save.ts converts to a
  // structured ToolExecuteResult for graceful degradation.

  function mockChildReturningJson(argv: string[], json: string): ShadowGitSpawnedProc {
    const encoder = new TextEncoder();
    return {
      exited: Promise.resolve(0),
      exitCode: 0,
      stdout: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(encoder.encode(json));
          c.close();
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(c) {
          c.close();
        },
      }),
      kill() {
        /* no-op */
      },
    } satisfies ShadowGitSpawnedProc;
  }

  function mockChildCrashing(exitCode: number, stderr = "segfault\n"): ShadowGitSpawnedProc {
    const encoder = new TextEncoder();
    return {
      exited: Promise.resolve(exitCode),
      exitCode,
      stdout: new ReadableStream<Uint8Array>({
        start(c) {
          c.close();
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(encoder.encode(stderr));
          c.close();
        },
      }),
      kill() {
        /* no-op */
      },
    } satisfies ShadowGitSpawnedProc;
  }

  test("isolation off (default): save runs in-process unchanged", async () => {
    const prior = process.env.OPEN_APEX_CHECKPOINT_ISOLATION;
    delete process.env.OPEN_APEX_CHECKPOINT_ISOLATION;
    try {
      let overrideCalled = false;
      __setShadowGitSaveChildSpawnForTest((_argv) => {
        overrideCalled = true;
        return mockChildCrashing(1, "should not be called\n");
      });
      const ws = mkWorkspace({ a: "1" });
      const store = new ShadowGitCheckpointStore({
        workspace: ws,
        storeRoot: mkStoreRoot(),
      });
      await store.init();
      const cp = await store.save("user_named", "s", 1);
      expect(cp.commitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(overrideCalled).toBe(false);
    } finally {
      __resetShadowGitSaveChildSpawnForTest();
      if (prior !== undefined) process.env.OPEN_APEX_CHECKPOINT_ISOLATION = prior;
    }
  });

  test("isolation on: happy path — child returns Checkpoint JSON, parent forwards it", async () => {
    process.env.OPEN_APEX_CHECKPOINT_ISOLATION = "1";
    try {
      const fakeCheckpoint = {
        commitSha: "a".repeat(40),
        manifestPath: "/tmp/fake.json",
        reason: "user_named",
        sessionId: "s",
        stepId: 1,
        createdAt: new Date().toISOString(),
        bytesAdded: 0,
        wallMs: 42,
      };
      const seenArgv: string[][] = [];
      __setShadowGitSaveChildSpawnForTest((argv) => {
        seenArgv.push([...argv]);
        return mockChildReturningJson(argv, JSON.stringify(fakeCheckpoint));
      });
      const ws = mkWorkspace({ a: "1" });
      const store = new ShadowGitCheckpointStore({
        workspace: ws,
        storeRoot: mkStoreRoot(),
      });
      await store.init();
      const cp = await store.save("user_named", "s", 1);
      expect(cp.commitSha).toBe(fakeCheckpoint.commitSha);
      // Argv should carry our workspace/store/session args.
      expect(seenArgv.length).toBe(1);
      expect(seenArgv[0]).toContain("--workspace");
      expect(seenArgv[0]).toContain("--session");
      expect(seenArgv[0]).toContain("s");
    } finally {
      __resetShadowGitSaveChildSpawnForTest();
      delete process.env.OPEN_APEX_CHECKPOINT_ISOLATION;
    }
  });

  test("isolation on: child exits 139 (SIGSEGV) → ShadowGitError with segfault hint; parent survives", async () => {
    process.env.OPEN_APEX_CHECKPOINT_ISOLATION = "1";
    try {
      __setShadowGitSaveChildSpawnForTest(() =>
        mockChildCrashing(139, "bash: line 1: Segmentation fault\n"),
      );
      const ws = mkWorkspace({ a: "1" });
      const store = new ShadowGitCheckpointStore({
        workspace: ws,
        storeRoot: mkStoreRoot(),
      });
      await store.init();
      let caught: unknown;
      try {
        await store.save("user_named", "s", 1);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ShadowGitError);
      const e = caught as ShadowGitError;
      expect(e.exitCode).toBe(139);
      expect(e.message).toContain("SIGSEGV");
      expect(e.message).toContain("parent survives");
    } finally {
      __resetShadowGitSaveChildSpawnForTest();
      delete process.env.OPEN_APEX_CHECKPOINT_ISOLATION;
    }
  });

  test("isolation on: child exits 2 (save threw) → ShadowGitError carries stderr", async () => {
    process.env.OPEN_APEX_CHECKPOINT_ISOLATION = "1";
    try {
      __setShadowGitSaveChildSpawnForTest(() =>
        mockChildCrashing(2, "save-runner: save() threw: disk full\n"),
      );
      const ws = mkWorkspace({ a: "1" });
      const store = new ShadowGitCheckpointStore({
        workspace: ws,
        storeRoot: mkStoreRoot(),
      });
      await store.init();
      let caught: unknown;
      try {
        await store.save("user_named", "s", 1);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ShadowGitError);
      expect((caught as ShadowGitError).message).toContain("disk full");
    } finally {
      __resetShadowGitSaveChildSpawnForTest();
      delete process.env.OPEN_APEX_CHECKPOINT_ISOLATION;
    }
  });

  test("isolation on: child emits malformed JSON on success → ShadowGitError with parse hint", async () => {
    process.env.OPEN_APEX_CHECKPOINT_ISOLATION = "1";
    try {
      __setShadowGitSaveChildSpawnForTest((argv) => mockChildReturningJson(argv, "not-json"));
      const ws = mkWorkspace({ a: "1" });
      const store = new ShadowGitCheckpointStore({
        workspace: ws,
        storeRoot: mkStoreRoot(),
      });
      await store.init();
      let caught: unknown;
      try {
        await store.save("user_named", "s", 1);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ShadowGitError);
      expect((caught as ShadowGitError).message).toContain("not a Checkpoint JSON");
    } finally {
      __resetShadowGitSaveChildSpawnForTest();
      delete process.env.OPEN_APEX_CHECKPOINT_ISOLATION;
    }
  });

  test("isolation on: real save-runner child performs one save without recursive spawning", async () => {
    const prior = process.env.OPEN_APEX_CHECKPOINT_ISOLATION;
    process.env.OPEN_APEX_CHECKPOINT_ISOLATION = "1";
    try {
      const ws = mkWorkspace({ a: "1\n" });
      const store = new ShadowGitCheckpointStore({
        workspace: ws,
        storeRoot: mkStoreRoot(),
      });
      await store.init();
      const cp = await store.save("user_named", "s", 1, { name: "real-child" });
      expect(cp.commitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(existsSync(cp.manifestPath)).toBe(true);
    } finally {
      if (prior === undefined) delete process.env.OPEN_APEX_CHECKPOINT_ISOLATION;
      else process.env.OPEN_APEX_CHECKPOINT_ISOLATION = prior;
    }
  }, 30_000);

  test("isolation on: env-provided save-runner path is honored", async () => {
    const priorIsolation = process.env.OPEN_APEX_CHECKPOINT_ISOLATION;
    const priorRunner = process.env.OPEN_APEX_SAVE_RUNNER_PATH;
    process.env.OPEN_APEX_CHECKPOINT_ISOLATION = "1";
    process.env.OPEN_APEX_SAVE_RUNNER_PATH = path.resolve(
      import.meta.dir,
      "../src/checkpoint/save-runner.ts",
    );
    try {
      const ws = mkWorkspace({ a: "1\n" });
      const store = new ShadowGitCheckpointStore({
        workspace: ws,
        storeRoot: mkStoreRoot(),
      });
      await store.init();
      const cp = await store.save("user_named", "s", 1, { name: "env-child" });
      expect(cp.commitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(existsSync(cp.manifestPath)).toBe(true);
    } finally {
      if (priorIsolation === undefined) delete process.env.OPEN_APEX_CHECKPOINT_ISOLATION;
      else process.env.OPEN_APEX_CHECKPOINT_ISOLATION = priorIsolation;
      if (priorRunner === undefined) delete process.env.OPEN_APEX_SAVE_RUNNER_PATH;
      else process.env.OPEN_APEX_SAVE_RUNNER_PATH = priorRunner;
    }
  }, 30_000);
});
