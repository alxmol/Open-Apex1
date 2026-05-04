/**
 * @open-apex/indexer — repo map + tree-sitter symbol index + env intelligence (§M3).
 */

export * from "./language-detect.ts";
export * from "./repo-map.ts";
export * from "./stack-detect.ts";
export * from "./symbol-index.ts";
export * from "./env-probe.ts";
export {
  ensureParserInit,
  loadGrammar,
  TREE_SITTER_LANGUAGES,
  __resetGrammarCacheForTest,
} from "./tree-sitter/init.ts";
export { SYMBOL_QUERIES, kindFromCapture, type SymbolKind } from "./tree-sitter/queries.ts";
