/**
 * §7.6.1 composition law for compound commands.
 *
 * Implements the full flow documented in build-plan §7.6.1 "Composition law
 * for compound commands":
 *   1. Run CATASTROPHIC regex against the full shlex-joined string → reject.
 *   2. Shell wrapper (`bash -c "..."`, etc.) → try to parse inner script as
 *      a simple pipeline; on success, recurse per subcommand. Opaque parse
 *      (substitutions, control flow, heredoc) → DESTRUCTIVE minimum.
 *   3. sudo/doas wrapping → unwrap, classify inner, elevate +1 tier.
 *   4. Process wrapper stripping: `timeout`, `time`, `nice`, `nohup`,
 *      `stdbuf`, bare `xargs` with no flags → strip and re-classify.
 *   5. Pipeline where later stage is a code-executing tool (sh, python -c,
 *      tee, etc.) → elevate all earlier stages to DESTRUCTIVE minimum.
 *   6. Command substitution `$(...)` / backticks → DESTRUCTIVE minimum.
 *   7. Database-client heredocs (psql/mysql/sqlite3/mongosh) with
 *      destructive-SQL bodies → DESTRUCTIVE.
 *
 * The parser is a hand-rolled tokenizer that handles the subset we need:
 *   - `&&`, `||`, `;`, `|` splitting.
 *   - single/double/backtick quoting.
 *   - `$(...)` detection (opaque → DESTRUCTIVE).
 *   - redirect arrows (`>`, `>>`, `<`).
 *   - heredoc preamble detection (`<<EOF`, `<<'EOF'`, `<<-EOF`).
 *
 * Tree-sitter-bash is NOT used; it's a heavier dependency we avoid at the
 * cost of a narrower understanding. The classifier is fail-upward: anything
 * the parser can't reason about is assigned `DESTRUCTIVE` minimum, never
 * under-classified.
 */

import { classifyArgvCatastrophic } from "./catastrophic.ts";
import { COMMAND_RULES, type CommandRule, type SubRule } from "./rules.ts";
import { classifyNetworkInvocation } from "./network.ts";
import { elevate, maxTier, type ClassifierResult, type ClassifierTier } from "./types.ts";

/** Wrappers stripped before rule lookup (process wrappers per §7.6.1 line 3857). */
const STRIPPABLE_WRAPPERS = new Set(["timeout", "time", "nice", "nohup", "stdbuf"]);
/** `xargs` stripped ONLY when used with no flags. */
const XARGS = "xargs";

/** Shell wrappers whose arg can be treated as inner script. */
const SHELL_WRAPPERS = new Set(["bash", "sh", "zsh", "ksh", "dash", "fish", "pwsh", "powershell"]);

const SUDO_WRAPPERS = new Set(["sudo", "doas"]);

/** Commands whose presence in a pipeline forces all earlier stages to DESTRUCTIVE minimum. */
const CODE_EXECUTING_INTERPRETERS = new Set([
  "sh",
  "bash",
  "zsh",
  "ksh",
  "dash",
  "fish",
  "pwsh",
  "powershell",
  "python",
  "python3",
  "ruby",
  "perl",
  "node",
  "deno",
  "bun",
  "php",
  "lua",
  "tee", // tee writes to files; elevate
]);

export interface ClassifyOptions {
  /** Domain allowlist for the network analyzer. */
  allowedDomains?: string[];
  /** Whether network is even permitted in this session. */
  networkEnabled?: boolean;
  /** Absolute workspace root, used to recognize locally built executables. */
  workspaceRoot?: string;
}

/**
 * Classify a full argv (post-sudo, post-wrapper) against the rule table +
 * network analyzer. Does NOT recurse into shell wrappers; that's the
 * caller's job (see `classifyCommand`).
 */
