// Types first (the five-tier taxonomy).
export type {
  ClassifierTier,
  ClassifierResult,
  AutonomyLevel,
  GateDecision,
  LegacyClassifierTier,
} from "./types.ts";
export { maxTier, elevate } from "./types.ts";

// Full §7.6.1 classifier surface.
export * from "./classifier.ts";

// Low-level composition helpers.
export {
  classifyAgainstRules,
  classifyCompound,
  classifyScript,
  splitScript,
  splitPipeline,
  tokenizeArgv,
  type ClassifyOptions,
} from "./composition.ts";

// Back-compat: CATASTROPHIC-only entrypoints kept for M1 call-sites.
export {
  CATASTROPHIC_PATTERNS,
  classifyArgv,
  classifyArgvCatastrophic,
  classifyString,
  type CatastrophicMatch,
  type CatastrophicPattern,
} from "./catastrophic.ts";

// §M2 soft-isolation scaffolding. No live consumer at M2; M4 wires the
// exploratory-executor subagent to this factory.
export {
  sandboxBackend,
  __resetSandboxBackendCache,
  createRestrictedRunShell,
  restrictedShellBlocks,
  type SandboxBackend,
  type SandboxProbeOptions,
  type RestrictedRunShellOptions,
} from "./sandbox.ts";
