import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import type { OpenApexRunContext } from "@open-apex/core";
import { repoMapTool } from "../src/tools/repo_map.ts";

function tmpWorkspace(seed: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openapex-toolsrepomap-"));
  for (const [rel, content] of Object.entries(seed)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

function makeCtx(workspace: string): OpenApexRunContext {
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    thinkingTokens: 0,
    cachedInputTokens: 0,
  };
  return {
    userContext: {
      workspace,
      openApexHome: "/tmp",
      autonomyLevel: "full_auto",
      sessionId: "t",
    },
    runId: "r",
    signal: new AbortController().signal,
    usage,
  };
}

describe("repo_map tool", () => {
  test("returns summary + language counts", async () => {
    const ws = tmpWorkspace({
      "src/main.py": "print('x')\n",
      "README.md": "# x\n",
    });
    const res = await repoMapTool.execute({}, makeCtx(ws), new AbortController().signal);
    expect(res.isError).toBeFalsy();
    const payload = res.content as {
      totalFiles: number;
      languageCounts: Record<string, number>;
      summary: string;
    };
    expect(payload.totalFiles).toBe(2);
    expect(payload.languageCounts.python).toBe(1);
    expect(payload.summary).toContain("python=1");
  });

  test("respects includeExtensions", async () => {
    const ws = tmpWorkspace({
      "src/a.py": "x=1\n",
      "src/b.ts": "export {};\n",
    });
    const res = await repoMapTool.execute(
      { includeExtensions: [".py"] },
      makeCtx(ws),
      new AbortController().signal,
    );
    const payload = res.content as { totalFiles: number; languageCounts: Record<string, number> };
    expect(payload.totalFiles).toBe(1);
    expect(payload.languageCounts.python).toBe(1);
  });
});