export function classifyAgainstRules(argv: string[], opts: ClassifyOptions = {}): ClassifierResult {
  if (argv.length === 0) return { tier: "READ_ONLY" };
  const envStripped = stripLeadingEnvAssignments(argv);
  if (envStripped.length !== argv.length) {
    if (envStripped.length === 0) return { tier: "READ_ONLY", rule: "env_assignment_prefix" };
    const inner = classifyAgainstRules(envStripped, opts);
    return {
      ...inner,
      rule: `env_prefix:${inner.rule ?? "unknown"}`,
      reason: inner.reason ?? "leading environment assignments stripped before classification",
    };
  }

  const exec = basename(argv[0]!);
  const joined = argv.join(" ");

  if (exec === "kill") {
    if (
      argv
        .slice(1)
        .some((arg, idx, rest) => arg === "-0" || (arg === "-s" && rest[idx + 1] === "0"))
    ) {
      return {
        tier: "READ_ONLY",
        rule: "kill:probe",
        reason: "kill -0 only probes process existence",
      };
    }
  }

  // Strippable process wrappers.
  if (STRIPPABLE_WRAPPERS.has(exec)) {
    // `timeout 30 cmd`, `nice cmd`, `nohup cmd` — strip and recurse.
    const stripped = stripProcessWrapper(argv, exec);
    if (stripped.length > 0) return classifyAgainstRules(stripped, opts);
    return { tier: "READ_ONLY" };
  }
  if (exec === XARGS && argv.length > 1 && !argv[1]!.startsWith("-")) {
    // bare `xargs cmd` with no flags: strip.
    const stripped = argv.slice(1);
    if (stripped.length > 0) return classifyAgainstRules(stripped, opts);
  }

  // Curl/wget/httpie → defer to network analyzer.
  if (isNetworkBinary(exec)) {
    const net = classifyNetworkInvocation(argv, opts);
    if (net) return { ...net, rule: `network:${exec}` };
    // Fall through to rule table for safe default.
  }

  // Rule table lookup.
  for (const rule of COMMAND_RULES) {
    if (!execMatches(rule.exec, exec)) continue;
    // Subcommand rules.
    if (rule.subcommandRules && argv.length > 1) {
      const sub = argv[1]!;
      const subRule = rule.subcommandRules[sub];
      if (subRule) {
        const tier = applySubRule(subRule, joined);
        const out: ClassifierResult = {
          tier,
          rule: `${ruleExecName(rule.exec)}:${sub}`,
        };
        const reason = subRule.note ?? rule.note;
        if (reason !== undefined) out.reason = reason;
        return out;
      }
    }
    // Top-level argv-absent-flag check. Accepts packed short-flags
    // (`-rf` matches `-r` + `-f`).
    if (rule.argvRequireAbsentFlags || rule.argvRequireAbsentPattern) {
      const elevatedFlagHit = rule.argvRequireAbsentFlags?.some((f) => {
        if (argv.slice(1).includes(f)) return true;
        if (f.startsWith("-") && !f.startsWith("--") && f.length === 2) {
          const letter = f[1]!;
          return argv
            .slice(1)
            .some((t) => /^-[A-Za-z]+$/.test(t) && !t.startsWith("--") && t.includes(letter));
        }
        return false;
      });
      const elevatedPatternHit = rule.argvRequireAbsentPattern?.test(joined) ?? false;
      if (elevatedFlagHit || elevatedPatternHit) {
        const out: ClassifierResult = {
          tier: rule.elseTier ?? rule.tier,
          rule: `${ruleExecName(rule.exec)}:flag-elevated`,
        };
        if (rule.note !== undefined) out.reason = rule.note;
        return out;
      }
    }
    return {
      tier: rule.tier,
      rule: ruleExecName(rule.exec),
      ...(rule.note ? { reason: rule.note } : {}),
    };
  }

  const localExecutable = classifyLocalExecutablePath(argv[0]!, opts);
  if (localExecutable) return localExecutable;

  return {
    tier: "UNKNOWN",
    rule: "unknown_exec",
    reason: `no rule for exec '${exec}'; default-upward per \u00a77.6.1`,
  };
}

/**
 * Main entrypoint. Applies CATASTROPHIC filter, then composition law.
 *
 * The `argv` argument is the exact spawned argv; the classifier does NOT
 * re-tokenize it as a shell string. When argv[0] is a shell wrapper with
 * `-c`/`-lc`/`-ic`/`-Command`, argv[1..] is the raw script string and we
 * parse it as a shell pipeline.
 */
