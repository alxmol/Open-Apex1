/**
 * Subagent contracts.
 * Locked per §3.4.4.
 *
 * Subagents return structured observations, not freeform essays. Role-specific
 * payloads are enforced via a discriminated union on `role`.
 */

import type { ContentPart } from "../provider/message.ts";

// ─── Shared types ─────────────────────────────────────────────────────────────

export type SubagentRole =
  | "repo_scout"
  | "environment_scout"
  | "web_researcher"
  | "strategy_planner"
  | "exploratory_executor"
  | "verifier";

export interface ArtifactRef {
  kind: "file" | "log" | "checkpoint" | "subagent_trajectory" | "search_result";
  /** Path or URI pointing at the artifact inside the run bundle. */
  path: string;
  /** Short excerpt for quick context; full content is loaded on demand. */
  excerpt?: string;
}

export interface SubagentBrief {
  taskId: string;
  role: SubagentRole;
  taskSummary: string;
  focusAreas: string[];
  artifacts: ArtifactRef[];
  constraints: {
    maxTurns: number;
    maxTokens: number;
    permissionClass: "read_only" | "reversible";
  };
}

export interface SubagentResultBase {
  role: SubagentRole;
  confidence: "high" | "medium" | "low";
  errors?: string[];
}

// ─── Role-specific result shapes ──────────────────────────────────────────────

export interface RepoMap {
  root: string;
  files: Array<{ path: string; language?: string; sizeBytes: number }>;
  totalFiles: number;
  totalBytes: number;
}

export interface SymbolIndexStats {
  symbolCount: number;
  byKind: Record<string, number>;
  indexedLanguages: string[];
}

export interface RepoScoutResult extends SubagentResultBase {
  role: "repo_scout";
  repoMap: RepoMap;
  languages: string[];
  testFrameworks: string[];
  buildSystems: string[];
  packageManagers: string[];
  keyFileContents: Array<{ path: string; excerpt: string }>;
  symbolIndex: SymbolIndexStats;
}

export interface EnvScoutResult extends SubagentResultBase {
  role: "environment_scout";
  installedPackages: Array<{ manager: string; packages: string[] }>;
  runningProcesses: string[];
  diskFree: string;
  memoryFree: string;
  runtimeVersions: Record<string, string>;
  containerContext?: string;
}

/** Structured search result from Serper/SerpAPI-normalized feed. */
export interface SearchResult {
  query: string;
  url: string;
  title: string;
  snippet: string;
  excerpt?: string;
  fetchStatus: "ok" | "blocked" | "failed" | "skipped";
  failureReason?: string;
  rankScore: number;
  /** Source/authority tier per §1.2 ranking policy. */
  sourceTier: "official_docs" | "source_repo" | "so" | "blog" | "other";
  provenance: {
    provider: "serper" | "serpapi";
    fetchedAt: string;
  };
}

export interface WebResearcherResult extends SubagentResultBase {
  role: "web_researcher";
  queries: string[];
  results: SearchResult[];
  aiOverviewContent?: string;
  roundsCompleted: number;
}

/** Structured validator-command guess used by §7.6.2 discovery ladder. */
export interface ValidatorCandidate {
  command: string;
  confidence: "high" | "medium" | "low";
  source:
    | "task_instruction"
    | "repo_manifest"
    | "framework_convention"
    | "repo_search"
    | "minimal_safe_fallback"
    | "harbor_task_convention";
  justification: string;
}

export interface StrategyPlannerResult extends SubagentResultBase {
  role: "strategy_planner";
  rankedApproaches: Array<{
    approach: string;
    pros: string[];
    cons: string[];
    /** 0.0 – 1.0 confidence score. */
    confidence: number;
  }>;
  likelyValidators: ValidatorCandidate[];
  riskyOperations: string[];
  failurePivots: string[];
  searchPivots: string[];
}

export interface ExploratoryExecutorResult extends SubagentResultBase {
  role: "exploratory_executor";
  commandsAttempted: Array<{
    command: string;
    exitCode: number;
    stdoutTail: string;
    stderrTail: string;
  }>;
  validatorOutcomes: Array<{ validator: string; passed: boolean }>;
  observedFailures: string[];
  environmentDiscoveries: string[];
  /** The sandbox checkpoint SHA — for audit only, never reused by parent runtime. */
  checkpointSha: string;
  /** Which isolation backend fired. Set to `soft` when Landlock probe failed. */
  sandboxIsolationBackend: "landlock" | "seatbelt" | "soft";
}

export interface VerifierFinding {
  finding: string;
  evidence: string;
  severity: "info" | "warning" | "error";
}

export interface VerifierResult extends SubagentResultBase {
  role: "verifier";
  findings: VerifierFinding[];
  diffsReviewed: string[];
  logsReviewed: string[];
  validatorsReviewed: string[];
}

// ─── Discriminated union ──────────────────────────────────────────────────────

export type SubagentResult =
  | RepoScoutResult
  | EnvScoutResult
  | WebResearcherResult
  | StrategyPlannerResult
  | ExploratoryExecutorResult
  | VerifierResult;

