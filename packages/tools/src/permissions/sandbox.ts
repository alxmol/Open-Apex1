/**
 * §M2 soft-isolation scaffolding (landlock probe + seatbelt detection +
 * restricted shell factory). No live consumer in M2 — the exploratory
 * executor subagent that uses this lands in M4. Ship the infra here so
 * M4 can plug in without re-doing the plumbing.
 *
 * Backend detection:
 *   - Linux: call `open-apex-landlock-exec --probe`; 0 → landlock,
 *     1 → soft fallback.
 *   - macOS: check `/usr/bin/sandbox-exec` existence → seatbelt.
 *   - Everything else: soft.
 *
 * The probe result is cached per-process; a subagent's shell wrapper calls
 * `sandboxBackend()` once at startup.
 */

import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { platform } from "node:os";

export type SandboxBackend = "landlock" | "seatbelt" | "soft";

let cached: SandboxBackend | null = null;

export interface SandboxProbeOptions {
  /** Path to the landlock helper binary. Defaults to `open-apex-landlock-exec` on PATH. */
  helperPath?: string;
  /** Force a specific backend (tests). */
  forceBackend?: SandboxBackend;
  /** Bypass cache — re-probe from scratch. */
  refresh?: boolean;
}

/**
 * Detect the best-available sandbox backend. Cached per process; safe to
 * call repeatedly. On macOS, returns `seatbelt` when `/usr/bin/sandbox-exec`
 * exists (the OS-bundled binary). On Linux, spawns the landlock helper
 * with `--probe`; falls back to `soft` when the helper isn't installed or
 * the probe returns non-zero.
 */
export function sandboxBackend(opts: SandboxProbeOptions = {}): SandboxBackend {
  if (opts.forceBackend !== undefined) return opts.forceBackend;
  if (cached !== null && !opts.refresh) return cached;

  const plat = platform();
  if (plat === "darwin") {
    if (existsSync("/usr/bin/sandbox-exec")) {
      cached = "seatbelt";
      return cached;
    }
    cached = "soft";
    return cached;
  }
  if (plat === "linux") {
    const helper = opts.helperPath ?? "open-apex-landlock-exec";
    try {
      const res = spawnSync(helper, ["--probe"], { stdio: "pipe" });
      if (res.status === 0) {
        cached = "landlock";
        return cached;
      }
    } catch {
      /* helper not on PATH or syscall blocked */
    }
    cached = "soft";
    return cached;
  }
  cached = "soft";
  return cached;
}

/** Reset the cached result. Tests. */
export function __resetSandboxBackendCache(): void {
  cached = null;
}

/**
 * Restricted shell factory. Returns a `ToolDefinition`-compatible object
 * that wraps the standard run_shell execution with the §M2 tool-layer
 * block-list (layer 2 of the three-layer design) and, on Linux with
 * landlock available, prepends the helper to activate layer 3. No live
 * consumer in M2; M4's exploratory-executor subagent imports this.
 */
import { executeShell, type RunShellResult, type RunShellInput } from "../tools/run_shell.ts";
import type { OpenApexRunContext, ToolDefinition, ToolExecuteResult } from "@open-apex/core";

export interface RestrictedRunShellOptions {
  /** Absolute path to the worktree the subagent is allowed to touch. */
  worktree: string;
  /** Detected backend (from `sandboxBackend()`). */
  sandboxBackend: SandboxBackend;
  /** Custom helper path (tests / packaging). */
  landlockHelperPath?: string;
}

/**
 * Returns true if the argv is rejected by the tool-layer block list.
 * Criteria (§M2 line 2885):
 *   - absolute paths outside the worktree,
 *   - `cd` to anywhere outside the worktree,
 *   - symlinks whose realpath resolves outside (best-effort; deferred to
 *     M4 where we have the full executor context),
 *   - commands that set GIT_DIR / GIT_WORK_TREE / HOME in subprocess env,
 *   - `sudo`/`doas`/`chroot`/`mount`/`unshare` invocations,
 *   - `exec` redirections outside the worktree (`> /outside`).
 */
