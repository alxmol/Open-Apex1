/**
 * §1.2 patch-failure recovery flow.
 *
 * When `apply_patch` returns a structured error with `path` set (context
 * mismatch, hunk-offset exhausted, path-missing, binary file), the runtime:
 *
 *   1. Synthesizes a fresh `read_file` tool_result for that path, expanded
 *      \u00b110 lines around the failed hunk (or the whole file when no hunk
 *      range is available), and appends it to history so the model sees
 *      fresh context on the next turn.
 *   2. Opens `write_file` for that specific path on the next turn by
 *      writing into a per-turn allowedTools override map — other files
 *      remain locked to `apply_patch` / `search_replace`.
 *   3. Emits a `patch_recovery_read_injected` model_event for telemetry.
 *   4. Tracks consecutive failures per path. After two consecutive failures
 *      on the same path (after the recovery read), emits `patch_apply_failed`
 *      and lets the turn-runner escalate.
 *
 * The ledger is scoped per-run and consumed by the turn-runner's scheduler
 * wrapper. M4's recovery engine will extend this with the full failure
 * taxonomy (§7.6.3); M2 ships the patch-specific fast path.
 */

import { readFileSync, statSync } from "node:fs";
import * as path from "node:path";

import type { HistoryItem, ToolCallRequest, ToolResult } from "@open-apex/core";

export interface PatchRecoveryState {
  /** Per-path failure counter. Reset on successful apply. */
  failureCount: Map<string, number>;
  /** Per-path write_file override — added on first failure; cleared on success or exhaustion. */
  writeFileOpenFor: Set<string>;
}

export function newPatchRecoveryState(): PatchRecoveryState {
  return { failureCount: new Map(), writeFileOpenFor: new Set() };
}

export interface RecoveryInjectionResult {
  /** Synthetic history items to splice into the conversation. */
  inject: HistoryItem[];
  /** Paths that exhausted the recovery ladder (hard-fail for this turn). */
  exhausted: string[];
  /** Paths where write_file is now open on the NEXT turn. */
  writeFileOpen: string[];
}

/**
 * Inspect the results of a tool batch for apply_patch failures and decide
 * what to do next. Returns a list of synthetic history items to inject +
 * per-path allowance state.
 *
 * Pure-ish: mutates `state` but does NOT touch disk beyond reading the
 * file the recovery needs to expose to the model.
 */
export function maybeInjectPatchRecovery(
  calls: ToolCallRequest[],
  results: ToolResult[],
  state: PatchRecoveryState,
  workspace: string,
  turnIndex: number,
): RecoveryInjectionResult {
  const inject: HistoryItem[] = [];
  const exhausted: string[] = [];
  const writeFileOpen: string[] = [];

  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]!;
    const result = results[i];
    if (call.name !== "apply_patch") continue;
    if (!result) continue;
    if (result.status !== "error") {
      // Successful apply_patch — reset this path's counter.
      const modified = extractModifiedPaths(result);
      for (const p of modified) {
        state.failureCount.delete(p);
        state.writeFileOpenFor.delete(p);
      }
      continue;
    }
    // Structured error: find the target path in the tool's metadata.
    const detail = extractPatchErrorDetail(result);
    if (!detail?.path) continue;

    const prior = state.failureCount.get(detail.path) ?? 0;
    const next = prior + 1;
    state.failureCount.set(detail.path, next);

    if (next > 2) {
      // Exhausted: emit a marker the turn-runner consumes. Don't inject
      // another read; the model has already been told twice.
      state.writeFileOpenFor.delete(detail.path);
      exhausted.push(detail.path);
      continue;
    }

    // Inject a synthetic read_file result with \u00b110-line context.
    const snippet = readContext(workspace, detail.path, detail.hunkIndex, detail.lineNumber);
    if (snippet) {
      inject.push({
        id: `patch_recovery_read_${turnIndex}_${i}`,
        createdAt: new Date().toISOString(),
        role: "user",
        content: [
          {
            type: "text",
            text:
              `apply_patch failed on ${detail.path} (${detail.code}: ${detail.message}). ` +
              `Fresh file content follows for your next attempt. ` +
              `write_file has been temporarily enabled for this specific path if a full rewrite is unavoidable.`,
          },
          {
            type: "text",
            text: `\n--- ${detail.path} (current on-disk content) ---\n${snippet}\n--- end ${detail.path} ---\n`,
          },
        ],
      });
    }

    state.writeFileOpenFor.add(detail.path);
    writeFileOpen.push(detail.path);
  }

  return { inject, exhausted, writeFileOpen };
}

