/**
 * read_file tool — range-capable file reads with binary rejection + BOM preserved.
 */

import { existsSync, statSync } from "node:fs";
import * as path from "node:path";

import type { OpenApexRunContext, ToolDefinition, ToolExecuteResult } from "@open-apex/core";

import {
  benchmarkIsolationMessage,
  isBenchmarkIsolatedPath,
  isBenchmarkMode,
} from "./benchmark-isolation.ts";

export interface ReadFileInput {
  path: string;
  startLine?: number;
  endLine?: number;
  encoding?: string;
}

export interface ReadFileResult {
  path: string;
  /** Raw contents (range-trimmed when start/end provided). */
  content: string;
  /** Total line count of the file (for range callers). */
  totalLines: number;
  /** True if the file had a UTF-8 BOM (preserved in content). */
  hadBom: boolean;
  /** Detected line ending. */
  lineEnding: "lf" | "crlf";
  /** True if content was truncated to stay under the model-context safe cap. */
  truncated?: boolean;
  /** Number of bytes dropped from the returned content (when `truncated`). */
  truncatedBytes?: number;
}

const UTF8_BOM = "\uFEFF";
const MAX_BYTES = 10 * 1024 * 1024; // 10 MB hard guard (rejection threshold)
/**
 * Soft cap on returned content. A single read_file result larger than this
 * risks blowing the model context on subsequent turns (TB2 gcode-to-text
 * had a 1.2M-token text.gcode file exceed Anthropic's 1M context). The cap
 * is ~65k tokens worth of ASCII, well under all current model contexts
 * (Claude 4.6 default 200k, OpenAI gpt-5.4 400k). Anything over the cap
 * gets truncated with a sentinel message telling the model to use
 * startLine/endLine ranges to page through the remainder.
 */
const MAX_CONTENT_BYTES = 256 * 1024;

export const readFileTool: ToolDefinition<ReadFileInput, ReadFileResult> = {
  name: "read_file",
  description:
    "Read the contents of a text file at a path relative to the workspace. Supports optional line-range reads via startLine / endLine (1-based, inclusive). Binary files are rejected. Large textual files are truncated at 256 KB with a sentinel + `truncated: true` in the result — use startLine/endLine to page through the remainder.",
  kind: "function",
  parameters: {
    type: "object",
    required: ["path"],
    additionalProperties: false,
    properties: {
      path: { type: "string" },
      startLine: { type: "integer", minimum: 1 },
      endLine: { type: "integer", minimum: 1 },
      encoding: { type: "string" },
    },
  },
  permissionClass: "READ_ONLY",
  errorCodes: [
    "file_not_found",
    "path_outside_workspace",
    "permission_denied",
    "is_directory",
    "binary_file",
    "file_too_large",
    "encoding_error",
  ] as const,
  async execute(
    input: ReadFileInput,
    ctx: OpenApexRunContext,
  ): Promise<ToolExecuteResult<ReadFileResult>> {
    const abs = resolveInsideWorkspace(ctx.userContext.workspace, input.path);
    if (!abs.ok) return errorResult(abs.code, abs.message);
    if (isBenchmarkMode(ctx) && isBenchmarkIsolatedPath(ctx.userContext.workspace, abs.path)) {
      return errorResult("permission_denied", benchmarkIsolationMessage(input.path));
    }
    if (!existsSync(abs.path)) return errorResult("file_not_found", `no such file: ${input.path}`);
    const st = statSync(abs.path);
    if (st.isDirectory()) return errorResult("is_directory", `${input.path} is a directory`);
    if (st.size > MAX_BYTES) {
      return errorResult(
        "file_too_large",
        `${input.path} is ${st.size} bytes (> 10 MB); use apply_patch with narrow hunks`,
      );
    }
    const buf = await Bun.file(abs.path).bytes();
    if (isBinary(buf)) {
      return errorResult("binary_file", `${input.path} appears to be binary`);
    }
    const encoding = (input.encoding ?? "utf-8").toLowerCase();
    if (encoding !== "utf-8" && encoding !== "utf8") {
      return errorResult("encoding_error", `only utf-8 is supported at M1 (got ${encoding})`);
    }
    let text = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    let hadBom = false;
    if (text.startsWith(UTF8_BOM)) {
      hadBom = true;
      text = text.slice(UTF8_BOM.length);
    }
    const lineEnding = text.includes("\r\n") ? "crlf" : "lf";
    const normalized = text.replace(/\r\n/g, "\n");
    const lines = normalized.split("\n");
    const totalLines = normalized.endsWith("\n") ? lines.length - 1 : lines.length;

    let content = text;
    let sliceStartLine = 1;
    if (input.startLine !== undefined || input.endLine !== undefined) {
      const start = Math.max(1, input.startLine ?? 1);
      const end = Math.min(totalLines, input.endLine ?? totalLines);
      if (start > end) {
        return errorResult("encoding_error", `startLine ${start} > endLine ${end}`);
      }
      const slice = lines.slice(start - 1, end).join("\n");
      content = lineEnding === "crlf" ? slice.replace(/\n/g, "\r\n") : slice;
      if (hadBom && start === 1) content = UTF8_BOM + content;
      sliceStartLine = start;
    } else if (hadBom) {
      content = UTF8_BOM + text;
    }

    // Soft-cap truncation: returning 1M+ tokens of file content will blow
    // the model's context on the next turn. Truncate along a line boundary
    // and tell the model to page via startLine/endLine.
    const truncation = truncateIfOversized(content, lineEnding, sliceStartLine, totalLines);
    const result: ReadFileResult = {
      path: input.path,
      content: truncation.content,
      totalLines,
      hadBom,
      lineEnding,
    };
    if (truncation.truncated) {
      result.truncated = true;
      result.truncatedBytes = truncation.truncatedBytes;
    }

    // §1.2 file-state map: record mtime/size so subsequent mutating tools
    // can detect shell-side drift (`file_stale_read`). Optional — when no
    // map is attached (tests, subagents running in isolation) the read
    // still succeeds; staleness detection just doesn't fire.
    const fsMap = (ctx.userContext as { fileStateMap?: FileStateMapLike }).fileStateMap;
    if (fsMap) fsMap.record(input.path, { mtimeMs: st.mtimeMs, size: st.size });
    return { content: result };
  },
};

