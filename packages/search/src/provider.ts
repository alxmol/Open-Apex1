/**
 * SearchProvider interface — the provider-neutral contract every search adapter
 * satisfies. Serper.dev is primary, SerpAPI is fallback + AI Overview
 * enrichment path (§1.2 Search).
 *
 * Adapters return their raw payload; `normalize.ts` folds them into
 * `SearchBundle`. This keeps provider quirks confined to the adapter.
 */

import type { SearchOptions, SerperRawPayload, SerpApiRawPayload } from "./types.ts";

export interface SearchProvider {
  readonly id: "serper" | "serpapi";
  search(query: string, opts?: SearchOptions): Promise<SerperRawPayload | SerpApiRawPayload>;
  /**
   * SerpAPI-only: fetches expanded AI Overview content when the initial
   * response returned a `page_token`. Serper currently never returns one;
   * its implementation no-ops with `null`.
   */
  aiOverview?(pageToken: string, opts?: SearchOptions): Promise<string | null>;
}
