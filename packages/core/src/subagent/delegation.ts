/**
 * Subagent delegation tiers.
 * Locked per §3.4.12.
 *
 * V1 ships Tiers 1 and 2 only. Tier 3 is shape-only; factory throws.
 */

import type { Agent, HandoffInputData, RunEvent, RunOptions, RunResult } from "../runtime/types.ts";

export type Delegation<TContext = unknown> =
  | HandoffDelegation<TContext>
  | AgentAsToolDelegation<TContext>
  | FullSpawnDelegation<TContext>;

/** Tier 1: variable swap, shared history. */
export interface HandoffDelegation<TContext = unknown> {
  kind: "handoff";
  target: Agent<TContext, any>;
  inputFilter?: (data: HandoffInputData) => Promise<HandoffInputData>;
}

/** Tier 2: nested Runner, isolated history. Used for all 5 gather subagents. */
export interface AgentAsToolDelegation<TContext = unknown> {
  kind: "agent_as_tool";
  innerAgent: Agent<TContext, any>;
  toolName: string;
  toolDescription: string;
  inputBuilder?: (args: unknown) => string | import("../provider/message.ts").HistoryItem[];
  outputExtractor?: (result: RunResult<TContext>) => string;
  runOptions?: Partial<RunOptions<TContext>>;
  onStream?: (event: RunEvent) => void;
}

/** Tier 3: v2 — separate Bun worker / child process. Factory throws in v1. */
export interface FullSpawnDelegation<TContext = unknown> {
  kind: "full_spawn";
  innerAgent: Agent<TContext, any>;
  background: boolean;
  separateContext: TContext;
  separateSessionId?: string;
  notificationEventName?: string;
}

export function isHandoffDelegation<T>(d: Delegation<T>): d is HandoffDelegation<T> {
  return d.kind === "handoff";
}
export function isAgentAsToolDelegation<T>(d: Delegation<T>): d is AgentAsToolDelegation<T> {
  return d.kind === "agent_as_tool";
}
export function isFullSpawnDelegation<T>(d: Delegation<T>): d is FullSpawnDelegation<T> {
  return d.kind === "full_spawn";
}
