/**
 * fetch_url — HTTP GET/HEAD a URL and return a readable-text excerpt (§M3).
 *
 * Permission flow:
 *   1. URL parsed; scheme must be http/https.
 *   2. Classified via §7.6.1 network policy (GET/HEAD to allow-listed →
 *      READ_ONLY_NETWORK; non-allow → MUTATING) by the scheduler before
 *      execute() is reached.
 *   3. Extracted via `@open-apex/search.fetchAndExtract` — strips scripts,
 *      keeps <article>/<main>, caps at 8 KB excerpt.
 *
 * Note: we always register with `permissionClass: "READ_ONLY_NETWORK"` because
 * we refuse non-GET/HEAD at the tool level. The scheduler applies the actual
 * URL/method allow-list gate before dispatch; this tool keeps protocol,
 * method, and extraction checks close to the network call as a second line.
 */

import type { OpenApexRunContext, ToolDefinition, ToolExecuteResult } from "@open-apex/core";
import { fetchAndExtract, type ExtractedPage } from "@open-apex/search";

export interface FetchUrlInput {
  url: string;
  method?: "GET" | "HEAD";
  maxExcerptBytes?: number;
}

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

export const fetchUrlTool: ToolDefinition<FetchUrlInput, ExtractedPage> = {
  name: "fetch_url",
  description:
    "HTTP GET (or HEAD) a URL and return a readable-text excerpt (scripts/styles/nav stripped). Capped at 8 KB per page. Use after `web_search` to read specific top-ranked results. Permission is READ_ONLY_NETWORK for allow-listed domains; non-allow-listed hosts are treated as MUTATING and will be denied under stricter autonomy.",
  kind: "function",
  parameters: {
    type: "object",
    required: ["url"],
    additionalProperties: false,
    properties: {
      url: { type: "string", minLength: 4 },
      method: { enum: ["GET", "HEAD"] },
      maxExcerptBytes: { type: "integer", minimum: 512, maximum: 65536 },
    },
  },
  permissionClass: "READ_ONLY_NETWORK",
  errorCodes: ["http_error", "blocked_domain", "fetch_timeout", "bad_args"] as const,
  async execute(
    input: FetchUrlInput,
    _ctx: OpenApexRunContext,
    signal: AbortSignal,
  ): Promise<ToolExecuteResult<ExtractedPage>> {
    let url: URL;
    try {
      url = new URL(input.url);
    } catch {
      return {
        isError: true,
        errorType: "bad_args",
        content: `invalid url: ${input.url}`,
      };
    }
    if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
      return {
        isError: true,
        errorType: "blocked_domain",
        content: `unsupported protocol: ${url.protocol}`,
      };
    }
    const method = input.method ?? "GET";
    if (method === "HEAD") {
      try {
        const res = await fetch(input.url, { method: "HEAD", signal });
        return {
          content: {
            url: input.url,
            title: undefined,
            excerpt: "",
            truncated: false,
            contentType: res.headers.get("content-type") ?? undefined,
            bytes: 0,
            status: res.ok ? "ok" : "blocked",
            ...(res.ok ? {} : { failureReason: `http_${res.status}` }),
          },
        };
      } catch (err) {
        return {
          isError: true,
          errorType: "fetch_timeout",
          content: (err as Error).message.slice(0, 200),
        };
      }
    }
    const opts: Parameters<typeof fetchAndExtract>[1] = { signal };
    if (input.maxExcerptBytes !== undefined) opts.maxExcerptBytes = input.maxExcerptBytes;
    const page = await fetchAndExtract(input.url, opts);
    if (page.status === "failed") {
      return {
        isError: true,
        errorType: "fetch_timeout",
        content: page.failureReason ?? "fetch failed",
      };
    }
    if (page.status === "blocked") {
      return {
        isError: true,
        errorType: "http_error",
        content: `fetch_url ${input.url}: ${page.failureReason ?? "blocked"}`,
      };
    }
    return { content: page };
  },
};
