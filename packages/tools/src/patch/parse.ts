/**
 * Unified-diff parser.
 * §1.2: apply_patch accepts `--- a/file`, `+++ b/file`, `@@ -l,c +l,c @@`.
 *
 * Deliberately minimal:
 *   - no support for git-extended headers (rename/copy) at M1
 *   - no binary diffs (return binary_file error before reaching the parser)
 *   - supports multi-file patches (one hunk group per file pair)
 *   - each hunk is a list of context/add/remove lines
 */

import { PatchError } from "./errors.ts";

export interface PatchFile {
  oldPath: string | null; // null for added files
  newPath: string | null; // null for deleted files
  hunks: PatchHunk[];
  /** Original header lines for round-trip / diagnostic. */
  headerLines: string[];
}

export interface PatchHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** Section header that appears after @@ — usually the enclosing function sig. */
  sectionHeader?: string;
  lines: PatchLine[];
}

export type PatchLine =
  | { kind: "context"; text: string }
  | { kind: "add"; text: string }
  | { kind: "remove"; text: string };

/**
 * Parse a unified-diff patch into PatchFiles. The input must use `\n` line
 * endings internally; callers should normalize before passing.
 */
export function parseUnifiedDiff(patch: string): PatchFile[] {
  if (!patch.trim()) {
    throw new PatchError({
      code: "patch_parse_error",
      message: "empty patch",
    });
  }
  const lines = patch.split(/\r?\n/);
  const files: PatchFile[] = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i] === undefined) break;
    if (lines[i] === "") {
      i++;
      continue;
    }
    const headerLines: string[] = [];
    while (i < lines.length && lines[i] !== undefined && !lines[i]!.startsWith("--- ")) {
      headerLines.push(lines[i]!);
      i++;
    }
    if (i >= lines.length) break;
    const oldLine = lines[i]!;
    if (!oldLine.startsWith("--- ")) {
      i++;
      continue;
    }
    const newLine = lines[i + 1];
    if (newLine === undefined || !newLine.startsWith("+++ ")) {
      throw new PatchError({
        code: "patch_parse_error",
        message: `expected '+++ ' header after '${oldLine}'`,
      });
    }
    const oldPath = parsePathHeader(oldLine.slice(4));
    const newPath = parsePathHeader(newLine.slice(4));
    i += 2;
    const hunks: PatchHunk[] = [];
    while (i < lines.length && lines[i] !== undefined && lines[i]!.startsWith("@@")) {
      const { hunk, consumed } = parseHunk(lines, i);
      hunks.push(hunk);
      i += consumed;
    }
    files.push({ oldPath, newPath, hunks, headerLines });
  }
  if (files.length === 0) {
    throw new PatchError({
      code: "patch_parse_error",
      message: "no file headers found; expected at least one '--- a/foo'",
    });
  }
  return files;
}

/** Parse the path portion of a --- or +++ line: `a/foo/bar.ts` → `foo/bar.ts`. */
function parsePathHeader(raw: string): string | null {
  let p = raw.trim();
  // Strip tab-suffixed metadata (timestamps): "a/foo\t2026-..."
  const tab = p.indexOf("\t");
  if (tab >= 0) p = p.slice(0, tab);
  if (p === "/dev/null") return null;
  if (p.startsWith("a/") || p.startsWith("b/")) return p.slice(2);
  return p;
}

function parseHunk(lines: string[], startIdx: number): { hunk: PatchHunk; consumed: number } {
  const header = lines[startIdx]!;
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(header);
  if (!match) {
    throw new PatchError({
      code: "patch_parse_error",
      message: `malformed hunk header: ${header}`,
    });
  }
  const oldStart = Number.parseInt(match[1]!, 10);
  const oldCount = match[2] !== undefined ? Number.parseInt(match[2], 10) : 1;
  const newStart = Number.parseInt(match[3]!, 10);
  const newCount = match[4] !== undefined ? Number.parseInt(match[4], 10) : 1;
  const sectionHeader = match[5]?.trim() || undefined;

  const hunkLines: PatchLine[] = [];
  let remainingOld = oldCount;
  let remainingNew = newCount;
  let i = startIdx + 1;
  while (i < lines.length && (remainingOld > 0 || remainingNew > 0)) {
    const line = lines[i];
    if (line === undefined) break;
    // Reached the start of the next hunk/file before consuming this one →
    // malformed input.
    if (line.startsWith("@@") || line.startsWith("--- ")) {
      throw new PatchError({
        code: "patch_parse_error",
        message: `hunk truncated before consuming declared counts at line ${i + 1}`,
      });
    }
    // Diff line markers: ' ' context, '+' add, '-' remove, '\' for no-newline-at-eof.
    if (line.startsWith("\\ ")) {
      i++;
      continue;
    }
    if (line.length === 0) break;
    const marker = line[0] ?? " ";
    const text = line.length > 0 ? line.slice(1) : "";
    if (marker === " ") {
      hunkLines.push({ kind: "context", text });
      remainingOld--;
      remainingNew--;
    } else if (marker === "+") {
      hunkLines.push({ kind: "add", text });
      remainingNew--;
    } else if (marker === "-") {
      hunkLines.push({ kind: "remove", text });
      remainingOld--;
    } else {
      throw new PatchError({
        code: "patch_parse_error",
        message: `unexpected line in hunk at line ${i + 1}: '${line}'`,
      });
    }
    i++;
  }
  if (remainingOld > 0 || remainingNew > 0) {
    throw new PatchError({
      code: "patch_parse_error",
      message: `hunk truncated before consuming declared counts at line ${i + 1}`,
    });
  }
  const hunk: PatchHunk = {
    oldStart,
    oldCount,
    newStart,
    newCount,
    lines: hunkLines,
  };
  if (sectionHeader !== undefined) hunk.sectionHeader = sectionHeader;
  return {
    hunk,
    consumed: i - startIdx,
  };
}
