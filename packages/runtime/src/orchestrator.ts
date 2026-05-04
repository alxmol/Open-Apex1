/**
 * Orchestrator skeleton (M0).
 *
 * Locked per §3.4.11. M0 exposes the class shape + stub methods that throw
 * with an M1 pointer, so downstream packages can import the type and wire
 * tests against `instanceof OrchestratorImpl`. Full state machine + tool
 * scheduler land in M1 (§3.4.13).
 */

import type {
  Agent,
  ContextUsageBreakdown,
  HistoryItem,
  Orchestrator,
  OrchestratorState,
  PermissionDecision,
  PermissionMode,
  RunEvent,
  RunOptions,
  RunResult,
  RunState,
} from "@open-apex/core";

export class OrchestratorImpl<TContext = unknown> implements Orchestrator<TContext> {
  // Exposed as read-only per interface.
  state: OrchestratorState = "idle";
  currentTurn = 0;

  run(
    _agent: Agent<TContext, any>,
    _input: string | HistoryItem[] | RunState<TContext>,
    _options?: RunOptions<TContext>,
  ): AsyncIterable<RunEvent> & { readonly result: Promise<RunResult<TContext>> } {
    const err = new Error("OrchestratorImpl.run() — implementation lands in Milestone 1");
    const rejected = Promise.reject(err);
    // Swallow so tests don't get "unhandled promise rejection" spam.
    rejected.catch(() => {});
    const iter: AsyncIterable<RunEvent> = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            return Promise.reject(err);
          },
        };
      },
    };
    return Object.assign(iter, { result: rejected });
  }

  async resolveToolApproval(_callId: string, _decision: PermissionDecision): Promise<void> {
    throw new Error("OrchestratorImpl.resolveToolApproval() — implementation lands in Milestone 1");
  }

  async interrupt(): Promise<void> {
    this.state = "cancelled";
  }

  async setPermissionMode(_mode: PermissionMode): Promise<void> {
    throw new Error("OrchestratorImpl.setPermissionMode() — implementation lands in Milestone 1");
  }

  async setModel(_model?: string): Promise<void> {
    throw new Error("OrchestratorImpl.setModel() — implementation lands in Milestone 1");
  }

  async getContextUsage(): Promise<ContextUsageBreakdown> {
    return {
      categories: [],
      totalTokens: 0,
      maxTokens: 0,
      percentage: 0,
    };
  }

  snapshotState(): RunState<TContext> {
    return {
      version: 1,
      runId: "",
      originalInput: "",
      currentAgent: { name: "" },
      currentTurn: this.currentTurn,
      history: [],
      pendingApprovals: [],
      context: undefined as TContext,
      snapshotTimestamp: new Date().toISOString(),
    };
  }
}
