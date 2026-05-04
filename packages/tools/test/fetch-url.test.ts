import { describe, expect, test } from "bun:test";

import type { OpenApexRunContext } from "@open-apex/core";
import { fetchUrlTool } from "../src/tools/fetch_url.ts";

function makeCtx(): OpenApexRunContext {
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    thinkingTokens: 0,
    cachedInputTokens: 0,
  };
  return {
    userContext: {
      workspace: "/tmp",
      openApexHome: "/tmp",
      autonomyLevel: "full_auto",
      sessionId: "t",
    },
    runId: "r",
    signal: new AbortController().signal,
    usage,
  };
}

describe("fetch_url tool", () => {
  test("rejects non-http schemes with blocked_domain", async () => {
    const res = await fetchUrlTool.execute(
      { url: "file:///etc/passwd" },
      makeCtx(),
      new AbortController().signal,
    );
    expect(res.isError).toBe(true);
    expect(res.errorType).toBe("blocked_domain");
  });

  test("bad URL returns bad_args", async () => {
    const res = await fetchUrlTool.execute(
      { url: "not a url" },
      makeCtx(),
      new AbortController().signal,
    );
    expect(res.isError).toBe(true);
    expect(res.errorType).toBe("bad_args");
  });
});
