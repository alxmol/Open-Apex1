/**
 * web_search — provider-neutral search tool (§M3).
 *
 * Wraps `@open-apex/search.runSearch`. Returns `SearchResult`-carrying content
 * parts that the provider adapters render as:
 *   - Anthropic `search_result` content blocks (native citation metadata)
 *   - OpenAI fenced `<search_result …>…</search_result>` text blocks
 *
 * Permission: `READ_ONLY_NETWORK`. Only registered when `networkEnabled: true`
 * and the preset hasn't excluded it via `contextManagement.excludeTools`.
 */

import type {
  ContentPart,
  OpenApexRunContext,
  ToolDefinition,
  ToolExecuteResult,
} from "@open-apex/core";
import { bundleToContentParts, runSearch, type SearchProvider } from "@open-apex/search";
import { InMemorySearchCache } from "@open-apex/search";

export interface WebSearchInput {
  query: string;
  numResults?: number;
  includeAiOverview?: boolean;
}

export interface WebSearchMetadata {
  query: string;
  provider: "serper" | "serpapi";
  kept: number;
  blocked: number;
  rounds: number;
}

// Module-scoped per-process search-provider factory hook. The runtime sets
// this at startup (CLI + benchmark mode) and tests override it for determinism.
type Factory = () => { provider: SearchProvider; benchmark: boolean };

let factory: Factory | null = null;
const cache = new InMemorySearchCache();

export function __setSearchProviderFactoryForTest(f: Factory | null): void {
  factory = f;
  cache.clear();
}

export function setSearchProviderFactory(f: Factory): void {
  factory = f;
}

export const webSearchTool: ToolDefinition<WebSearchInput, WebSearchMetadata> = {
  name: "web_search",
  description:
    "Search the web via the configured SERP provider (Serper.dev primary, SerpAPI fallback). Returns structured search results with provenance. Use selectively: prefer when the task depends on up-to-date external documentation, a specific framework's API, or error messages whose recent fixes are on the web. Results carry a `sourceTier` — prefer `official_docs` and `source_repo` over `blog`/`other`.",
  kind: "function",
  parameters: {
    type: "object",
    required: ["query"],
    additionalProperties: false,
    properties: {
      query: { type: "string", minLength: 2, maxLength: 256 },
      numResults: { type: "integer", minimum: 1, maximum: 10 },
      includeAiOverview: { type: "boolean" },
    },
  },
  permissionClass: "READ_ONLY_NETWORK",
  errorCodes: ["search_disabled", "search_failed"] as const,
  async execute(
    input: WebSearchInput,
    _ctx: OpenApexRunContext,
    signal: AbortSignal,
  ): Promise<ToolExecuteResult<WebSearchMetadata>> {
    if (!factory) {
      return {
        isError: true,
        errorType: "search_disabled",
        content: "web_search is not configured (no SearchProvider factory registered).",
      };
    }
    const { provider, benchmark } = factory();
    try {
      const bundle = await runSearch(
        input.query,
        { provider, cache, benchmark },
        {
          ...(input.numResults !== undefined ? { numResults: input.numResults } : {}),
          ...(input.includeAiOverview !== undefined
            ? { includeAiOverview: input.includeAiOverview }
            : {}),
          signal,
        },
      );
      const content: ContentPart[] = bundleToContentParts(bundle);
      return {
        content,
        metadata: {
          query: input.query,
          provider: bundle.provider,
          kept: bundle.results.length,
          blocked: bundle.blockedByContamination,
          rounds: bundle.roundsCompleted,
        },
      };
    } catch (err) {
      return {
        isError: true,
        errorType: "search_failed",
        content: `web_search failed: ${(err as Error).message.slice(0, 300)}`,
      };
    }
  },
};
