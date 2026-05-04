/**
 * run_shell tool — argv-array shell execution.
 *
 * Locked per §1.2:
 *   - argv form (Bun.spawn(argv)) — NO shell wrapping. Model writes `bash -lc`
 *     explicitly when it needs pipes/globs/heredocs.
 *   - 300s default timeout; model can request longer via timeoutMs, but
 *     every call is hard-capped at HARD_MAX_TIMEOUT_MS (10 min) server-side
 *     regardless of what the model requests. This prevents brute-force
 *     tasks (TB2 crack-7z-hash) from consuming the entire Harbor agent
 *     budget on a single blocking shell.
 *   - CATASTROPHIC-classifier pre-check before dispatch.
 *   - structured error shape on non-zero exit.
 */

import * as path from "node:path";

import {
  parseDurationMs,
  type OpenApexRunContext,
  type ToolDefinition,
  type ToolExecuteResult,
} from "@open-apex/core";

import { classifyCommand } from "../permissions/classifier.ts";

export interface RunShellInput {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stdin?: string;
}

export interface RunShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** True if the command was killed by timeout (not a natural non-zero exit). */
  timedOut: boolean;
  wallMs: number;
}

const DEFAULT_TIMEOUT_MS = 300_000;
const MIN_SAFE_BENCHMARK_SHELL_TIMEOUT_MS = 60_000;
const ALLOW_UNSAFE_BENCHMARK_SHELL_TIMEOUT_ENV =
  "OPEN_APEX_ALLOW_UNSAFE_BENCHMARK_SHELL_TIMEOUT_MS";
/**
 * Hard server-side ceiling. Anything the model requests above this is
 * silently clamped. Rationale: Harbor's agent_timeout is typically 900 s
 * for TB2; a single blocking shell that runs close to that starves the
 * rest of the turn loop (tool output, retries, verifier). 10 min keeps
 * long-running brute-force operations possible but forces the model to
 * break them into checkpointed sub-steps.
 */
export const HARD_MAX_TIMEOUT_MS = 600_000;
/**
 * Hard deadline on waiting for `proc.exited` after we SIGKILL a timed-out
 * shell. Some bash children hold stdout pipes open past SIGKILL (pip
 * install + its subshells, background npm processes); without this
 * deadline the tool blocks indefinitely even after we "killed" the
 * process, which is what stalled sonnet/hf-model-inference for 13
 * minutes on the last TB2 run. We accept that a briefly-zombie process
 * may linger — Harbor tears down the container regardless.
 */
const REAP_DEADLINE_MS = 5_000;
/**
 * After the direct child exits, stdout/stderr should close almost
 * immediately. If a background grandchild inherited the pipe, keep only a
 * short grace window and then cancel the reader so `nohup ... & echo PID=$!`
 * style commands return promptly.
 */
const POST_EXIT_STREAM_GRACE_MS = 1_000;
const MAX_OUTPUT_BYTES = 256 * 1024; // 256 KB cap per stream

export interface ShellTimeoutPolicy {
  requestedMs: number;
  baseMs: number;
  computedMs: number;
  benchmarkMode: boolean;
  capReason: string;
  envCapMs?: number;
  ignoredUnsafeEnvCapMs?: number;
  deadlineCapMs?: number;
  remainingDeadlineMs?: number;
}

/**
 * Pure clamp: `undefined` → DEFAULT_TIMEOUT_MS, anything < 1000 ms is floored
 * to 1000 ms, anything > HARD_MAX_TIMEOUT_MS is ceiled to HARD_MAX_TIMEOUT_MS.
 * Exported for direct testing — the integration test can't wait 10 minutes
 * to observe the cap firing, but can assert the clamp math in isolation.
 */
export function clampTimeoutMs(
  requested: number | undefined,
  opts: { benchmarkMode?: boolean; deadlineAtMs?: number; nowMs?: number } = {},
): number {
  return resolveShellTimeoutPolicy(requested, opts).computedMs;
}

/**
 * Compute the effective shell timeout without leaking benchmark time into the
 * command itself. Benchmark mode may apply explicit safe caps, but wrapper
 * deadlines are crash-containment signals for the parent process and must not
 * shrink ordinary build/test commands.
 */
