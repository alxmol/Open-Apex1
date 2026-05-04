import { describe, expect, test, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import type { OpenApexRunContext } from "@open-apex/core";
import { symbolLookupTool, __resetSymbolIndexCacheForTest } from "../src/tools/symbol_lookup.ts";

function tmpWorkspace(seed: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openapex-toolsym-"));
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

afterEach(() => __resetSymbolIndexCacheForTest());

describe("symbol_lookup tool", () => {
  test("finds a python class across workspace", async () => {
    const ws = tmpWorkspace({
      "pkg/__init__.py": "",
      "pkg/core.py": [
        "def helper():",
        "    return 1",
        "",
        "class Orchestrator:",
        "    def run(self): pass",
        "",
      ].join("\n"),
      "pkg/other.py": "class Unrelated: pass\n",
    });
    const res = await symbolLookupTool.execute(
      { symbol: "Orchestrator" },
      makeCtx(ws),
      new AbortController().signal,
    );
    expect(res.isError).toBeFalsy();
    const payload = res.content as {
      matches: Array<{ name: string; kind: string; path: string }>;
    };
    expect(payload.matches[0]!.name).toBe("Orchestrator");
    expect(payload.matches[0]!.kind).toBe("class");
    expect(payload.matches[0]!.path).toBe("pkg/core.py");
  });

  test("kind filter narrows results", async () => {
    const ws = tmpWorkspace({
      "a.ts": "export function Foo() {} class Foo {}\n",
    });
    const res = await symbolLookupTool.execute(
      { symbol: "Foo", kind: "class" },
      makeCtx(ws),
      new AbortController().signal,
    );
    const payload = res.content as { matches: Array<{ kind: string }> };
    expect(payload.matches.every((m) => m.kind === "class")).toBe(true);
  });

  test("no match returns symbol_not_found with index stats", async () => {
    const ws = tmpWorkspace({
      "a.py": "x = 1\n",
    });
    const res = await symbolLookupTool.execute(
      { symbol: "DoesNotExist" },
      makeCtx(ws),
      new AbortController().signal,
    );
    expect(res.isError).toBe(true);
    expect(res.errorType).toBe("symbol_not_found");
  });
});
