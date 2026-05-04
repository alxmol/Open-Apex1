/**
 * §7.6.1 autonomy-level gate: maps a classifier tier + session autonomy
 * into an allow/prompt/sandbox/reject decision.
 *
 *   readonly  : READ_ONLY auto; everything else reject
 *   low       : READ_ONLY auto; REVERSIBLE/MUTATING/UNKNOWN prompt; DESTRUCTIVE/CATASTROPHIC reject
 *   medium    : READ_ONLY/REVERSIBLE auto; MUTATING/DESTRUCTIVE/UNKNOWN prompt; CATASTROPHIC reject
 *   high      : READ_ONLY/REVERSIBLE/MUTATING auto; DESTRUCTIVE prompt; UNKNOWN sandbox (or prompt); CATASTROPHIC reject
 *   full_auto : READ_ONLY/REVERSIBLE/MUTATING/DESTRUCTIVE auto; UNKNOWN sandbox; CATASTROPHIC reject
 */

import type { AutonomyLevel, ClassifierTier, GateDecision } from "./types.ts";

export interface GateOptions {
  /** When false, UNKNOWN-tier commands prompt at high/full_auto (no sandbox available). */
  sandboxAvailable?: boolean;
}

export function gateDecision(
  tier: ClassifierTier,
  level: AutonomyLevel,
  opts: GateOptions = {},
): GateDecision {
  if (tier === "CATASTROPHIC") {
    return {
      kind: "reject",
      tier,
      reason: "CATASTROPHIC commands are always rejected regardless of autonomy level",
    };
  }
  const sandboxed = opts.sandboxAvailable === true;

  switch (level) {
    case "readonly":
      if (tier === "READ_ONLY" || tier === "READ_ONLY_NETWORK") {
        return { kind: "auto", tier };
      }
      return { kind: "reject", tier, reason: `autonomy=readonly rejects tier=${tier}` };
    case "low":
      if (tier === "READ_ONLY" || tier === "READ_ONLY_NETWORK") {
        return { kind: "auto", tier };
      }
      if (tier === "REVERSIBLE" || tier === "MUTATING" || tier === "UNKNOWN") {
        return { kind: "prompt", tier, reason: `autonomy=low prompts for tier=${tier}` };
      }
      return { kind: "reject", tier, reason: `autonomy=low rejects tier=${tier}` };
    case "medium":
      if (tier === "READ_ONLY" || tier === "READ_ONLY_NETWORK" || tier === "REVERSIBLE") {
        return { kind: "auto", tier };
      }
      if (tier === "MUTATING" || tier === "DESTRUCTIVE" || tier === "UNKNOWN") {
        return { kind: "prompt", tier, reason: `autonomy=medium prompts for tier=${tier}` };
      }
      return { kind: "reject", tier, reason: `autonomy=medium rejects tier=${tier}` };
    case "high":
      if (
        tier === "READ_ONLY" ||
        tier === "READ_ONLY_NETWORK" ||
        tier === "REVERSIBLE" ||
        tier === "MUTATING"
      ) {
        return { kind: "auto", tier };
      }
      if (tier === "DESTRUCTIVE") {
        return { kind: "prompt", tier, reason: "autonomy=high prompts for DESTRUCTIVE" };
      }
      if (tier === "UNKNOWN") {
        return sandboxed
          ? { kind: "sandbox", tier, reason: "autonomy=high sandboxes UNKNOWN" }
          : { kind: "prompt", tier, reason: "autonomy=high prompts UNKNOWN (no sandbox)" };
      }
      return { kind: "reject", tier, reason: `autonomy=high rejects tier=${tier}` };
    case "full_auto":
      if (
        tier === "READ_ONLY" ||
        tier === "READ_ONLY_NETWORK" ||
        tier === "REVERSIBLE" ||
        tier === "MUTATING" ||
        tier === "DESTRUCTIVE"
      ) {
        return { kind: "auto", tier };
      }
      if (tier === "UNKNOWN") {
        return sandboxed
          ? { kind: "sandbox", tier, reason: "autonomy=full_auto sandboxes UNKNOWN" }
          : { kind: "prompt", tier, reason: "autonomy=full_auto prompts UNKNOWN (no sandbox)" };
      }
      return { kind: "reject", tier, reason: `autonomy=full_auto rejects tier=${tier}` };
  }
}

export type { AutonomyLevel, ClassifierTier, GateDecision } from "./types.ts";
