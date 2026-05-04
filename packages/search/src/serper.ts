/**
 * Serper.dev adapter. Primary SERP provider per §1.2.
 *
 * Endpoint: POST https://google.serper.dev/search
 * Auth:     X-API-KEY: <SERPER_API_KEY>
 *
 * Does NOT return AI Overview as of 2026-04; `aiOverview` hook is a no-op.
 * When Serper starts including an `aiOverview` field opportunistically, the
 * normalizer picks it up — we never hard-require it.
 */

import type { SearchProvider } from "./provider.ts";
import type { FetchLike, SearchOptions, SerperRawPayload } from "./types.ts";

export interface SerperProviderOpts {
  apiKey?: string;
  /** Override base URL (for tests). */
  baseUrl?: string;
  /** Override `fetch` (for tests). */
  fetchImpl?: FetchLike;
}

export class SerperProvider implements SearchProvider {
  readonly id = "serper" as const;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: SerperProviderOpts = {}) {
    const key = opts.apiKey ?? process.env.SERPER_API_KEY;
    if (!key) {
      throw new Error("SERPER_API_KEY is not set; cannot construct SerperProvider");
    }
    this.apiKey = key;
    this.baseUrl = opts.baseUrl ?? "https://google.serper.dev";
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async search(query: string, opts: SearchOptions = {}): Promise<SerperRawPayload> {
    const timeout = opts.timeoutMs ?? 15_000;
    const ac = new AbortController();
    const composite = linkSignals(opts.signal, ac.signal);
    const timer = setTimeout(() => ac.abort(new Error("serper request timeout")), timeout);
    try {
      const body: Record<string, unknown> = {
        q: query,
        num: opts.numResults ?? 8,
      };
      if (opts.gl) body.gl = opts.gl;
      if (opts.hl) body.hl = opts.hl;
      const res = await this.fetchImpl(`${this.baseUrl}/search`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-KEY": this.apiKey,
          "User-Agent": "Open-Apex/0.0.1 (+serper)",
        },
        body: JSON.stringify(body),
        signal: composite,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`serper ${res.status}: ${text.slice(0, 200)}`);
      }
      const json = (await res.json()) as SerperRawPayload;
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Serper does not expose a deferred AI Overview endpoint; no-op. */
  async aiOverview(): Promise<string | null> {
    return null;
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
