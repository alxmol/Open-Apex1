/**
 * §M3 search canaries — Serper.dev primary + SerpAPI AI-Overview enrichment.
 *
 * Both canaries skip cleanly when the relevant key is absent. They hit real
 * SERP endpoints so the contamination blocklist + normalization code stays
 * honest against live payloads.
 */

import { runSearch, SerperProvider, SerpApiProvider } from "@open-apex/search";

import type { CanaryResult, CanarySpec } from "./types.ts";

function skip(reason: string, started: number): CanaryResult {
  return { outcome: "skip", reason, wallMs: Date.now() - started };
}
function pass(evidence: Record<string, unknown>, started: number): CanaryResult {
  return { outcome: "pass", evidence, wallMs: Date.now() - started };
}
function fail(reason: string, started: number): CanaryResult {
  return { outcome: "fail", reason, wallMs: Date.now() - started };
}

export const SEARCH_CANARIES: CanarySpec[] = [
  {
    id: "search-serper-live",
    provider: "external",
    description:
      "live Serper.dev /search normalizes into SearchResult[] with provenance + sourceTier",
    capability: "search.serper",
    milestone: "M3",
    estimatedCostUsd: 0.001,
    async run(): Promise<CanaryResult> {
      const started = Date.now();
      if (!process.env.SERPER_API_KEY) return skip("SERPER_API_KEY not set", started);
      try {
        const provider = new SerperProvider();
        const bundle = await runSearch("fastapi websockets", { provider }, { numResults: 5 });
        if (bundle.results.length === 0) {
          return fail("serper returned zero organic results", started);
        }
        const official = bundle.results.find((r) => r.sourceTier === "official_docs");
        return pass(
          {
            count: bundle.results.length,
            hasOfficial: Boolean(official),
            tiers: [...new Set(bundle.results.map((r) => r.sourceTier))],
          },
          started,
        );
      } catch (err) {
        return fail((err as Error).message.slice(0, 300), started);
      }
    },
  },
  {
    id: "search-serpapi-ai-overview",
    provider: "external",
    description:
      "live SerpAPI returns AI Overview content (inline text_blocks or deferred page_token)",
    capability: "search.serpapi_ai_overview",
    milestone: "M3",
    estimatedCostUsd: 0.015,
    async run(): Promise<CanaryResult> {
      const started = Date.now();
      if (!process.env.SERP_API_KEY && !process.env.SERPAPI_KEY) {
        return skip("SERP_API_KEY / SERPAPI_KEY not set", started);
      }
      try {
        const provider = new SerpApiProvider();
        const bundle = await runSearch(
          "what is asyncio in python",
          { provider },
          { numResults: 5, includeAiOverview: true },
        );
        const hasAiOverview = typeof bundle.aiOverview === "string" && bundle.aiOverview.length > 0;
        const anyResult = bundle.results.length > 0;
        if (!hasAiOverview && !anyResult) {
          return fail("serpapi returned neither ai_overview nor organic results", started);
        }
        return pass(
          {
            hasAiOverview,
            organic: bundle.results.length,
            aiOverviewLen: bundle.aiOverview?.length ?? 0,
          },
          started,
        );
      } catch (err) {
        return fail((err as Error).message.slice(0, 300), started);
      }
    },
  },
];
