import { describe, expect, test } from "bun:test";

import type { AgentRequest } from "@open-apex/core";

import { buildRequest } from "../src/request-builder.ts";

describe("OpenAI request-builder multimodal (§M3)", () => {
  test("base64 image → input_image data URL", () => {
    const req: AgentRequest = {
      systemPrompt: "",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "What is in this image?" },
            {
              type: "image",
              source: {
                kind: "base64",
                data: "iVBORw0KGgo=",
                mediaType: "image/png",
              },
            },
          ],
        },
      ],
      tools: [],
    };
    const payload = buildRequest(req, {}, { modelId: "gpt-5.4", systemPrompt: "" });
    const inputItem = payload.input[0] as { role: string; content: unknown[] };
    const img = inputItem.content.find((c) => (c as { type: string }).type === "input_image") as {
      type: string;
      image_url: string;
    };
    expect(img).toBeDefined();
    expect(img.image_url.startsWith("data:image/png;base64,")).toBe(true);
  });

  test("base64 PDF → input_file with file_data + filename", () => {
    const req: AgentRequest = {
      systemPrompt: "",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Summarize this document." },
            {
              type: "pdf",
              source: { kind: "base64", data: "JVBERi0xLjQK" },
            },
            { type: "text", text: "filename:report.pdf" },
          ],
        },
      ],
      tools: [],
    };
    const payload = buildRequest(req, {}, { modelId: "gpt-5.4", systemPrompt: "" });
    const inputItem = payload.input[0] as { role: string; content: unknown[] };
    const pdf = inputItem.content.find((c) => (c as { type: string }).type === "input_file") as {
      type: string;
      file_data: string;
      filename: string;
    };
    expect(pdf).toBeDefined();
    expect(pdf.filename).toBe("report.pdf");
    expect(pdf.file_data.startsWith("data:application/pdf;base64,")).toBe(true);
  });

  test("multimodal tool_result → function_call_output output content array", () => {
    const req: AgentRequest = {
      systemPrompt: "",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolCallId: "call_asset",
              content: [
                { type: "text", text: "Attached asset: diagram.png" },
                {
                  type: "image",
                  source: {
                    kind: "base64",
                    data: "iVBORw0KGgo=",
                    mediaType: "image/png",
                  },
                },
                {
                  type: "pdf",
                  source: { kind: "base64", data: "JVBERi0xLjQK" },
                },
                { type: "text", text: "filename:report.pdf" },
              ],
            },
          ],
        },
      ],
      tools: [],
    };
    const payload = buildRequest(req, {}, { modelId: "gpt-5.4", systemPrompt: "" });
    const output = payload.input.find(
      (i) => (i as { type?: string }).type === "function_call_output",
    ) as { type: string; output: unknown[] };
    expect(output).toBeDefined();
    expect(output.output.some((p) => (p as { type: string }).type === "input_image")).toBe(true);
    const file = output.output.find((p) => (p as { type: string }).type === "input_file") as {
      filename: string;
      file_data: string;
    };
    expect(file.filename).toBe("report.pdf");
    expect(file.file_data.startsWith("data:application/pdf;base64,")).toBe(true);
  });

  test("search_result renders as fenced input_text with provenance metadata", () => {
    const req: AgentRequest = {
      systemPrompt: "",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "search_result",
              title: "Python asyncio",
              url: "https://docs.python.org/3/library/asyncio.html",
              snippet: "Asynchronous I/O",
              content: "Long doc excerpt...",
              metadata: {
                sourceTier: "official_docs",
                provider: "serper",
                rankScore: 0.98,
                fetchedAt: "2026-04-24T00:00:00.000Z",
              },
            },
          ],
        },
      ],
      tools: [],
    };
    const payload = buildRequest(req, {}, { modelId: "gpt-5.4", systemPrompt: "" });
    const inputItem = payload.input[0] as { role: string; content: unknown[] };
    const text = inputItem.content.find((c) => (c as { type: string }).type === "input_text") as {
      type: string;
      text: string;
    };
    expect(text.text).toMatch(/^<search_result /);
    expect(text.text).toContain('source="https://docs.python.org/3/library/asyncio.html"');
    expect(text.text).toContain('title="Python asyncio"');
    expect(text.text).toContain('tier="official_docs"');
    expect(text.text).toContain('provider="serper"');
    expect(text.text).toContain('rank="0.98"');
    expect(text.text).toContain('fetched_at="2026-04-24T00:00:00.000Z"');
    expect(text.text).toContain("Long doc excerpt...");
    expect(text.text).toContain("</search_result>");
  });

  test("search_result metadata escapes XML-like attribute values", () => {
    const req: AgentRequest = {
      systemPrompt: "",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "search_result",
              title: 'Edge "case" <docs>',
              url: "https://example.com/?q=a&b=c",
              snippet: "Escaped attrs.",
            },
          ],
        },
      ],
      tools: [],
    };
    const payload = buildRequest(req, {}, { modelId: "gpt-5.4", systemPrompt: "" });
    const inputItem = payload.input[0] as { role: string; content: unknown[] };
    const text = inputItem.content.find((c) => (c as { type: string }).type === "input_text") as {
      type: string;
      text: string;
    };
    expect(text.text).toContain('source="https://example.com/?q=a&amp;b=c"');
    expect(text.text).toContain('title="Edge &quot;case&quot; &lt;docs&gt;"');
  });
});