export function resolveShellTimeoutPolicy(
  requested: number | undefined,
  opts: { benchmarkMode?: boolean; deadlineAtMs?: number; nowMs?: number } = {},
): ShellTimeoutPolicy {
  const raw = requested ?? DEFAULT_TIMEOUT_MS;
  const base = Math.min(Math.max(1000, raw), HARD_MAX_TIMEOUT_MS);
  const policy: ShellTimeoutPolicy = {
    requestedMs: raw,
    baseMs: base,
    computedMs: base,
    benchmarkMode: opts.benchmarkMode === true,
    capReason:
      raw < 1000 ? "floor" : raw > HARD_MAX_TIMEOUT_MS ? "hard_max" : "requested_or_default",
  };
  if (!opts.benchmarkMode) return policy;

  const envRaw = process.env.OPEN_APEX_BENCHMARK_SHELL_TIMEOUT_MS;
  if (envRaw !== undefined && envRaw.trim() !== "") {
    const envCap = parseDurationMs(envRaw, Number.NaN);
    if (Number.isFinite(envCap) && envCap > 0) {
      const allowUnsafe = process.env[ALLOW_UNSAFE_BENCHMARK_SHELL_TIMEOUT_ENV] === "1";
      if (envCap >= MIN_SAFE_BENCHMARK_SHELL_TIMEOUT_MS || allowUnsafe) {
        policy.envCapMs = envCap;
        if (envCap < policy.computedMs) {
          policy.computedMs = Math.max(1000, envCap);
          policy.capReason = "benchmark_env_cap";
        }
      } else {
        policy.ignoredUnsafeEnvCapMs = envCap;
      }
    }
  }

  if (opts.deadlineAtMs !== undefined) {
    const remaining = opts.deadlineAtMs - (opts.nowMs ?? Date.now());
    policy.remainingDeadlineMs = remaining;
  }
  policy.computedMs = Math.min(Math.max(1000, policy.computedMs), HARD_MAX_TIMEOUT_MS);
  return policy;
}

/**
 * Shape we need from a spawn return value. Matches the subset of `Bun.spawn`
 * we actually use, so tests can substitute a never-resolving `exited` promise
 * to exercise the reap-deadline fallback.
 */
export interface RunShellSpawnedProc {
  exited: Promise<number | void>;
  exitCode: number | null;
  stdout: ReadableStream<Uint8Array> | number | undefined;
  stderr: ReadableStream<Uint8Array> | number | undefined;
  stdin?: unknown;
  kill(signal?: string | number): void;
}

export type RunShellSpawnFn = (
  argv: string[],
  opts: {
    cwd: string;
    stdout: "pipe";
    stderr: "pipe";
    stdin: "pipe" | "ignore";
    env?: Record<string, string>;
    signal?: AbortSignal;
    killSignal?: string | number;
  },
) => RunShellSpawnedProc;

/**
 * Test-only override for the spawn implementation. Undefined in production;
 * set via `__setSpawnForTest` + cleared via `__resetSpawnForTest`. Keeps the
 * production code path untouched while letting us exercise the reap-deadline
 * and read-deadline paths deterministically without relying on actual child
 * processes that hold pipes open past SIGKILL.
 */
let spawnOverride: RunShellSpawnFn | undefined;
export function __setSpawnForTest(fn: RunShellSpawnFn): void {
  spawnOverride = fn;
}
export function __resetSpawnForTest(): void {
  spawnOverride = undefined;
}
/** Exported for tests that want to assert against the deadline constants. */
export const __REAP_DEADLINE_MS_FOR_TEST = REAP_DEADLINE_MS;

export const runShellTool: ToolDefinition<RunShellInput, RunShellResult> = {
  name: "run_shell",
  description:
    "Run a shell command as an argv array via Bun.spawn — NO shell wrapping. For pipes, heredocs, globs, or env substitution, write the wrapper explicitly: ['bash','-lc','ls | grep foo']. Do NOT use heredoc, echo, or cat for file creation — use write_file instead. Commands matching CATASTROPHIC patterns (rm -rf /, fork bombs, curl|sh, etc.) are rejected before dispatch. Default timeout: 300s; every call is hard-capped at 600s server-side regardless of the timeoutMs you request. stdout/stderr are captured and truncated at 256 KB each.",
  kind: "shell",
  parameters: {
    type: "object",
    required: ["argv"],
    additionalProperties: false,
    properties: {
      argv: {
        type: "array",
        items: { type: "string" },
        minItems: 1,
      },
      cwd: { type: "string" },
      env: {
        type: "object",
        additionalProperties: { type: "string" },
      },
      timeoutMs: { type: "integer", minimum: 1000, maximum: 3_600_000 },
      stdin: { type: "string" },
    },
  },
  permissionClass: "CLASSIFIED",
  errorCodes: [
    "shell_non_zero_exit",
    "shell_timeout",
    "shell_not_found",
    "path_outside_workspace",
    "permission_denied",
  ] as const,
  async execute(
    input: RunShellInput,
    ctx: OpenApexRunContext,
    signal: AbortSignal,
  ): Promise<ToolExecuteResult<RunShellResult>> {
    return executeShell(input, ctx, signal);
  },
};