interface FileStateMapLike {
  record(path: string, stat: { mtimeMs: number; size: number }): void;
}

/**
 * If `content` exceeds `MAX_CONTENT_BYTES`, truncate along a newline boundary
 * and append a sentinel describing the shape of what was dropped. Returns
 * the original unchanged when within the cap.
 *
 * `sliceStartLine` is the 1-based starting line of `content` within the
 * original file (1 when no range was requested). Used to compute the
 * `endLine` hint in the sentinel.
 */
function truncateIfOversized(
  content: string,
  lineEnding: "lf" | "crlf",
  sliceStartLine: number,
  totalLines: number,
): { content: string; truncated: boolean; truncatedBytes: number } {
  const byteLen = Buffer.byteLength(content, "utf8");
  if (byteLen <= MAX_CONTENT_BYTES) {
    return { content, truncated: false, truncatedBytes: 0 };
  }
  // Slice to the cap, then back up to the last newline so we never cut a
  // line in half. The content uses whatever line ending the source has; we
  // search for both \n and \r\n and pick the later boundary.
  const sliced = content.slice(0, MAX_CONTENT_BYTES);
  const lastNl = Math.max(sliced.lastIndexOf("\n"), sliced.lastIndexOf("\r\n"));
  const cut = lastNl > MAX_CONTENT_BYTES / 2 ? lastNl + 1 : MAX_CONTENT_BYTES;
  const head = sliced.slice(0, cut);
  const droppedBytes = byteLen - Buffer.byteLength(head, "utf8");
  // Compute the approximate last line included, so the model can ask for
  // the next range starting from there.
  const headLines = head.split(/\r\n|\n/);
  const includedLineCount = head.endsWith("\n") ? headLines.length - 1 : headLines.length;
  const lastIncludedLine = sliceStartLine + includedLineCount - 1;
  const nextLine = Math.min(lastIncludedLine + 1, totalLines);
  const nl = lineEnding === "crlf" ? "\r\n" : "\n";
  const sentinel =
    `${nl}... [truncated: ${droppedBytes} more bytes / approximately ${totalLines - lastIncludedLine} more lines. ` +
    `Use startLine=${nextLine} (and optionally endLine) to read the next range.]`;
  return {
    content: head + sentinel,
    truncated: true,
    truncatedBytes: droppedBytes,
  };
}

function resolveInsideWorkspace(
  workspace: string,
  rel: string,
): { ok: true; path: string } | { ok: false; code: "path_outside_workspace"; message: string } {
  const ws = path.resolve(workspace);
  const resolved = path.resolve(ws, rel);
  if (resolved !== ws && !resolved.startsWith(ws + path.sep)) {
    return {
      ok: false,
      code: "path_outside_workspace",
      message: `${rel} resolves outside workspace`,
    };
  }
  return { ok: true, path: resolved };
}

function isBinary(buf: Uint8Array): boolean {
  const sampleLen = Math.min(buf.length, 8192);
  let nulls = 0;
  let high = 0;
  for (let i = 0; i < sampleLen; i++) {
    const b = buf[i]!;
    if (b === 0) nulls++;
    else if (b > 127) high++;
  }
  if (nulls > 0) return true;
  return sampleLen > 0 && high / sampleLen > 0.3;
}

function errorResult<T>(
  code: import("@open-apex/core").ToolErrorType,
  message: string,
): ToolExecuteResult<T> {
  return {
    content: message,
    isError: true,
    errorType: code,
  };
}
