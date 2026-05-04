/**
 * CATASTROPHIC regex patterns.
 * Locked per §7.6.1 "CATASTROPHIC regex patterns (always rejected)".
 *
 * These patterns are matched against the full shlex-joined argv string BEFORE
 * any rule lookup, so wrapper stripping and subcommand parsing cannot hide
 * them. System-wide or cross-user damage is always rejected regardless of
 * autonomy level; no override flag.
 *
 * The full 5-tier classifier (READ_ONLY / REVERSIBLE / MUTATING / DESTRUCTIVE
 * / CATASTROPHIC) with composition law, sudo-unwrap, network allowlist, and
 * autonomy gate lands in M2. This module is M1's minimum-viable safety gate.
 */

export interface CatastrophicPattern {
  name: string;
  pattern: RegExp;
}

/**
 * Verbatim port of the §7.6.1 CATASTROPHIC block. Each pattern is labelled so
 * telemetry can surface the specific family that fired.
 */
export const CATASTROPHIC_PATTERNS: readonly CatastrophicPattern[] = Object.freeze([
  // Filesystem destruction.
  {
    name: "rm_-rf_root_or_home",
    pattern:
      /(?:^|[\s;&|])(?:sudo\s+)?rm\s+(?=(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+)(?:-[a-zA-Z]+\s+)+(?:--no-preserve-root\s+)?(?:\/|~|\$HOME|\$\{HOME\})(?:\s|$)/,
  },
  {
    name: "rm_-rf_system_dir",
    pattern:
      /(?:^|[\s;&|])(?:sudo\s+)?rm\s+(?=(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+)(?:-[a-zA-Z]+\s+)+\/(?:bin|boot|dev|etc|lib|lib32|lib64|opt|proc|root|sbin|srv|sys|usr|var|Library|System|Applications|Users)(?:[/\s]|$)/,
  },
  {
    name: "rm_-rf_current_or_parent",
    pattern:
      /(?:^|[\s;&|])(?:sudo\s+)?rm\s+(?=(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*[rR][a-zA-Z]*\s+)(?:-[a-zA-Z]+\s+)+\.\.?(?:\s|$)/,
  },
  {
    name: "rm_no_preserve_root",
    pattern: /\brm\s+--no-preserve-root\b/,
  },
  {
    name: "chmod_-R_system_path",
    pattern:
      /\bchmod\s+-R\s+[0-7]{3,4}\s+(?:\/|\/etc|\/usr|\/var|\/bin|\/sbin|\/opt|\/boot|\/lib|~|\$HOME)/,
  },
  {
    name: "chown_-R_system_path",
    pattern:
      /\bchown\s+-R\s+\S+\s+(?:\/|\/etc|\/usr|\/var|\/bin|\/sbin|\/opt|\/boot|\/lib|~|\$HOME)/,
  },
  // Block-device / filesystem wipe.
  {
    name: "dd_of_block_device",
    pattern: /\bdd\s+.*\bof=\/dev\/(?:sd[a-z]|nvme\d+n\d+|hd[a-z]|disk\d+|mmcblk\d+)/,
  },
  {
    name: "mkfs_block_device",
    pattern: /\b(?:mkfs|mkfs\.[a-z0-9]+)\s+\/dev\//,
  },
  {
    name: "partition_tool_block_device",
    pattern: /\b(?:fdisk|sfdisk|cfdisk|gdisk|parted|wipefs)\s+.*\/dev\//,
  },
  {
    name: "shred_block_device",
    pattern: /\bshred\s+.*\/dev\//,
  },
  // System halt.
  {
    name: "shutdown_reboot_halt",
    pattern: /^(?:sudo\s+)?(?:shutdown|reboot|halt|poweroff|init\s+0|init\s+6)\b/,
  },
  {
    name: "systemctl_halt",
    pattern: /^(?:sudo\s+)?systemctl\s+(?:poweroff|reboot|halt|kexec|emergency|rescue)\b/,
  },
  // Fork bomb.
  {
    name: "fork_bomb",
    pattern: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,
  },
  // Pipe-to-shell RCE.
  {
    name: "curl_pipe_shell",
    pattern:
      /(?:curl|wget|fetch|aria2c)\b[^|;&]*\|\s*(?:bash|sh|zsh|fish|ksh|dash|pwsh|powershell)\b/,
  },
  {
    name: "shell_process_substitution",
    pattern: /(?:bash|sh|zsh|ksh|dash)\s+<\(\s*(?:curl|wget|fetch)\b/,
  },
  {
    // Only bare `| python` (interpreter reads script from stdin) or the
    // explicit `| python -` form are RCE. `| python -c "code"`, `-m module`,
    // `script.py`, and `- <<HEREDOC` all ignore stdin and are safe. Match
    // only when the interpreter is followed by end-of-invocation (EOL, ;,
    // &, |) or an explicit `-` terminator — never when a flag or filename
    // follows.
    name: "curl_pipe_interpreter",
    pattern:
      /(?:curl|wget|fetch)\b[^|;&]*\|\s*(?:python|python3|perl|ruby|node|php|lua|deno|bun)(?:\s+-)?\s*(?:$|;|&|\|)/,
  },
  // Git protected-branch force-push.
  {
    name: "git_force_push_protected",
    pattern:
      /\bgit\s+push\s+(?:\S+\s+)*--force(?:-with-lease)?\b(?:\s+\S+)*\s+(?:main|master|production|prod|release|develop|staging)(?:\s|$)/,
  },
  {
    name: "git_force_push_protected_short",
    pattern:
      /\bgit\s+push\s+(?:\S+\s+)*-f\b(?:\s+\S+)*\s+(?:main|master|production|prod|release|develop|staging)(?:\s|$)/,
  },
  {
    name: "git_push_delete_protected",
    pattern: /\bgit\s+push\s+\S+\s+:(?:main|master|production|prod|release)(?:\s|$)/,
  },
  {
    name: "git_push_mirror",
    pattern: /\bgit\s+push\s+--mirror\b/,
  },
  // Cloud destruction.
  {
    name: "aws_s3_rb_force",
    pattern: /\baws\s+s3\s+rb\s+.*--force\b/,
  },
  {
    name: "aws_s3_rm_recursive",
    pattern: /\baws\s+s3\s+rm\s+.*--recursive\s+s3:\/\/[^/\s]+\/?(?:\s|$)/,
  },
  {
    name: "aws_rds_delete_no_snapshot",
    pattern: /\baws\s+rds\s+delete-db-(?:instance|cluster)\b.*--skip-final-snapshot/,
  },
  {
    name: "gcloud_project_delete",
    pattern: /\bgcloud\s+projects\s+delete\b/,
  },
  {
    name: "kubectl_delete_prod_namespace",
    pattern: /\bkubectl\s+delete\s+(?:ns|namespace)\s+(?:production|prod|prd)\b/,
  },
  {
    name: "kubectl_delete_all_namespaces",
    pattern: /\bkubectl\s+delete\s+--all\b.*\bnamespaces?\b/,
  },
  {
    name: "kubectl_delete_all_pv",
    pattern: /\bkubectl\s+delete\s+pv\s+--all\b/,
  },
  // Agent self-modification.
  {
    name: "delete_agent_config",
    pattern:
      /(?:rm|mv)\s+.*(?:\.codex\/rules|\.claude\/settings|\.open-apex\/config|\.openapex\/config)/,
  },
  {
    name: "chmod_ssh_dir",
    pattern: /(?:chmod|chown)\s+.*~\/\.ssh\//,
  },
  {
    name: "write_authorized_keys",
    pattern: />>?\s*~\/\.ssh\/authorized_keys/,
  },
  {
    name: "write_system_config",
    pattern: />>?\s*\/etc\/(?:passwd|shadow|sudoers|cron|crontab|ssh\/)/,
  },
]);

/**
 * Back-compat tier. Legacy M1 callers used `ALLOWED|CATASTROPHIC`; M2 exposes
 * the full five-tier taxonomy via `./types.ts`. The `ALLOWED` alias maps to
 * "not catastrophic" — callers that still rely on it should migrate to the
 * full classifier in `./composition.ts`.
 */
export type LegacyCatastrophicTier = "ALLOWED" | "CATASTROPHIC";

export interface CatastrophicMatch {
  tier: LegacyCatastrophicTier;
  rule?: string;
  reason?: string;
}

/**
 * Run ONLY the CATASTROPHIC regex block against argv. This is stage 1 of
 * §7.6.1 composition law and is also callable on its own as a cheap pre-
 * flight check.
 */
export function classifyArgvCatastrophic(argv: string[]): CatastrophicMatch {
  const joined = joinArgv(argv);
  for (const { name, pattern } of CATASTROPHIC_PATTERNS) {
    if (pattern.test(joined)) {
      if (name === "rm_-rf_system_dir" && isScopedPackageCacheCleanup(joined)) {
        continue;
      }
      return {
        tier: "CATASTROPHIC",
        rule: name,
        reason: `matched CATASTROPHIC pattern '${name}'`,
      };
    }
  }
  return { tier: "ALLOWED" };
}

/**
 * @deprecated Use `classifyCommand` from `./classifier.ts` which delegates
 * to the full `classifyCompound` flow. Kept for back-compat with M1 call
 * sites that still import `classifyArgv`.
 */
export const classifyArgv = classifyArgvCatastrophic;

/** Back-compat for callers importing `classifyString`. */
export function classifyString(cmd: string): CatastrophicMatch {
  return classifyArgvCatastrophic([cmd]);
}

// Note: the legacy type aliases `ClassifierResult` and `ClassifierTier`
// previously lived here for M1 back-compat. They've migrated to
// `./types.ts` (full five-tier taxonomy). If you're looking for the old
// ALLOWED/CATASTROPHIC union, use `LegacyCatastrophicTier` here or
// `ClassifierTier` from `./types.ts` (which includes CATASTROPHIC).

/**
 * Shell-style flat-join: argv elements joined with single spaces. We do NOT
 * quote whitespace-containing args because the CATASTROPHIC regex patterns
 * anchor on whitespace / pipe / semicolon boundaries — wrapping args in
 * quotes would break those anchors (`'rm` doesn't match `\brm`).
 */
function joinArgv(argv: string[]): string {
  return argv.join(" ");
}

function isScopedPackageCacheCleanup(script: string): boolean {
  const rmInvocations = script.matchAll(
    /(?:^|[\s;&|])(?:sudo\s+)?rm\s+((?:-[a-zA-Z]+\s+)+)([^;&|]+)/g,
  );
  let sawRecursiveRm = false;

  for (const match of rmInvocations) {
    const flags = match[1] ?? "";
    if (!/-[a-zA-Z]*[rR][a-zA-Z]*/.test(flags)) {
      continue;
    }
    sawRecursiveRm = true;
    const targets = (match[2] ?? "")
      .trim()
      .split(/\s+/)
      .map((target) => target.replace(/^['"]|['"]$/g, ""))
      .filter((target) => target.length > 0 && !target.startsWith(">") && !/^\d?>/.test(target));

    if (targets.length === 0 || targets.some((target) => !isAllowedScopedCleanupTarget(target))) {
      return false;
    }
  }

  return sawRecursiveRm;
}

function isAllowedScopedCleanupTarget(target: string): boolean {
  return (
    target === "/var/cache/apt/archives/*" ||
    target === "/var/cache/apt/archives/partial/*" ||
    target === "/var/lib/apt/lists/*" ||
    target === "/tmp/apt-dpkg-install-*" ||
    target === "/tmp/*"
  );
}
