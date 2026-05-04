import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { buildRepoMap } from "../src/repo-map.ts";
import { detectStack } from "../src/stack-detect.ts";

function tmpWorkspace(seed: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openapex-stack-"));
  for (const [rel, content] of Object.entries(seed)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

describe("detectStack", () => {
  test("python pytest + tsconfig + cargo", async () => {
    const ws = tmpWorkspace({
      "pyproject.toml": "",
      "tsconfig.json": "{}\n",
      "Cargo.toml": "[package]\nname = 'x'\n",
      "tests/test_x.py": "def test_a(): pass\n",
      "src/lib.rs": "// x",
      "src/main.ts": "export {};\n",
    });
    const map = await buildRepoMap({ workspace: ws });
    const stack = detectStack(ws, map);
    expect(stack.languages).toContain("python");
    expect(stack.languages).toContain("typescript");
    expect(stack.languages).toContain("rust");
    expect(stack.testFrameworks).toContain("pytest");
    expect(stack.testFrameworks).toContain("cargo-test");
    expect(stack.packageManagers).toContain("cargo");
    expect(stack.packageManagers).toContain("pip");
    expect(stack.buildSystems).toContain("tsc");
    expect(stack.keyConfigFiles).toContain("pyproject.toml");
    expect(stack.keyConfigFiles).toContain("Cargo.toml");
  });

  test("node with npm + jest config", async () => {
    const ws = tmpWorkspace({
      "package.json": JSON.stringify({ name: "x" }),
      "jest.config.ts": "export default {};\n",
      "src/index.ts": "export const x = 1;\n",
      "pnpm-lock.yaml": "",
    });
    const map = await buildRepoMap({ workspace: ws });
    const stack = detectStack(ws, map);
    expect(stack.packageManagers).toContain("npm");
    expect(stack.packageManagers).toContain("pnpm");
    expect(stack.testFrameworks).toContain("jest");
  });

  test("go + make", async () => {
    const ws = tmpWorkspace({
      "go.mod": "module example.com/x\n",
      Makefile: "test:\n\tgo test ./...\n",
      "main.go": "package main\nfunc main(){}\n",
    });
    const map = await buildRepoMap({ workspace: ws });
    const stack = detectStack(ws, map);
    expect(stack.packageManagers).toContain("go-modules");
    expect(stack.buildSystems).toContain("make");
    expect(stack.buildSystems).toContain("go");
    expect(stack.likelyEntrypoints).toContain("main.go");
  });
});
