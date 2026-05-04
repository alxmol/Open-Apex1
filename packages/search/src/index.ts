/**
 * @open-apex/search — Open-Apex-owned web search layer (§M3).
 *
 * Serper.dev primary, SerpAPI fallback + AI Overview enrichment.
 * Contamination blocklist (§7.6.4). Selective trigger policy (§1.2).
 * Source-tier ranking. HTML extractor. Per-run + optional persistent cache.
 */

export * from "./types.ts";
export * from "./provider.ts";
export * from "./serper.ts";
export * from "./serpapi.ts";
export * from "./ranking.ts";
export * from "./contamination.ts";
export * from "./normalize.ts";
export * from "./extractor.ts";
export * from "./cache.ts";
export * from "./trigger.ts";
export * from "./run-search.ts";
export * from "./render.ts";