export function restrictedShellBlocks(argv: string[], worktree: string): string | null {
  if (argv.length === 0) return "empty argv";
  const joined = argv.join(" ");
  // sudo / chroot / namespace escape.
  if (/(?:^|\s)(?:sudo|doas|chroot|mount|umount|unshare|nsenter)\b/.test(joined)) {
    return "sudo / chroot / namespace escape not allowed in restricted shell";
  }
  // env override of shadow-git / HOME variables.
  if (/\b(?:GIT_DIR|GIT_WORK_TREE|HOME)=/.test(joined)) {
    return "env override of GIT_DIR / GIT_WORK_TREE / HOME not allowed";
  }
  // cd outside worktree.
  const cdMatch = /\bcd\s+("?)([^"&|;]+)\1/.exec(joined);
  if (cdMatch) {
    const target = cdMatch[2]!.trim();
    if (target.startsWith("/") && !isInside(target, worktree)) {
      return `cd outside worktree (${target})`;
    }
    if (target === "-" || target === "..") {
      // Allowing `cd ..` would let the agent escape; reject conservatively.
      return "cd to parent / - not allowed in restricted shell";
    }
  }
  // Redirect outside worktree.
  const redirect = />>?\s*([^\s|&;]+)/.exec(joined);
  if (redirect) {
    const target = redirect[1]!.trim();
    if (target.startsWith("/") && !isInside(target, worktree)) {
      return `redirect to outside worktree (${target})`;
    }
  }
  // Any absolute-path argv token outside the worktree is suspicious.
  for (const tok of argv.slice(1)) {
    if (tok.startsWith("/") && !tok.startsWith("-") && !isInside(tok, worktree)) {
      // Allow well-known read-only system paths used by test suites.
      if (isReadOnlySystemPath(tok)) continue;
      return `absolute path outside worktree: ${tok}`;
    }
  }
  return null;
}

function isInside(abs: string, worktree: string): boolean {
  return abs === worktree || abs.startsWith(worktree + "/");
}

function isReadOnlySystemPath(abs: string): boolean {
  return (
    abs.startsWith("/usr/") ||
    abs.startsWith("/bin/") ||
    abs.startsWith("/lib/") ||
    abs.startsWith("/etc/ca-certificates") ||
    abs === "/dev/null" ||
    abs === "/dev/urandom"
  );
}

/**
 * Produce a `ToolDefinition` whose execute() runs argv through the
 * restricted-shell block-list and (on Linux/landlock) wraps it with the
 * helper before dispatching to `executeShell`.
 *
 * This mirrors the regular run_shell contract; callers that want
 * restricted behaviour can swap it in place of the base tool.
 */
export function createRestrictedRunShell(
  opts: RestrictedRunShellOptions,
): ToolDefinition<RunShellInput, RunShellResult> {
  return {
    name: "run_shell",
    description:
      "Run a restricted shell command in the exploratory-executor worktree. " +
      "Commands touching paths outside the worktree, sudo / chroot, or env overrides of GIT_DIR / HOME / GIT_WORK_TREE are rejected with shell_command_rejected.",
    kind: "shell",
    parameters: {
      type: "object",
      required: ["argv"],
      additionalProperties: false,
      properties: {
        argv: { type: "array", items: { type: "string" }, minItems: 1 },
        cwd: { type: "string" },
        env: { type: "object", additionalProperties: { type: "string" } },
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
      // Layer 2: tool-layer block list.
      const blockReason = restrictedShellBlocks(input.argv, opts.worktree);
      if (blockReason) {
        return {
          content: `shell_command_rejected: ${blockReason}`,
          isError: true,
          errorType: "permission_denied",
        };
      }
      // Layer 3: landlock helper wrap (Linux only, when backend is landlock).
      if (opts.sandboxBackend === "landlock") {
        const helper = opts.landlockHelperPath ?? "open-apex-landlock-exec";
        const wrapped: RunShellInput = {
          ...input,
          argv: [helper, "--worktree", opts.worktree, "--", ...input.argv],
        };
        return executeShell(wrapped, ctx, signal);
      }
      // Layer 1 (worktree) is assumed to be enforced by the caller (they
      // pre-create the git worktree and set ctx.userContext.workspace).
      return executeShell(input, ctx, signal);
    },
  };
}
