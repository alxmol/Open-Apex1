import { describe, expect, test, afterEach } from "bun:test";

import type { OpenApexRunContext } from "@open-apex/core";
import { SerperProvider } from "@open-apex/search";
import type { FetchLike, SerperRawPayload } from "@open-apex/search";

import { webSearchTool, __setSearchProviderFactoryForTest } from "../src/tools/web_search.ts";

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
      sessionId: "test",
    },
    runId: "r1",
    signal: new AbortController().signal,
    usage,
  };
}

afterEach(() => {
  __setSearchProviderFactoryForTest(null);
});

describe("web_search tool", () => {
  test("unconfigured factory → search_disabled", async () => {
    __setSearchProviderFactoryForTest(null);
    const res = await webSearchTool.execute(
      { query: "asyncio" },
      makeCtx("/tmp"),
      new AbortController().signal,
    );
    expect(res.isError).toBe(true);
    expect(res.errorType).toBe("search_disabled");
  });

  test("returns rendered ContentPart[] from mocked Serper", async () => {
    const payload: SerperRawPayload = {
      organic: [
        {
          title: "Django docs",
          link: "https://docs.djangoproject.com/en/5.0/",
          snippet: "Django docs.",
          position: 1,
        },
      ],
    };
    const mockFetch: FetchLike = async () => new Response(JSON.stringify(payload), { status: 200 });
    __setSearchProviderFactoryForTest(() => ({
      provider: new SerperProvider({ apiKey: "test", fetchImpl: mockFetch }),
      benchmark: false,
    }));
    const res = await webSearchTool.execute(
      { query: "django docs", numResults: 3 },
      makeCtx("/tmp"),
      new AbortController().signal,
    );
    expect(res.isError).toBeFalsy();
    expect(Array.isArray(res.content)).toBe(true);
    const parts = res.content as unknown[];
    expect(parts.length).toBeGreaterThan(0);
    const first = parts.find((p) => (p as { type: string }).type === "search_result") as
      | { type: string; url: string; title: string }
      | undefined;
    expect(first).toBeDefined();
    expect(first?.url).toContain("djangoproject.com");
    expect((res.metadata as { kept: number }).kept).toBe(1);
  });

  test("benchmark mode strips contaminated results", async () => {
    const payload: SerperRawPayload = {
      organic: [
        {
          title: "Leaderboard Terminal-Bench",
          link: "https://www.tbench.ai/leaderboard/terminal-bench/2.0",
          snippet: "full TB2 leaderboard",
          position: 1,
        },
        {
          title: "Good result",
          link: "https://docs.python.org/3/",
          snippet: "docs.",
          position: 2,
        },
      ],
    };
    const mockFetch: FetchLike = async () => new Response(JSON.stringify(payload), { status: 200 });
    __setSearchProviderFactoryForTest(() => ({
      provider: new SerperProvider({ apiKey: "x", fetchImpl: mockFetch }),
      benchmark: true,
    }));
    const res = await webSearchTool.execute(
      { query: "terminal-bench leaderboard" },
      makeCtx("/tmp"),
      new AbortController().signal,
    );
    expect((res.metadata as { blocked: number }).blocked).toBeGreaterThan(0);
    const parts = res.content as Array<{ type: string; url?: string }>;
    const urls = parts.filter((p) => p.type === "search_result").map((p) => p.url ?? "");
    expect(urls.every((u) => !u.includes("tbench.ai"))).toBe(true);
  });

  test("provider throw surfaces as search_failed", async () => {
    __setSearchProviderFactoryForTest(() => ({
      provider: new SerperProvider({
        apiKey: "x",
        fetchImpl: (async () => {
          throw new Error("timeout");
        }) as FetchLike,
      }),
      benchmark: false,
    }));
    const res = await webSearchTool.execute(
      { query: "boom" },
      makeCtx("/tmp"),
      new AbortController().signal,
    );
    expect(res.isError).toBe(true);
    expect(res.errorType).toBe("search_failed");
  });
});
