/**
 * Deterministic patch applier with reverse-patch generation.
 *
 * Per §1.2:
 *   1. parse unified diff
 *   2. resolve paths inside the workspace
 *   3. verify file existence/type assumptions
 *   4. verify hunk context byte-for-byte
 *   5. apply or return a structured error
 *
 * Additionally emits a reverse patch so the caller can undo.
 */

import { readFileSync, statSync } from "node:fs";
import * as path from "node:path";

import { PatchError } from "./errors.ts";
import { parseUnifiedDiff, type PatchFile, type PatchHunk } from "./parse.ts";

export interface PlanApplyInput {
  /** Absolute workspace root. Patches that escape are rejected. */
  workspace: string;
  /** Raw unified-diff text. */
  patch: string;
}

export interface ApplyPatchPlan {
  /** Files the patch would modify (resolved to absolute paths under workspace). */
  files: AppliedFile[];
  /** Reverse patch — applying this undoes the whole change. */
  reversePatch: string;
}

export interface AppliedFile {
  /** Absolute path under workspace. */
  path: string;
  /** Workspace-relative POSIX-style path. */
  relPath: string;
  action: "modify" | "create" | "delete";
  /** New file contents (undefined when action=delete). */
  newContents?: string;
  /** Previous file contents (undefined when action=create). */
  previousContents?: string;
  /** Content encoding detected — UTF-8 only at M1. */
  encoding: "utf-8";
  /** Whether the file had a UTF-8 BOM we preserved. */
  hadBom: boolean;
  /** Original line ending convention preserved. */
  lineEnding: "lf" | "crlf";
}

const UTF8_BOM = "\uFEFF";

/**
 * Parse + validate + compute the result of applying a unified diff.
 * Does NOT write to disk; the caller is responsible for persisting the
 * AppliedFile.newContents. This separation lets the tool scheduler
 * checkpoint + write atomically.
 */
export function planApply(input: PlanApplyInput): ApplyPatchPlan {
  const files = parseUnifiedDiff(input.patch);
  const applied: AppliedFile[] = [];
  for (const f of files) applied.push(planOneFile(f, input.workspace));
  const reversePatch = generateReversePatch(applied);
  return { files: applied, reversePatch };
}

function planOneFile(file: PatchFile, workspace: string): AppliedFile {
  const oldPath = file.oldPath;
  const newPath = file.newPath;
  const targetRelPath = newPath ?? oldPath;
  if (!targetRelPath) {
    throw new PatchError({
      code: "patch_parse_error",
      message: "file diff has no old or new path",
    });
  }
  const absPath = resolveInsideWorkspace(workspace, targetRelPath);
  const action: AppliedFile["action"] =
    oldPath === null ? "create" : newPath === null ? "delete" : "modify";

  // For modify/delete, load current contents.
  let previousRaw: string | undefined;
  let hadBom = false;
  let lineEnding: "lf" | "crlf" = "lf";
  if (action !== "create") {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(absPath);
    } catch {
      throw new PatchError({
        code: "path_missing",
        message: `file not found at workspace path: ${targetRelPath}`,
        path: targetRelPath,
      });
    }
    if (!st.isFile()) {
      throw new PatchError({
        code: "path_missing",
        message: `path exists but is not a regular file: ${targetRelPath}`,
        path: targetRelPath,
      });
    }
    const buf = readFileSync(absPath);
    if (isBinary(buf)) {
      throw new PatchError({
        code: "binary_file",
        message: `refusing to patch binary file: ${targetRelPath}`,
        path: targetRelPath,
      });
    }
    previousRaw = buf.toString("utf8");
    if (previousRaw.startsWith(UTF8_BOM)) {
      hadBom = true;
      previousRaw = previousRaw.slice(UTF8_BOM.length);
    }
    lineEnding = detectLineEnding(previousRaw);
  }

  let newContents: string | undefined;
  if (action === "create") {
    // A create patch has no previous contents; the hunk's + lines ARE the new file.
    newContents = buildFromAddOnly(file);
  } else if (action === "delete") {
    newContents = undefined;
  } else {
    newContents = applyHunks(previousRaw ?? "", file, targetRelPath);
  }

  const result: AppliedFile = {
    path: absPath,
    relPath: targetRelPath.split(path.sep).join("/"),
    action,
    encoding: "utf-8",
    hadBom,
    lineEnding,
  };
  if (newContents !== undefined) result.newContents = newContents;
  if (previousRaw !== undefined) result.previousContents = previousRaw;
  return result;
}

function resolveInsideWorkspace(workspace: string, relPath: string): string {
  const resolved = path.resolve(workspace, relPath);
  const ws = path.resolve(workspace);
  if (resolved !== ws && !resolved.startsWith(ws + path.sep)) {
    throw new PatchError({
      code: "path_outside_workspace",
      message: `patch targets path outside workspace: ${relPath}`,
      path: relPath,
    });
  }
  return resolved;
}

/**
 * Apply the hunks of a modify patch to `previous`. Normalizes line endings to
 * LF for matching; preserves the original per-file convention on output.
 */
