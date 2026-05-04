import { describe, expect, test } from "bun:test";

import { SerperProvider } from "../src/serper.ts";
import { SerpApiProvider } from "../src/serpapi.ts";
import { runSearch, runWebResearch } from "../src/run-search.ts";
import { InMemorySearchCache } from "../src/cache.ts";
import { loadContaminationBlocklist } from "../src/contamination.ts";
import type { FetchLike, SerperRawPayload, SerpApiRawPayload } from "../src/types.ts";

function mockFetchJson(payload: unknown, status = 200): FetchLike {
  return async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
}

describe("runSearch — Serper primary path", () => {
  test("normalizes + caches + passes through when benchmark=false", async () => {
    const payload: SerperRawPayload = {
      organic: [
        {
          title: "Django docs",
          link: "https://docs.djangoproject.com/en/5.0/",
          snippet: "Django documentation.",
          position: 1,
        },
      ],
    };
    const provider = new SerperProvider({
      apiKey: "test",
      fetchImpl: mockFetchJson(payload),
    });
    const cache = new InMemorySearchCache();
    const bundle = await runSearch("django docs", { provider, cache });
    expect(bundle.results).toHaveLength(1);
    expect(bundle.results[0]!.sourceTier).toBe("official_docs");
    expect(cache.size()).toBe(1);

    // Second call returns cached result without hitting the provider.
    let hit = false;
    const provider2 = new SerperProvider({
      apiKey: "test",
      fetchImpl: (async () => {
        hit = true;
        throw new Error("should not fire");
      }) as FetchLike,
    });
    await runSearch("django docs", { provider: provider2, cache });
    expect(hit).toBe(false);
  });

  test("benchmark mode strips blocklisted results", async () => {
    const payload: SerperRawPayload = {
      organic: [
        {
          title: "Leaderboard — Terminal-Bench",
          link: "https://www.tbench.ai/leaderboard/terminal-bench/2.0",
          snippet: "Full TB2 leaderboard.",
          position: 1,
        },
        {
          title: "Official Docs",
          link: "https://docs.python.org/3/",
          snippet: "Python docs.",
          position: 2,
        },
      ],
    };
    const provider = new SerperProvider({ apiKey: "x", fetchImpl: mockFetchJson(payload) });
    const blocklist = await loadContaminationBlocklist();
    const bundle = await runSearch(
      "terminal-bench leaderboard",
      { provider, benchmark: true, blocklist },
      {},
    );
    expect(bundle.blockedByContamination).toBeGreaterThanOrEqual(1);
    expect(bundle.results.every((r) => !r.url.includes("tbench.ai"))).toBe(true);
  });

  test("benchmark mode strips contaminated auxiliary search text", async () => {
    const payload: SerperRawPayload = {
      organic: [
        {
          title: "Official Docs",
          link: "https://docs.python.org/3/",
          snippet: "Python docs.",
          position: 1,
        },
      ],
      aiOverview: { text: "Walkthrough for hf-model-inference." },
      answerBox: { title: "Answer", snippet: "crack-7z-hash notes" },
      knowledgeGraph: {
        title: "KG",
        description: "fix-git solution",
        website: "https://example.com",
      },
      peopleAlsoAsk: [{ question: "What is this?", snippet: "overfull-hbox detail" }],
      relatedSearches: [{ query: "gcode-to-text" }],
    };
    const provider = new SerperProvider({ apiKey: "x", fetchImpl: mockFetchJson(payload) });
    const blocklist = await loadContaminationBlocklist();
    const bundle = await runSearch("safe query", { provider, benchmark: true, blocklist }, {});
    expect(bundle.results).toHaveLength(1);
    expect(bundle.aiOverview).toBeUndefined();
    expect(bundle.answerBox).toBeUndefined();
    expect(bundle.knowledgeGraph).toBeUndefined();
    expect(bundle.peopleAlsoAsk).toHaveLength(0);
    expect(bundle.relatedQueries).toHaveLength(0);
    expect(bundle.blockedByContamination).toBeGreaterThanOrEqual(5);
  });

  test("benchmark mode preserves clean auxiliary search text", async () => {
    const payload: SerperRawPayload = {
      organic: [
        {
          title: "Official Docs",
          link: "https://docs.python.org/3/",
          snippet: "Python docs.",
          position: 1,
        },
      ],
      aiOverview: { text: "Python has excellent standard library documentation." },
      answerBox: { title: "Python", snippet: "General Python documentation." },
      knowledgeGraph: { title: "Python", description: "A programming language." },
      peopleAlsoAsk: [{ question: "Where are docs?", snippet: "The official docs site." }],
      relatedSearches: [{ query: "python standard library docs" }],
    };
    const provider = new SerperProvider({ apiKey: "x", fetchImpl: mockFetchJson(payload) });
    const blocklist = await loadContaminationBlocklist();
    const bundle = await runSearch("python docs", { provider, benchmark: true, blocklist }, {});
    expect(bundle.aiOverview).toBeDefined();
    expect(bundle.answerBox).toBeDefined();
    expect(bundle.knowledgeGraph).toBeDefined();
    expect(bundle.peopleAlsoAsk).toHaveLength(1);
    expect(bundle.relatedQueries).toHaveLength(1);
    expect(bundle.blockedByContamination).toBe(0);
  });

  test("SerpAPI + includeAiOverview redeems page_token", async () => {
    const first: SerpApiRawPayload = {
      organic_results: [
        { title: "X", link: "https://docs.python.org/3/", snippet: "s", position: 1 },
      ],
      ai_overview: { page_token: "TOK" },
    };
    const second = {
      ai_overview: {
        text_blocks: [{ snippet: "Fetched overview text." }],
      },
    };
    let call = 0;
    const mock: FetchLike = async (url) => {
      call++;
      if (call === 1) {
        expect(String(url)).toContain("engine=google");
        return new Response(JSON.stringify(first), { status: 200 });
      }
      expect(String(url)).toContain("engine=google_ai_overview");
      return new Response(JSON.stringify(second), { status: 200 });
    };
    const provider = new SerpApiProvider({ apiKey: "x", fetchImpl: mock });
    const bundle = await runSearch(
      "python asyncio overview",
      { provider },
      { includeAiOverview: true },
    );
    expect(bundle.aiOverview).toBe("Fetched overview text.");
    expect(call).toBe(2);
  });
});

