/**
 * Tree-sitter-backed symbol index.
 *
 * Per §M3 design:
 *   - Incremental: mtime + size cache so re-indexing only re-parses changed files.
 *   - Memory-safe: every `Tree` and `Query` is `.delete()`'d in a try/finally.
 *   - Cross-language: supports the SYMBOL_INDEXABLE_LANGUAGES set.
 *
 * The resulting `SymbolIndex` is consumed by the `symbol_lookup` tool and
 * contributes `SymbolIndexStats` to future M4 `RepoScoutResult`.
 */

import { readFile, stat } from "node:fs/promises";
import * as path from "node:path";

import { Parser, Query } from "web-tree-sitter";

import type { SymbolIndexStats } from "@open-apex/core";

import {
  detectLanguage,
  type IndexedLanguage,
  SYMBOL_INDEXABLE_LANGUAGES,
} from "./language-detect.ts";
import { ensureParserInit, loadGrammar } from "./tree-sitter/init.ts";
import { SYMBOL_QUERIES, kindFromCapture, type SymbolKind } from "./tree-sitter/queries.ts";

export interface SymbolEntry {
  name: string;
  kind: SymbolKind;
  language: IndexedLanguage;
  path: string;
  startLine: number;
  endLine: number;
  startCol: number;
  endCol: number;
}

export interface IndexStatsEntry {
  mtimeMs: number;
  size: number;
  symbolCount: number;
}

export interface SymbolIndex {
  workspace: string;
  symbols: Map<string, SymbolEntry[]>;
  fileStats: Map<string, IndexStatsEntry>;
}

export function createEmptySymbolIndex(workspace: string): SymbolIndex {
  return {
    workspace: path.resolve(workspace),
    symbols: new Map(),
    fileStats: new Map(),
  };
}

export interface IndexOpts {
  /** Max bytes per file the indexer will attempt to parse. Default 2 MiB. */
  maxFileBytes?: number;
  /** Force re-parse even when mtime/size unchanged. Default false. */
  forceReparse?: boolean;
  /** Abort signal. */
  signal?: AbortSignal;
}

/**
 * Index (or re-index) a single file. Returns the number of symbols recorded.
 * Removes the file's old symbols from the index on each call.
 */
export async function indexFile(
  index: SymbolIndex,
  relPath: string,
  opts: IndexOpts = {},
): Promise<number> {
  if (opts.signal?.aborted) return 0;
  const abs = path.resolve(index.workspace, relPath);
  const st = await stat(abs);
  if (opts.signal?.aborted) return 0;
  const maxBytes = opts.maxFileBytes ?? 2 * 1024 * 1024;
  if (!st.isFile() || st.size === 0 || st.size > maxBytes) return 0;

  const existing = index.fileStats.get(relPath);
  if (
    !opts.forceReparse &&
    existing &&
    existing.mtimeMs === st.mtimeMs &&
    existing.size === st.size
  ) {
    return existing.symbolCount;
  }

  const language = detectLanguage(abs);
  if (!language || !SYMBOL_INDEXABLE_LANGUAGES.includes(language)) return 0;
  if (opts.signal?.aborted) return 0;
  const grammar = await loadGrammar(language);
  if (!grammar) return 0;
  const queryDef = SYMBOL_QUERIES[language];
  if (!queryDef) return 0;

  await ensureParserInit();
  if (opts.signal?.aborted) return 0;
  const source = await readFile(abs, "utf8");
  if (opts.signal?.aborted) return 0;

  // Clear previous symbols for this file before re-indexing.
  index.symbols.delete(relPath);

  const parser = new Parser();
  parser.setLanguage(grammar);
  if (opts.signal?.aborted) {
    parser.delete();
    return 0;
  }
  const tree = parser.parse(source);
  if (opts.signal?.aborted) {
    tree?.delete();
    parser.delete();
    return 0;
  }
  if (!tree) {
    parser.delete();
    return 0;
  }
  const query = new Query(grammar, queryDef.query);
  const entries: SymbolEntry[] = [];
  try {
    if (opts.signal?.aborted) return 0;
    const captures = query.captures(tree.rootNode);
    for (const cap of captures) {
      if (opts.signal?.aborted) return 0;
      const kind = kindFromCapture(cap.name);
      if (!kind) continue;
      const text = cap.node.text;
      const start = cap.node.startPosition;
      const end = cap.node.endPosition;
      entries.push({
        name: text,
        kind,
        language,
        path: relPath,
        startLine: start.row + 1,
        endLine: end.row + 1,
        startCol: start.column,
        endCol: end.column,
      });
    }
  } finally {
    query.delete();
    tree.delete();
    parser.delete();
  }

  if (entries.length > 0) index.symbols.set(relPath, entries);
  index.fileStats.set(relPath, {
    mtimeMs: st.mtimeMs,
    size: st.size,
    symbolCount: entries.length,
  });
  return entries.length;
}

/** Index (or re-index) a batch of files. */
export async function indexBatch(
  index: SymbolIndex,
  relPaths: readonly string[],
  opts: IndexOpts = {},
): Promise<number> {
  let total = 0;
  for (const p of relPaths) {
    if (opts.signal?.aborted) break;
    try {
      total += await indexFile(index, p, opts);
    } catch {
      // Parser errors shouldn't kill the batch — skip the file.
    }
    // Keep large benchmark repo scans cooperative so an aborted gather lane can
    // return control to the phase engine promptly instead of monopolizing the
    // event loop across many parse-heavy files.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return total;
}

export interface SymbolMatch extends SymbolEntry {
  score: number;
}

export interface FindSymbolsOpts {
  kind?: SymbolKind;
  language?: IndexedLanguage;
  limit?: number;
  /** Exact name match only when true. Default false (substring + case-insensitive). */
  exact?: boolean;
}

/** Look up symbols by name. Substring + case-insensitive by default. */
export function findSymbols(
  index: SymbolIndex,
  name: string,
  opts: FindSymbolsOpts = {},
): SymbolMatch[] {
  const needle = name.toLowerCase();
  const out: SymbolMatch[] = [];
  for (const entries of index.symbols.values()) {
    for (const e of entries) {
      if (opts.kind && e.kind !== opts.kind) continue;
      if (opts.language && e.language !== opts.language) continue;
      const lc = e.name.toLowerCase();
      if (opts.exact ? lc === needle : lc.includes(needle)) {
        const exact = lc === needle;
        const score = exact ? 1 : Math.max(0.2, needle.length / Math.max(1, lc.length));
        out.push({ ...e, score });
      }
    }
  }
  out.sort((a, b) => b.score - a.score);
  const limit = opts.limit ?? 50;
  return out.slice(0, limit);
}

export function symbolIndexStats(index: SymbolIndex): SymbolIndexStats {
  const byKind: Record<string, number> = {};
  const languages = new Set<string>();
  let total = 0;
  for (const entries of index.symbols.values()) {
    for (const e of entries) {
      total++;
      byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
      languages.add(e.language);
    }
  }
  return {
    symbolCount: total,
    byKind,
    indexedLanguages: [...languages].sort(),
  };
}
