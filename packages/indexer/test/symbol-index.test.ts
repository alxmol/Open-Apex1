import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
  createEmptySymbolIndex,
  findSymbols,
  indexBatch,
  indexFile,
  symbolIndexStats,
} from "../src/symbol-index.ts";
import {
  __resolveGrammarPathForTest,
  __resolveRuntimeWasmPathForTest,
} from "../src/tree-sitter/init.ts";

function tmpWorkspace(seed: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openapex-symbols-"));
  for (const [rel, content] of Object.entries(seed)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

describe("tree-sitter installed-agent asset lookup", () => {
  test("prefers OPEN_APEX_ASSETS_DIR for runtime and grammar WASM files", () => {
    const assets = mkdtempSync(path.join(tmpdir(), "openapex-assets-"));
    mkdirSync(path.join(assets, "web-tree-sitter"), { recursive: true });
    mkdirSync(path.join(assets, "tree-sitter-wasms", "out"), { recursive: true });
    const runtime = path.join(assets, "web-tree-sitter", "web-tree-sitter.wasm");
    const grammar = path.join(assets, "tree-sitter-wasms", "out", "tree-sitter-python.wasm");
    writeFileSync(runtime, "wasm");
    writeFileSync(grammar, "wasm");
    const previous = process.env.OPEN_APEX_ASSETS_DIR;
    process.env.OPEN_APEX_ASSETS_DIR = assets;
    try {
      expect(__resolveRuntimeWasmPathForTest("tree-sitter.wasm")).toBe(runtime);
      expect(__resolveGrammarPathForTest("tree-sitter-python.wasm")).toBe(grammar);
    } finally {
      if (previous === undefined) delete process.env.OPEN_APEX_ASSETS_DIR;
      else process.env.OPEN_APEX_ASSETS_DIR = previous;
    }
  });
});

describe("symbol-index: Python", () => {
  test("indexes functions and classes", async () => {
    const ws = tmpWorkspace({
      "app.py": [
        "def greet(name):",
        "    return f'hi {name}'",
        "",
        "class Calculator:",
        "    def add(self, a, b):",
        "        return a + b",
        "",
      ].join("\n"),
    });
    const idx = createEmptySymbolIndex(ws);
    const count = await indexFile(idx, "app.py");
    expect(count).toBeGreaterThanOrEqual(2);
    const matches = findSymbols(idx, "greet");
    expect(matches[0]!.name).toBe("greet");
    expect(matches[0]!.kind).toBe("function");
    expect(findSymbols(idx, "Calculator")[0]!.kind).toBe("class");
  });

  test("re-index is no-op when mtime + size unchanged", async () => {
    const ws = tmpWorkspace({
      "a.py": "def x(): pass\n",
    });
    const idx = createEmptySymbolIndex(ws);
    await indexFile(idx, "a.py");
    const statsBefore = idx.fileStats.get("a.py")!;
    await indexFile(idx, "a.py");
    const statsAfter = idx.fileStats.get("a.py")!;
    expect(statsAfter.mtimeMs).toBe(statsBefore.mtimeMs);
    expect(statsAfter.symbolCount).toBe(1);
  });
});

describe("symbol-index: TypeScript + Rust + Go", () => {
  test("captures TS class/interface/type/function", async () => {
    const ws = tmpWorkspace({
      "a.ts": [
        "export function hello(): number { return 1; }",
        "export class Foo { bar(): void {} }",
        "export interface Baz { q: number; }",
        "export type Id = string;",
        "",
      ].join("\n"),
    });
    const idx = createEmptySymbolIndex(ws);
    await indexFile(idx, "a.ts");
    const stats = symbolIndexStats(idx);
    expect(stats.symbolCount).toBeGreaterThanOrEqual(4);
    expect(stats.indexedLanguages).toContain("typescript");
    expect(findSymbols(idx, "Foo")[0]!.kind).toBe("class");
    expect(findSymbols(idx, "Baz")[0]!.kind).toBe("interface");
    expect(findSymbols(idx, "Id")[0]!.kind).toBe("type");
  });

  test("rust struct + trait + function", async () => {
    const ws = tmpWorkspace({
      "lib.rs": [
        'pub fn greet(name: &str) -> String { format!("hi {}", name) }',
        "pub struct Calc;",
        "pub trait Adder { fn add(&self, a: i32, b: i32) -> i32; }",
        "",
      ].join("\n"),
    });
    const idx = createEmptySymbolIndex(ws);
    await indexFile(idx, "lib.rs");
    expect(findSymbols(idx, "greet")[0]!.kind).toBe("function");
    expect(findSymbols(idx, "Calc")[0]!.kind).toBe("struct");
    expect(findSymbols(idx, "Adder")[0]!.kind).toBe("trait");
  });

  test("go func + type", async () => {
    const ws = tmpWorkspace({
      "main.go": ["package main", "func Hello() {}", "type User struct { ID int }", ""].join("\n"),
    });
    const idx = createEmptySymbolIndex(ws);
    await indexFile(idx, "main.go");
    expect(findSymbols(idx, "Hello")[0]!.kind).toBe("function");
    expect(findSymbols(idx, "User")[0]!.kind).toBe("type");
  });
});

describe("indexBatch + findSymbols", () => {
  test("aborted signal exits promptly without throwing", async () => {
    const ws = tmpWorkspace({
      "a.py": "def compute(): pass\n",
      "b.ts": "export function computeAll() { return 0; }\n",
    });
    const idx = createEmptySymbolIndex(ws);
    const controller = new AbortController();
    controller.abort();

    const total = await indexBatch(idx, ["a.py", "b.ts"], { signal: controller.signal });

    expect(total).toBe(0);
    expect(symbolIndexStats(idx).symbolCount).toBe(0);
  });

  test("indexes a multi-language workspace and ranks exact matches first", async () => {
    const ws = tmpWorkspace({
      "a.py": "def compute(): pass\n",
      "b.ts": "export function computeAll() { return 0; }\n",
      "c.go": "package main\nfunc compute() {}\n",
    });
    const idx = createEmptySymbolIndex(ws);
    const total = await indexBatch(idx, ["a.py", "b.ts", "c.go"]);
    expect(total).toBe(3);
    const matches = findSymbols(idx, "compute", { limit: 10 });
    expect(matches[0]!.name).toBe("compute");
    expect(matches.some((m) => m.name === "computeAll")).toBe(true);
    expect(matches[0]!.score).toBe(1);
  });

  test("kind filter narrows to that kind only", async () => {
    const ws = tmpWorkspace({
      "a.ts": "class Foo {}\nfunction foo() {}\n",
    });
    const idx = createEmptySymbolIndex(ws);
    await indexFile(idx, "a.ts");
    const classes = findSymbols(idx, "foo", { kind: "class" });
    expect(classes.every((m) => m.kind === "class")).toBe(true);
    expect(classes.map((m) => m.name)).toContain("Foo");
  });
});
