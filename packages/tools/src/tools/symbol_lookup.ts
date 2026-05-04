/**
 * symbol_lookup — find function / class / struct / trait / etc. definitions
 * by name across the workspace using the tree-sitter symbol index (§M3).
 *
 * The runtime lazily builds + caches a `SymbolIndex` keyed by workspace path.
 * First call seeds it from the repo map; subsequent calls re-index files whose
 * mtime changed since last scan.
 */

import { existsSync, statSync } from "node:fs";
import * as path from "node:path";

import type { OpenApexRunContext, ToolDefinition, ToolExecuteResult } from "@open-apex/core";
import {
  buildRepoMap,
  createEmptySymbolIndex,
  findSymbols,
  indexBatch,
  SYMBOL_INDEXABLE_LANGUAGES,
  type SymbolIndex,
  type SymbolKind,
} from "@open-apex/indexer";

export interface SymbolLookupInput {
  symbol: string;
  kind?: SymbolKind;
  language?: (typeof SYMBOL_INDEXABLE_LANGUAGES)[number];
  exact?: boolean;
  limit?: number;
}

export interface SymbolLookupResult {
  symbol: string;
  matches: Array<{
    name: string;
    kind: string;
    language: string;
    path: string;
    startLine: number;
    endLine: number;
    score: number;
  }>;
  indexStats: {
    symbolCount: number;
    fileCount: number;
    indexedLanguages: string[];
  };
}

// Cache one symbol index per workspace per process.
const indexCache = new Map<string, SymbolIndex>();

export function __resetSymbolIndexCacheForTest(): void {
  indexCache.clear();
}

async function getOrBuild(workspace: string, signal: AbortSignal): Promise<SymbolIndex> {
  const ws = path.resolve(workspace);
  let idx = indexCache.get(ws);
  if (!idx) {
    idx = createEmptySymbolIndex(ws);
    indexCache.set(ws, idx);
  }
  // Refresh the list of indexable files, skipping anything excluded by repo-map.
  const map = await buildRepoMap({ workspace: ws, signal });
  const candidates = map.files
    .filter(
      (f) =>
        f.language !== undefined &&
        (SYMBOL_INDEXABLE_LANGUAGES as readonly string[]).includes(f.language),
    )
    .map((f) => f.path);
  await indexBatch(idx, candidates, { signal });
  // Drop entries for files that no longer exist.
  const live = new Set(candidates);
  for (const p of idx.fileStats.keys()) {
    if (!live.has(p)) {
      idx.symbols.delete(p);
      idx.fileStats.delete(p);
    } else {
      const abs = path.join(ws, p);
      if (!existsSync(abs)) {
        idx.symbols.delete(p);
        idx.fileStats.delete(p);
        continue;
      }
      try {
        const st = statSync(abs);
        if (st.size === 0) {
          idx.symbols.delete(p);
          idx.fileStats.delete(p);
        }
      } catch {
        /* skip */
      }
    }
  }
  return idx;
}

export const symbolLookupTool: ToolDefinition<SymbolLookupInput, SymbolLookupResult> = {
  name: "symbol_lookup",
  description:
    "Find a function, class, struct, trait, interface, type, method, enum, or module by name across the workspace using a tree-sitter symbol index. Substring + case-insensitive by default; set `exact: true` for exact-name matches. Returns up to 50 matches with file paths and 1-based line ranges. Prefer this over blind `search_text` when looking for a symbol definition.",
  kind: "function",
  parameters: {
    type: "object",
    required: ["symbol"],
    additionalProperties: false,
    properties: {
      symbol: { type: "string", minLength: 1, maxLength: 120 },
      kind: {
        enum: [
          "function",
          "class",
          "method",
          "type",
          "interface",
          "struct",
          "enum",
          "trait",
          "module",
          "variable",
        ],
      },
      language: {
        enum: SYMBOL_INDEXABLE_LANGUAGES as unknown as string[],
      },
      exact: { type: "boolean" },
      limit: { type: "integer", minimum: 1, maximum: 200 },
    },
  },
  permissionClass: "READ_ONLY",
  errorCodes: ["symbol_not_found", "bad_args"] as const,
  async execute(
    input: SymbolLookupInput,
    ctx: OpenApexRunContext,
    signal: AbortSignal,
  ): Promise<ToolExecuteResult<SymbolLookupResult>> {
    const idx = await getOrBuild(ctx.userContext.workspace, signal);
    const findOpts: Parameters<typeof findSymbols>[2] = {};
    if (input.kind !== undefined) findOpts.kind = input.kind;
    if (input.language !== undefined) findOpts.language = input.language;
    if (input.exact !== undefined) findOpts.exact = input.exact;
    if (input.limit !== undefined) findOpts.limit = input.limit;
    const matches = findSymbols(idx, input.symbol, findOpts);
    const indexStats = {
      symbolCount: Array.from(idx.symbols.values()).reduce((a, b) => a + b.length, 0),
      fileCount: idx.fileStats.size,
      indexedLanguages: [
        ...new Set(
          Array.from(idx.symbols.values())
            .flat()
            .map((e) => e.language),
        ),
      ].sort(),
    };
    if (matches.length === 0) {
      return {
        isError: true,
        errorType: "symbol_not_found",
        content: `symbol '${input.symbol}' not found across ${indexStats.fileCount} indexed files (${indexStats.symbolCount} symbols)`,
        metadata: { indexStats },
      };
    }
    return {
      content: {
        symbol: input.symbol,
        matches: matches.map((m) => ({
          name: m.name,
          kind: m.kind,
          language: m.language,
          path: m.path,
          startLine: m.startLine,
          endLine: m.endLine,
          score: m.score,
        })),
        indexStats,
      },
    };
  },
};
