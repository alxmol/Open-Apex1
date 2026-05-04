import { describe, expect, test } from "bun:test";

import type { Message } from "@open-apex/core";

import { __messageToContentBlocksForTest } from "../src/request-builder.ts";

describe("Anthropic request-builder multimodal (§M3)", () => {
  test("base64 image → native image block", () => {
    const m: Message = {
      role: "user",
      content: [
        { type: "text", text: "Describe this." },
        {
          type: "image",
          source: { kind: "base64", data: "iVBORw0KGgo=", mediaType: "image/png" },
        },
      ],
    };
    const blocks = __messageToContentBlocksForTest(m);
    const image = blocks.find((b) => b.type === "image") as
      | { type: string; source: { type: string; media_type: string; data: string } }
      | undefined;
    expect(image).toBeDefined();
    expect(image?.source.type).toBe("base64");
    expect(image?.source.media_type).toBe("image/png");
  });

  test("base64 PDF → native document block", () => {
    const m: Message = {
      role: "user",
      content: [
        { type: "text", text: "Extract the total." },
        { type: "pdf", source: { kind: "base64", data: "JVBERi0xLjQK" } },
      ],
    };
    const blocks = __messageToContentBlocksForTest(m);
    const doc = blocks.find((b) => b.type === "document") as
      | { type: string; source: { type: string; media_type: string } }
      | undefined;
    expect(doc).toBeDefined();
    expect(doc?.source.media_type).toBe("application/pdf");
  });

  test("multimodal tool_result keeps tool_result first and defers PDF document sibling", () => {
    const m: Message = {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolCallId: "toolu_asset",
          content: [
            { type: "text", text: "Attached asset: diagram.png" },
            {
              type: "image",
              source: { kind: "base64", data: "iVBORw0KGgo=", mediaType: "image/png" },
            },
            { type: "pdf", source: { kind: "base64", data: "JVBERi0xLjQK" } },
          ],
        },
        { type: "text", text: "Continue." },
      ],
    };
    const blocks = __messageToContentBlocksForTest(m);
    expect(blocks[0]?.type).toBe("tool_result");
    const toolResult = blocks[0] as {
      type: string;
      content: Array<{ type: string }>;
    };
    expect(toolResult.content.some((b) => b.type === "image")).toBe(true);
    expect(toolResult.content.some((b) => b.type === "document")).toBe(false);
    expect(blocks[1]?.type).toBe("document");
    expect(blocks[2]).toEqual({ type: "text", text: "Continue." });
  });

  test("search_result content part maps to native search_result block", () => {
    const m: Message = {
      role: "user",
      content: [
        {
          type: "search_result",
          title: "FastAPI WebSockets",
          url: "https://fastapi.tiangolo.com/advanced/websockets/",
          snippet: "Use WebSockets with FastAPI.",
        },
      ],
    };
    const blocks = __messageToContentBlocksForTest(m);
    const sr = blocks.find((b) => b.type === "search_result") as
      | {
          type: string;
          title: string;
          source: string;
          content: Array<{ type: string; text: string }>;
          citations?: { enabled: boolean };
        }
      | undefined;
    expect(sr).toBeDefined();
    expect(sr?.title).toBe("FastAPI WebSockets");
    expect(sr?.source).toContain("fastapi.tiangolo.com");
    expect(sr?.content[0]?.text).toContain("Use WebSockets");
    expect(sr?.citations?.enabled).toBe(true);
  });
});