/**
 * Shared primitive for argv-based shell execution. Used by `run_shell` (via
 * argv directly) and `shell_command` (which wraps a single command string
 * through the user's login shell before calling this). The scheduler's
 * runtime classifier gate runs BEFORE this is invoked — the belt-and-
 * suspenders CATASTROPHIC pre-check here guards against direct callers
 * (tests, future helper code) that don't route through the scheduler.
 */
export async function executeShell(
  input: RunShellInput,
  ctx: OpenApexRunContext,
  signal: AbortSignal,
): Promise<ToolExecuteResult<RunShellResult>> {
  if (input.argv.length === 0) {
    return errorResult("shell_non_zero_exit", "argv must not be empty");
  }
  const classification = classifyCommand(input.argv);
  if (classification.tier === "CATASTROPHIC") {
    return errorResult(
      "permission_denied",
      `command rejected by classifier rule '${classification.rule}': ${classification.reason ?? ""}`,
    );
  }
  const ws = path.resolve(ctx.userContext.workspace);
  let cwd = ws;
  if (input.cwd) {
    const resolved = path.resolve(ws, input.cwd);
    if (resolved !== ws && !resolved.startsWith(ws + path.sep)) {
      return errorResult("path_outside_workspace", `cwd '${input.cwd}' resolves outside workspace`);
    }
    cwd = resolved;
  }
  // Server-side timeout cap: model-requested values above HARD_MAX_TIMEOUT_MS
  // are silently clamped so a single shell can't starve the Harbor budget
  // (TB2 crack-7z-hash previously hung 7m past our 300s default because the
  // model requested a huge timeout and nothing enforced a ceiling).
  const benchmark = ctx.userContext as {
    benchmarkMode?: boolean;
    benchmarkDeadlineAtMs?: number;
  };
  const timeoutPolicy = resolveShellTimeoutPolicy(input.timeoutMs, {
    benchmarkMode: benchmark.benchmarkMode === true,
    ...(benchmark.benchmarkDeadlineAtMs !== undefined
      ? { deadlineAtMs: benchmark.benchmarkDeadlineAtMs }
      : {}),
  });
  const timeoutMs = timeoutPolicy.computedMs;
  const started = Date.now();

  const ctrl = new AbortController();
  const linkedAbort = () => ctrl.abort();
  if (signal.aborted) ctrl.abort();
  else signal.addEventListener("abort", linkedAbort, { once: true });
  const timeout = setTimeout(() => ctrl.abort(), timeoutMs);

  let proc: RunShellSpawnedProc;
  try {
    const spawnOpts: Parameters<typeof Bun.spawn>[1] = {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: input.stdin !== undefined ? "pipe" : "ignore",
      signal: ctrl.signal,
      killSignal: "SIGKILL",
    };
    if (input.env) {
      spawnOpts.env = { ...process.env, ...input.env };
    }
    proc = spawnOverride
      ? spawnOverride(input.argv, {
          cwd,
          stdout: "pipe",
          stderr: "pipe",
          stdin: input.stdin !== undefined ? "pipe" : "ignore",
          ...(input.env ? { env: { ...process.env, ...input.env } as Record<string, string> } : {}),
          signal: ctrl.signal,
          killSignal: "SIGKILL",
        })
      : (Bun.spawn(input.argv, spawnOpts) as unknown as RunShellSpawnedProc);
    if (input.stdin !== undefined && proc.stdin) {
      (proc.stdin as { write: (s: string) => void; end: () => void }).write(input.stdin);
      (proc.stdin as { end: () => void }).end();
    }
  } catch (err) {
    clearTimeout(timeout);
    signal.removeEventListener("abort", linkedAbort);
    return errorResult("shell_not_found", `failed to spawn: ${(err as Error).message}`);
  }

  const stdoutCapture = captureStream(proc.stdout);
  const stderrCapture = captureStream(proc.stderr);

  // Race: either the process exits normally, or our AbortController fires.
  let timedOut = false;
  const waitExit = new Promise<void>((resolve) => {
    proc.exited.then(() => resolve()).catch(() => resolve());
  });
  const waitAbort = new Promise<void>((resolve) => {
    if (ctrl.signal.aborted) {
      resolve();
      return;
    }
    ctrl.signal.addEventListener("abort", () => resolve(), { once: true });
  });
  await Promise.race([waitExit, waitAbort]);
  let reapDeadlineHit = false;
  if (ctrl.signal.aborted && proc.exitCode === null) {
    timedOut = true;
    try {
      proc.kill("SIGKILL");
    } catch {
      /* process may already have been killed by Bun's AbortSignal */
    }
    // Race the actual reap against a hard 5s deadline. See
    // REAP_DEADLINE_MS block-comment: bash children can hold pipes open
    // past SIGKILL; without this race the tool hangs indefinitely.
    let settled = false;
    await Promise.race([
      (async () => {
        await proc.exited;
        settled = true;
      })(),
      new Promise<void>((r) => setTimeout(() => r(), REAP_DEADLINE_MS)),
    ]);
    if (!settled) reapDeadlineHit = true;
  }
  clearTimeout(timeout);
  signal.removeEventListener("abort", linkedAbort);

  // stdout/stderr were drained from process start. After child exit, allow a
  // short grace period for final buffered bytes; on timeout/reap failure use
  // the longer reap deadline. This bounds background grandchildren that keep
  // pipe fds open without sacrificing normal trailing output.
  const streamDeadline = timedOut || reapDeadlineHit ? REAP_DEADLINE_MS : POST_EXIT_STREAM_GRACE_MS;
  const [stdout, stderr] = await Promise.all([
    stdoutCapture.wait(streamDeadline),
    stderrCapture.wait(streamDeadline),
  ]);
  const exitCode = reapDeadlineHit ? -1 : (proc.exitCode ?? -1);
  const wallMs = Date.now() - started;

  if (timedOut) {
    return {
      content: {
        exitCode,
        stdout,
        stderr,
        timedOut: true,
        wallMs,
      },
      isError: true,
      errorType: "shell_timeout",
      metadata: { shellTimeoutPolicy: timeoutPolicy },
    };
  }
  const result: RunShellResult = {
    exitCode,
    stdout,
    stderr,
    timedOut: false,
    wallMs,
  };
  return {
    content: result,
    ...(exitCode !== 0 ? { isError: true, errorType: "shell_non_zero_exit" as const } : {}),
    metadata: { shellTimeoutPolicy: timeoutPolicy },
  };
}

