/**
 * Orchestrator state-machine helpers.
 *
 * M0 exposes the legal state-transition table so downstream tests can assert
 * invariants (§3.4.11 invariants 1–8). The full Orchestrator impl lives in
 * `./orchestrator.ts` and lands in M1.
 */

import type { OrchestratorState } from "@open-apex/core";

/**
 * Legal transitions per §3.4.11 state diagram.
 * `key` is the source state; values are the set of allowed next states.
 */
export const STATE_TRANSITIONS: Readonly<Record<OrchestratorState, readonly OrchestratorState[]>> =
  Object.freeze({
    idle: ["preparing_turn"],
    preparing_turn: ["awaiting_model", "done_error"],
    awaiting_model: ["processing_response", "cancelled"],
    processing_response: [
      "switching_agent",
      "awaiting_permission",
      "executing_tools",
      "done_final",
      "preparing_turn", // no-op, pure reasoning
    ],
    switching_agent: ["preparing_turn"],
    awaiting_permission: ["executing_tools", "processing_response", "done_error", "cancelled"],
    executing_tools: ["preparing_turn", "switching_agent", "done_final", "done_error", "cancelled"],
    done_final: [],
    done_error: [],
    cancelled: [],
  });

export const TERMINAL_STATES = new Set<OrchestratorState>([
  "done_final",
  "done_error",
  "cancelled",
]);

export function isLegalTransition(from: OrchestratorState, to: OrchestratorState): boolean {
  return STATE_TRANSITIONS[from].includes(to);
}

export function isTerminal(state: OrchestratorState): boolean {
  return TERMINAL_STATES.has(state);
}
