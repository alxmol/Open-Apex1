import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import type { ContentPart, ImageContent, OpenApexRunContext, PdfContent } from "@open-apex/core";
import { readAssetTool } from "../src/tools/read_asset.ts";

function tmpWorkspace(seed: Record<string, Uint8Array | string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openapex-asset-"));
  for (const [rel, content] of Object.entries(seed)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content as Uint8Array);
  }
  return dir;
}

function makeCtx(workspace: string): OpenApexRunContext {
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    thinkingTokens: 0,
    cachedInputTokens: 0,
  };
  return {
    userContext: {
      workspace,
      openApexHome: "/tmp",
      autonomyLevel: "full_auto",
      sessionId: "t",
    },
    runId: "r",
    signal: new AbortController().signal,
    usage,
  };
}

// Tiny 1x1 PNG (89 bytes) produced by a one-off encoder.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAcCBlCwAAAABJRU5ErkJggg==",
  "base64",
);

// Minimal 1-page PDF (valid magic + %%EOF).
const TINY_PDF = `%PDF-1.4
1 0 obj
<</Type/Catalog/Pages 2 0 R>>
endobj
2 0 obj
<</Type/Pages/Kids[3 0 R]/Count 1>>
endobj
3 0 obj
<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]>>
endobj
xref
0 4
0000000000 65535 f
0000000010 00000 n
0000000054 00000 n
0000000101 00000 n
trailer
<</Size 4/Root 1 0 R>>
startxref
156
%%EOF
`;

describe("read_asset tool", () => {
  test("returns ImageContent for a PNG as base64", async () => {
    const ws = tmpWorkspace({ "diagram.png": TINY_PNG });
    const res = await readAssetTool.execute(
      { path: "diagram.png" },
      makeCtx(ws),
      new AbortController().signal,
    );
    expect(res.isError).toBeFalsy();
    const parts = res.content as ContentPart[];
    const img = parts.find((p) => p.type === "image") as ImageContent | undefined;
    expect(img).toBeDefined();
    expect(img?.source.kind).toBe("base64");
    if (img && img.source.kind === "base64") {
      expect(img.source.mediaType).toBe("image/png");
      expect(img.source.data.length).toBeGreaterThan(0);
    }
    expect((res.metadata as { kind: string }).kind).toBe("image");
    // filename trailer should be emitted so adapters can populate OpenAI `input_file.filename`.
    expect(
      parts.some((p) => p.type === "text" && (p as { text: string }).text.startsWith("filename:")),
    ).toBe(true);
  });

  test("returns PdfContent for a PDF as base64", async () => {
    const ws = tmpWorkspace({ "doc.pdf": TINY_PDF });
    const res = await readAssetTool.execute(
      { path: "doc.pdf" },
      makeCtx(ws),
      new AbortController().signal,
    );
    expect(res.isError).toBeFalsy();
    const parts = res.content as ContentPart[];
    const pdf = parts.find((p) => p.type === "pdf") as PdfContent | undefined;
    expect(pdf).toBeDefined();
    expect(pdf?.source.kind).toBe("base64");
    expect((res.metadata as { mediaType: string }).mediaType).toBe("application/pdf");
  });

  test("rejects .txt as unsupported_format", async () => {
    const ws = tmpWorkspace({ "notes.txt": "hi" });
    const res = await readAssetTool.execute(
      { path: "notes.txt" },
      makeCtx(ws),
      new AbortController().signal,
    );
    expect(res.errorType).toBe("unsupported_format");
  });

  test("rejects outside-workspace paths", async () => {
    const ws = tmpWorkspace({});
    const res = await readAssetTool.execute(
      { path: "../outside.png" },
      makeCtx(ws),
      new AbortController().signal,
    );
    expect(res.errorType).toBe("path_outside_workspace");
  });

  test("missing file → file_not_found", async () => {
    const ws = tmpWorkspace({});
    const res = await readAssetTool.execute(
      { path: "missing.png" },
      makeCtx(ws),
      new AbortController().signal,
    );
    expect(res.errorType).toBe("file_not_found");
  });
});
