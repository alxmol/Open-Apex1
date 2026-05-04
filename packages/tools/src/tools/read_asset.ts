/**
 * read_asset — read an image or PDF for multimodal model input (§M3).
 *
 * Returns a structured content array that the caller folds into the next
 * turn's user message. Providers lift native `input_image` / `input_file`
 * (OpenAI) or `image` / `document` (Anthropic) blocks from the
 * `ImageContent` / `PdfContent` `source: "path"` shapes we emit.
 *
 * Size budget:
 *   - 10 MiB per asset hard cap.
 *   - Aggregate-per-turn cap is enforced by the runtime scheduler.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";

import type {
  OpenApexRunContext,
  ToolDefinition,
  ToolExecuteResult,
  ContentPart,
  ImageMediaType,
} from "@open-apex/core";

export interface ReadAssetInput {
  path: string;
  mediaType?: string;
}

export interface ReadAssetMetadata {
  path: string;
  mediaType: string;
  kind: "image" | "pdf";
  sizeBytes: number;
}

const IMAGE_EXT: Record<string, ImageMediaType> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
const PDF_EXT = new Set([".pdf"]);
const MAX_BYTES = 10 * 1024 * 1024;

export const readAssetTool: ToolDefinition<ReadAssetInput, ReadAssetMetadata> = {
  name: "read_asset",
  description:
    "Read one targeted image (PNG/JPEG/GIF/WEBP) or PDF file so it is attached to the next turn's user message for multimodal model analysis. Use for specific screenshots, diagrams, PDFs, and document images only after listing/choosing the needed file; do not fan out across whole document folders. Hard 10 MiB cap per asset; the runtime also caps each turn to 4 assets / 20 MiB total. PDFs are passed through as native `document` blocks on Anthropic and `input_file` on OpenAI.",
  kind: "function",
  parameters: {
    type: "object",
    required: ["path"],
    additionalProperties: false,
    properties: {
      path: { type: "string", minLength: 1 },
      mediaType: { type: "string" },
    },
  },
  permissionClass: "READ_ONLY",
  errorCodes: [
    "file_not_found",
    "path_outside_workspace",
    "asset_too_large",
    "asset_budget_exceeded",
    "unsupported_format",
  ] as const,
  async execute(
    input: ReadAssetInput,
    ctx: OpenApexRunContext,
  ): Promise<ToolExecuteResult<ReadAssetMetadata>> {
    const ws = path.resolve(ctx.userContext.workspace);
    const abs = path.resolve(ws, input.path);
    if (abs !== ws && !abs.startsWith(ws + path.sep)) {
      return {
        isError: true,
        errorType: "path_outside_workspace",
        content: `${input.path} resolves outside workspace`,
      };
    }
    if (!existsSync(abs)) {
      return {
        isError: true,
        errorType: "file_not_found",
        content: `no such file: ${input.path}`,
      };
    }
    const st = statSync(abs);
    if (st.size > MAX_BYTES) {
      return {
        isError: true,
        errorType: "asset_too_large",
        content: `asset exceeds 10 MiB cap (${st.size} bytes)`,
      };
    }
    const ext = path.extname(abs).toLowerCase();
    const imageMedia = IMAGE_EXT[ext];
    const isPdf = PDF_EXT.has(ext);
    if (!imageMedia && !isPdf) {
      return {
        isError: true,
        errorType: "unsupported_format",
        content: `unsupported extension: ${ext}`,
      };
    }
    const mediaType = imageMedia ?? "application/pdf";

    const bytes = readFileSync(abs);
    const b64 = bytes.toString("base64");

    const parts: ContentPart[] = [
      {
        type: "text",
        text: `Attached asset: ${input.path} (${mediaType}, ${st.size} bytes)`,
      },
    ];
    if (imageMedia) {
      parts.push({
        type: "image",
        source: { kind: "base64", data: b64, mediaType: imageMedia },
      });
    } else {
      parts.push({
        type: "pdf",
        source: { kind: "base64", data: b64 },
      });
    }
    // Tag the path so adapters can surface a filename (OpenAI's input_file
    // requires one when passing base64 `file_data`).
    parts.push({
      type: "text",
      text: `filename:${path.basename(input.path)}`,
    });

    return {
      content: parts,
      metadata: {
        path: input.path,
        mediaType,
        kind: imageMedia ? "image" : "pdf",
        sizeBytes: st.size,
      },
    };
  },
};
