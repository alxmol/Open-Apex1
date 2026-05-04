import { describe, expect, test } from "bun:test";

import { extractFromHtml, fetchAndExtract } from "../src/extractor.ts";
import type { FetchLike } from "../src/types.ts";

describe("extractFromHtml", () => {
  test("extracts <title> and main article text, drops scripts/styles/nav", () => {
    const html = `<!doctype html>
    <html><head>
      <title>Hello World</title>
      <style>body { color: red; }</style>
    </head>
    <body>
      <nav>Menu</nav>
      <main>
        <h1>Introduction</h1>
        <p>FastAPI is a framework.</p>
        <pre><code>uvicorn app:api</code></pre>
      </main>
      <script>window.evil = 1</script>
      <footer>Copyright</footer>
    </body></html>`;
    const r = extractFromHtml(html);
    expect(r.title).toBe("Hello World");
    expect(r.excerpt).toContain("Introduction");
    expect(r.excerpt).toContain("FastAPI is a framework.");
    expect(r.excerpt).toContain("uvicorn app:api");
    expect(r.excerpt).not.toMatch(/window\.evil/);
    expect(r.excerpt).not.toContain("Copyright");
    expect(r.excerpt).not.toContain("color: red");
    expect(r.truncated).toBe(false);
  });

  test("truncates to byte budget with sentinel", () => {
    const filler = "x".repeat(20000);
    const html = `<html><body><p>${filler}</p></body></html>`;
    const r = extractFromHtml(html, 1024);
    expect(r.truncated).toBe(true);
    expect(r.excerpt).toMatch(/excerpt truncated/);
    expect(Buffer.byteLength(r.excerpt, "utf8")).toBeLessThan(1300);
  });

  test("fallbacks to <body> when no main/article", () => {
    const html = `<html><body><p>Bare body text.</p></body></html>`;
    const r = extractFromHtml(html);
    expect(r.excerpt).toContain("Bare body text.");
  });
});

describe("fetchAndExtract", () => {
  test("returns structured failed record on non-2xx", async () => {
    const mockFetch: FetchLike = async () =>
      new Response("not found", { status: 404, statusText: "Not Found" });
    const r = await fetchAndExtract("https://example.com/404", { fetchImpl: mockFetch });
    expect(r.status).toBe("blocked");
    expect(r.failureReason).toBe("http_404");
    expect(r.excerpt).toBe("");
  });

  test("returns extracted content on 200", async () => {
    const mockFetch: FetchLike = async () =>
      new Response(
        "<html><head><title>Doc</title></head><body><main>Body text</main></body></html>",
        {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        },
      );
    const r = await fetchAndExtract("https://example.com/ok", { fetchImpl: mockFetch });
    expect(r.status).toBe("ok");
    expect(r.title).toBe("Doc");
    expect(r.excerpt).toContain("Body text");
  });

  test("captures network errors as status=failed", async () => {
    const mockFetch: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const r = await fetchAndExtract("https://example.com/fail", { fetchImpl: mockFetch });
    expect(r.status).toBe("failed");
    expect(r.failureReason).toContain("ECONNREFUSED");
  });
});
