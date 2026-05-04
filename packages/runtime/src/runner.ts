/**
 * Runner skeleton (M0).
 *
 * Locked per §3.4.11. M0 exposes the class shape; full impl lands in M1.
 */

import type {
  Agent,
  HistoryItem,
  RunConfig,
  RunEvent,
  RunOptions,
  RunResult,
  RunState,
  Runner,
} from "@open-apex/core";

export class RunnerImpl implements Runner {
  readonly config: Readonly<RunConfig>;

  constructor(config: RunConfig = {}) {
    this.config = Object.freeze({ ...config });
  }

  run<TContext = unknown>(
    _agent: Agent<TContext, any>,
    _input: string | HistoryItem[] | RunState<TContext>,
    options?: RunOptions<TContext> & { stream?: false },
  ): Promise<RunResult<TContext>>;
  run<TContext = unknown>(
    _agent: Agent<TContext, any>,
    _input: string | HistoryItem[] | RunState<TContext>,
    options: RunOptions<TContext> & { stream: true },
  ): AsyncIterable<RunEvent> & { readonly result: Promise<RunResult<TContext>> };
  run<TContext = unknown>(
    _agent: Agent<TContext, any>,
    _input: string | HistoryItem[] | RunState<TContext>,
    _options?: RunOptions<TContext>,
  ): unknown {
    const err = new Error("RunnerImpl.run() — implementation lands in Milestone 1");
    if (_options?.stream) {
      const rejected = Promise.reject(err);
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
    return Promise.reject(err);
  }
}
