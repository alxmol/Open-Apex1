import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { buildRepoMap, renderRepoMapSummary } from "../src/repo-map.ts";

function tmpWorkspace(seed: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openapex-indexer-"));
  for (const [rel, content] of Object.entries(seed)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

describe("buildRepoMap", () => {
  test("scans workspace, detects languages, computes totals", async () => {
    const ws = tmpWorkspace({
      "src/main.py": "print('hi')\n",
      "src/util.py": "x = 1\n",
      "pkg/index.ts": "export const a = 1;\n",
      "README.md": "# readme\n",
      "node_modules/bad/index.js": "// should be skipped\n",
      "dist/bad.js": "// skipped\n",
    });
    const map = await buildRepoMap({ workspace: ws });
    expect(map.totalFiles).toBe(4);
    expect(map.languageCounts.python).toBe(2);
    expect(map.languageCounts.typescript).toBe(1);
    expect(map.languageCounts.markdown).toBe(1);
    expect(map.truncated).toBe(false);
    expect(map.files.every((f) => !f.path.includes("node_modules"))).toBe(true);
  });

  test("respects .gitignore at root", async () => {
    const ws = tmpWorkspace({
      "src/ok.py": "x=1\n",
      "secret.txt": "hunter2\n",
      ".gitignore": "secret.txt\n*.log\nlogs/\n",
      "app.log": "log\n",
      "logs/yesterday.log": "log\n",
    });
    const map = await buildRepoMap({ workspace: ws });
    const paths = map.files.map((f) => f.path);
    expect(paths).toContain("src/ok.py");
    expect(paths).not.toContain("secret.txt");
    expect(paths.every((p) => !p.endsWith(".log"))).toBe(true);
    expect(paths.every((p) => !p.startsWith("logs/"))).toBe(true);
  });

  test("maxFiles truncates", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 10; i++) files[`src/f${i}.py`] = `# ${i}\n`;
    const ws = tmpWorkspace(files);
    const map = await buildRepoMap({ workspace: ws, maxFiles: 5 });
    expect(map.totalFiles).toBe(5);
    expect(map.truncated).toBe(true);
  });

  test("includeExtensions narrows output", async () => {
    const ws = tmpWorkspace({
      "src/a.py": "x=1\n",
      "src/b.ts": "export {};\n",
      "src/c.md": "# x\n",
    });
    const map = await buildRepoMap({
      workspace: ws,
      includeExtensions: [".py"],
    });
    expect(map.totalFiles).toBe(1);
    expect(map.files[0]!.path).toBe("src/a.py");
  });

  test("aborted signal exits promptly during traversal", async () => {
    const ws = tmpWorkspace({ "src/a.py": "x=1\n" });
    const controller = new AbortController();
    controller.abort(new Error("stop"));

    await expect(buildRepoMap({ workspace: ws, signal: controller.signal })).rejects.toThrow(
      "aborted",
    );
  });
});

describe("renderRepoMapSummary", () => {
  test("includes language summary + file list", async () => {
    const ws = tmpWorkspace({
      "src/main.py": "print('x')\n",
      "README.md": "# x\n",
    });
    const map = await buildRepoMap({ workspace: ws });
    const s = renderRepoMapSummary(map);
    expect(s).toContain("files: 2");
    expect(s).toContain("python=1");
    expect(s).toContain("src/main.py");
  });
});