function applyHunks(previous: string, file: PatchFile, targetRelPath: string): string {
  // Normalize to LF for in-memory work.
  const originalLineEnding = detectLineEnding(previous);
  const lfText = previous.replace(/\r\n/g, "\n");
  let lines = lfText.split("\n");
  // Track hasTrailingNewline; split keeps an empty last element if so.
  const hasTrailingNewline = lfText.endsWith("\n");
  if (hasTrailingNewline) lines.pop();

  for (let h = 0; h < file.hunks.length; h++) {
    const hunk = file.hunks[h]!;
    const hunkIdx = h + 1;
    lines = applyOneHunk(lines, hunk, hunkIdx, targetRelPath);
  }

  let result = lines.join("\n");
  if (hasTrailingNewline) result += "\n";

  if (originalLineEnding === "crlf") {
    result = result.replace(/\n/g, "\r\n");
  }
  return result;
}

/**
 * Apply a single hunk at its declared oldStart (1-based). Scans outward for
 * offset if the exact position doesn't match, subject to a small offset window
 * — for M1 we enforce strict equality and fail on mismatch so the model
 * must re-read. §1.2 hunk_offset_exhausted is a structured error.
 */
function applyOneHunk(
  lines: string[],
  hunk: PatchHunk,
  hunkIndex: number,
  targetRelPath: string,
): string[] {
  const oldStartIdx = hunk.oldStart - 1; // 0-based
  const context: string[] = [];
  const adds: string[] = [];
  for (const l of hunk.lines) {
    if (l.kind === "context" || l.kind === "remove") context.push(l.text);
    if (l.kind === "context" || l.kind === "add") adds.push(l.text);
  }
  // Try exact position first; if missing, search ±64 lines.
  const candidates = [oldStartIdx];
  for (let delta = 1; delta <= 64; delta++) {
    candidates.push(oldStartIdx + delta, oldStartIdx - delta);
  }
  for (const pos of candidates) {
    if (pos < 0) continue;
    if (pos + context.length > lines.length) continue;
    let ok = true;
    for (let j = 0; j < context.length; j++) {
      if (lines[pos + j] !== context[j]) {
        ok = false;
        break;
      }
    }
    if (ok) {
      const before = lines.slice(0, pos);
      const after = lines.slice(pos + context.length);
      return [...before, ...adds, ...after];
    }
  }
  // Mismatch: emit structured error with the expected vs actual at oldStart.
  const actual = lines[oldStartIdx] ?? "";
  const expected = context[0] ?? "";
  throw new PatchError({
    code: "patch_context_mismatch",
    message: `hunk ${hunkIndex} context mismatch in ${targetRelPath} at line ${hunk.oldStart}`,
    path: targetRelPath,
    hunkIndex,
    lineNumber: hunk.oldStart,
    expected,
    actual,
  });
}

function buildFromAddOnly(file: PatchFile): string {
  const lines: string[] = [];
  for (const h of file.hunks) {
    for (const l of h.lines) {
      if (l.kind === "add" || l.kind === "context") lines.push(l.text);
    }
  }
  return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}

function isBinary(buf: Uint8Array): boolean {
  const sampleLen = Math.min(buf.length, 8192);
  let nullBytes = 0;
  let highBytes = 0;
  for (let i = 0; i < sampleLen; i++) {
    const b = buf[i]!;
    if (b === 0) nullBytes++;
    else if (b > 127) highBytes++;
  }
  if (nullBytes > 0) return true;
  // If > 30% high bytes, treat as non-text (§1.2 sniff heuristic).
  return sampleLen > 0 && highBytes / sampleLen > 0.3;
}

function detectLineEnding(s: string): "lf" | "crlf" {
  const crlf = (s.match(/\r\n/g) ?? []).length;
  const lf = (s.match(/(?<!\r)\n/g) ?? []).length;
  if (crlf > lf) return "crlf";
  return "lf";
}

function splitLinesNoTrailing(s: string): string[] {
  const lf = s.replace(/\r\n/g, "\n");
  const parts = lf.split("\n");
  if (parts.length > 0 && parts[parts.length - 1] === "") parts.pop();
  return parts;
}

/**
 * Generate a unified-diff that, when applied to the NEW state, reverts to the
 * previous state. Simple version: swap add/remove lines and adjust hunk headers.
 */
export function generateReversePatch(files: AppliedFile[]): string {
  const out: string[] = [];
  for (const f of files) {
    const relPath = f.relPath;
    // Reverse create → delete, delete → create, modify → modify with swapped lines.
    if (f.action === "create") {
      const prevLines = splitLinesNoTrailing(f.newContents ?? "");
      const removed = prevLines.map((l) => `-${l}`).join("\n");
      out.push(`--- a/${relPath}`, `+++ /dev/null`, `@@ -1,${prevLines.length} +0,0 @@`, removed);
    } else if (f.action === "delete") {
      const addLines = splitLinesNoTrailing(f.previousContents ?? "");
      const added = addLines.map((l) => `+${l}`).join("\n");
      out.push(`--- /dev/null`, `+++ b/${relPath}`, `@@ -0,0 +1,${addLines.length} @@`, added);
    } else {
      // modify: reverse patch takes the NEW state back to PREVIOUS. Emit the
      // new lines as removals and the previous lines as additions. Strip
      // trailing empty sentinel from split so counts match the applier's
      // line array (which pops the trailing empty too).
      const prev = splitLinesNoTrailing(f.previousContents ?? "");
      const next = splitLinesNoTrailing(f.newContents ?? "");
      out.push(`--- a/${relPath}`, `+++ b/${relPath}`, `@@ -1,${next.length} +1,${prev.length} @@`);
      for (const l of next) out.push(`-${l}`);
      for (const l of prev) out.push(`+${l}`);
    }
  }
  return out.join("\n") + "\n";
}
