import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import {
  PatchError,
  parseUnifiedDiff,
  planApply,
  generateReversePatch,
} from "../src/patch/index.ts";

function mkWorkspace(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openapex-patch-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
  return dir;
}

describe("parseUnifiedDiff", () => {
  test("parses a simple modify patch with one hunk", () => {
    const patch = "--- a/foo.txt\n+++ b/foo.txt\n@@ -1,2 +1,2 @@\n hello\n-world\n+earth\n";
    const files = parseUnifiedDiff(patch);
    expect(files.length).toBe(1);
    expect(files[0]?.oldPath).toBe("foo.txt");
    expect(files[0]?.newPath).toBe("foo.txt");
    const hunk = files[0]?.hunks[0]!;
    expect(hunk.oldStart).toBe(1);
    expect(hunk.oldCount).toBe(2);
    expect(hunk.lines.map((l) => l.kind)).toEqual(["context", "remove", "add"]);
  });

  test("parses add-only (file creation): --- /dev/null", () => {
    const patch = "--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+line1\n+line2\n";
    const files = parseUnifiedDiff(patch);
    expect(files[0]?.oldPath).toBeNull();
    expect(files[0]?.newPath).toBe("new.txt");
  });

  test("parses multi-file patch", () => {
    const patch = [
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -1,1 +1,1 @@",
      "-one",
      "+two",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -1,1 +1,1 @@",
      "-three",
      "+four",
      "",
    ].join("\n");
    const files = parseUnifiedDiff(patch);
    expect(files.length).toBe(2);
    expect(files.map((f) => f.newPath)).toEqual(["a.ts", "b.ts"]);
  });

  test("rejects missing '+++ ' header", () => {
    const bad = "--- a/foo\n@@ -1,1 +1,1 @@\n-x\n+y\n";
    expect(() => parseUnifiedDiff(bad)).toThrow(PatchError);
  });

  test("rejects malformed hunk header", () => {
    const bad = "--- a/foo\n+++ b/foo\n@@ malformed @@\n x\n";
    expect(() => parseUnifiedDiff(bad)).toThrow(PatchError);
  });

  test("rejects EOF-truncated hunks with unsatisfied line counts", () => {
    const bad = "--- a/foo\n+++ b/foo\n@@ -1,2 +1,2 @@\n-old\n+new\n";
    expect(() => parseUnifiedDiff(bad)).toThrow(PatchError);
  });
});

describe("planApply — clean apply", () => {
  test("modifies a file in-place", () => {
    const ws = mkWorkspace({ "foo.txt": "hello\nworld\n" });
    const patch = "--- a/foo.txt\n+++ b/foo.txt\n@@ -1,2 +1,2 @@\n hello\n-world\n+earth\n";
    const plan = planApply({ workspace: ws, patch });
    expect(plan.files.length).toBe(1);
    const f = plan.files[0]!;
    expect(f.action).toBe("modify");
    expect(f.newContents).toBe("hello\nearth\n");
    expect(f.previousContents).toBe("hello\nworld\n");
  });

  test("creates a new file", () => {
    const ws = mkWorkspace({});
    const patch = "--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+first\n+second\n";
    const plan = planApply({ workspace: ws, patch });
    expect(plan.files[0]?.action).toBe("create");
    expect(plan.files[0]?.newContents).toBe("first\nsecond\n");
  });

  test("reverse patch of a modify restores the original text", () => {
    const ws = mkWorkspace({ "foo.txt": "hello\nworld\n" });
    const patch = "--- a/foo.txt\n+++ b/foo.txt\n@@ -1,2 +1,2 @@\n hello\n-world\n+earth\n";
    const plan = planApply({ workspace: ws, patch });
    // Write the new contents.
    writeFileSync(plan.files[0]!.path, plan.files[0]!.newContents!, "utf8");
    expect(readFileSync(plan.files[0]!.path, "utf8")).toBe("hello\nearth\n");
    // Apply the reverse patch.
    const reversePlan = planApply({ workspace: ws, patch: plan.reversePatch });
    writeFileSync(reversePlan.files[0]!.path, reversePlan.files[0]!.newContents!, "utf8");
    expect(readFileSync(plan.files[0]!.path, "utf8")).toBe("hello\nworld\n");
  });
});

