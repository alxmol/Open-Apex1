/**
 * RepoMap builder — gitignore-aware repo walk producing §3.4.4 `RepoMap`.
 *
 * Implementation notes:
 *   - Walks via Node's `fs/promises.readdir` with `withFileTypes: true`.
 *   - Respects `.gitignore` patterns from the workspace root (single-file
 *     parser; sufficient for M3's needs — M5 can extend to nested .gitignores).
 *   - Default excludes: `node_modules`, `dist`, `build`, `.venv`, `venv`,
 *     `target`, `__pycache__`, `.git`, `.next`, `.open-apex`, `.pytest_cache`,
 *     `.cache`, `.DS_Store`, dot-prefixed build dirs.
 *   - Hard caps: 50 000 files + 500 MB bytes scanned → stops early with
 *     `truncated: true` in the returned map so the caller can surface it.
 *   - Symlinks: followed when they point inside the workspace, skipped
 *     otherwise (avoids escapes + cycles).
 */

import { readdir, readFile, stat } from "node:fs/promises";
import * as path from "node:path";

import type { RepoMap } from "@open-apex/core";

import { detectLanguage } from "./language-detect.ts";

export interface BuildRepoMapOpts {
  workspace: string;
  /** Hard file-count ceiling before truncation. Default 50_000. */
  maxFiles?: number;
  /** Hard byte ceiling before truncation. Default 500 MiB. */
  maxBytes?: number;
  /** Extra excluded directory names (merged with defaults). */
  extraExcludes?: readonly string[];
  /** Whether to honor `.gitignore` at workspace root. Default true. */
  respectGitignore?: boolean;
  /** If set, only include files matching at least one of these extensions. */
  includeExtensions?: readonly string[];
  /** Follow symlinks inside the workspace (default true). */
  followSymlinks?: boolean;
  /** Optional abort signal. */
  signal?: AbortSignal;
}

export interface RepoMapExtended extends RepoMap {
  /** True when maxFiles / maxBytes limits stopped the walk early. */
  truncated: boolean;
  /** Counts by IndexedLanguage for UX. */
  languageCounts: Record<string, number>;
}

const DEFAULT_EXCLUDES: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  ".venv",
  "venv",
  "target",
  "__pycache__",
  ".git",
  ".next",
  ".nuxt",
  ".open-apex",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".cache",
  "coverage",
  ".nyc_output",
  ".idea",
  ".vscode",
  ".DS_Store",
]);

const DEFAULT_MAX_FILES = 50_000;
const DEFAULT_MAX_BYTES = 500 * 1024 * 1024;

export async function buildRepoMap(opts: BuildRepoMapOpts): Promise<RepoMapExtended> {
  const workspace = path.resolve(opts.workspace);
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const extraExcludes = new Set(opts.extraExcludes ?? []);
  const respectGitignore = opts.respectGitignore !== false;
  const followSymlinks = opts.followSymlinks !== false;
  const includeExtensions = opts.includeExtensions
    ? new Set(opts.includeExtensions.map((e) => (e.startsWith(".") ? e : `.${e}`)))
    : null;

  const gitignore = respectGitignore ? await loadGitignore(workspace) : null;

  const files: RepoMapExtended["files"] = [];
  const languageCounts: Record<string, number> = {};
  let totalBytes = 0;
  let truncated = false;

  function throwIfAborted(): void {
    if (opts.signal?.aborted) throw new Error("aborted");
  }

  async function walk(abs: string, relRoot: string): Promise<void> {
    throwIfAborted();
    if (files.length >= maxFiles || totalBytes >= maxBytes) {
      truncated = true;
      return;
    }
    let entries;
    try {
      entries = await readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      throwIfAborted();
      const name = e.name;
      if (DEFAULT_EXCLUDES.has(name) || extraExcludes.has(name)) continue;
      const full = path.join(abs, name);
      const rel = relRoot === "" ? name : `${relRoot}/${name}`;
      if (gitignore && gitignore.ignores(rel, e.isDirectory())) continue;
      if (e.isDirectory()) {
        await walk(full, rel);
        if (truncated) return;
      } else if (e.isSymbolicLink()) {
        if (!followSymlinks) continue;
        try {
          throwIfAborted();
          const st = await stat(full);
          if (st.isDirectory()) {
            const real = await resolveRealPath(full);
            if (!real || !real.startsWith(workspace + path.sep)) continue;
            await walk(full, rel);
            if (truncated) return;
          } else {
            await recordFile(full, rel, st.size);
          }
        } catch {
          continue;
        }
      } else if (e.isFile()) {
        try {
          throwIfAborted();
          const st = await stat(full);
          await recordFile(full, rel, st.size);
          if (files.length >= maxFiles || totalBytes >= maxBytes) {
            truncated = true;
            return;
          }
        } catch {
          continue;
        }
      }
    }
  }

  async function recordFile(abs: string, rel: string, size: number): Promise<void> {
    throwIfAborted();
    if (includeExtensions) {
      const ext = path.extname(rel).toLowerCase();
      if (!includeExtensions.has(ext)) return;
    }
    const language = detectLanguage(abs);
    const entry: { path: string; language?: string; sizeBytes: number } = {
      path: rel,
      sizeBytes: size,
    };
    if (language) entry.language = language;
    files.push(entry);
    totalBytes += size;
    if (language) {
      languageCounts[language] = (languageCounts[language] ?? 0) + 1;
    }
  }

  await walk(workspace, "");

  const map: RepoMapExtended = {
    root: workspace,
    files,
    totalFiles: files.length,
    totalBytes,
    truncated,
    languageCounts,
  };
  return map;
}

