/**
 * §7.6.1 five-tier taxonomy + classifier result shape.
 *
 * At M1 we shipped ALLOWED|CATASTROPHIC. M2 widens to the full taxonomy.
 * The old string literals remain in the exported union for backward
 * compatibility with M1 code paths; `ALLOWED` is aliased to `READ_ONLY`.
 */

export type ClassifierTier =
  | "READ_ONLY"
  | "READ_ONLY_NETWORK"
  | "REVERSIBLE"
  | "MUTATING"
  | "DESTRUCTIVE"
  | "UNKNOWN"
  | "CATASTROPHIC";

/**
 * Back-compat alias for M1 consumers; points at READ_ONLY. New code should
 * use the five-tier values directly.
 * @deprecated use `READ_ONLY` / `REVERSIBLE` / etc.
 */
export type LegacyClassifierTier = "ALLOWED" | "CATASTROPHIC";

export interface ClassifierResult {
  tier: ClassifierTier;
  /** Rule name when a specific rule fired (CATASTROPHIC pattern name, or rule-table entry). */
  rule?: string;
  /** Human-readable justification surfaced to logs + to the model on deny. */
  reason?: string;
  /** When present, the classifier ran composition law and found sub-commands. */
  subcommands?: ClassifierResult[];
}

/** Helper for tier comparisons: higher index = more dangerous. */
const TIER_ORDER: Record<ClassifierTier, number> = {
  READ_ONLY: 0,
  READ_ONLY_NETWORK: 0,
  REVERSIBLE: 1,
  UNKNOWN: 2,
  MUTATING: 3,
  DESTRUCTIVE: 4,
  CATASTROPHIC: 5,
};

export function maxTier(a: ClassifierTier, b: ClassifierTier): ClassifierTier {
  return TIER_ORDER[a] >= TIER_ORDER[b] ? a : b;
}

export function elevate(t: ClassifierTier, steps = 1): ClassifierTier {
  const target = Math.min(TIER_ORDER[t] + steps, TIER_ORDER.CATASTROPHIC);
  const names: ClassifierTier[] = [
    "READ_ONLY",
    "REVERSIBLE",
    "UNKNOWN",
    "MUTATING",
    "DESTRUCTIVE",
    "CATASTROPHIC",
  ];
  return names[target] ?? "CATASTROPHIC";
}

/** Autonomy level mirrors §7.6.1 — kept parallel to `AutonomyLevel` in core. */
export type AutonomyLevel = "readonly" | "low" | "medium" | "high" | "full_auto";

export type GateDecision =
  | { kind: "auto"; tier: ClassifierTier }
  | { kind: "prompt"; tier: ClassifierTier; reason: string }
  | { kind: "sandbox"; tier: ClassifierTier; reason: string }
  | { kind: "reject"; tier: ClassifierTier; reason: string };
