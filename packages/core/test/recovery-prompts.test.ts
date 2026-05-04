/**
 * §7.6.3 recovery prompt library loader tests.
 *
 * Covers: every declared key loads + fills placeholders. No live consumer
 * at M2; M4 recovery engine will consume these.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
  __clearRecoveryPromptCacheForTest,
  fillRecoveryPrompt,
  loadRecoveryPrompt,
  type RecoveryPromptKey,
} from "../src/prompts/recovery/index.ts";

const ALL_KEYS: RecoveryPromptKey[] = [
  "syntax_error",
  "import_error",
  "path_not_found",
  "permission_denied",
  "patch_apply_failed",
  "shell_timeout",
  "test_failure",
];

describe("recovery prompt loader (\u00a77.6.3)", () => {
  for (const key of ALL_KEYS) {
    test(`loads ${key} literal`, () => {
      const txt = loadRecoveryPrompt(key);
      expect(txt.length).toBeGreaterThan(50);
    });
  }

  test("fills placeholders without touching unrelated tokens", () => {
    const filled = fillRecoveryPrompt("syntax_error", {
      language: "python",
      error_excerpt: "SyntaxError: invalid syntax",
      path: "src/foo.py",
      excerpt: "line 5: def bar(\nline 6:    ...",
    });
    expect(filled).toContain("python");
    expect(filled).toContain("SyntaxError: invalid syntax");
    expect(filled).toContain("src/foo.py");
  });

  test("caches subsequent loads", () => {
    const a = loadRecoveryPrompt("patch_apply_failed");
    const b = loadRecoveryPrompt("patch_apply_failed");
    expect(a).toBe(b);
  });

  test("prefers OPEN_APEX_PROMPTS_DIR/recovery in installed-agent bundles", () => {
    const prompts = mkdtempSync(path.join(tmpdir(), "openapex-prompts-"));
    mkdirSync(path.join(prompts, "recovery"), { recursive: true });
    writeFileSync(
      path.join(prompts, "recovery", "test_failure.md"),
      "override test failure prompt with enough content to pass sanity checks\n",
    );
    const previous = process.env.OPEN_APEX_PROMPTS_DIR;
    process.env.OPEN_APEX_PROMPTS_DIR = prompts;
    __clearRecoveryPromptCacheForTest();
    try {
      expect(loadRecoveryPrompt("test_failure")).toContain("override test failure prompt");
    } finally {
      if (previous === undefined) delete process.env.OPEN_APEX_PROMPTS_DIR;
      else process.env.OPEN_APEX_PROMPTS_DIR = previous;
      __clearRecoveryPromptCacheForTest();
    }
  });
});
