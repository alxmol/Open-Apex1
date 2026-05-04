/**
 * §0.6 Frozen verification-gate artifact.
 *
 * Produced by `packages/config/src/verification-gate/run.ts`.
 * Checked into the repo and referenced by every nightly live-canary run as
 * the "expected environment" baseline. Drift against it is a circuit-breaker
 * signal (§5.4).
 */

export type CapabilityState = "required" | "optional" | "experimental" | "fallback-defined";

export type ProbeOutcome = "available" | "unavailable" | "untested" | "skipped";

export interface CapabilityProbeResult {
  capability: string;
  state: CapabilityState;
  outcome: ProbeOutcome;
  /** HTTP response status observed when probed. */
  httpStatus?: number;
  /** Adapter-level notes. */
  notes?: string;
  /** If unavailable, the fallback entry that kicks in per §3.6. */
  fallback?: string;
  /** Matrix reference: §3.6 subsection / row. */
  matrixRef?: string;
}

export interface ModelAliasResolution {
  alias: string;
  /** The dated snapshot the API currently serves for this alias. */
  resolvedId?: string;
  present: boolean;
  displayName?: string;
  provider: "openai" | "anthropic";
  /** User directive (§user-answer): no fallback; just note. */
  note?: "models are not set up" | string;
}

export interface VerificationGateArtifact {
  schema_version: 1;
  verifiedOn: string; // YYYY-MM-DD
  cli_version: string;
  tooling: {
    bun_version: string;
    node_version: string;
    git_version: string;
    python_version: string;
    ripgrep_version: string;
    tree_sitter_bash_version?: string;
    harbor_version?: string;
  };
  model_aliases: ModelAliasResolution[];
  /** Accepted beta headers with their smoke response codes. */
  beta_headers: Array<{
    header: string;
    smokeHttpStatus: number;
    outcome: ProbeOutcome;
  }>;
  /** §0.6 Harbor + TB2 dataset commit pin. */
  harbor_framework_commit_sha?: string;
  tb2_dataset_commit_sha: string;
  external_services: Array<{
    name: string;
    reachable: boolean;
    httpStatus?: number;
    notes?: string;
  }>;
  capabilities: CapabilityProbeResult[];
  /** Any entry here blocks benchmark runs. */
  blockers: string[];
  /** Entries here are advisories only. */
  advisories: string[];
}
