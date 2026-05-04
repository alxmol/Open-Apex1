/**
 * Language detection by extension and shebang.
 *
 * Feeds `RepoMap.files[].language` + symbol-index targeting. Covers the
 * languages that appear in the TB2 task inventory plus common friends.
 */

import * as path from "node:path";

export type IndexedLanguage =
  | "python"
  | "typescript"
  | "tsx"
  | "javascript"
  | "rust"
  | "go"
  | "bash"
  | "c"
  | "cpp"
  | "ruby"
  | "java"
  | "ocaml"
  | "scheme"
  | "html"
  | "css"
  | "json"
  | "toml"
  | "yaml"
  | "markdown"
  | "makefile"
  | "dockerfile";

const EXTENSION_MAP: ReadonlyMap<string, IndexedLanguage> = new Map([
  [".py", "python"],
  [".pyi", "python"],
  [".ipynb", "python"],
  [".ts", "typescript"],
  [".mts", "typescript"],
  [".cts", "typescript"],
  [".tsx", "tsx"],
  [".js", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".jsx", "javascript"],
  [".rs", "rust"],
  [".go", "go"],
  [".sh", "bash"],
  [".bash", "bash"],
  [".zsh", "bash"],
  [".c", "c"],
  [".h", "c"],
  [".cc", "cpp"],
  [".cpp", "cpp"],
  [".cxx", "cpp"],
  [".hh", "cpp"],
  [".hpp", "cpp"],
  [".rb", "ruby"],
  [".java", "java"],
  [".ml", "ocaml"],
  [".mli", "ocaml"],
  [".scm", "scheme"],
  [".ss", "scheme"],
  [".rkt", "scheme"],
  [".html", "html"],
  [".htm", "html"],
  [".css", "css"],
  [".json", "json"],
  [".toml", "toml"],
  [".yml", "yaml"],
  [".yaml", "yaml"],
  [".md", "markdown"],
  [".markdown", "markdown"],
]);

// Matches common shebang forms like `#!/usr/bin/env python3` or `#!/bin/bash`.
// We look for the interpreter name anywhere after `#!` with a word boundary.
const SHEBANG_MAP: ReadonlyArray<[RegExp, IndexedLanguage]> = [
  [/^#!.*\bpython\d*\b/i, "python"],
  [/^#!.*\b(?:bash|zsh|ksh|dash)\b/i, "bash"],
  [/^#!\/(?:bin|usr\/bin)\/sh\b/i, "bash"],
  [/^#!.*\bnode\b/i, "javascript"],
  [/^#!.*\bruby\b/i, "ruby"],
  [/^#!.*\bocaml\b/i, "ocaml"],
];

/** Filename-only matches (no extension) — Makefile, Dockerfile, etc. */
const FILENAME_MAP: ReadonlyMap<string, IndexedLanguage> = new Map([
  ["Makefile", "makefile"],
  ["makefile", "makefile"],
  ["GNUmakefile", "makefile"],
  ["Dockerfile", "dockerfile"],
]);

export function detectLanguageByPath(absPath: string): IndexedLanguage | undefined {
  const base = path.basename(absPath);
  const filename = FILENAME_MAP.get(base);
  if (filename) return filename;
  const ext = path.extname(absPath).toLowerCase();
  return EXTENSION_MAP.get(ext);
}

/** Given the first line of a file, infer language from shebang. */
export function detectLanguageByShebang(firstLine: string): IndexedLanguage | undefined {
  for (const [re, lang] of SHEBANG_MAP) {
    if (re.test(firstLine)) return lang;
  }
  return undefined;
}

/**
 * Best-effort detect from path + (optional) first bytes. `contentHead` is the
 * first ~512 bytes as UTF-8 text; only used when the extension gives no hint.
 */
export function detectLanguage(absPath: string, contentHead?: string): IndexedLanguage | undefined {
  const fromPath = detectLanguageByPath(absPath);
  if (fromPath) return fromPath;
  if (contentHead) {
    const firstLine = contentHead.split(/\r?\n/, 1)[0] ?? "";
    const fromShebang = detectLanguageByShebang(firstLine);
    if (fromShebang) return fromShebang;
  }
  return undefined;
}

/** Languages the symbol indexer can parse with tree-sitter today. */
export const SYMBOL_INDEXABLE_LANGUAGES: ReadonlyArray<IndexedLanguage> = Object.freeze([
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
]);