describe("runWebResearch — multi-round budget", () => {
  test("stops early on official_docs hit in round 1", async () => {
    const payload: SerperRawPayload = {
      organic: [
        {
          title: "Official",
          link: "https://docs.python.org/3/",
          snippet: "s",
          position: 1,
        },
      ],
      relatedSearches: [{ query: "pivot" }],
    };
    let calls = 0;
    const mock: FetchLike = async () => {
      calls++;
      return new Response(JSON.stringify(payload), { status: 200 });
    };
    const provider = new SerperProvider({ apiKey: "x", fetchImpl: mock });
    const r = await runWebResearch("asyncio primer", { provider }, { maxRounds: 2 });
    expect(r.roundsCompleted).toBe(1);
    expect(calls).toBe(1);
  });

  test("pivots to related query for round 2 when no tier-1 hit", async () => {
    const round1: SerperRawPayload = {
      organic: [
        {
          title: "Medium post",
          link: "https://foo.medium.com/x",
          snippet: "s",
          position: 1,
        },
      ],
      relatedSearches: [{ query: "better query" }],
    };
    const round2: SerperRawPayload = {
      organic: [
        {
          title: "StackOverflow",
          link: "https://stackoverflow.com/q/1",
          snippet: "s",
          position: 1,
        },
      ],
    };
    let call = 0;
    const mock: FetchLike = async (_url, init) => {
      call++;
      const body = init?.body as string | undefined;
      if (call === 1) {
        expect(body).toContain("asyncio primer");
        return new Response(JSON.stringify(round1), { status: 200 });
      }
      expect(body).toContain("better query");
      return new Response(JSON.stringify(round2), { status: 200 });
    };
    const provider = new SerperProvider({ apiKey: "x", fetchImpl: mock });
    const r = await runWebResearch("asyncio primer", { provider }, { maxRounds: 2 });
    expect(r.roundsCompleted).toBe(2);
    expect(r.candidateUrls.some((u) => u.url.includes("stackoverflow.com"))).toBe(true);
  });
});
