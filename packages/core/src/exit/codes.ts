/**
 * Exit-status taxonomy.
 * Locked per §3.4.9.
 *
 * Autonomous-mode exit codes (also emitted in `result.json.exit_status`):
 */

export const ExitCodes = {
  /** success: task completed, validators passed, artifacts flushed. */
  success: 0,
  /** task_failure: validators ran but one or more failed; final answer not useful. */
  task_failure: 1,
  /**
   * validation_unknown: no validator could be confidently determined;
   * autonomous mode may not report success under the strict completion policy.
   */
  validation_unknown: 2,
  /**
   * permission_refusal_unrecovered: a required operation hit the catastrophic
   * denylist and no alternative was found.
   */
  permission_refusal_unrecovered: 3,
  /**
   * runtime_failure: provider/network/tool runtime crashed in a way the
   * retry layer could not recover from.
   */
  runtime_failure: 4,
  /** config_error: invalid preset, missing required env var, bad CLI flag combination. */
  config_error: 5,
  /**
   * benchmark_contamination_detected: benchmark mode detected a contamination
   * source (poison OPEN_APEX.md, TB2 identifier in external fetch) and aborted.
   */
  benchmark_contamination_detected: 6,
  /**
   * timeout_approaching: Harbor timeout within 60s; agent finalized best-effort
   * artifacts and exited cleanly. Harbor will ultimately report its own timeout.
   */
  timeout_approaching: 7,
  /** cancelled_by_user: SIGINT received in chat mode. */
  cancelled_by_user: 130,
} as const;

export type ExitCode = (typeof ExitCodes)[keyof typeof ExitCodes];

export type ExitStatusName = keyof typeof ExitCodes;

/** Reverse lookup: number -> name. */
export function exitStatusName(code: number): ExitStatusName | "unknown" {
  for (const [name, c] of Object.entries(ExitCodes)) {
    if (c === code) return name as ExitStatusName;
  }
  return "unknown";
}
