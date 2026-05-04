/**
 * search_replace tool — exact old-text → new-text replacement.
 *
 * §1.2 edge-case policy:
 *   - UTF-8 default; BOM preserved on read + write
 *   - CRLF/LF detected and preserved (both old_text + new_text normalized first)
 *   - binary files rejected via first-8-KB null-byte + >30% high-byte sniff
 *   - case-sensitive exact match; no fuzzy
 *   - uniqueness required by default; replaceAll: true replaces all and reports count
 *   - 10 MB file cap; larger → file_too_large
 *   - symlinks: M1 reads through to the target; if target is outside workspace, rejects
 *
 * Deferred to M5: file-state-map stale-read detection (needs persistent SessionStore).
 */

import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import type {
  OpenApexRunContext,
  ToolDefinition,
  ToolErrorType,
  ToolExecuteResult,
} from "@open-apex/core";

export interface SearchReplaceInput {
  path: string;
  oldText: string;
  newText: string;
  replaceAll?: boolean;
  encoding?: string;
}

export interface SearchReplaceResult {
  path: string;
  replacements: number;
}

const UTF8_BOM = "\uFEFF";
const MAX_FILE_BYTES = 10 * 1024 * 1024;

export const searchReplaceTool: ToolDefinition<SearchReplaceInput, SearchReplaceResult> = {
  name: "search_replace",
  description:
    "Replace an exact substring in a file. Matching is byte-for-byte after line-ending normalization (both oldText and the file are normalized to LF for matching; the file's original line endings are preserved on write). By default oldText must be unique; set replaceAll=true to replace every occurrence. Binary files and non-UTF-8 files are rejected.",
  kind: "editor",
  parameters: {
    type: "object",
    required: ["path", "oldText", "newText"],
    additionalProperties: false,
    properties: {
      path: { type: "string" },
      oldText: { type: "string" },
      newText: { type: "string" },
      replaceAll: { type: "boolean" },
      encoding: { type: "string" },
    },
  },
  permissionClass: "REVERSIBLE",
  errorCodes: [
    "file_not_found",
    "path_outside_workspace",
    "binary_file",
    "file_too_large",
    "encoding_error",
    "search_replace_ambiguous",
    "search_replace_not_found",
    "file_stale_read",
  ] as const,
  async execute(
    input: SearchReplaceInput,
    ctx: OpenApexRunContext,
  ): Promise<ToolExecuteResult<SearchReplaceResult>> {
    const ws = path.resolve(ctx.userContext.workspace);
    const abs = path.resolve(ws, input.path);
    if (abs !== ws && !abs.startsWith(ws + path.sep)) {
      return errorResult("path_outside_workspace", `${input.path} resolves outside workspace`);
    }
    if (!existsSync(abs)) {
      return errorResult("file_not_found", `no such file: ${input.path}`);
    }
    // §1.2 file-state-map stale-read guard. If the map was populated by a
    // prior `read_file` and the on-disk mtime/size has drifted (likely a
    // shell-side `echo >>` or out-of-band edit), surface `file_stale_read`
    // with the recorded vs. current stats so the model re-reads before
    // trying again.
    const fsMap = (ctx.userContext as { fileStateMap?: FileStateMapLike }).fileStateMap;
    if (fsMap) {
      const stale = fsMap.isStale(input.path);
      if (stale) {
        return errorResult(
          "file_stale_read",
          `file_stale_read: file ${input.path} changed on disk since last read (mtime ${stale.recordedMtimeMs}→${stale.currentMtimeMs}, size ${stale.recordedSize}→${stale.currentSize}); re-read before editing.`,
        );
      }
    }
    // Symlink policy: read through to the target, reject if target is outside
    // workspace. We realpath both sides so symlink chains like /tmp →
    // /private/tmp on macOS don't produce false positives.
    let real: string;
    try {
      real = realpathSync(abs);
    } catch {
      real = abs;
    }
    let realWs: string;
    try {
      realWs = realpathSync(ws);
    } catch {
      realWs = ws;
    }
    if (real !== realWs && !real.startsWith(realWs + path.sep)) {
      return errorResult(
        "path_outside_workspace",
        `symlink ${input.path} resolves outside workspace (target: ${real})`,
      );
    }
    const st = statSync(real);
    if (!st.isFile()) {
      return errorResult("file_not_found", `${input.path} is not a regular file`);
    }
    if (st.size > MAX_FILE_BYTES) {
      return errorResult(
        "file_too_large",
        `${input.path} is ${st.size} bytes (> 10 MB); use apply_patch with narrow hunks`,
      );
    }
    const encoding = (input.encoding ?? "utf-8").toLowerCase();
    if (encoding !== "utf-8" && encoding !== "utf8") {
      return errorResult("encoding_error", `only utf-8 is supported at M1 (got ${encoding})`);
    }
    const buf = readFileSync(real);
    if (isBinary(buf)) {
      return errorResult("binary_file", `${input.path} appears to be binary`);
    }
    let raw = new TextDecoder("utf-8", { fatal: false }).decode(buf);
    let hadBom = false;
    if (raw.startsWith(UTF8_BOM)) {
      hadBom = true;
      raw = raw.slice(UTF8_BOM.length);
    }
    const lineEnding: "lf" | "crlf" = raw.includes("\r\n") ? "crlf" : "lf";
    const normalized = raw.replace(/\r\n/g, "\n");
    const oldLf = input.oldText.replace(/\r\n/g, "\n");
    const newLf = input.newText.replace(/\r\n/g, "\n");

    if (input.replaceAll) {
      const count = countOccurrences(normalized, oldLf);
      if (count === 0) {
        return errorResult("search_replace_not_found", `oldText not found in ${input.path}`);
      }
      const replaced = normalized.split(oldLf).join(newLf);
      const finalText = preserveLineEndings(replaced, lineEnding, hadBom);
      writeFileSync(real, finalText, "utf8");
      fsMap?.clear(input.path);
      return {
        content: { path: input.path, replacements: count },
      };
    }

    const firstIdx = normalized.indexOf(oldLf);
    if (firstIdx < 0) {
      return errorResult("search_replace_not_found", `oldText not found in ${input.path}`);
    }
    const secondIdx = normalized.indexOf(oldLf, firstIdx + 1);
    if (secondIdx >= 0) {
      const lineNumbers = matchLineNumbers(normalized, oldLf).slice(0, 10);
      return {
        content: `oldText matches ${countOccurrences(normalized, oldLf)} places in ${input.path} (lines ${lineNumbers.join(", ")}). Expand oldText for uniqueness or set replaceAll: true.`,
        isError: true,
        errorType: "search_replace_ambiguous" as ToolErrorType,
      };
    }
    const replacedOnce =
      normalized.slice(0, firstIdx) + newLf + normalized.slice(firstIdx + oldLf.length);
    const finalText = preserveLineEndings(replacedOnce, lineEnding, hadBom);
    writeFileSync(real, finalText, "utf8");
    fsMap?.clear(input.path);
    return { content: { path: input.path, replacements: 1 } };
  },
};

