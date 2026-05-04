import { describe, expect, test } from "bun:test";

import { normalizeSerper, normalizeSerpApi } from "../src/normalize.ts";
import type { SerperRawPayload, SerpApiRawPayload } from "../src/types.ts";

const fetchedAt = "2026-04-24T00:00:00.000Z";

describe("normalizeSerper", () => {
  test("maps organic + answerBox + knowledgeGraph + peopleAlsoAsk", () => {
    const raw: SerperRawPayload = {
      searchParameters: { q: "fastapi websockets" },
      organic: [
        {
          title: "FastAPI - WebSockets",
          link: "https://fastapi.tiangolo.com/advanced/websockets/",
          snippet: "Use WebSockets with FastAPI.",
          position: 1,
        },
        {
          title: "FastAPI WebSockets tutorial (Medium)",
          link: "https://medium.com/foo/fastapi-ws",
          snippet: "A walkthrough.",
          position: 2,
        },
      ],
      answerBox: {
        title: "FastAPI",
        snippet: "FastAPI supports WebSockets via starlette.",
        link: "https://fastapi.tiangolo.com/advanced/websockets/",
      },
      knowledgeGraph: {
        title: "FastAPI",
        description: "Modern, fast (high-performance) web framework for Python.",
        descriptionLink: "https://fastapi.tiangolo.com/",
      },
      peopleAlsoAsk: [
        {
          question: "Is FastAPI faster than Flask?",
          snippet: "Benchmarks say yes.",
          link: "https://example.com/x",
        },
      ],
      relatedSearches: [{ query: "fastapi websocket example" }],
    };
    const bundle = normalizeSerper("fastapi websockets", raw, { fetchedAt });
    expect(bundle.provider).toBe("serper");
    expect(bundle.results).toHaveLength(2);
    // Official docs must rank above medium blog in the sort.
    expect(bundle.results[0]!.sourceTier).toBe("official_docs");
    expect(bundle.results[1]!.sourceTier).toBe("blog");
    expect(bundle.results[0]!.rankScore).toBeGreaterThan(bundle.results[1]!.rankScore);
    expect(bundle.answerBox?.snippet).toContain("WebSockets");
    expect(bundle.knowledgeGraph?.description).toContain("Modern");
    expect(bundle.peopleAlsoAsk).toHaveLength(1);
    expect(bundle.relatedQueries).toEqual(["fastapi websocket example"]);
    expect(bundle.results[0]!.provenance.provider).toBe("serper");
  });

  test("drops organic entries missing link or title", () => {
    const raw: SerperRawPayload = {
      organic: [
        { title: "", link: "https://x.com/" },
        { title: "T", link: "" },
        { title: "Good", link: "https://example.com/" },
      ],
    };
    const bundle = normalizeSerper("q", raw, { fetchedAt });
    expect(bundle.results).toHaveLength(1);
    expect(bundle.results[0]!.title).toBe("Good");
  });

  test("exposes aiOverview when Serper opportunistically provides it", () => {
    const raw: SerperRawPayload = {
      organic: [{ title: "T", link: "https://example.com/", snippet: "s" }],
      aiOverview: { text: "Overview text." },
    };
    const bundle = normalizeSerper("q", raw, { fetchedAt });
    expect(bundle.aiOverview).toBe("Overview text.");
  });
});

describe("normalizeSerpApi", () => {
  test("maps organic_results + inline ai_overview", () => {
    const raw: SerpApiRawPayload = {
      organic_results: [
        {
          title: "Rust Book — Async",
          link: "https://doc.rust-lang.org/book/ch17-00-async-await.html",
          snippet: "Async and await in Rust.",
          position: 1,
        },
      ],
      ai_overview: {
        text_blocks: [
          { snippet: "Async in Rust uses futures." },
          { snippet: "Tokio is the standard runtime." },
        ],
      },
      related_questions: [
        { question: "Is tokio part of std?", snippet: "No", link: "https://example.com/x" },
      ],
    };
    const bundle = normalizeSerpApi("rust async", raw, { fetchedAt });
    expect(bundle.provider).toBe("serpapi");
    expect(bundle.results).toHaveLength(1);
    expect(bundle.aiOverview).toContain("Async in Rust");
    expect(bundle.aiOverview).toContain("Tokio");
    expect(bundle.peopleAlsoAsk[0]!.question).toBe("Is tokio part of std?");
  });

  test("empty payload yields empty bundle with zero results", () => {
    const bundle = normalizeSerpApi("q", {}, { fetchedAt });
    expect(bundle.results).toEqual([]);
    expect(bundle.aiOverview).toBeUndefined();
  });
});