describe("planApply — error paths", () => {
  test("path_missing: target file does not exist", () => {
    const ws = mkWorkspace({});
    const patch = "--- a/missing.txt\n+++ b/missing.txt\n@@ -1,1 +1,1 @@\n-x\n+y\n";
    try {
      planApply({ workspace: ws, patch });
      throw new Error("unreachable");
    } catch (err) {
      expect((err as PatchError).code).toBe("path_missing");
    }
  });

  test("patch_context_mismatch: file exists but context doesn't match", () => {
    const ws = mkWorkspace({ "foo.txt": "hello\nworld\n" });
    const patch = "--- a/foo.txt\n+++ b/foo.txt\n@@ -1,2 +1,2 @@\n hello\n-different\n+new\n";
    try {
      planApply({ workspace: ws, patch });
      throw new Error("unreachable");
    } catch (err) {
      expect((err as PatchError).code).toBe("patch_context_mismatch");
      expect((err as PatchError).detail.path).toBe("foo.txt");
    }
  });

  test("binary_file: refuses to patch a file with null bytes", () => {
    const ws = mkWorkspace({});
    const abs = path.join(ws, "bin.dat");
    const buf = new Uint8Array([0x00, 0x01, 0x02, 0x03]);
    writeFileSync(abs, buf);
    const patch = "--- a/bin.dat\n+++ b/bin.dat\n@@ -1,1 +1,1 @@\n-x\n+y\n";
    try {
      planApply({ workspace: ws, patch });
      throw new Error("unreachable");
    } catch (err) {
      expect((err as PatchError).code).toBe("binary_file");
    }
  });

  test("path_outside_workspace: ../ escape rejected", () => {
    const ws = mkWorkspace({});
    const patch = "--- a/../escape.txt\n+++ b/../escape.txt\n@@ -1,1 +1,1 @@\n-x\n+y\n";
    try {
      planApply({ workspace: ws, patch });
      throw new Error("unreachable");
    } catch (err) {
      expect((err as PatchError).code).toBe("path_outside_workspace");
    }
  });
});

describe("generateReversePatch", () => {
  test("modify patch produces a whole-file reverse", () => {
    const rp = generateReversePatch([
      {
        path: "/tmp/a",
        relPath: "a",
        action: "modify",
        previousContents: "one\ntwo\n",
        newContents: "one\nthree\n",
        encoding: "utf-8",
        hadBom: false,
        lineEnding: "lf",
      },
    ]);
    // Applying rp to current state should restore previous state; shape check.
    expect(rp).toContain("--- a/a");
    expect(rp).toContain("+++ b/a");
    expect(rp).toContain("-one");
    expect(rp).toContain("-three");
    expect(rp).toContain("+one");
    expect(rp).toContain("+two");
  });

  test("reverse patch preserves nested workspace-relative paths", () => {
    const ws = mkWorkspace({ "src/a.txt": "one\ntwo\n" });
    const plan = planApply({
      workspace: ws,
      patch: "--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1,2 +1,2 @@\n one\n-two\n+three\n",
    });
    expect(plan.reversePatch).toContain("--- a/src/a.txt");
    expect(plan.reversePatch).toContain("+++ b/src/a.txt");
  });

  test("create → reverse is delete", () => {
    const rp = generateReversePatch([
      {
        path: "/tmp/new",
        relPath: "new",
        action: "create",
        newContents: "hello\n",
        encoding: "utf-8",
        hadBom: false,
        lineEnding: "lf",
      },
    ]);
    expect(rp).toContain("+++ /dev/null");
  });
});
