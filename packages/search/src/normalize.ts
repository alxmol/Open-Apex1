/**
 * Normalize Serper / SerpAPI raw payloads into `SearchBundle`.
 *
 * Per §1.2 we return:
 *   - organic results as `SearchResult[]` with provenance + rank score
 *   - answerBox when present (rendered separately so the model can cite)
 *   - knowledgeGraph when present
 *   - peopleAlsoAsk + relatedQueries (used by multi-round search to pivot)
 *   - aiOverview text when present (Serper rare, SerpAPI inline or deferred)
 */

import type { SearchBundle, SearchResult, SerperRawPayload, SerpApiRawPayload } from "./types.ts";
import { classifySourceTier, computeRankScore } from "./ranking.ts";

export interface NormalizeOpts {
  /** ISO 8601 timestamp assigned to every result's `provenance.fetchedAt`. */
  fetchedAt: string;
  /** Number of rounds already completed — used by multi-round driver. */
  roundsCompleted?: number;
}

export function normalizeSerper(
  query: string,
  raw: SerperRawPayload,
  opts: NormalizeOpts,
): SearchBundle {
  const results: SearchResult[] = [];
  const organic = raw.organic ?? [];
  for (const o of organic) {
    if (!o.link || !o.title) continue;
    const tier = classifySourceTier(o.link);
    const position = typeof o.position === "number" ? o.position : results.length + 1;
    results.push({
      query,
      url: o.link,
      title: o.title ?? "",
      snippet: o.snippet ?? "",
      fetchStatus: "ok",
      rankScore: computeRankScore(tier, position),
      sourceTier: tier,
      provenance: { provider: "serper", fetchedAt: opts.fetchedAt },
    });
  }
  results.sort((a, b) => b.rankScore - a.rankScore);

  const bundle: SearchBundle = {
    query,
    provider: "serper",
    results,
    relatedQueries: (raw.relatedSearches ?? []).map((r) => r.query ?? "").filter(Boolean),
    peopleAlsoAsk: (raw.peopleAlsoAsk ?? [])
      .map((p) => ({
        question: p.question ?? "",
        snippet: p.snippet ?? "",
        ...(p.link ? { url: p.link } : {}),
      }))
      .filter((p) => p.question),
    blockedByContamination: 0,
    roundsCompleted: opts.roundsCompleted ?? 1,
    fetchedAt: opts.fetchedAt,
  };

  if (raw.answerBox) {
    const snippet = raw.answerBox.snippet ?? raw.answerBox.answer ?? "";
    if (snippet) {
      bundle.answerBox = {
        ...(raw.answerBox.title ? { title: raw.answerBox.title } : {}),
        snippet,
        ...(raw.answerBox.link ? { link: raw.answerBox.link } : {}),
      };
    }
  }

  if (raw.knowledgeGraph) {
    const description = raw.knowledgeGraph.description ?? "";
    if (description) {
      bundle.knowledgeGraph = {
        ...(raw.knowledgeGraph.title ? { title: raw.knowledgeGraph.title } : {}),
        description,
        ...(raw.knowledgeGraph.descriptionLink
          ? { sourceUrl: raw.knowledgeGraph.descriptionLink }
          : {}),
      };
    }
  }

  const aiOverview = raw.aiOverview?.text ?? raw.aiOverview?.content;
  if (aiOverview) bundle.aiOverview = aiOverview;

  return bundle;
}

export function normalizeSerpApi(
  query: string,
  raw: SerpApiRawPayload,
  opts: NormalizeOpts,
): SearchBundle {
  const results: SearchResult[] = [];
  const organic = raw.organic_results ?? [];
  for (const o of organic) {
    if (!o.link || !o.title) continue;
    const tier = classifySourceTier(o.link);
    const position = typeof o.position === "number" ? o.position : results.length + 1;
    results.push({
      query,
      url: o.link,
      title: o.title ?? "",
      snippet: o.snippet ?? "",
      fetchStatus: "ok",
      rankScore: computeRankScore(tier, position),
      sourceTier: tier,
      provenance: { provider: "serpapi", fetchedAt: opts.fetchedAt },
    });
  }
  results.sort((a, b) => b.rankScore - a.rankScore);

  const bundle: SearchBundle = {
    query,
    provider: "serpapi",
    results,
    relatedQueries: [],
    peopleAlsoAsk: (raw.related_questions ?? [])
      .map((p) => ({
        question: p.question ?? "",
        snippet: p.snippet ?? "",
        ...(p.link ? { url: p.link } : {}),
      }))
      .filter((p) => p.question),
    blockedByContamination: 0,
    roundsCompleted: opts.roundsCompleted ?? 1,
    fetchedAt: opts.fetchedAt,
  };

  if (raw.answer_box) {
    const snippet = raw.answer_box.snippet ?? raw.answer_box.answer ?? "";
    if (snippet) {
      bundle.answerBox = {
        ...(raw.answer_box.title ? { title: raw.answer_box.title } : {}),
        snippet,
        ...(raw.answer_box.link ? { link: raw.answer_box.link } : {}),
      };
    }
  }
  if (raw.knowledge_graph) {
    const description = raw.knowledge_graph.description ?? "";
    if (description) {
      bundle.knowledgeGraph = {
        ...(raw.knowledge_graph.title ? { title: raw.knowledge_graph.title } : {}),
        description,
        ...(raw.knowledge_graph.source?.link ? { sourceUrl: raw.knowledge_graph.source.link } : {}),
      };
    }
  }

  // Inline AI Overview text (deferred via page_token is resolved in run-search).
  const inlineOverview = (raw.ai_overview?.text_blocks ?? [])
    .map((b) => b.snippet ?? "")
    .filter(Boolean)
    .join("\n\n")
    .trim();
  if (inlineOverview) bundle.aiOverview = inlineOverview;

  return bundle;
}