export function classifyCompound(argv: string[], opts: ClassifyOptions = {}): ClassifierResult {
  if (argv.length === 0) return { tier: "READ_ONLY" };

  // Stage 1: CATASTROPHIC regex against the full joined argv.
  const cat = classifyArgvCatastrophic(argv);
  if (cat.tier === "CATASTROPHIC") {
    const out: ClassifierResult = { tier: "CATASTROPHIC" };
    if (cat.rule !== undefined) out.rule = cat.rule;
    if (cat.reason !== undefined) out.reason = cat.reason;
    return out;
  }

  // Stage 2: sudo/doas unwrap.
  const exec = basename(argv[0]!);
  if (SUDO_WRAPPERS.has(exec)) {
    const inner = unwrapSudo(argv);
    if (inner.length === 0) {
      // sudo with no command is nearly always READ_ONLY (`sudo -l`, `sudo -v`).
      return { tier: "MUTATING", rule: "sudo_no_inner", reason: "sudo invocation without command" };
    }
    const innerResult = classifyCompound(inner, opts);
    // Elevate +1 tier, floor at MUTATING. Cap at DESTRUCTIVE — sudo alone
    // should not auto-promote a command to CATASTROPHIC (which is always
    // rejected). CATASTROPHIC is reserved for the regex pre-filter that
    // runs before sudo-unwrap.
    let elevated = maxTier(elevate(innerResult.tier, 1), "MUTATING");
    if (elevated === "CATASTROPHIC") elevated = "DESTRUCTIVE";
    return {
      tier: elevated,
      rule: `sudo:${innerResult.rule ?? exec}`,
      reason: `sudo elevation applied: inner=${innerResult.tier} → elevated=${elevated}`,
    };
  }

  // Stage 3: shell wrapper with -c/-lc script argument.
  if (SHELL_WRAPPERS.has(exec)) {
    const dashC = argv.findIndex(
      (a) => a === "-c" || a === "-lc" || a === "-ic" || a === "-Command",
    );
    if (dashC !== -1 && dashC + 1 < argv.length) {
      const script = argv[dashC + 1]!;
      return classifyScript(script, opts);
    }
  }

  // Stage 4: plain argv → rule table.
  return classifyAgainstRules(argv, opts);
}

/**
 * Parse a shell-script string and classify. Non-trivial scripts (heredoc,
 * substitutions, control flow) return DESTRUCTIVE minimum per §7.6.1.
 */
