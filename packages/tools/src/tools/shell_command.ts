/**
 * shell_command — single-string shell execution via the user's login shell.
 *
 * §7.6.12 sibling of `run_shell`: takes `{ command: string }` and wraps it
 * via `[shell, '-lc', command]` (or PowerShell on Windows). Classified and
 * executed by the same shared `executeShell` primitive as `run_shell`, so
 * the CATASTROPHIC pre-check, server-side timeout cap, reap deadline, and
 * stream read-deadline all apply identically.
 *
 * The scheduler's classifier gate runs on the WRAPPED argv (shell wrapper
 * + the command string) so `shell_command "rm -rf /"` and
 * `run_shell ['rm', '-rf', '/']` both hit the same CATASTROPHIC pattern.
 */

import type { OpenApexRunContext, ToolDefinition, ToolExecuteResult } from "@open-apex/core";

import { executeShell, type RunShellResult } from "./run_shell.ts";

export interface ShellCommandInput {
  command: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  stdin?: string;
}

export const shellCommandTool: ToolDefinition<ShellCommandInput, RunShellResult> = {
  name: "shell_command",
  description:
    "Run a single shell command string, wrapped via the user's login shell (`bash -lc` / `zsh -lc` / equivalent). Prefer this over `run_shell` when you have a one-line command with pipes, redirects, or env substitution and don't want to hand-encode the shell wrapper. Classified identically to `run_shell` — CATASTROPHIC patterns, the 600s hard-cap, and the structured error shape all apply.",
  kind: "shell",
  parameters: {
    type: "object",
    required: ["command"],
    additionalProperties: false,
    properties: {
      command: { type: "string" },
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
    input: ShellCommandInput,
    ctx: OpenApexRunContext,
    signal: AbortSignal,
  ): Promise<ToolExecuteResult<RunShellResult>> {
    const shell = detectLoginShell();
    const argvInput: {
      argv: string[];
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
      stdin?: string;
    } = { argv: [shell, "-lc", input.command] };
    if (input.cwd !== undefined) argvInput.cwd = input.cwd;
    if (input.env !== undefined) argvInput.env = input.env;
    if (input.timeoutMs !== undefined) argvInput.timeoutMs = input.timeoutMs;
    if (input.stdin !== undefined) argvInput.stdin = input.stdin;
    return executeShell(argvInput, ctx, signal);
  },
};

/**
 * Resolve the invoking user's login shell. Honors `$SHELL` when it points
 * at a recognized shell, falls back to `/bin/bash` on POSIX and omits
 * Windows support — Windows PowerShell wrapping lands with CLI-packaging
 * work in M7.
 */
function detectLoginShell(): string {
  const shell = process.env.SHELL;
  if (shell && /\/(?:bash|zsh|sh|ksh|dash|fish)$/.test(shell)) return shell;
  return "/bin/bash";
}
