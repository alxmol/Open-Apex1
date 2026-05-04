import { describe, expect, test } from "bun:test";

import {
  detectLanguage,
  detectLanguageByPath,
  detectLanguageByShebang,
  SYMBOL_INDEXABLE_LANGUAGES,
  type IndexedLanguage,
} from "../src/language-detect.ts";

describe("detectLanguageByPath", () => {
  test.each([
    ["src/main.py", "python"],
    ["src/main.ts", "typescript"],
    ["src/App.tsx", "tsx"],
    ["foo.mjs", "javascript"],
    ["src/lib.rs", "rust"],
    ["main.go", "go"],
    ["install.sh", "bash"],
    ["foo.c", "c"],
    ["foo.cpp", "cpp"],
    ["app.rb", "ruby"],
    ["Main.java", "java"],
    ["lib.ml", "ocaml"],
    ["Makefile", "makefile"],
    ["Dockerfile", "dockerfile"],
  ])("%s → %s", (p, expected) => {
    expect(detectLanguageByPath(p)).toBe(expected as IndexedLanguage);
  });

  test("unknown extension returns undefined", () => {
    expect(detectLanguageByPath("weird.xyz")).toBeUndefined();
  });
});

describe("detectLanguageByShebang", () => {
  test("python3 shebang", () => {
    expect(detectLanguageByShebang("#!/usr/bin/env python3")).toBe("python");
  });
  test("bash shebang", () => {
    expect(detectLanguageByShebang("#!/bin/bash")).toBe("bash");
  });
  test("node shebang", () => {
    expect(detectLanguageByShebang("#!/usr/bin/env node")).toBe("javascript");
  });
  test("not a shebang", () => {
    expect(detectLanguageByShebang("plain text")).toBeUndefined();
  });
});

describe("detectLanguage falls back to shebang when extension unknown", () => {
  test("returns python via shebang", () => {
    expect(detectLanguage("/abs/script", "#!/usr/bin/env python3\nprint(1)")).toBe("python");
  });
});

describe("SYMBOL_INDEXABLE_LANGUAGES", () => {
  test("includes all tree-sitter-supported languages", () => {
    for (const lang of [
      "python",
      "typescript",
      "tsx",
      "javascript",
      "rust",
      "go",
      "bash",
      "c",
      "cpp",
      "ruby",
      "java",
      "ocaml",
    ] as const) {
      expect(SYMBOL_INDEXABLE_LANGUAGES).toContain(lang);
    }
  });
});