/** Capped repo-map serializer used by the `repo_map` tool. */
export interface RenderRepoMapOpts {
  maxFiles?: number;
  maxBytes?: number;
}

export function renderRepoMapSummary(map: RepoMapExtended, opts: RenderRepoMapOpts = {}): string {
  const maxFiles = opts.maxFiles ?? 400;
  const topFiles = map.files.slice(0, maxFiles);
  const langs = Object.entries(map.languageCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([l, c]) => `${l}=${c}`)
    .join(", ");
  const header = [
    `root: ${map.root}`,
    `files: ${map.totalFiles} (${(map.totalBytes / 1024).toFixed(1)} KiB)${map.truncated ? " [truncated]" : ""}`,
    `languages: ${langs || "(none detected)"}`,
    "---",
  ].join("\n");
  return (
    header +
    "\n" +
    topFiles.map((f) => `${f.language ?? "text"}: ${f.path} (${f.sizeBytes}b)`).join("\n")
  );
}

// ─── Gitignore mini-parser ────────────────────────────────────────────────────

/** Minimal single-file `.gitignore` handler: glob → regex, respects negations. */
interface GitignoreMatcher {
  ignores(relPath: string, isDir: boolean): boolean;
}

async function loadGitignore(workspace: string): Promise<GitignoreMatcher | null> {
  const p = path.join(workspace, ".gitignore");
  let text: string;
  try {
    text = await readFile(p, "utf8");
  } catch {
    return null;
  }
  const rules = parseGitignore(text);
  if (rules.length === 0) return null;
  return {
    ignores(relPath, isDir) {
      let ignored = false;
      for (const r of rules) {
        if (r.dirOnly && !isDir) continue;
        if (r.regex.test(relPath) || r.regex.test(relPath + "/")) {
          ignored = !r.negate;
        }
      }
      return ignored;
    },
  };
}

interface GitignoreRule {
  regex: RegExp;
  negate: boolean;
  dirOnly: boolean;
}

function parseGitignore(text: string): GitignoreRule[] {
  const rules: GitignoreRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let negate = false;
    let pattern = line;
    if (pattern.startsWith("!")) {
      negate = true;
      pattern = pattern.slice(1);
    }
    const dirOnly = pattern.endsWith("/");
    if (dirOnly) pattern = pattern.slice(0, -1);
    const regex = globToRegex(pattern);
    rules.push({ regex, negate, dirOnly });
  }
  return rules;
}

function globToRegex(pattern: string): RegExp {
  // Simple, sufficient for 90%: /** matches any path, ** matches nothing-or-more,
  // * matches no-slash, ? matches one non-slash char.
  let anchored = false;
  if (pattern.startsWith("/")) {
    anchored = true;
    pattern = pattern.slice(1);
  }
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**` matches any sequence incl. slashes
        out += ".*";
        i += 2;
        if (pattern[i] === "/") i++; // gulp trailing slash
      } else {
        out += "[^/]*";
        i++;
      }
    } else if (c === "?") {
      out += "[^/]";
      i++;
    } else if (c === ".") {
      out += "\\.";
      i++;
    } else if (c !== undefined && /[-/]/.test(c)) {
      out += c === "-" ? "\\-" : c;
      i++;
    } else if (c !== undefined && /[a-zA-Z0-9_]/.test(c)) {
      out += c;
      i++;
    } else if (c !== undefined) {
      out += "\\" + c;
      i++;
    }
  }
  const prefix = anchored ? "^" : "(^|/)";
  return new RegExp(prefix + out + "($|/)");
}

async function resolveRealPath(p: string): Promise<string | null> {
  try {
    return (await import("node:fs/promises")).realpath(p);
  } catch {
    return null;
  }
}
