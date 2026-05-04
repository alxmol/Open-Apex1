/**
 * SerpAPI adapter. Fallback SERP + AI Overview enrichment path per §1.2.
 *
 * Endpoint: GET https://serpapi.com/search.json?engine=google&q=...&api_key=...
 * AI Overview: some queries return inline `ai_overview.text_blocks`; others
 * return a `page_token` that must be redeemed within ~1–4 minutes via a
 * second call to `engine=google_ai_overview`. We implement both.
 *
 * Env: reads `SERP_API_KEY` (project convention per .env.local) with
 * `SERPAPI_KEY` accepted as legacy fallback.
 */

import type { SearchProvider } from "./provider.ts";
import type { FetchLike, SearchOptions, SerpApiRawPayload } from "./types.ts";

export interface SerpApiProviderOpts {
  apiKey?: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

export class SerpApiProvider implements SearchProvider {
  readonly id = "serpapi" as const;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: SerpApiProviderOpts = {}) {
    const key = opts.apiKey ?? process.env.SERP_API_KEY ?? process.env.SERPAPI_KEY;
    if (!key) {
      throw new Error("SERP_API_KEY (or SERPAPI_KEY) is not set; cannot construct SerpApiProvider");
    }
    this.apiKey = key;
    this.baseUrl = opts.baseUrl ?? "https://serpapi.com";
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SerpApiRawPayload> {
    const timeout = opts.timeoutMs ?? 15_000;
    const ac = new AbortController();
    const composite = linkSignals(opts.signal, ac.signal);
    const timer = setTimeout(() => ac.abort(new Error("serpapi request timeout")), timeout);
    try {
      const params = new URLSearchParams({
        engine: "google",
        q: query,
        api_key: this.apiKey,
        num: String(opts.numResults ?? 8),
      });
      if (opts.gl) params.set("gl", opts.gl);
      if (opts.hl) params.set("hl", opts.hl);
      const res = await this.fetchImpl(`${this.baseUrl}/search.json?${params.toString()}`, {
        method: "GET",
        headers: { "User-Agent": "Open-Apex/0.0.1 (+serpapi)" },
        signal: composite,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`serpapi ${res.status}: ${text.slice(0, 200)}`);
      }
      return (await res.json()) as SerpApiRawPayload;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Redeems the deferred `page_token` returned by `ai_overview.page_token` on
   * the primary search. Token TTL is ~1–4 minutes; we let the HTTP error
   * bubble up if expired.
   */
  async aiOverview(pageToken: string, opts: SearchOptions = {}): Promise<string | null> {
    const timeout = opts.timeoutMs ?? 15_000;
    const ac = new AbortController();
    const composite = linkSignals(opts.signal, ac.signal);
    const timer = setTimeout(() => ac.abort(new Error("serpapi ai_overview timeout")), timeout);
    try {
      const params = new URLSearchParams({
        engine: "google_ai_overview",
        page_token: pageToken,
        api_key: this.apiKey,
      });
      const res = await this.fetchImpl(`${this.baseUrl}/search.json?${params.toString()}`, {
        method: "GET",
        headers: { "User-Agent": "Open-Apex/0.0.1 (+serpapi-ai)" },
        signal: composite,
      });
      if (!res.ok) return null;
      const json = (await res.json()) as {
        ai_overview?: { text_blocks?: Array<{ snippet?: string }> };
      };
      const blocks = json.ai_overview?.text_blocks ?? [];
      const text = blocks
        .map((b) => (typeof b.snippet === "string" ? b.snippet : ""))
        .filter(Boolean)
        .join("\n\n")
        .trim();
      return text ? text : null;
    } finally {
      clearTimeout(timer);
    }
  }
}

function linkSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  const ac = new AbortController();
  const abort = () => ac.abort();
  if (a.aborted) ac.abort(a.reason);
  if (b.aborted) ac.abort(b.reason);
  a.addEventListener("abort", abort, { once: true });
  b.addEventListener("abort", abort, { once: true });
  return ac.signal;
}
