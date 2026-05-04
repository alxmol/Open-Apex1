/**
 * @open-apex/search types.
 *
 * Re-exports `SearchResult` from `@open-apex/core` (the rendered shape the
 * orchestrator and provider adapters already know about) and adds
 * search-layer-internal shapes (rounds, raw payloads, extraction metadata).
 *
 * Per §1.2 Search + §M3 Search layer. Provider-neutral; Serper / SerpAPI
 * adapters speak these shapes.
 */

import type { SearchResult } from "@open-apex/core";

export type { SearchResult };

/** Search aggressiveness per §7.6.9 / §7.6.10. */
export type SearchAggressiveness = "off" | "selective" | "proactive" | "aggressive";

/** Single round of a multi-round search run. §1.2 caps: r1 = 4, r2 = 3, r3 = 2. */
export interface SearchRound {
  round: 1 | 2 | 3;
  query: string;
  fetchBudget: number;
  reason?: string;
}

/** Source-authority tier — drives ranking + rendering. */
export type SourceTier = SearchResult["sourceTier"];

/**
 * Options passed to `runSearch` / a `SearchProvider`.
 */
export interface SearchOptions {
  /** Number of results to request from the SERP API (default 8). */
  numResults?: number;
  /** Benchmark mode — enables contamination blocklist by default. */
  benchmark?: boolean;
  /** Allowed domains (merged with preset defaults). */
  allowedDomains?: readonly string[];
  /** Opt-in to SerpAPI's google_ai_overview deferred fetch on page_token. */
  includeAiOverview?: boolean;
  /** Geographic target (Serper `gl`, SerpAPI `gl`). */
  gl?: string;
  /** Language target (Serper `hl`, SerpAPI `hl`). */
  hl?: string;
  /** Abort signal for in-flight HTTP. */
  signal?: AbortSignal;
  /** Request timeout in ms (default 15000). */
  timeoutMs?: number;
  /** Override the Date.now() source (for deterministic tests). */
  now?: () => Date;
}

/** Raw Serper.dev search payload — only the fields we actually consume. */
export interface SerperRawPayload {
  searchParameters?: { q?: string; num?: number; gl?: string; hl?: string };
  organic?: Array<{
    title?: string;
    link?: string;
    snippet?: string;
    position?: number;
    sitelinks?: Array<{ title?: string; link?: string }>;
    date?: string;
  }>;
  answerBox?: {
    title?: string;
    snippet?: string;
    link?: string;
    answer?: string;
  };
  knowledgeGraph?: {
    title?: string;
    type?: string;
    website?: string;
    description?: string;
    descriptionSource?: string;
    descriptionLink?: string;
    attributes?: Record<string, string>;
  };
  peopleAlsoAsk?: Array<{
    question?: string;
    snippet?: string;
    title?: string;
    link?: string;
  }>;
  relatedSearches?: Array<{ query?: string }>;
  /**
   * Serper has experimentally returned an `aiOverview` field on select
   * queries; we accept it opportunistically since it's a pure win when present.
   */
  aiOverview?: { text?: string; content?: string };
}

/** Raw SerpAPI payload shape — narrow surface we rely on. */
export interface SerpApiRawPayload {
  organic_results?: Array<{
    title?: string;
    link?: string;
    snippet?: string;
    position?: number;
    date?: string;
  }>;
  answer_box?: {
    title?: string;
    snippet?: string;
    link?: string;
    answer?: string;
  };
  knowledge_graph?: {
    title?: string;
    type?: string;
    description?: string;
    source?: { link?: string; name?: string };
    attributes?: Record<string, string>;
  };
  ai_overview?: {
    page_token?: string;
    serpapi_link?: string;
    text_blocks?: Array<{
      type?: string;
      snippet?: string;
      snippet_highlighted_words?: string[];
      reference_indexes?: number[];
      list?: Array<{ title?: string; snippet?: string }>;
    }>;
  };
  related_questions?: Array<{
    question?: string;
    snippet?: string;
    title?: string;
    link?: string;
  }>;
}

/**
 * Normalized bundle returned by `runSearch`. Used by `web_search` tool and
 * (later) the M4 `web_researcher` subagent. Keeps AI Overview / answer-box
 * / knowledge-graph separately addressable so renderers can cite them.
 */
export interface SearchBundle {
  query: string;
  provider: "serper" | "serpapi";
  results: SearchResult[];
  aiOverview?: string;
  answerBox?: { title?: string; snippet: string; link?: string };
  knowledgeGraph?: { title?: string; description: string; sourceUrl?: string };
  relatedQueries: string[];
  peopleAlsoAsk: Array<{ question: string; snippet: string; url?: string }>;
  blockedByContamination: number;
  roundsCompleted: number;
  fetchedAt: string;
}

/**
 * Minimal fetch signature the search layer needs. Matches `globalThis.fetch`
 * but omits Bun's non-standard extras (`preconnect`) so tests can supply a
 * trivial mock without implementing the full Bun surface.
 */
export type FetchLike = (
  input: string | URL | Request,
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

/** HTML-extraction output; used by `fetch_url` and multi-round research fetch. */
export interface ExtractedPage {
  url: string;
  title: string | undefined;
  excerpt: string;
  truncated: boolean;
  /** e.g. `text/html; charset=utf-8`. */
  contentType: string | undefined;
  /** Number of bytes received (post-decoding). */
  bytes: number;
  status: "ok" | "blocked" | "failed";
  failureReason?: string;
}
