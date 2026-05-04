/**
 * `runSearch` — the top-level entrypoint.
 *
 * Flow:
 *   1. Normalize query, check per-run cache (always-on) and optional persistent
 *      cache (dev only).
 *   2. Call primary `SearchProvider.search` (default Serper).
 *   3. Normalize raw payload → `SearchBundle`.
 *   4. If `includeAiOverview` + SerpAPI path + `page_token` present,
 *      redeem deferred overview (best-effort).
 *   5. Apply contamination blocklist when `benchmark: true`.
 *   6. Record into per-run cache.
 *
 * Multi-round: `runWebResearch` wraps `runSearch` with the §1.2 fetch budget
 * (r1=4 / r2=3 / r3=2) and pivots via `peopleAlsoAsk` + `relatedQueries`.
 */

import type { SearchProvider } from "./provider.ts";
import type {
  SearchBundle,
  SearchOptions,
  SearchResult,
  SerperRawPayload,
  SerpApiRawPayload,
} from "./types.ts";
import { normalizeSerper, normalizeSerpApi } from "./normalize.ts";
import {
  applyContaminationBlocklist,
  loadContaminationBlocklist,
  type ContaminationBlocklist,
  type ContaminationCandidate,
} from "./contamination.ts";
import { InMemorySearchCache } from "./cache.ts";

export interface RunSearchCtx {
  provider: SearchProvider;
  cache?: InMemorySearchCache;
  blocklist?: ContaminationBlocklist;
  /** Caller controls whether contamination filter runs. Benchmark mode: true. */
  benchmark?: boolean;
}

export async function runSearch(
  query: string,
  ctx: RunSearchCtx,
  opts: SearchOptions = {},
): Promise<SearchBundle> {
  const cache = ctx.cache ?? new InMemorySearchCache();
  const cached = cache.get(query);
  if (cached) return cached;

  const now = (opts.now ?? (() => new Date()))();
  const fetchedAt = now.toISOString();
  const raw = await ctx.provider.search(query, opts);
  let bundle =
    ctx.provider.id === "serper"
      ? normalizeSerper(query, raw as SerperRawPayload, { fetchedAt })
      : normalizeSerpApi(query, raw as SerpApiRawPayload, { fetchedAt });

  // SerpAPI deferred AI Overview redemption.
  if (
    ctx.provider.id === "serpapi" &&
    opts.includeAiOverview &&
    !bundle.aiOverview &&
    ctx.provider.aiOverview
  ) {
    const pageToken = (raw as SerpApiRawPayload).ai_overview?.page_token;
    if (pageToken) {
      try {
        const overview = await ctx.provider.aiOverview(pageToken, opts);
        if (overview) bundle = { ...bundle, aiOverview: overview };
      } catch {
        // Best-effort — stale token etc. Nothing to do.
      }
    }
  }

  // Contamination filter.
  if (ctx.benchmark) {
    const blocklist = ctx.blocklist ?? (await loadContaminationBlocklist());
    let blocked = 0;
    const outcome = applyContaminationBlocklist(bundle.results, {
      blocklist,
      mode: "benchmark",
    });
    blocked += outcome.removed.length;
    const aux = filterAuxiliaryContamination(bundle, blocklist);
    blocked += aux.blocked;
    bundle = {
      query: bundle.query,
      provider: bundle.provider,
      results: outcome.kept,
      relatedQueries: aux.patch.relatedQueries ?? [],
      peopleAlsoAsk: aux.patch.peopleAlsoAsk ?? [],
      blockedByContamination: blocked,
      roundsCompleted: bundle.roundsCompleted,
      fetchedAt: bundle.fetchedAt,
      ...(aux.patch.aiOverview !== undefined ? { aiOverview: aux.patch.aiOverview } : {}),
      ...(aux.patch.answerBox !== undefined ? { answerBox: aux.patch.answerBox } : {}),
      ...(aux.patch.knowledgeGraph !== undefined
        ? { knowledgeGraph: aux.patch.knowledgeGraph }
        : {}),
    };
  }

  cache.set(query, bundle);
  return bundle;
}

