import { describe, expect, test } from "bun:test";

import { classifySourceTier, computeRankScore } from "../src/ranking.ts";
import type { SourceTier } from "../src/types.ts";

describe("classifySourceTier (§1.2 ranking)", () => {
  test.each([
    ["https://docs.python.org/3/library/asyncio.html", "official_docs"],
    ["https://developers.openai.com/api/docs/guides/reasoning/", "official_docs"],
    ["https://platform.claude.com/docs/en/build-with-claude/adaptive-thinking", "official_docs"],
    ["https://pkg.go.dev/net/http", "official_docs"],
    ["https://github.com/anthropics/claude-agent-sdk-typescript", "source_repo"],
    ["https://gitlab.com/some/project", "source_repo"],
    ["https://stackoverflow.com/questions/12345/foo", "so"],
    ["https://serverfault.com/a/1234", "so"],
    ["https://foo.medium.com/articles/bar", "blog"],
    ["https://dev.to/author/post", "blog"],
    ["https://random.example.com/x", "other"],
    ["not a url", "other"],
  ])("classifies %s as %s", (url, expected) => {
    expect(classifySourceTier(url)).toBe(expected as SourceTier);
  });
});

describe("computeRankScore", () => {
  test("official_docs at pos 1 beats source_repo at pos 1", () => {
    expect(computeRankScore("official_docs", 1)).toBeGreaterThan(
      computeRankScore("source_repo", 1),
    );
  });
  test("position penalty is linear 0→0.15 over 1→10", () => {
    const top = computeRankScore("official_docs", 1);
    const bottom = computeRankScore("official_docs", 10);
    expect(top).toBeCloseTo(1.0, 5);
    expect(bottom).toBeCloseTo(0.85, 5);
  });
  test("score is clamped to [0, 1]", () => {
    expect(computeRankScore("other", 10)).toBeGreaterThanOrEqual(0);
    expect(computeRankScore("official_docs", -5)).toBeLessThanOrEqual(1);
  });
});