export function classifyScript(script: string, opts: ClassifyOptions = {}): ClassifierResult {
  // Stage 1 (inner): CATASTROPHIC regex against raw script string.
  const cat = classifyArgvCatastrophic([script]);
  if (cat.tier === "CATASTROPHIC") {
    const out: ClassifierResult = { tier: "CATASTROPHIC" };
    if (cat.rule !== undefined) out.rule = cat.rule;
    if (cat.reason !== undefined) out.reason = cat.reason;
    return out;
  }

  // Bail-out signals → DESTRUCTIVE minimum.
  if (hasOpaqueConstruct(script)) {
    return {
      tier: "DESTRUCTIVE",
      rule: "opaque_script",
      reason:
        "script contains command substitution, heredoc, or control flow; not parseable → DESTRUCTIVE minimum per \u00a77.6.1",
    };
  }

  // Split into pipeline stages and top-level &&/||/; sequences.
  const stages = splitScript(script);
  if (stages.length === 0) return { tier: "READ_ONLY", rule: "empty_script" };

  const subResults: ClassifierResult[] = [];
  let overallTier: ClassifierTier = "READ_ONLY";

  for (const stage of stages) {
    // Each stage is a pipeline `a | b | c`.
    const pipelineParts = splitPipeline(stage);
    const partResults: ClassifierResult[] = [];
    for (const part of pipelineParts) {
      const partArgv = normalizeGroupedCommandArgv(tokenizeArgv(part));
      if (partArgv.length === 0) continue;
      // Full recursion so nested sudo / shell-wrappers keep unwrapping.
      const r = classifyCompound(partArgv, opts);
      partResults.push(r);
    }
    // Pipeline-to-interpreter elevation.
    const terminalIsInterpreter =
      partResults.length > 0 && isCodeInterpreter(pipelineParts.at(-1)!);
    let pipelineTier: ClassifierTier = partResults.reduce<ClassifierTier>(
      (acc, r) => maxTier(acc, r.tier),
      "READ_ONLY",
    );
    if (terminalIsInterpreter && partResults.length > 1) {
      pipelineTier = maxTier(pipelineTier, "DESTRUCTIVE");
    }
    // Redirect to outside path → REVERSIBLE minimum (catastrophic writes
    // already caught by CATASTROPHIC regex for /etc etc.).
    if (hasRedirect(stage)) {
      pipelineTier = maxTier(pipelineTier, "REVERSIBLE");
    }
    subResults.push(...partResults);
    overallTier = maxTier(overallTier, pipelineTier);
  }

  return {
    tier: overallTier,
    rule: "script_compound",
    reason: `aggregated ${subResults.length} sub-command(s)`,
    subcommands: subResults,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

function execMatches(exec: CommandRule["exec"], candidate: string): boolean {
  if (typeof exec === "string") return exec === candidate;
  if (exec instanceof RegExp) return exec.test(candidate);
  return exec.includes(candidate);
}

function ruleExecName(exec: CommandRule["exec"]): string {
  if (typeof exec === "string") return exec;
  if (exec instanceof RegExp) return exec.source;
  return exec[0]!;
}

function applySubRule(sub: SubRule, joined: string): ClassifierTier {
  const tokens = joined.split(/\s+/);
  const flagHit = sub.argvRequireAbsentFlags?.some((f) => {
    // Exact token match OR packed short-flag (e.g., `-fdx` contains `-f`).
    if (tokens.includes(f)) return true;
    if (f.startsWith("-") && !f.startsWith("--") && f.length === 2) {
      const letter = f[1]!;
      return tokens.some(
        (t) => /^-[A-Za-z]+$/.test(t) && !t.startsWith("--") && t.includes(letter),
      );
    }
    return false;
  });
  if (flagHit) return sub.elseTier ?? sub.tier;
  if (sub.argvRequireAbsentPattern && sub.argvRequireAbsentPattern.test(joined)) {
    return sub.elseTier ?? sub.tier;
  }
  return sub.tier;
}

function stripProcessWrapper(argv: string[], exec: string): string[] {
  // Skip wrapper-specific flags: e.g., `timeout 30 cmd`, `nice -n 10 cmd`,
  // `stdbuf -o0 cmd`. Keep it simple: strip argv[0], then skip any leading
  // flag or numeric/string value that belongs to the wrapper.
  let i = 1;
  while (i < argv.length) {
    const t = argv[i]!;
    // `timeout <duration>`: positional duration.
    if (exec === "timeout" && /^\d+[smhd]?$/.test(t) && i === 1) {
      i++;
      continue;
    }
    if (t.startsWith("-")) {
      i++;
      // Value-taking wrapper flags: `nice -n 10`, `stdbuf -o0 -e0`, `time -p`.
      // Generic heuristic: if the flag is `-n` / `-o` / `-e` / `-i` and the
      // next arg is a value (starts with digit/letter but not a new flag),
      // consume it.
      const valueFlags = new Set(["-n", "-o", "-e", "-i", "--niceness", "--io-class"]);
      if (valueFlags.has(t) && i < argv.length && !argv[i]!.startsWith("-")) {
        i++;
      }
      continue;
    }
    break;
  }
  return argv.slice(i);
}

function unwrapSudo(argv: string[]): string[] {
  // Strip sudo/doas and their own flags (-u user, -E, -H, -n, -k, etc.).
  let i = 1;
  while (i < argv.length) {
    const t = argv[i]!;
    if (t.startsWith("-")) {
      // Some sudo flags take arguments: -u USER, -g GROUP.
      if (t === "-u" || t === "-g" || t === "--user" || t === "--group") {
        i += 2;
      } else {
        i++;
      }
    } else {
      break;
    }
  }
  return argv.slice(i);
}

function isNetworkBinary(exec: string): boolean {
  return (
    exec === "curl" ||
    exec === "wget" ||
    exec === "httpie" ||
    exec === "http" ||
    exec === "xh" ||
    exec === "aria2c" ||
    exec === "fetch"
  );
}

function classifyLocalExecutablePath(
  command: string,
  opts: ClassifyOptions,
): ClassifierResult | null {
  if (!command.includes("/")) return null;
  if (command.includes("\0")) return null;

  const normalized = normalizeSlashes(command);
  if (normalized.startsWith("../") || normalized.includes("/../") || normalized.endsWith("/..")) {
    return null;
  }

  if (normalized.startsWith("./") || isBareRelativePath(normalized)) {
    return {
      tier: "MUTATING",
      rule: "local_executable_path",
      reason: "workspace-relative executable path; local code execution may mutate workspace",
    };
  }

  if (normalized.startsWith("/tmp/")) {
    return {
      tier: "MUTATING",
      rule: "local_executable_path",
      reason: "temporary local executable path; local code execution may mutate workspace",
    };
  }

  if (normalized.startsWith("/app/")) {
    return {
      tier: "MUTATING",
      rule: "local_executable_path",
      reason: "benchmark workspace executable path; local code execution may mutate workspace",
    };
  }

  if (opts.workspaceRoot) {
    const ws = normalizeAbsoluteDir(opts.workspaceRoot);
    if (ws && (normalized === ws || normalized.startsWith(`${ws}/`))) {
      return {
        tier: "MUTATING",
        rule: "local_executable_path",
        reason:
          "absolute executable path under workspace; local code execution may mutate workspace",
      };
    }
  }

  return null;
}

function normalizeSlashes(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+/g, "/");
}

function normalizeAbsoluteDir(value: string): string | null {
  const normalized = normalizeSlashes(value).replace(/\/+$/g, "");
  if (!normalized.startsWith("/") || normalized.includes("/../") || normalized.endsWith("/..")) {
    return null;
  }
  return normalized || null;
}

function isBareRelativePath(value: string): boolean {
  return !value.startsWith("/") && !value.startsWith("-") && !value.startsWith("~");
}

function isCodeInterpreter(pipelineStage: string): boolean {
  const argv = tokenizeArgv(pipelineStage);
  if (argv.length === 0) return false;
  const exec = basename(argv[0]!);
  return CODE_EXECUTING_INTERPRETERS.has(exec);
}

/** True if the script contains unparseable constructs (substitutions, heredoc, control flow). */
function hasOpaqueConstruct(script: string): boolean {
  // Command substitution $() or backticks.
  if (/\$\([^)]*\)|`[^`]*`/.test(script)) return true;
  // Heredocs.
  if (/<<-?\s*['"]?[A-Za-z_][A-Za-z0-9_]*/.test(script)) return true;
  // Control flow (conservative).
  if (/\b(?:if|for|while|until|case|select|function)\b/i.test(script)) return true;
  return false;
}

/** True if the stage contains `>`, `>>`, or `<` redirection. */
function hasRedirect(stage: string): boolean {
  return /(?:^|[^<>])(?:>>?|<)(?:[^<>]|$)/.test(stage);
}

/**
 * Split a script at top-level `&&`, `||`, `;`, and newlines. Ignores boundaries inside
 * quotes. Returns each stage (which may itself be a pipeline).
 */
export function splitScript(script: string): string[] {
  const stages: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < script.length; i++) {
    const c = script[i]!;
    const next = script[i + 1];
    if (!inDouble && c === "'") inSingle = !inSingle;
    else if (!inSingle && c === '"') inDouble = !inDouble;
    if (!inSingle && !inDouble) {
      if (c === ";" || c === "\n" || c === "\r") {
        if (buf.trim()) stages.push(buf.trim());
        buf = "";
        if (c === "\r" && next === "\n") i++;
        continue;
      }
      if ((c === "&" && next === "&") || (c === "|" && next === "|")) {
        if (buf.trim()) stages.push(buf.trim());
        buf = "";
        i++; // skip next
        continue;
      }
    }
    buf += c;
  }
  if (buf.trim()) stages.push(buf.trim());
  return stages;
}

function stripLeadingEnvAssignments(argv: string[]): string[] {
  let i = 0;
  while (i < argv.length && isEnvAssignment(argv[i]!)) i++;
  return i === 0 ? argv : argv.slice(i);
}

function isEnvAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

/** Split a single stage into pipeline parts (`a | b | c`), quote-aware. */
export function splitPipeline(stage: string): string[] {
  const parts: string[] = [];
  let buf = "";
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < stage.length; i++) {
    const c = stage[i]!;
    const next = stage[i + 1];
    if (!inDouble && c === "'") inSingle = !inSingle;
    else if (!inSingle && c === '"') inDouble = !inDouble;
    if (!inSingle && !inDouble) {
      if (c === "|" && next !== "|") {
        if (buf.trim()) parts.push(buf.trim());
        buf = "";
        continue;
      }
    }
    buf += c;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}

/**
 * Tokenize a single command stage into an argv array. Handles single,
 * double, and backslash-escaped tokens; strips quote wrappers.
 */
export function tokenizeArgv(stage: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;
  let escaped = false;
  for (let i = 0; i < stage.length; i++) {
    const c = stage[i]!;
    if (escaped) {
      cur += c;
      escaped = false;
      continue;
    }
    if (c === "\\" && !inSingle) {
      escaped = true;
      continue;
    }
    if (!inDouble && c === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && c === '"') {
      inDouble = !inDouble;
      continue;
    }
    if (!inSingle && !inDouble && /\s/.test(c)) {
      if (cur.length > 0) tokens.push(cur);
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.length > 0) tokens.push(cur);
  return tokens;
}

function normalizeGroupedCommandArgv(argv: string[]): string[] {
  if (argv.length === 0) return argv;
  const out = [...argv];
  while (out[0]?.startsWith("(")) {
    out[0] = out[0]!.slice(1);
    if (out[0]!.length > 0) break;
    out.shift();
  }
  if (out.length === 0) return out;
  const last = out.length - 1;
  while (out[last]?.endsWith(")") && out[last] !== ")") {
    out[last] = out[last]!.slice(0, -1);
  }
  return out;
}