function filterAuxiliaryContamination(
  bundle: SearchBundle,
  blocklist: ContaminationBlocklist,
): {
  blocked: number;
  patch: AuxiliaryPatch;
} {
  let blocked = 0;
  const patch: AuxiliaryPatch = {};

  if (bundle.aiOverview !== undefined) {
    const kept = keepAux({ title: "AI Overview", snippet: bundle.aiOverview }, blocklist);
    if (kept) patch.aiOverview = bundle.aiOverview;
    else {
      patch.aiOverview = undefined;
      blocked++;
    }
  }
  if (bundle.answerBox !== undefined) {
    const kept = keepAux(
      {
        url: bundle.answerBox.link,
        title: bundle.answerBox.title ?? "Answer box",
        snippet: bundle.answerBox.snippet,
      },
      blocklist,
    );
    if (kept) patch.answerBox = bundle.answerBox;
    else {
      patch.answerBox = undefined;
      blocked++;
    }
  }
  if (bundle.knowledgeGraph !== undefined) {
    const kept = keepAux(
      {
        url: bundle.knowledgeGraph.sourceUrl,
        title: bundle.knowledgeGraph.title ?? "Knowledge graph",
        snippet: bundle.knowledgeGraph.description,
      },
      blocklist,
    );
    if (kept) patch.knowledgeGraph = bundle.knowledgeGraph;
    else {
      patch.knowledgeGraph = undefined;
      blocked++;
    }
  }

  const people = applyContaminationBlocklist(
    bundle.peopleAlsoAsk.map((p) => ({
      url: p.url,
      title: p.question,
      snippet: p.snippet,
      value: p,
    })),
    { blocklist, mode: "benchmark" },
  );
  patch.peopleAlsoAsk = people.kept.map((p) => p.value);
  blocked += people.removed.length;

  const related = applyContaminationBlocklist(
    bundle.relatedQueries.map((q) => ({ title: q, snippet: q, value: q })),
    { blocklist, mode: "benchmark" },
  );
  patch.relatedQueries = related.kept.map((q) => q.value);
  blocked += related.removed.length;

  return { blocked, patch };
}

interface AuxiliaryPatch {
  aiOverview?: SearchBundle["aiOverview"] | undefined;
  answerBox?: SearchBundle["answerBox"] | undefined;
  knowledgeGraph?: SearchBundle["knowledgeGraph"] | undefined;
  peopleAlsoAsk?: SearchBundle["peopleAlsoAsk"];
  relatedQueries?: SearchBundle["relatedQueries"];
}

function keepAux(candidate: ContaminationCandidate, blocklist: ContaminationBlocklist): boolean {
  const outcome = applyContaminationBlocklist([candidate], { blocklist, mode: "benchmark" });
  return outcome.kept.length === 1;
}

/**
 * Multi-round search: §1.2 budget r1=4 / r2=3 / r3=2 page fetches. We don't
 * fetch pages here — that's `fetch_url`'s job — but we surface candidate URLs
 * up to the budget so the caller can fan out. The driver pivots queries via
 * `peopleAlsoAsk` and `relatedQueries` when uncertainty remains.
 */
export interface RunWebResearchOpts extends SearchOptions {
  maxRounds?: 1 | 2 | 3;
}

export interface WebResearchResult {
  focusQuery: string;
  bundles: SearchBundle[];
  /** Unique candidate URLs across rounds, sorted by rankScore. */
  candidateUrls: SearchResult[];
  roundsCompleted: number;
}

export async function runWebResearch(
  focusQuery: string,
  ctx: RunSearchCtx,
  opts: RunWebResearchOpts = {},
): Promise<WebResearchResult> {
  const maxRounds = opts.maxRounds ?? 2;
  const budgets: Record<1 | 2 | 3, number> = { 1: 4, 2: 3, 3: 2 };
  const bundles: SearchBundle[] = [];
  const seen = new Set<string>();
  const ranked: SearchResult[] = [];
  let current = focusQuery;
  for (let round = 1 as 1 | 2 | 3; round <= maxRounds; round = (round + 1) as 1 | 2 | 3) {
    const bundle = await runSearch(current, ctx, opts);
    bundles.push(bundle);
    for (const r of bundle.results.slice(0, budgets[round])) {
      if (seen.has(r.url)) continue;
      seen.add(r.url);
      ranked.push(r);
    }
    // Pivot unless we've got strong answerBox or enough tier-1 hits.
    const strong = bundle.answerBox || bundle.results.some((r) => r.sourceTier === "official_docs");
    if (strong) break;
    const pivot = pickPivotQuery(bundle);
    if (!pivot || pivot === current) break;
    current = pivot;
  }
  ranked.sort((a, b) => b.rankScore - a.rankScore);
  return { focusQuery, bundles, candidateUrls: ranked, roundsCompleted: bundles.length };
}

function pickPivotQuery(bundle: SearchBundle): string | null {
  if (bundle.relatedQueries[0]) return bundle.relatedQueries[0];
  if (bundle.peopleAlsoAsk[0]?.question) return bundle.peopleAlsoAsk[0].question;
  return null;
}
