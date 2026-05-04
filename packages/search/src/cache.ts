/**
 * Search cache layer.
 *
 * Within a single run: always-on per-run `Map<normalizedQuery, SearchBundle>`.
 *   - Ensures determinism inside a task.
 *   - Avoids burning SERP credits when the model re-searches the same query.
 *
 * Across runs: opt-in persistent dev cache, gated by
 * `config.search.dev_persistent_cache` (default OFF). Benchmark mode NEVER
 * uses the persistent cache (§1.2 "do NOT cache by default for benchmarks").
 */

import type { SearchBundle } from "./types.ts";

/** Normalize a query for keying: lowercase, collapse whitespace, trim. */
export function normalizeQueryKey(query: string): string {
  return query.toLowerCase().replace(/\s+/g, " ").trim();
}

export class InMemorySearchCache {
  private readonly store = new Map<string, SearchBundle>();

  get(query: string): SearchBundle | undefined {
    return this.store.get(normalizeQueryKey(query));
  }

  set(query: string, bundle: SearchBundle): void {
    this.store.set(normalizeQueryKey(query), bundle);
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }
}

/**
 * Persistent dev cache. File-per-query under `$OPEN_APEX_HOME/search-cache/`.
 * Never used in benchmark mode.
 */
export class PersistentSearchCache {
  constructor(
    private readonly rootDir: string,
    private readonly ttlMs: number,
  ) {}

  async get(query: string): Promise<SearchBundle | null> {
    const key = hash(normalizeQueryKey(query));
    const p = `${this.rootDir}/${key}.json`;
    const file = Bun.file(p);
    if (!(await file.exists())) return null;
    try {
      const data = (await file.json()) as { cachedAt: number; bundle: SearchBundle };
      const age = Date.now() - data.cachedAt;
      if (age > this.ttlMs) return null;
      return data.bundle;
    } catch {
      return null;
    }
  }

  async set(query: string, bundle: SearchBundle): Promise<void> {
    const key = hash(normalizeQueryKey(query));
    const p = `${this.rootDir}/${key}.json`;
    await Bun.write(p, JSON.stringify({ cachedAt: Date.now(), bundle }, null, 2));
  }
}

/** Small sha1-ish helper. Collisions don't matter — worst case = miss. */
function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (h << 5) - h + s.charCodeAt(i);
    h |= 0;
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
