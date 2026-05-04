import { describe, expect, test } from "bun:test";

import {
  bundleToAnthropicBlocks,
  bundleToOpenAiText,
  bundleToContentParts,
} from "../src/render.ts";
import type { SearchBundle } from "../src/types.ts";

function makeBundle(): SearchBundle {
  const fetchedAt = "2026-04-24T00:00:00.000Z";
  return {
    query: "fastapi websockets",
    provider: "serper",
    results: [
      {
        query: "fastapi websockets",
        url: "https://fastapi.tiangolo.com/advanced/websockets/",
        title: "FastAPI — WebSockets",
        snippet: "Use WebSockets with FastAPI.",
        fetchStatus: "ok",
        rankScore: 1.0,
        sourceTier: "official_docs",
        provenance: { provider: "serper", fetchedAt },
      },
      {
        query: "fastapi websockets",
        url: "https://stackoverflow.com/q/12345",
        title: "FastAPI WS question",
        snippet: "When the ws closes...",
        fetchStatus: "ok",
        rankScore: 0.5,
        sourceTier: "so",
        provenance: { provider: "serper", fetchedAt },
      },
    ],
    answerBox: {
      title: "FastAPI",
      snippet: "FastAPI supports WebSockets.",
      link: "https://fastapi.tiangolo.com/advanced/websockets/",
    },
    relatedQueries: [],
    peopleAlsoAsk: [],
    blockedByContamination: 0,
    roundsCompleted: 1,
    fetchedAt,
  };
}

describe("bundleToAnthropicBlocks", () => {
  test("emits type:search_result for each result with metadata", () => {
    const blocks = bundleToAnthropicBlocks(makeBundle());
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.type).toBe("search_result");
    expect(blocks[0]!.url).toContain("fastapi");
    expect(blocks[0]!.metadata?.sourceTier).toBe("official_docs");
    expect(blocks[0]!.metadata?.rankScore).toBeCloseTo(1, 5);
  });
});

describe("bundleToOpenAiText", () => {
  test("renders fenced search_result blocks + ai_overview-less auxiliary", () => {
    const txt = bundleToOpenAiText(makeBundle(), { maxResults: 2 });
    expect(txt).toContain(
      '<answer_box title="FastAPI" source="https://fastapi.tiangolo.com/advanced/websockets/">',
    );
    expect(txt).toMatch(/<search_result[^>]*tier="official_docs"/);
    expect(txt).toMatch(/<search_result[^>]*tier="so"/);
    expect(txt).toContain("</search_result>");
  });

  test("escapes quotes and angle brackets in titles", () => {
    const bundle = makeBundle();
    bundle.results[0]!.title = 'Edge "case" <title>';
    const txt = bundleToOpenAiText(bundle);
    expect(txt).toContain("&quot;case&quot;");
    expect(txt).toContain("&lt;title&gt;");
  });
});

describe("bundleToContentParts", () => {
  test("mixes text (aux) + search_result parts", () => {
    const parts = bundleToContentParts(makeBundle());
    expect(parts[0]!.type).toBe("text");
    expect(parts.filter((p) => p.type === "search_result")).toHaveLength(2);
  });
});