interface FileStateMapLike {
  isStale(path: string): {
    recordedMtimeMs: number;
    recordedSize: number;
    currentMtimeMs: number;
    currentSize: number;
  } | null;
  clear(path: string): void;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let pos = 0;
  while (true) {
    const idx = haystack.indexOf(needle, pos);
    if (idx < 0) break;
    count++;
    pos = idx + needle.length;
  }
  return count;
}

function matchLineNumbers(haystack: string, needle: string): number[] {
  const out: number[] = [];
  let pos = 0;
  while (true) {
    const idx = haystack.indexOf(needle, pos);
    if (idx < 0) break;
    // 1-based line number.
    const prefix = haystack.slice(0, idx);
    const lineNum = (prefix.match(/\n/g)?.length ?? 0) + 1;
    out.push(lineNum);
    pos = idx + needle.length;
  }
  return out;
}

function preserveLineEndings(
  lfText: string,
  originalEnding: "lf" | "crlf",
  hadBom: boolean,
): string {
  let out = lfText;
  if (originalEnding === "crlf") out = out.replace(/\n/g, "\r\n");
  if (hadBom) out = UTF8_BOM + out;
  return out;
}

function isBinary(buf: Uint8Array): boolean {
  const n = Math.min(buf.length, 8192);
  let nulls = 0;
  let high = 0;
  for (let i = 0; i < n; i++) {
    const b = buf[i]!;
    if (b === 0) nulls++;
    else if (b > 127) high++;
  }
  if (nulls > 0) return true;
  return n > 0 && high / n > 0.3;
}

function errorResult<T>(
  code: import("@open-apex/core").ToolErrorType,
  message: string,
): ToolExecuteResult<T> {
  return { content: message, isError: true, errorType: code };
}
