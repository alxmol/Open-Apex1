/**
 * Tree-sitter runtime bootstrap. Loads `web-tree-sitter` WASM once and
 * resolves grammar .wasm files out of the `tree-sitter-wasms` package.
 */

import { existsSync } from "node:fs";
import * as path from "node:path";

import { Parser, Language } from "web-tree-sitter";

import type { IndexedLanguage } from "../language-detect.ts";

let initPromise: Promise<void> | null = null;
const grammarCache = new Map<IndexedLanguage, Language>();

/** Map indexer languages to the tree-sitter-wasms grammar file stem. */
const GRAMMAR_FILE: Record<IndexedLanguage, string | null> = {
  python: "tree-sitter-python.wasm",
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  rust: "tree-sitter-rust.wasm",
  go: "tree-sitter-go.wasm",
  bash: "tree-sitter-bash.wasm",
  c: "tree-sitter-c.wasm",
  cpp: "tree-sitter-cpp.wasm",
  ruby: "tree-sitter-ruby.wasm",
  java: "tree-sitter-java.wasm",
  ocaml: "tree-sitter-ocaml.wasm",
  scheme: null,
  html: null,
  css: null,
  json: null,
  toml: null,
  yaml: null,
  markdown: null,
  makefile: null,
  dockerfile: null,
};

export async function ensureParserInit(): Promise<void> {
  if (!initPromise) {
    initPromise = Parser.init({
      locateFile(fileName: string) {
        return resolveRuntimeWasmPath(fileName);
      },
    });
  }
  return initPromise;
}

function resolveRuntimeWasmPath(fileName: string): string {
  const assetsRoot = process.env.OPEN_APEX_ASSETS_DIR;
  if (assetsRoot) {
    // Installed-agent runs upload web-tree-sitter's runtime WASM outside the
    // bundled JS file. Emscripten may ask for either old or new package names,
    // so check both before falling back to the requested filename.
    const runtimeDir = path.join(assetsRoot, "web-tree-sitter");
    const candidates = [
      path.join(runtimeDir, fileName),
      path.join(runtimeDir, "web-tree-sitter.wasm"),
      path.join(runtimeDir, "tree-sitter.wasm"),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
  }
  for (const spec of [
    `web-tree-sitter/${fileName}`,
    "web-tree-sitter/web-tree-sitter.wasm",
    "web-tree-sitter/tree-sitter.wasm",
  ]) {
    try {
      const resolved = Bun.resolveSync(spec, import.meta.dir);
      if (existsSync(resolved)) return resolved;
    } catch {
      // Try the next package-version runtime filename.
    }
  }
  return fileName;
}

/** Test utility: expose installed-agent asset lookup without initializing WASM. */
export function __resolveRuntimeWasmPathForTest(fileName: string): string {
  return resolveRuntimeWasmPath(fileName);
}

/** Resolve a grammar .wasm file path via installed assets, then Bun's module resolver. */
function resolveGrammarPath(fileName: string): string {
  const assetsRoot = process.env.OPEN_APEX_ASSETS_DIR;
  if (assetsRoot) {
    const candidate = path.join(assetsRoot, "tree-sitter-wasms", "out", fileName);
    if (existsSync(candidate)) return candidate;
  }
  const spec = `tree-sitter-wasms/out/${fileName}`;
  // Bun.resolveSync knows where workspace-installed node_modules live.
  return Bun.resolveSync(spec, import.meta.dir);
}

/** Test utility: expose grammar lookup without loading a Language object. */
export function __resolveGrammarPathForTest(fileName: string): string {
  return resolveGrammarPath(fileName);
}

export async function loadGrammar(lang: IndexedLanguage): Promise<Language | null> {
  const file = GRAMMAR_FILE[lang];
  if (!file) return null;
  const cached = grammarCache.get(lang);
  if (cached) return cached;
  await ensureParserInit();
  const wasmPath = resolveGrammarPath(file);
  const language = await Language.load(wasmPath);
  grammarCache.set(lang, language);
  return language;
}

/** Test utility: clear the grammar cache (forces re-load). */
export function __resetGrammarCacheForTest(): void {
  grammarCache.clear();
}

/** Set of languages the indexer can currently parse. */
export const TREE_SITTER_LANGUAGES: readonly IndexedLanguage[] = Object.freeze(
  (Object.entries(GRAMMAR_FILE) as Array<[IndexedLanguage, string | null]>)
    .filter(([, v]) => v !== null)
    .map(([k]) => k),
);