interface StreamCapture {
  wait(deadlineMs: number): Promise<string>;
}

function captureStream(stream: ReadableStream<Uint8Array> | number | undefined): StreamCapture {
  if (!stream || typeof stream === "number") {
    return { wait: async () => "" };
  }
  const reader = (stream as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let totalBytes = 0;
  let truncated = false;
  let cancelReason: string | null = null;
  let settled = false;

  const done = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (!truncated) {
          buf += decoder.decode(value, { stream: true });
          if (totalBytes > MAX_OUTPUT_BYTES) {
            buf = buf.slice(0, MAX_OUTPUT_BYTES) + "\n... [output truncated]";
            truncated = true;
          }
        }
      }
      if (!truncated) buf += decoder.decode();
    } catch (err) {
      if (!cancelReason) {
        const msg = (err as Error).message ?? String(err);
        buf += `\n... [output read error: ${msg}]`;
      }
    } finally {
      settled = true;
      if (cancelReason) buf += cancelReason;
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
    }
    return buf;
  })();

  function cancel(reason: string): void {
    if (settled) return;
    if (!cancelReason) cancelReason = reason;
    void reader.cancel(reason).catch(() => {
      /* stream already closed */
    });
  }

  return {
    async wait(deadlineMs: number): Promise<string> {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadlineSentinel = Symbol("deadline");
      const deadline = new Promise<typeof deadlineSentinel>((resolve) => {
        timer = setTimeout(() => resolve(deadlineSentinel), deadlineMs);
      });
      const winner = await Promise.race([done, deadline]);
      if (timer) clearTimeout(timer);
      if (winner === deadlineSentinel) {
        const reason = "\n... [output read deadline exceeded]";
        cancel(reason);
        return cancelReason ? buf + cancelReason : buf + reason;
      }
      return winner;
    },
  };
}

function errorResult<T>(
  code: import("@open-apex/core").ToolErrorType,
  message: string,
): ToolExecuteResult<T> {
  return { content: message, isError: true, errorType: code };
}