// ─── Type guards (used by orchestrator branches) ──────────────────────────────

export function isRepoScout(r: SubagentResult): r is RepoScoutResult {
  return r.role === "repo_scout";
}
export function isEnvScout(r: SubagentResult): r is EnvScoutResult {
  return r.role === "environment_scout";
}
export function isWebResearcher(r: SubagentResult): r is WebResearcherResult {
  return r.role === "web_researcher";
}
export function isStrategyPlanner(r: SubagentResult): r is StrategyPlannerResult {
  return r.role === "strategy_planner";
}
export function isExploratoryExecutor(r: SubagentResult): r is ExploratoryExecutorResult {
  return r.role === "exploratory_executor";
}
export function isVerifier(r: SubagentResult): r is VerifierResult {
  return r.role === "verifier";
}

/**
 * §3.4.4 per-subagent output budget is ~1K tokens. This is a soft cap checked
 * at orchestrator boundary; content still serializes if a subagent slightly
 * overshoots — the orchestrator trims strategy_planner and exploratory_executor
 * last when over-budget.
 */
export const SUBAGENT_OUTPUT_TOKEN_CAP = 1000;
export const SUBAGENT_BRIEF_TOKEN_CAP = 4000;

/**
 * Text-only excerpt extraction helper used by synthesis when it needs to
 * render a SubagentResult into the prompt. Keeps the renderer role-agnostic.
 */
export function extractSubagentContent(
  r: SubagentResult,
): Array<Extract<ContentPart, { type: "text" }>> {
  const parts: Array<Extract<ContentPart, { type: "text" }>> = [];
  const lines: string[] = [`[${r.role} / confidence=${r.confidence}]`];
  if (r.errors?.length) {
    lines.push(`errors: ${r.errors.join("; ")}`);
  }
  switch (r.role) {
    case "repo_scout":
      lines.push(
        `languages: ${r.languages.join(", ")}`,
        `test frameworks: ${r.testFrameworks.join(", ")}`,
        `build systems: ${r.buildSystems.join(", ")}`,
        `package managers: ${r.packageManagers.join(", ")}`,
        `symbols: ${r.symbolIndex.symbolCount} across ${r.symbolIndex.indexedLanguages.join(", ")}`,
        `files: ${r.repoMap.totalFiles}, ${(r.repoMap.totalBytes / 1024).toFixed(1)} KiB`,
      );
      for (const k of r.keyFileContents) {
        lines.push(`  ${k.path}:`, k.excerpt);
      }
      break;
    case "environment_scout":
      lines.push(
        `disk free: ${r.diskFree}`,
        `memory free: ${r.memoryFree}`,
        `runtime versions: ${Object.entries(r.runtimeVersions)
          .map(([k, v]) => `${k}=${v}`)
          .join(", ")}`,
      );
      if (r.containerContext) lines.push(`container: ${r.containerContext}`);
      break;
    case "web_researcher":
      lines.push(
        `queries: ${r.queries.length}, rounds: ${r.roundsCompleted}, results: ${r.results.length}`,
      );
      if (r.aiOverviewContent) {
        lines.push(`AI overview:`, r.aiOverviewContent);
      }
      for (const s of r.results) {
        lines.push(`  [${s.sourceTier}] ${s.title} — ${s.url}`, `    ${s.snippet}`);
      }
      break;
    case "strategy_planner":
      for (const a of r.rankedApproaches) {
        lines.push(
          `approach (${a.confidence.toFixed(2)}): ${a.approach}`,
          `  pros: ${a.pros.join("; ")}`,
          `  cons: ${a.cons.join("; ")}`,
        );
      }
      if (r.likelyValidators.length > 0) {
        lines.push("likely validators:");
        for (const v of r.likelyValidators) {
          lines.push(`  (${v.confidence}) ${v.command} — ${v.justification}`);
        }
      }
      if (r.riskyOperations.length > 0) {
        lines.push(`risky ops: ${r.riskyOperations.join("; ")}`);
      }
      if (r.failurePivots.length > 0) {
        lines.push(`failure pivots: ${r.failurePivots.join("; ")}`);
      }
      break;
    case "exploratory_executor":
      lines.push(`sandbox: ${r.sandboxIsolationBackend}, checkpoint=${r.checkpointSha}`);
      for (const c of r.commandsAttempted) {
        lines.push(`$ ${c.command} (exit=${c.exitCode})`);
        if (c.stderrTail) lines.push(`  stderr: ${c.stderrTail}`);
      }
      if (r.environmentDiscoveries.length > 0) {
        lines.push(`env discoveries: ${r.environmentDiscoveries.join("; ")}`);
      }
      if (r.validatorOutcomes.length > 0) {
        for (const v of r.validatorOutcomes) {
          lines.push(`  validator '${v.validator}': ${v.passed ? "pass" : "fail"}`);
        }
      }
      break;
    case "verifier":
      for (const f of r.findings) {
        lines.push(`[${f.severity}] ${f.finding}`, `  evidence: ${f.evidence}`);
      }
      break;
  }
  parts.push({ type: "text", text: lines.join("\n") });
  return parts;
}
