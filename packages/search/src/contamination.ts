/**
 * TB2 contamination blocklist (§7.6.4 v1).
 *
 * Applied to every Serper/SerpAPI result in benchmark mode (unconditional in
 * benchmark mode; preset/config-configurable outside benchmark). Returns the
 * results unchanged when disabled.
 *
 * The blocklist JSON lives at `packages/config/contamination-blocklist.v1.json`
 * so it's reviewable + schema-versioned independent of code.
 */

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

import type { SearchResult } from "./types.ts";

export interface ContaminationBlocklist {
  schema_version: string;
  updated_at: string;
  denied_domains: string[];
  denied_url_substrings: string[];
  denied_title_substrings: string[];
  denied_snippet_substrings: string[];
  denied_task_ids: string[];
}

export interface ContaminationFilterOpts {
  blocklist: ContaminationBlocklist;
  /** `benchmark` forces-on; `dev` returns pass-through. */
  mode: "benchmark" | "dev";
}

export interface ContaminationCandidate {
  url?: string | undefined;
  title?: string | undefined;
  snippet?: string | undefined;
}

export interface ContaminationFilterOutcome<T extends ContaminationCandidate = SearchResult> {
  kept: T[];
  removed: Array<{ result: T; reason: string }>;
}

const BUNDLED_BLOCKLIST_PATH = new URL(
  "../../config/contamination-blocklist.v1.json",
  import.meta.url,
).pathname;
const BLOCKLIST_FILENAME = "contamination-blocklist.v1.json";

let cachedBlocklist: ContaminationBlocklist | null = null;
let cachedBlocklistPath: string | null = null;

/** Load the bundled blocklist from packages/config/. Cached per-process. */
export async function loadContaminationBlocklist(): Promise<ContaminationBlocklist> {
  const blocklistPath = resolveBlocklistPath();
  if (cachedBlocklist && cachedBlocklistPath === blocklistPath) return cachedBlocklist;
  const text = readFileSync(blocklistPath, "utf8");
  const parsed = JSON.parse(text) as ContaminationBlocklist;
  validateBlocklistShape(parsed);
  cachedBlocklist = parsed;
  cachedBlocklistPath = blocklistPath;
  return parsed;
}

export function resolveBlocklistPath(): string {
  const explicit = process.env.OPEN_APEX_CONTAMINATION_BLOCKLIST;
  if (explicit && explicit.length > 0) {
    if (!existsSync(explicit)) {
      throw new Error(
        `contamination blocklist not found at OPEN_APEX_CONTAMINATION_BLOCKLIST=${explicit}`,
      );
    }
    return explicit;
  }

  const configDir = process.env.OPEN_APEX_CONFIG_DIR;
  if (configDir && configDir.length > 0) {
    const candidate = path.join(configDir, BLOCKLIST_FILENAME);
    if (!existsSync(candidate)) {
      throw new Error(`contamination blocklist not found at OPEN_APEX_CONFIG_DIR=${configDir}`);
    }
    return candidate;
  }

  if (existsSync(BUNDLED_BLOCKLIST_PATH)) return BUNDLED_BLOCKLIST_PATH;
  throw new Error(`contamination blocklist not found at bundled path ${BUNDLED_BLOCKLIST_PATH}`);
}

function validateBlocklistShape(b: ContaminationBlocklist): void {
  const required: Array<keyof ContaminationBlocklist> = [
    "schema_version",
    "updated_at",
    "denied_domains",
    "denied_url_substrings",
    "denied_title_substrings",
    "denied_snippet_substrings",
    "denied_task_ids",
  ];
  for (const k of required) {
    if (!(k in b)) throw new Error(`contamination blocklist missing field: ${k}`);
  }
}

export function applyContaminationBlocklist<T extends ContaminationCandidate>(
  results: readonly T[],
  opts: ContaminationFilterOpts,
): ContaminationFilterOutcome<T>;
export function applyContaminationBlocklist<T extends ContaminationCandidate>(
  results: readonly T[],
  opts: ContaminationFilterOpts,
): ContaminationFilterOutcome<T> {
  if (opts.mode === "dev") {
    return { kept: results.slice(), removed: [] };
  }
  const kept: T[] = [];
  const removed: Array<{ result: T; reason: string }> = [];
  for (const r of results) {
    const reason = shouldBlock(r, opts.blocklist);
    if (reason) {
      removed.push({ result: r, reason });
    } else {
      kept.push(r);
    }
  }
  return { kept, removed };
}

function shouldBlock(r: ContaminationCandidate, b: ContaminationBlocklist): string | null {
  const url = (r.url ?? "").toLowerCase();
  const title = (r.title ?? "").toLowerCase();
  const snippet = (r.snippet ?? "").toLowerCase();
  for (const d of b.denied_domains) {
    if (urlHostMatches(url, d)) return `denied_domain:${d}`;
  }
  for (const s of b.denied_url_substrings) {
    if (url.includes(s.toLowerCase())) return `denied_url_substring:${s}`;
  }
  for (const t of b.denied_title_substrings) {
    if (title.includes(t.toLowerCase())) return `denied_title_substring:${t}`;
  }
  for (const s of b.denied_snippet_substrings) {
    if (snippet.includes(s.toLowerCase())) return `denied_snippet_substring:${s}`;
  }
  for (const id of b.denied_task_ids) {
    // Task-id matching hits URL + title + snippet. Word-boundary to avoid
    // false positives like "fix-git" matching "bug-fix-git-worktree"—we use
    // a kebab-safe regex: must be surrounded by non-[a-z0-9] characters.
    const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegex(id)}([^a-z0-9]|$)`, "i");
    if (pattern.test(url) || pattern.test(title) || pattern.test(snippet)) {
      return `denied_task_id:${id}`;
    }
  }
  return null;
}

function urlHostMatches(lowerUrl: string, lowerDomain: string): boolean {
  try {
    const host = new URL(lowerUrl).hostname;
    return host === lowerDomain || host.endsWith(`.${lowerDomain}`);
  } catch {
    return lowerUrl.includes(`://${lowerDomain}`) || lowerUrl.includes(`.${lowerDomain}`);
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Test utility: reset the cached blocklist so fixture-loading tests don't leak. */
export function __resetContaminationCacheForTest(): void {
  cachedBlocklist = null;
  cachedBlocklistPath = null;
}
