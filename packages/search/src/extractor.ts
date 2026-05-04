/**
 * HTML → readable-text extractor for `fetch_url` + multi-round search fetch.
 *
 * Lightweight, Bun-friendly: uses `node-html-parser` (no DOM polyfills, no
 * headless browser). Strips scripts / styles / nav / aside / footer, keeps
 * `<article>` / `<main>` / body text, preserves basic inline emphasis and
 * code-block boundaries so the model still sees structure.
 *
 * Cap: 8 KB excerpt per page (§M3 design). Truncation is hard — we don't
 * attempt to locate the most-relevant passage; that's model work.
 */

import { parse } from "node-html-parser";

import type { ExtractedPage, FetchLike } from "./types.ts";

export interface ExtractOpts {
  maxExcerptBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}

const EXCERPT_BUDGET = 8 * 1024;
const DEFAULT_TIMEOUT = 12_000;

const DROP_TAGS: ReadonlySet<string> = new Set([
  "script",
  "style",
  "noscript",
  "template",
  "svg",
  "iframe",
  "nav",
  "aside",
  "footer",
  "form",
  "header",
  "button",
  "input",
  "select",
  "textarea",
  "object",
  "embed",
  "canvas",
]);

const BLOCK_TAGS: ReadonlySet<string> = new Set([
  "p",
  "div",
  "section",
  "article",
  "main",
  "li",
  "ul",
  "ol",
  "pre",
  "code",
  "blockquote",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "table",
  "tr",
  "td",
  "th",
  "hr",
  "br",
]);

/**
 * Fetch and extract a URL. Returns a well-formed `ExtractedPage` even on
 * failure (`status: "failed"` + `failureReason`) so callers always have a
 * structured record.
 */
export async function fetchAndExtract(url: string, opts: ExtractOpts = {}): Promise<ExtractedPage> {
  const maxExcerpt = opts.maxExcerptBytes ?? EXCERPT_BUDGET;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const ac = new AbortController();
  const composite = linkSignals(opts.signal, ac.signal);
  const timer = setTimeout(
    () => ac.abort(new Error("fetch timeout")),
    opts.timeoutMs ?? DEFAULT_TIMEOUT,
  );
  try {
    const res = await fetchImpl(url, {
      method: "GET",
      headers: {
        "User-Agent": "Open-Apex/0.0.1 (+fetch_url)",
        Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
      },
      signal: composite,
    });
    const contentType = res.headers.get("content-type") ?? undefined;
    if (!res.ok) {
      return {
        url,
        title: undefined,
        excerpt: "",
        truncated: false,
        contentType,
        bytes: 0,
        status: "blocked",
        failureReason: `http_${res.status}`,
      };
    }
    const body = await res.text();
    const extracted = extractFromHtml(body, maxExcerpt);
    return {
      url,
      title: extracted.title,
      excerpt: extracted.excerpt,
      truncated: extracted.truncated,
      contentType,
      bytes: body.length,
      status: "ok",
    };
  } catch (err) {
    return {
      url,
      title: undefined,
      excerpt: "",
      truncated: false,
      contentType: undefined,
      bytes: 0,
      status: "failed",
      failureReason: (err as Error).message.slice(0, 200),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Parse a raw HTML string and return a byte-capped excerpt + detected title. */
export function extractFromHtml(
  html: string,
  maxExcerptBytes: number = EXCERPT_BUDGET,
): { excerpt: string; truncated: boolean; title: string | undefined } {
  const root = parse(html, {
    lowerCaseTagName: true,
    comment: false,
    blockTextElements: {
      script: false,
      style: false,
      pre: true,
      code: true,
    },
  });

  const titleEl = root.querySelector("title");
  const title = titleEl?.text?.trim() || undefined;

  // Prefer <main>/<article> when present; otherwise body.
  const body =
    root.querySelector("main") ??
    root.querySelector("article") ??
    root.querySelector("body") ??
    root;

  const lines: string[] = [];
  walk(body, lines);

  const normalized = lines
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");

  const asBuf = Buffer.from(normalized, "utf8");
  if (asBuf.byteLength <= maxExcerptBytes) {
    return { excerpt: normalized, truncated: false, title };
  }
  const truncated = asBuf.subarray(0, maxExcerptBytes).toString("utf8");
  return { excerpt: truncated + "\n[…excerpt truncated at 8 KB…]", truncated: true, title };
}

function walk(node: ReturnType<typeof parse>, out: string[]): void {
  for (const child of node.childNodes) {
    const tag = (child as { tagName?: string }).tagName?.toLowerCase();
    if (!tag) {
      const raw = typeof child.rawText === "string" ? child.rawText : "";
      const txt = raw.trim();
      if (txt) out.push(txt);
      continue;
    }
    if (DROP_TAGS.has(tag)) continue;
    if (tag === "pre" || tag === "code") {
      const code = (child as { text?: string }).text ?? "";
      if (code.trim()) out.push("```\n" + code.trim() + "\n```");
      continue;
    }
    if (BLOCK_TAGS.has(tag)) {
      const before = out.length;
      walk(child as unknown as ReturnType<typeof parse>, out);
      // Insert a newline boundary between blocks so we don't glue paragraphs.
      if (out.length > before) out.push("");
    } else {
      walk(child as unknown as ReturnType<typeof parse>, out);
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
