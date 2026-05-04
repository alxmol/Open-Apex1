/**
 * Permission classifier public entrypoint.
 *
 * M1 shipped CATASTROPHIC-only. M2 widens to the full §7.6.1 five-tier
 * classifier with composition law, sudo-unwrap, process-wrapper stripping,
 * pipeline-to-interpreter elevation, and HTTP-method/domain network rules.
 *
 * Call chain:
 *   classifyCommand(argv)
 *     → classifyCompound(argv)
 *         → catastrophic regex stage (CATASTROPHIC fast-reject)
 *         → sudo/doas unwrap + elevate
 *         → shell-wrapper -c parse (recurse)
 *         → rule-table lookup + network analyzer for curl/wget
 *
 * The runtime (tool-loop) combines the classifier result with the session's
 * autonomy level via `gateDecision(...)` from `./autonomy-gate.ts`.
 */

import { classifyCompound, type ClassifyOptions } from "./composition.ts";
import type { ClassifierResult } from "./types.ts";

// Types + helpers + composition are re-exported via ./index.ts; classifier.ts
// exposes only the `classifyCommand` entrypoint + the legacy error class.
export { gateDecision } from "./autonomy-gate.ts";
export { classifyNetworkInvocation, DEFAULT_ALLOWED_DOMAINS, DENIED_DOMAINS } from "./network.ts";
export { COMMAND_RULES } from "./rules.ts";

/**
 * Classify a shell invocation. Primary entrypoint used by the tool
 * scheduler. Returns a `ClassifierResult` with the assigned tier; caller
 * decides what to do via `gateDecision`.
 */
export function classifyCommand(argv: string[], opts: ClassifyOptions = {}): ClassifierResult {
  if (argv.length === 0) return { tier: "READ_ONLY" };
  return classifyCompound(argv, opts);
}

/**
 * Back-compat wrapper for M1 code paths that only cared about the
 * CATASTROPHIC check. New callers should use `classifyCommand` + the
 * autonomy gate. The `rule` / `reason` fields remain compatible.
 */
export class CatastrophicCommandError extends Error {
  constructor(
    readonly argv: string[],
    readonly rule: string,
    readonly reason: string,
  ) {
    super(`CATASTROPHIC command rejected by classifier rule '${rule}': ${reason}`);
    this.name = "CatastrophicCommandError";
  }
}