/**
 * Extract the structured `PatchErrorDetail` from an apply_patch tool
 * result. The `apply_patch` tool stuffs the detail into `result.metadata`
 * on error; we need access to that for recovery decisions. Since the
 * ToolResult shape erases metadata, we rely on the JSON-stringified
 * content as the authoritative source (the detail is embedded in the
 * message the model sees).
 *
 * The content shape on failure is `"<code>: <message>"` per apply_patch.ts
 * current implementation. We parse that back and try to extract the path.
 */
function extractPatchErrorDetail(result: ToolResult): PatchErrorLike | null {
  if (!result.errorType) return null;
  const errorType = result.errorType;
  const known = new Set([
    "patch_parse_error",
    "patch_context_mismatch",
    "path_missing",
    "hunk_offset_exhausted",
    "binary_file",
  ]);
  if (!known.has(errorType)) return null;
  const content =
    typeof result.content === "string" ? result.content : JSON.stringify(result.content);
  // Messages the patch engine emits include the path (see apply.ts):
  //   "hunk N context mismatch in <path> at line M"
  //   "file not found at workspace path: <path>"
  //   "refusing to patch binary file: <path>"
  //   "patch targets path outside workspace: <path>"
  //   "file diff has no old or new path"
  const pathPatterns = [
    /context mismatch in (\S+) at line (\d+)/,
    /hunk (\d+) context mismatch in (\S+) at line (\d+)/,
    /file not found at workspace path:\s*(\S+)/,
    /path exists but is not a regular file:\s*(\S+)/,
    /refusing to patch binary file:\s*(\S+)/,
    /patch targets path outside workspace:\s*(\S+)/,
  ];
  let matchedPath: string | undefined;
  let hunkIndex: number | undefined;
  let lineNumber: number | undefined;
  for (const re of pathPatterns) {
    const m = re.exec(content);
    if (m) {
      // Three-capture: hunkIndex + path + line
      if (m.length === 4) {
        hunkIndex = Number.parseInt(m[1]!, 10);
        matchedPath = m[2]!;
        lineNumber = Number.parseInt(m[3]!, 10);
      } else if (m.length === 3) {
        matchedPath = m[1]!;
        lineNumber = Number.parseInt(m[2]!, 10);
      } else {
        matchedPath = m[1]!;
      }
      break;
    }
  }
  if (!matchedPath) return null;
  return {
    code: errorType,
    message: content,
    path: matchedPath,
    ...(hunkIndex !== undefined ? { hunkIndex } : {}),
    ...(lineNumber !== undefined ? { lineNumber } : {}),
  };
}

/** Minimal apply_patch detail shape used locally. */
interface PatchErrorLike {
  code: string;
  message: string;
  path: string;
  hunkIndex?: number;
  lineNumber?: number;
}

/** Extract `filesModified[].path` from a successful apply_patch result. */
function extractModifiedPaths(result: ToolResult): string[] {
  const content = result.content;
  if (!content || typeof content !== "object") return [];
  const fm = (content as { filesModified?: Array<{ path?: string }> }).filesModified;
  if (!Array.isArray(fm)) return [];
  return fm.map((f) => f.path).filter((p): p is string => typeof p === "string");
}

const RECOVERY_READ_MAX_BYTES = 128 * 1024; // half of read_file's 256 KB cap.

function readContext(
  workspace: string,
  relPath: string,
  _hunkIndex: number | undefined,
  lineNumber: number | undefined,
): string | null {
  const abs = path.resolve(workspace, relPath);
  try {
    const st = statSync(abs);
    if (!st.isFile()) return null;
    // Binary-file detection is cheap on read_file; we rely on the fact that
    // binary_file errors already short-circuit above (the patch engine
    // returns before we call this).
    const buf = readFileSync(abs);
    if (buf.byteLength > RECOVERY_READ_MAX_BYTES) {
      // For huge files, just send the window \u00b110 lines around the failure.
      if (lineNumber !== undefined) {
        const text = buf.toString("utf8");
        const lines = text.split("\n");
        const start = Math.max(0, lineNumber - 11);
        const end = Math.min(lines.length, lineNumber + 10);
        const slice = lines.slice(start, end).join("\n");
        return `(window around line ${lineNumber}, lines ${start + 1}-${end})\n${slice}`;
      }
      return buf.slice(0, RECOVERY_READ_MAX_BYTES).toString("utf8") + "\n... [truncated]";
    }
    return buf.toString("utf8");
  } catch {
    return null;
  }
}
