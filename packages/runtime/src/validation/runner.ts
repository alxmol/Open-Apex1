/**
 * Validator runner — executes a ValidatorCandidate and classifies the result
 * per §3.4.3:
 *   pass    — exit 0, ran to completion
 *   fail    — non-zero exit, real-code failure
 *   crash   — SIGKILL / timeout / missing interpreter / 137 OOM — NOT the
 *             agent's fault; routes to validation_unknown
 *   noop    — exit 0 but output matches "didn't actually validate anything"
 *             patterns (pytest "collected 0 items", cargo "no test targets",
 *             tsc on no .ts files, etc.)
 */

import type {
  CrashReason,
  ValidatorCandidate,
  ValidatorRun,
  ValidatorStatus,
} from "@open-apex/core";

export interface RunValidatorOptions {
  workspace: string;
  /** Default timeout per validator. Default 300s per §1.2 shell policy. */
  timeoutMs?: number;
  /** Override for tests. */
  spawn?: typeof Bun.spawn;
}

const DEFAULT_TIMEOUT_MS = 300_000;
const STDOUT_TAIL_BYTES = 8 * 1024;
const REAP_DEADLINE_MS = 5_000;
const STREAM_READ_DEADLINE_MS = 5_000;

/** Patterns that indicate the validator ran but didn't validate anything real. */
const NOOP_PATTERNS: RegExp[] = [
  /collected 0 items/i, // pytest
  /no test targets? found/i, // cargo
  /no tests to run/i,
  /0 passed, 0 failed/i,
  /no files? matching/i,
  /no \.ts files found/i, // bespoke tsc noop
];

export async function runValidator(
  candidate: ValidatorCandidate,
  opts: RunValidatorOptions,
): Promise<ValidatorRun> {
  // The candidate.command is a shell command string; we need to invoke it
  // through `bash -lc` to honor pipes / redirects / globs / conda envs.
  // This IS a place we need shell wrapping (cf. §1.2 `shell_command`).
  const argv = ["bash", "-lc", candidate.command];
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = (opts.spawn ?? Bun.spawn)(argv, {
      cwd: opts.workspace,
      stdout: "pipe",
      stderr: "pipe",
      signal: ctrl.signal,
      killSignal: "SIGKILL",
    });
  } catch (err) {
    clearTimeout(timer);
    return {
      validator: candidate,
      validatorStatus: "crash",
      exitCode: null,
      signal: null,
      stdoutTail: "",
      stderrTail: (err as Error).message,
      wallMs: Date.now() - started,
      crashReason: "spawn_failed",
    };
  }

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
  let timedOut = false;
  if (ctrl.signal.aborted && proc.exitCode === null) {
    timedOut = true;
    proc.kill("SIGKILL");
    await Promise.race([
      proc.exited.catch(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, REAP_DEADLINE_MS)),
    ]);
  }
  clearTimeout(timer);

  const stdout = await readTail(proc.stdout, STDOUT_TAIL_BYTES);
  const stderr = await readTail(proc.stderr, STDOUT_TAIL_BYTES);
  const exitCode = proc.exitCode ?? -1;
  const wallMs = Date.now() - started;

  let status: ValidatorStatus;
  let crashReason: CrashReason | undefined;
  let signalName: string | null = null;
  if (timedOut) {
    status = "crash";
    crashReason = "timeout";
    signalName = "SIGKILL";
  } else if (exitCode === 137) {
    status = "crash";
    crashReason = "nonzero_exit_137_oom";
  } else if (isMissingInterpreterError(candidate.command, stderr)) {
    status = "crash";
    crashReason = "missing_interpreter";
  } else if (exitCode === 0) {
    status = isNoopOutput(stdout + "\n" + stderr) ? "noop" : "pass";
  } else {
    status = "fail";
  }

  const run: ValidatorRun = {
    validator: candidate,
    validatorStatus: status,
    exitCode: timedOut ? null : exitCode,
    signal: signalName,
    stdoutTail: stdout,
    stderrTail: stderr,
    wallMs,
  };
  if (crashReason !== undefined) run.crashReason = crashReason;
  return run;
}

function isNoopOutput(combined: string): boolean {
  for (const p of NOOP_PATTERNS) if (p.test(combined)) return true;
  return false;
}

function isMissingInterpreterError(command: string, stderr: string): boolean {
  return (
    /command not found/i.test(stderr) ||
    /: not found/.test(stderr) ||
    // `python -m pytest` fails before user code runs when pytest itself is not
    // installed. Treat that as a validator-environment crash; ordinary
    // app-level `ModuleNotFoundError` from tests remains a real failure.
    (/\bpython3?\b[\s\S]*\s-m\s+pytest\b/.test(command) &&
      /No module named ['"]?pytest['"]?/i.test(stderr)) ||
    (/No such file or directory/i.test(stderr) &&
      /^(?:node|python|python3|ruby|go|cargo|rustc|gcc|clang|mypy|pytest|tsc)/m.test(stderr))
  );
}

async function readTail(
  stream: ReadableStream<Uint8Array> | number | undefined,
  maxBytes: number,
): Promise<string> {
  if (!stream || typeof stream === "number") return "";
  const reader = (stream as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let totalBytes = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = Symbol("validator_stream_deadline");
  const read = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      buf += decoder.decode(value, { stream: true });
      if (buf.length > maxBytes * 2) {
        buf = buf.slice(-maxBytes);
      }
    }
    return buf;
  })();
  try {
    const winner = await Promise.race([
      read,
      new Promise<typeof deadline>((resolve) => {
        timer = setTimeout(() => resolve(deadline), STREAM_READ_DEADLINE_MS);
      }),
    ]);
    if (winner === deadline) {
      try {
        await reader.cancel("deadline");
      } catch {
        /* stream may already be closing */
      }
      return `${buf}\n... [validator output read deadline exceeded]`;
    }
    buf = winner;
  } finally {
    if (timer) clearTimeout(timer);
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
  if (buf.length > maxBytes) buf = buf.slice(-maxBytes);
  void totalBytes;
  return buf;
}
