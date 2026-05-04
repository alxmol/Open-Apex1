/**
 * Validator discovery ladder — full §7.6.2 implementation.
 *
 * Ordered rungs, first-match wins; later rungs append additional low-confidence
 * candidates only when earlier rungs produced nothing concrete.
 *
 *   1. Explicit from task instruction — backtick commands + file-existence /
 *      port / output-file claims extracted into concrete shell probes.
 *      Confidence: high.
 *   2. Repo manifest declared — package.json scripts, pyproject.toml pytest
 *      config, Cargo.toml, go.mod, Makefile targets, composer.json, Gemfile.
 *      Confidence: medium.
 *   3. Framework convention — pytest.ini / tests dir → pytest; jest/vitest
 *      configs; tsconfig-only → tsc --noEmit; .github/workflows test steps.
 *      Confidence: medium.
 *   4. Repo search — `rg --files -g '{test,tests,spec,specs}/**'`. Confidence:
 *      low.
 *   5. Workspace-local Harbor scripts — task-shipped run_tests.sh / verify.sh
 *      / test.sh in the workspace root (what TB2 tasks actually ship; the
 *      `/tests/` dir is ONLY copied by Harbor at verify time, after the agent
 *      exits). Confidence: high.
 *   6. Minimal-safe fallback — per-language compile/syntax check. Confidence:
 *      low. On its own, §7.6.2 honest-completion forces validation_unknown.
 *
 * Rungs 1 + 5 short-circuit when they produce high-confidence candidates.
 * Rungs 2-4 are additive; rung 6 always appends.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

import type { ValidatorCandidate } from "@open-apex/core";

import { instructionRequiresSourceProvenance } from "./completion-policy.ts";
import { discoverMinimalSafeFallback } from "./minimal-safe-fallback.ts";

export interface DiscoveredValidators {
  /** Candidates in priority order (earlier rungs first). */
  candidates: ValidatorCandidate[];
  /** Per-ladder trace for debugging + ATIF extra. */
  trace: Array<{ step: string; matched: boolean; detail?: string }>;
}

export interface DiscovererInput {
  workspace: string;
  taskInstruction?: string;
  /**
   * Harbor convention tests dir. Typically `/tests/` but Harbor only mounts
   * this AT VERIFY TIME — not during agent execution — so it's rarely
   * present. Kept for parity with §7.6.2 spec and for non-Harbor use.
   */
  harborTestsDir?: string;
  /**
   * If set, cap how many candidates are returned. Protects the autonomous
   * CLI's downstream slice() from runaway manifest combinations.
   */
  maxCandidates?: number;
}

export async function discoverValidators(input: DiscovererInput): Promise<DiscoveredValidators> {
  const trace: DiscoveredValidators["trace"] = [];
  const candidates: ValidatorCandidate[] = [];
  const maxCandidates = input.maxCandidates ?? 8;

  // ── Rung 1: explicit from instruction.
  const fromInstruction = input.taskInstruction
    ? extractFromInstruction(input.taskInstruction, input.workspace)
    : [];
  if (fromInstruction.length > 0) {
    trace.push({
      step: "explicit_from_instruction",
      matched: true,
      detail: `${fromInstruction.length} candidate(s)`,
    });
    for (const c of fromInstruction) {
      if (/^\(.*\)$/.test(c.command)) continue; // hint-only placeholders skip
      candidates.push(c);
    }
    // Short-circuit if we have a concrete high-confidence command AND the
    // explicit probe looks executable (not just "(run project test suite)").
    const hasHigh = candidates.some(
      (c) => c.confidence === "high" && c.source === "task_instruction",
    );
    if (hasHigh && candidates.length > 0) {
      return {
        candidates: finalizeDiscoveredCandidates(candidates, maxCandidates, trace, input.workspace),
        trace,
      };
    }
  } else {
    trace.push({ step: "explicit_from_instruction", matched: false });
  }

  // ── Rung 5 first (promoted): workspace-local Harbor-style scripts.
  // These ship in /app/ (where the agent actually runs). High confidence.
  const wsScripts = discoverWorkspaceScripts(input.workspace);
  if (wsScripts.length > 0) {
    trace.push({
      step: "workspace_local_scripts",
      matched: true,
      detail: wsScripts.map((c) => c.command).join(", "),
    });
    // High-confidence task-local validators prove more than weak instruction
    // probes such as `test -s /app/out.txt`. Keep any explicit high-confidence
    // commands, but drop low output-file checks so semantic validators lead.
    const explicitStrong = candidates.filter((c) => c.confidence === "high");
    return {
      candidates: finalizeDiscoveredCandidates(
        [...explicitStrong, ...wsScripts],
        maxCandidates,
        trace,
        input.workspace,
      ),
      trace,
    };
  } else {
    trace.push({ step: "workspace_local_scripts", matched: false });
  }

  // ── Rung 2: repo manifest declared.
  const manifestCandidates = discoverFromRepoManifest(input.workspace);
  if (manifestCandidates.length > 0) {
    trace.push({
      step: "repo_manifest",
      matched: true,
      detail: manifestCandidates.map((c) => c.command).join(", "),
    });
    candidates.push(...manifestCandidates);
  } else {
    trace.push({ step: "repo_manifest", matched: false });
  }

  // ── Rung 3: framework convention.
  const frameworkCandidates = discoverFromFrameworkConvention(input.workspace);
  if (frameworkCandidates.length > 0) {
    trace.push({
      step: "framework_convention",
      matched: true,
      detail: frameworkCandidates.map((c) => c.command).join(", "),
    });
    // Dedupe against manifest candidates by command string.
    for (const c of frameworkCandidates) {
      if (!candidates.some((x) => x.command === c.command)) candidates.push(c);
    }
  } else {
    trace.push({ step: "framework_convention", matched: false });
  }

  // ── Rung 4: repo search.
  if (candidates.length === 0) {
    const repoSearchCandidate = discoverFromRepoSearch(input.workspace);
    if (repoSearchCandidate) {
      trace.push({
        step: "repo_search",
        matched: true,
        detail: repoSearchCandidate.command,
      });
      candidates.push(repoSearchCandidate);
    } else {
      trace.push({ step: "repo_search", matched: false });
    }
  } else {
    trace.push({
      step: "repo_search",
      matched: false,
      detail: "skipped — prior rungs produced candidates",
    });
  }

  // ── Legacy/historical: `/tests/` dir (only meaningful outside benchmark
  // mode since Harbor mounts `/tests/` only at verify time).
  const harborCandidate = discoverHarborTaskConvention(input.harborTestsDir ?? "/tests");
  if (harborCandidate) {
    trace.push({
      step: "harbor_tests_dir",
      matched: true,
      detail: harborCandidate.command,
    });
    if (!candidates.some((x) => x.command === harborCandidate.command)) {
      candidates.push(harborCandidate);
    }
  } else {
    trace.push({ step: "harbor_tests_dir", matched: false });
  }

  // ── Rung 6: minimal-safe fallback — always appended at the end.
  const fallbacks = await discoverMinimalSafeFallback(input.workspace);
  if (fallbacks.length > 0) {
    trace.push({
      step: "minimal_safe_fallback",
      matched: true,
      detail: fallbacks.map((f) => f.language).join(", "),
    });
    for (const f of fallbacks) {
      if (!candidates.some((x) => x.command === f.candidate.command)) {
        candidates.push(f.candidate);
      }
    }
  } else {
    trace.push({ step: "minimal_safe_fallback", matched: false });
  }

  return {
    candidates: finalizeDiscoveredCandidates(candidates, maxCandidates, trace, input.workspace),
    trace,
  };
}

function finalizeDiscoveredCandidates(
  candidates: ValidatorCandidate[],
  maxCandidates: number,
  trace: DiscoveredValidators["trace"],
  workspace: string,
): ValidatorCandidate[] {
  const accepted: ValidatorCandidate[] = [];
  for (const candidate of candidates) {
    const sanity = sanitizeValidatorCandidate(candidate, workspace);
    if (sanity.ok) {
      accepted.push(candidate);
      continue;
    }
    trace.push({
      step: "validator_candidate_rejected",
      matched: true,
      detail: `${sanity.reason}: ${candidate.command}`,
    });
  }
  return accepted.slice(0, maxCandidates);
}

// ─── Rung 1: explicit from instruction ────────────────────────────────────

/**
 * Parse the task instruction for validator signals:
 *   - Backtick-quoted commands containing validator keywords.
 *   - File-existence claims ("write X to /path", "create /path/file.ext").
 *   - HTTP port claims ("on port 5000", "listens on 8080").
 *
 * Each claim becomes a concrete shell probe.
 */
export function extractFromInstruction(
  instruction: string,
  _workspace?: string,
): ValidatorCandidate[] {
  const out: ValidatorCandidate[] = [];
  const VALIDATOR_KEYWORDS = [
    "test",
    "check",
    "lint",
    "build",
    "vet",
    "compile",
    "typecheck",
    "pytest",
    "jest",
    "vitest",
    "rspec",
    "mocha",
    "pdflatex",
  ];
  const backticks = [...instruction.matchAll(/`([^`\n]{3,160})`/g)];
  for (const m of backticks) {
    const cmd = m[1]!.trim();
    const shape = classifyValidatorCommandShape(cmd, _workspace);
    if (!shape.ok) continue;
    const keywordMatched = commandHasValidatorKeyword(cmd, VALIDATOR_KEYWORDS);
    const contextMatched = hasNearbyValidatorProse(
      instruction,
      m.index ?? 0,
      m[0]?.length ?? cmd.length,
    );
    if (keywordMatched || contextMatched) {
      out.push({
        command: cmd,
        confidence: "high",
        source: "task_instruction",
        justification: contextMatched
          ? `backtick-quoted command appears near validator prose in task instruction: \`${cmd}\``
          : `backtick-quoted command in task instruction: \`${cmd}\``,
      });
    }
  }

  // Output-file claims: "write the output to /app/out.txt", "create a file called /path".
  // Permissive regex; capture paths and turn each into a `test -s <path>` probe.
  // NOTE: file-existence probes are emitted at `low` confidence, NOT high. File
  // presence + non-emptiness is necessary but not sufficient for correctness —
  // gcode-to-text TB2 trial (agent wrote `flag{gcode_is_challenging}` to the
  // claimed path) proves a `test -s` pass does NOT imply task success. The
  // completion-policy treats an all-file-existence pass-set as
  // validation_unknown, mirroring the minimal-safe-fallback downgrade.
  const pathClaimRe =
    /(?:write|save|create|output|produce|place|put)\s+(?:the\s+\w+\s+)?(?:(?:a\s+)?file\s+(?:called\s+)?["`']?|to\s+["`']?)?((?:\/|~\/)[\w./\-]+|"\/[^"]+"|'[^']+')/gi;
  const seenPaths = new Set<string>();
  for (const m of instruction.matchAll(pathClaimRe)) {
    let p = (m[1] ?? "").trim();
    // Strip quoting.
    p = p.replace(/^["'`]|["'`]$/g, "");
    // Sentence punctuation after an unquoted path is prose, not part of the
    // filesystem target (`/app/out.txt.` would make the probe meaningless).
    p = p.replace(/[.,;:]+$/g, "");
    if (!p.startsWith("/") && !p.startsWith("~/")) continue;
    if (seenPaths.has(p)) continue;
    seenPaths.add(p);
    out.push({
      command: `test -s ${shellEscape(p)}`,
      confidence: "low",
      source: "task_instruction",
      justification: `task instruction promises a file at ${p}; probe confirms it exists and is non-empty (content not validated)`,
    });
  }

  // HTTP-port claims: "on port 5000", "port 8080", "port :8080".
  // When the instruction also mentions a curl/http URL pointing at that port,
  // collect the path(s) and probe each one; otherwise fall back to `/`.
  // ALSO recognize standalone endpoint declarations like
  //   "Endpoint: POST /sentiment", "endpoint at /api/v1/foo",
  //   "POST /sentiment accepts ...", "GET /health returns ..."
  // — these are the hf-model-inference-style specs where the task names the
  // endpoint path in prose (not as a curl example). Prefer `curl -X METHOD`
  // with a minimal `-d '{}'` body when POST is specified.
  const portRe =
    /\b(?:port|listen(?:s|ing)?\s+on|running\s+on\s+port|accessible\s+on\s+port)\s*:?\s*(\d{2,5})\b/gi;
  const pathsByPort = extractUrlPathsByPort(instruction);
  const endpointPaths = extractEndpointDeclarations(instruction);
  const seenPorts = new Set<string>();
  for (const m of instruction.matchAll(portRe)) {
    const port = (m[1] ?? "").trim();
    if (!port) continue;
    if (seenPorts.has(port)) continue;
    seenPorts.add(port);
    const fromCurl = pathsByPort.get(port) ?? new Set<string>();
    // Merge endpoint declarations into the path set for this port. We don't
    // know which port the endpoint declaration targets — if the port was
    // separately mentioned, assume the endpoint lives there too (common TB2
    // pattern: one service, one port, one endpoint spec).
    const combined = new Map<string, "GET" | "POST">();
    for (const p of fromCurl) combined.set(p, "GET");
    for (const ep of endpointPaths) {
      // If an explicit METHOD path matches one we already have, upgrade it.
      combined.set(ep.path, ep.method);
    }
    if (combined.size === 0) combined.set("/", "GET");
    for (const [urlPath, method] of combined) {
      out.push({
        command: buildPortProbe(port, urlPath, method),
        confidence: "medium",
        source: "task_instruction",
        justification:
          `task claims a service listens on port ${port}` +
          (urlPath !== "/" ? ` at ${method} ${urlPath}` : "") +
          `; probe verifies any 2xx/3xx HTTP response`,
      });
    }
  }

  // Some TB2 tasks require a local model cache, not just a responsive HTTP
  // endpoint. Add a semantic validator that actually loads the saved
  // Hugging Face artifact when the prompt names the cache path. This prevents
  // endpoint/py_compile smoke checks from being mistaken for model correctness.
  const modelCacheValidator = buildModelCacheValidator(instruction);
  if (modelCacheValidator && !out.some((c) => c.command === modelCacheValidator.command)) {
    out.push(modelCacheValidator);
  }

  const sourceProbe = buildExistingSourceProvenanceProbe(instruction, _workspace);
  if (sourceProbe && !out.some((c) => c.command === sourceProbe.command)) {
    out.push(sourceProbe);
  }

  // Bare validator-binary claims in prose. Covers the overfull-hbox case
  // (`pdflatex main.tex`) and similar phrasings that don't backtick the
  // command. Confidence `medium` — this is inferred, not directly quoted.
  // Dedupe against backtick-matched commands: if the instruction already
  // quotes a command containing the same binary name (e.g. backtick `pytest -q`
  // plus prose "run pytest"), the backtick wins and the bare match is skipped.
  const backtickBinaries = new Set<string>();
  for (const c of out) {
    const first = c.command.split(/\s+/)[0];
    if (first) backtickBinaries.add(first);
  }
  const bareMatches = extractBareValidatorCommands(instruction, _workspace);
  for (const bare of bareMatches) {
    if (out.some((c) => c.command === bare.command)) continue;
    const bareFirst = bare.command.split(/\s+/)[0];
    const bareBinaries = bareBinaryTokens(bare.command);
    // Skip if any of the bare's binary tokens is already represented by a
    // backtick command.
    const overlaps = [...bareBinaries].some((b) => backtickBinaries.has(b));
    if (overlaps) continue;
    if (bareFirst && backtickBinaries.has(bareFirst)) continue;
    out.push(bare);
  }

  // When the task mentions a LaTeX compile AND a warning keyword the prompt
  // explicitly forbids (e.g., "with no overfull hbox warnings"), emit a
  // second validator that re-runs the compile and FAILS if the output log
  // contains the warning string. Without this, `pdflatex -halt-on-error`
  // alone exits 0 on warnings (they're not errors), producing a false
  // positive — exactly what happened on the TB2 overfull-hbox trial.
  const latexTools = bareMatches.filter((c) => /\b(?:pdf|xe|lua)?latex\b/i.test(c.command));
  const warningKeywords = extractForbiddenLatexWarnings(instruction);
  for (const latexCmd of latexTools) {
    for (const keyword of warningKeywords) {
      // Build the inner script with the keyword embedded via shellEscape
      // (which may wrap it in single quotes), then shell-escape the WHOLE
      // script once for `sh -c`. Previously we hand-concatenated a single-
      // quoted outer wrapper with an inner `'keyword'`, which closed the
      // outer quote early and truncated the script, producing false-pass
      // results (observed on all 3 overfull-hbox trials in the tb2-smoke
      // regression run — the TB2 verifier disagreed with our validator).
      //
      // Also use `grep -qiE` with a regex that tolerates TeX's actual
      // output format: `Overfull \hbox` (backslash-hbox) rather than
      // `Overfull hbox`. extractForbiddenLatexWarnings strips backslashes
      // from the keyword; we re-insert tolerance in the grep regex so both
      // `overfull hbox` and `overfull \hbox` match.
      const keywordRegex = keyword
        .split(/\s+/)
        .map((tok) => tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("[ \\\\]+");
      const inner =
        `OUT=$(${latexCmd.command} 2>&1); ` +
        `status=$?; [ $status -ne 0 ] && { echo "$OUT" >&2; exit 1; }; ` +
        `echo "$OUT" | grep -qiE ${shellEscape(keywordRegex)} && exit 1 || exit 0`;
      const grepCmd = `sh -c ${shellEscape(inner)}`;
      out.push({
        command: grepCmd,
        confidence: "medium",
        source: "task_instruction",
        justification: `task forbids "${keyword}" in compile output; probe fails if the output log contains the warning`,
      });
    }
  }

  // Generic "run the tests" fallback marker (hint only — left in for logging).
  if (/\brun (?:the )?tests\b/i.test(instruction) && out.length === 0) {
    out.push({
      command: "(run project test suite)",
      confidence: "low",
      source: "task_instruction",
      justification:
        "instruction says 'run the tests' but does not name a command; later rungs pick the concrete runner",
    });
  }
  return out;
}

/**
 * Some TB2 tasks give a concrete sanity command whose command text does not
 * contain a conventional validator keyword (`pmars ...`, `povray ...`). The
 * surrounding prose is the validator signal, so inspect a small local window
 * around the backtick span rather than promoting every quoted shell fragment.
 */
function hasNearbyValidatorProse(instruction: string, index: number, length: number): boolean {
  // Keep the prose window local to the quoted span's sentence/line. Earlier
  // versions used a wide +/-180 character window, which promoted unrelated
  // paths like `/app` or `/app/deps/illum1.pov` simply because a later
  // sentence said "we will verify".
  const leftBoundary = Math.max(
    instruction.lastIndexOf("\n", index),
    instruction.lastIndexOf(".", index),
    instruction.lastIndexOf("!", index),
    instruction.lastIndexOf("?", index),
  );
  const rightCandidates = [
    instruction.indexOf("\n", index + length),
    instruction.indexOf(".", index + length),
    instruction.indexOf("!", index + length),
    instruction.indexOf("?", index + length),
  ].filter((pos) => pos >= 0);
  const rightBoundary =
    rightCandidates.length > 0 ? Math.min(...rightCandidates) : instruction.length;
  const start = Math.max(0, leftBoundary + 1, index - 90);
  const end = Math.min(instruction.length, rightBoundary, index + length + 90);
  const window = instruction.slice(start, end).toLowerCase();
  return /(?:\btests?\b|\btest\b|\bverify\b|\bverification\b|\bvalidated?\b|\bsanity[-\s]+checks?\b|\bwe(?:'ll| will)\s+verify\b|\bthis\s+should\s+output\b|\bshould\s+output\b|\bshould\s+complete\s+successfully\b|\bshould\s+complete\b)/i.test(
    window,
  );
}

export type ValidatorCandidateRejectionReason =
  | "empty"
  | "url_only"
  | "path_only"
  | "directory"
  | "data_file"
  | "setup_command"
  | "not_command_like";

export type ValidatorCandidateSanity =
  | { ok: true }
  | { ok: false; reason: ValidatorCandidateRejectionReason };

/**
 * Validate a proposed shell validator before it enters the runner. The
 * extractor is intentionally conservative: task prompts often backtick paths,
 * package names, or setup commands near words like "verify", and running
 * those as validators creates false recovery loops.
 */
export function sanitizeValidatorCandidate(
  candidate: ValidatorCandidate,
  workspace?: string,
): ValidatorCandidateSanity {
  if (/^\(.*\)$/.test(candidate.command.trim())) return { ok: true };
  return classifyValidatorCommandShape(candidate.command, workspace);
}

const KNOWN_VALIDATOR_COMMANDS = new Set([
  "[",
  "awk",
  "bash",
  "bun",
  "c++",
  "cargo",
  "cc",
  "clang",
  "clang++",
  "cmake",
  "cobc",
  "composer",
  "curl",
  "diff",
  "g++",
  "gcc",
  "go",
  "gradle",
  "grep",
  "java",
  "jest",
  "jq",
  "make",
  "mocha",
  "mvn",
  "mypy",
  "node",
  "npm",
  "npx",
  "pdflatex",
  "pmars",
  "pnpm",
  "povray",
  "pytest",
  "python",
  "python3",
  "r",
  "rscript",
  "ruff",
  "ruby",
  "rspec",
  "sed",
  "sh",
  "test",
  "tsc",
  "uv",
  "vitest",
  "xelatex",
  "yarn",
]);

const EXECUTABLE_SCRIPT_EXTENSIONS = new Set([".sh", ".bash", ".py", ".rb", ".js", ".mjs"]);
const DATA_FILE_EXTENSIONS = new Set([
  ".csv",
  ".dat",
  ".gif",
  ".html",
  ".jpg",
  ".jpeg",
  ".json",
  ".log",
  ".md",
  ".pdf",
  ".png",
  ".pov",
  ".red",
  ".tex",
  ".txt",
  ".xml",
  ".yaml",
  ".yml",
]);

function commandHasValidatorKeyword(command: string, keywords: readonly string[]): boolean {
  const lc = command.toLowerCase();
  return keywords.some((kw) => new RegExp(`(^|[^a-z0-9_])${kw}([^a-z0-9_]|$)`, "i").test(lc));
}

function classifyValidatorCommandShape(
  command: string,
  workspace?: string,
): ValidatorCandidateSanity {
  const trimmed = command.trim();
  if (!trimmed) return { ok: false, reason: "empty" };
  if (/^https?:\/\//i.test(trimmed)) return { ok: false, reason: "url_only" };

  const words = shellWords(trimmed);
  const executableIndex = firstExecutableIndex(words);
  const executable = executableIndex >= 0 ? words[executableIndex] : undefined;
  if (!executable) return { ok: false, reason: "not_command_like" };

  const next = words[executableIndex + 1]?.toLowerCase();
  const base = path
    .basename(executable)
    .replace(/\.(?:exe|cmd|bat)$/i, "")
    .toLowerCase();
  const ext = path.extname(executable).toLowerCase();
  const singleExecutable = words.length === executableIndex + 1;

  if (base === "git" && next === "clone") return { ok: false, reason: "setup_command" };
  if ((base === "pip" || base === "pip3") && next === "install") {
    return { ok: false, reason: "setup_command" };
  }
  if (
    (base === "npm" || base === "pnpm" || base === "yarn" || base === "bun") &&
    next === "install"
  ) {
    return { ok: false, reason: "setup_command" };
  }

  const pathish = looksPathish(executable);
  if (pathish) {
    const resolved = resolveMaybeWorkspacePath(executable, workspace);
    if (resolved) {
      try {
        if (statSync(resolved).isDirectory()) return { ok: false, reason: "directory" };
      } catch {
        /* missing paths are still shape-checked below */
      }
    }
    if (DATA_FILE_EXTENSIONS.has(ext) && !EXECUTABLE_SCRIPT_EXTENSIONS.has(ext)) {
      return { ok: false, reason: "data_file" };
    }
    if (singleExecutable && !EXECUTABLE_SCRIPT_EXTENSIONS.has(ext)) {
      return { ok: false, reason: "path_only" };
    }
  } else if (DATA_FILE_EXTENSIONS.has(ext)) {
    return { ok: false, reason: "data_file" };
  }

  if (KNOWN_VALIDATOR_COMMANDS.has(base)) return { ok: true };
  if (pathish && EXECUTABLE_SCRIPT_EXTENSIONS.has(ext)) return { ok: true };
  if (pathish && words.length > executableIndex + 1 && KNOWN_VALIDATOR_COMMANDS.has(base)) {
    return { ok: true };
  }
  return { ok: false, reason: "not_command_like" };
}

function shellWords(command: string): string[] {
  return (
    command
      .match(/"(?:\\"|[^"])*"|'(?:\\'|[^'])*'|[^\s|;&()<>]+/g)
      ?.map((word) => word.replace(/^["']|["']$/g, "")) ?? []
  );
}

function firstExecutableIndex(words: readonly string[]): number {
  for (let i = 0; i < words.length; i++) {
    const word = words[i]!;
    if (/^[A-Za-z_][A-Za-z0-9_]*=.*/.test(word)) continue;
    if (["env", "sudo", "time", "timeout", "command"].includes(word)) continue;
    return i;
  }
  return -1;
}

function looksPathish(token: string): boolean {
  return (
    token.startsWith("/") ||
    token.startsWith("./") ||
    token.startsWith("../") ||
    token.startsWith("~/")
  );
}

function resolveMaybeWorkspacePath(token: string, workspace?: string): string | null {
  if (token.startsWith("~/")) return null;
  if (path.isAbsolute(token)) return token;
  if (!workspace) return null;
  if (token.startsWith("./") || token.startsWith("../")) return path.resolve(workspace, token);
  return null;
}

function buildModelCacheValidator(instruction: string): ValidatorCandidate | null {
  if (!/model_cache|from_pretrained|hugging\s*face|transformers/i.test(instruction)) return null;
  const pathMatch =
    /(\/app\/model_cache\/[A-Za-z0-9_.@+\-/%]+|model_cache\/[A-Za-z0-9_.@+\-/%]+)/i.exec(
      instruction,
    );
  if (!pathMatch) return null;
  const modelPath = pathMatch[1]!.startsWith("/") ? pathMatch[1]! : `/app/${pathMatch[1]!}`;
  const script = [
    "from transformers import AutoModelForSequenceClassification, AutoTokenizer",
    "p = " + JSON.stringify(modelPath),
    "AutoTokenizer.from_pretrained(p, local_files_only=True)",
    "AutoModelForSequenceClassification.from_pretrained(p, local_files_only=True)",
  ].join("; ");
  return {
    command: `python3 -c ${shellEscape(script)}`,
    confidence: "medium",
    source: "task_instruction",
    justification: `task requires a loadable Hugging Face model cache at ${modelPath}`,
  };
}

function buildExistingSourceProvenanceProbe(
  instruction: string,
  workspace?: string,
): ValidatorCandidate | null {
  if (!instructionRequiresSourceProvenance(instruction)) {
    return null;
  }
  if (!workspace) return null;

  let sourceDir: string | null = null;
  for (const name of ["debian", "src", "source"]) {
    if (existsSync(path.join(workspace, name))) {
      sourceDir = name;
      break;
    }
  }
  if (!sourceDir) {
    try {
      const entries = readdirSync(workspace, { withFileTypes: true });
      sourceDir =
        entries
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
          .find((name) => /(?:source|src|debian|pmars|povray)/i.test(name)) ?? null;
    } catch {
      sourceDir = null;
    }
  }
  if (!sourceDir) return null;

  return {
    command: `test -d ${shellEscape(sourceDir)}`,
    confidence: "low",
    source: "task_instruction",
    justification:
      "source-provenance evidence only; directory existence does not prove the final artifact was built from source",
  };
}

function shellEscape(s: string): string {
  if (/^[A-Za-z0-9_./:@+,=%-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build a curl probe against `127.0.0.1:<port><urlPath>`. Passes on any
 * 2xx/3xx/4xx response (server is reachable and handling requests); fails
 * on 5xx or curl-transport errors (connection refused, DNS, timeout —
 * these all produce `000` as the http_code).
 *
 * Why 4xx = pass: for POST endpoints like hf-model-inference's
 * `POST /sentiment` spec, sending a minimal `{}` body correctly returns
 * 400 ("missing required `text` field"). That IS the server working as
 * designed — the agent built the endpoint, it's routing, it validates
 * inputs. Harbor's own verifier sends a valid payload and sees 2xx.
 * Our weaker probe should not false-negative a working endpoint just
 * because we sent an empty body. 5xx still fails (server internal error)
 * and `000` still fails (no listener).
 *
 * For POST endpoints we still send a minimal `{}` body so routing can
 * fire — a bare `curl -X POST` with no body can confuse some frameworks.
 */
function buildPortProbe(port: string, urlPath: string, method: "GET" | "POST" = "GET"): string {
  const cleanPath = urlPath.startsWith("/") ? urlPath : `/${urlPath}`;
  const quoted = shellEscape(`http://127.0.0.1:${port}${cleanPath}`);
  const methodFlags =
    method === "POST" ? `-X POST -H 'Content-Type: application/json' --data-raw '{}'` : "";
  const base = `curl -sS -m 10 -o /dev/null -w '%{http_code}' ${methodFlags} ${quoted}`.trim();
  return `${base} | grep -qE '^[234]'`;
}

/**
 * Extract explicit endpoint declarations. Matches:
 *   "Endpoint: POST /sentiment"
 *   "endpoint: /health"
 *   "POST /api/v1/items accepts ..."
 *   "GET /health returns ..."
 * Filters to paths that LOOK like real URL paths (start with `/`, contain a
 * path-safe character set). Method defaults to GET when unspecified.
 */
function extractEndpointDeclarations(
  instruction: string,
): Array<{ path: string; method: "GET" | "POST" }> {
  const out: Array<{ path: string; method: "GET" | "POST" }> = [];
  const seen = new Set<string>();
  const push = (path: string, method: "GET" | "POST"): void => {
    const key = `${method} ${path}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ path, method });
  };
  // "Endpoint: [METHOD] /path" (case-insensitive, optional method token).
  const endpointRe = /\bendpoint\s*:?\s*(?:(GET|POST|PUT|DELETE|PATCH)\s+)?(\/[A-Za-z0-9_\-/.]+)/gi;
  for (const m of instruction.matchAll(endpointRe)) {
    const method = (m[1] ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "POST") continue;
    push(m[2]!, method);
  }
  // Bare "POST /path" / "GET /path" phrasings — require at least one
  // following noun-verb context so we don't match random "POST /help".
  const bareRe =
    /\b(GET|POST|PUT|DELETE|PATCH)\s+(\/[A-Za-z0-9_\-/.]+)\b(?=\s+(?:accepts?|returns?|responds?|handles?|serves?|receives?|expects?|is|at|with|and))/gi;
  for (const m of instruction.matchAll(bareRe)) {
    const method = m[1]!.toUpperCase();
    if (method !== "GET" && method !== "POST") continue;
    push(m[2]!, method);
  }
  return out;
}

/**
 * Parse forbidden-warning keywords out of the task instruction. TB2 prompts
 * say things like "compile with no overfull hbox warnings" — we extract the
 * lower-cased keyword so the grep validator can scan for it in the LaTeX log.
 */
function extractForbiddenLatexWarnings(instruction: string): string[] {
  const out = new Set<string>();
  const patterns = [
    /\bno\s+(overfull\s+hbox(?:\s+warnings?)?)/gi,
    /\bno\s+(underfull\s+hbox(?:\s+warnings?)?)/gi,
    /\bno\s+(overfull\s+\\hbox)/gi,
    /\bno\s+(underfull\s+\\hbox)/gi,
    /\bwith\s+no\s+["`']?(overfull\s+hbox)/gi,
    /\bwithout\s+(overfull\s+hbox)/gi,
  ];
  for (const re of patterns) {
    for (const m of instruction.matchAll(re)) {
      const kw = (m[1] ?? "")
        .trim()
        .replace(/\\/g, "")
        .replace(/\s+warnings?$/i, "");
      if (kw) out.add(kw.toLowerCase());
    }
  }
  return Array.from(out);
}

/**
 * Extract URL paths the task instruction mentions, grouped by port. Matches
 * patterns like "curl http://server:8080/hello.html" or "http://host:5000/api".
 * Lets the probe target the same path the task did, avoiding false negatives
 * when the service routes `/hello.html` but 4xx's on `/`.
 */
function extractUrlPathsByPort(instruction: string): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  const urlRe = /https?:\/\/[^\s"'`)<>]+:(\d{2,5})(\/[^\s"'`)<>]*)?/gi;
  for (const m of instruction.matchAll(urlRe)) {
    const port = m[1]!;
    const p = (m[2] ?? "/").trim();
    if (!p) continue;
    if (!map.has(port)) map.set(port, new Set<string>());
    map.get(port)!.add(p);
  }
  return map;
}

/**
 * Detect bare validator-binary mentions in prose — `pdflatex`, `pytest`,
 * `cargo test`, `go test`, `make`, `npm test`, `bun test`, etc. — when they
 * appear WITHOUT backticks (which the main keyword pass already catches).
 * Only fires when the instruction implies the command is how correctness is
 * verified ("run", "using", "via", "ensure ... compiles with", etc.).
 */
function extractBareValidatorCommands(
  instruction: string,
  workspace?: string,
): ValidatorCandidate[] {
  const out: ValidatorCandidate[] = [];
  const lc = instruction.toLowerCase();

  // Map of (keyword regex, concrete command, justification).
  // Keyword regex must match the bare command appearing in a
  // verification-implying context.
  const rules: Array<{
    match: RegExp;
    command: string;
    justification: string;
  }> = [
    {
      match: /\bpdflatex\b/,
      command: findMainTex(workspace)
        ? `pdflatex -interaction=nonstopmode -halt-on-error ${findMainTex(workspace)}`
        : "pdflatex -interaction=nonstopmode -halt-on-error main.tex",
      justification: "task names pdflatex as the compiler",
    },
    {
      match: /\b(?:run\s+)?pytest\b/,
      command: "python3 -m pytest -q",
      justification: "task names pytest as the validator",
    },
    {
      match: /\b(?:run\s+)?cargo\s+test\b/,
      command: "cargo test --all-targets",
      justification: "task names cargo test as the validator",
    },
    {
      match: /\b(?:run\s+)?go\s+test\b/,
      command: "go test ./...",
      justification: "task names go test as the validator",
    },
    {
      match: /\b(?:run\s+)?npm\s+(?:run\s+)?test\b/,
      command: "npm test --silent",
      justification: "task names npm test as the validator",
    },
    {
      match: /\b(?:run\s+)?bun\s+test\b/,
      command: "bun test",
      justification: "task names bun test as the validator",
    },
    {
      match: /\b(?:run\s+)?make\s+test\b/,
      command: "make test",
      justification: "task names make test as the validator",
    },
    {
      match: /\b(?:run\s+)?make\s+check\b/,
      command: "make check",
      justification: "task names make check as the validator",
    },
  ];

  for (const rule of rules) {
    if (rule.match.test(lc)) {
      out.push({
        command: rule.command,
        confidence: "medium",
        source: "task_instruction",
        justification: rule.justification,
      });
    }
  }
  return out;
}

/**
 * Extract every binary-ish token from a shell command string. Used to dedupe
 * bare-name matches against backtick matches.
 *
 * `python3 -m pytest -q` → { python3, pytest }
 * `cargo test --all-targets` → { cargo, test }
 * `pdflatex -interaction=... main.tex` → { pdflatex }
 */
function bareBinaryTokens(cmd: string): Set<string> {
  const tokens = cmd.split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  if (tokens.length === 0) return out;
  out.add(tokens[0]!);
  // Python "-m <module>" and bun/uv-style `-m` flags: the module name is also
  // a binary identity in our dedupe logic.
  for (let i = 0; i < tokens.length - 1; i++) {
    if (tokens[i] === "-m") out.add(tokens[i + 1]!);
  }
  // Compound commands like `cargo test`, `go test`, `npm test`, `make test`:
  // token 2 is meaningful.
  if (["cargo", "go", "npm", "make", "bun", "yarn", "pnpm"].includes(tokens[0]!)) {
    if (tokens[1] && !tokens[1].startsWith("-")) out.add(tokens[1]);
  }
  return out;
}

function findMainTex(workspace?: string): string | null {
  if (!workspace) return null;
  const candidates = ["main.tex", "document.tex", "paper.tex", "thesis.tex"];
  for (const c of candidates) {
    if (existsSync(path.join(workspace, c))) return c;
  }
  return null;
}

// ─── Rung 5 (promoted): workspace-local scripts ───────────────────────────

/** Names that TB2 tasks commonly ship at the workspace root. */
const WORKSPACE_SCRIPT_NAMES = [
  "run_tests.sh",
  "test.sh",
  "tests.sh",
  "verify.sh",
  "check.sh",
  "run.sh",
];
const WORKSPACE_PY_VALIDATOR_NAMES = ["test_outputs.py", "test_output.py", "verify.py", "check.py"];

function discoverWorkspaceScripts(workspace: string): ValidatorCandidate[] {
  const out: ValidatorCandidate[] = [];
  for (const name of WORKSPACE_SCRIPT_NAMES) {
    const p = path.join(workspace, name);
    if (existsSync(p)) {
      out.push({
        command: `bash ./${shellEscape(name)}`,
        confidence: "high",
        source: "repo_manifest",
        justification: `workspace-local validator script ${name}`,
      });
    }
  }
  for (const name of WORKSPACE_PY_VALIDATOR_NAMES) {
    const p = path.join(workspace, name);
    if (!existsSync(p)) continue;
    const isPytestStyle = /^test_outputs?\.py$/.test(name);
    out.push({
      command: isPytestStyle
        ? `python3 -m pytest ./${shellEscape(name)} -q`
        : `python3 ./${shellEscape(name)}`,
      confidence: "high",
      source: "harbor_task_convention",
      justification: `workspace-local Python validator ${name}`,
    });
  }
  return out;
}

// ─── Rung 2: repo manifest ───────────────────────────────────────────────

function discoverFromRepoManifest(workspace: string): ValidatorCandidate[] {
  const out: ValidatorCandidate[] = [];

  // package.json scripts
  const pkgPath = path.join(workspace, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
        scripts?: Record<string, string>;
      };
      const scripts = pkg.scripts ?? {};
      for (const key of ["test", "ci", "check"]) {
        if (typeof scripts[key] === "string") {
          out.push({
            command: `npm run ${key} --silent`,
            confidence: "medium",
            source: "repo_manifest",
            justification: `package.json scripts.${key}: ${scripts[key]}`,
          });
        }
      }
    } catch {
      /* malformed package.json → skip */
    }
  }

  // pyproject.toml
  const pyproject = path.join(workspace, "pyproject.toml");
  if (existsSync(pyproject)) {
    try {
      const body = readFileSync(pyproject, "utf8");
      if (/\[tool\.pytest\.ini_options\]/.test(body)) {
        out.push({
          command: "python3 -m pytest -q",
          confidence: "medium",
          source: "repo_manifest",
          justification: "pyproject.toml declares [tool.pytest.ini_options]",
        });
      }
      if (/\[tool\.poetry\.scripts\]/.test(body)) {
        const m = /^\s*test\s*=\s*"([^"]+)"/m.exec(body);
        if (m) {
          out.push({
            command: m[1]!.trim(),
            confidence: "medium",
            source: "repo_manifest",
            justification: `pyproject.toml [tool.poetry.scripts] test = "${m[1]}"`,
          });
        }
      }
    } catch {
      /* malformed */
    }
  }

  // Cargo.toml → cargo test
  if (existsSync(path.join(workspace, "Cargo.toml"))) {
    out.push({
      command: "cargo test --all-targets",
      confidence: "medium",
      source: "repo_manifest",
      justification: "Cargo.toml present",
    });
  }

  // go.mod → go test ./...
  if (existsSync(path.join(workspace, "go.mod"))) {
    out.push({
      command: "go test ./...",
      confidence: "medium",
      source: "repo_manifest",
      justification: "go.mod present",
    });
  }

  // Makefile — look for `test:` / `check:` / `verify:` targets
  const makefile = path.join(workspace, "Makefile");
  if (existsSync(makefile)) {
    try {
      const body = readFileSync(makefile, "utf8");
      for (const target of ["test", "check", "verify"]) {
        const re = new RegExp(`^${target}\\s*:`, "m");
        if (re.test(body)) {
          out.push({
            command: `make ${target}`,
            confidence: "medium",
            source: "repo_manifest",
            justification: `Makefile has target ${target}:`,
          });
        }
      }
    } catch {
      /* skip */
    }
  }

  // composer.json scripts.test (PHP)
  const composer = path.join(workspace, "composer.json");
  if (existsSync(composer)) {
    try {
      const c = JSON.parse(readFileSync(composer, "utf8")) as {
        scripts?: Record<string, unknown>;
      };
      if (c.scripts && typeof c.scripts["test"] === "string") {
        out.push({
          command: "composer test",
          confidence: "medium",
          source: "repo_manifest",
          justification: "composer.json declares scripts.test",
        });
      }
    } catch {
      /* skip */
    }
  }

  // Gemfile + spec/ → bundle exec rspec
  if (existsSync(path.join(workspace, "Gemfile")) && existsSync(path.join(workspace, "spec"))) {
    out.push({
      command: "bundle exec rspec",
      confidence: "medium",
      source: "repo_manifest",
      justification: "Gemfile + spec/ detected",
    });
  }

  return out;
}

// ─── Rung 3: framework convention ────────────────────────────────────────

function discoverFromFrameworkConvention(workspace: string): ValidatorCandidate[] {
  const out: ValidatorCandidate[] = [];
  const j = (s: string): string => path.join(workspace, s);

  // pytest
  const hasPytestConfig =
    existsSync(j("pytest.ini")) || existsSync(j("tox.ini")) || existsSync(j("conftest.py"));
  const hasTestsDir = existsSync(j("tests")) || existsSync(j("test"));
  if (hasPytestConfig || hasTestsDir) {
    out.push({
      command: "python3 -m pytest -q",
      confidence: "medium",
      source: "framework_convention",
      justification: "pytest config or tests/ directory present",
    });
  }

  // jest / vitest
  for (const cfg of [
    "jest.config.js",
    "jest.config.ts",
    "jest.config.mjs",
    "jest.config.cjs",
    "jest.config.json",
  ]) {
    if (existsSync(j(cfg))) {
      out.push({
        command: "npx --no-install jest --silent",
        confidence: "medium",
        source: "framework_convention",
        justification: `jest config detected: ${cfg}`,
      });
      break;
    }
  }
  for (const cfg of ["vitest.config.js", "vitest.config.ts", "vitest.config.mjs"]) {
    if (existsSync(j(cfg))) {
      out.push({
        command: "npx --no-install vitest run",
        confidence: "medium",
        source: "framework_convention",
        justification: `vitest config detected: ${cfg}`,
      });
      break;
    }
  }

  // tsconfig-only repo
  if (
    existsSync(j("tsconfig.json")) &&
    !existsSync(j("package.json")) &&
    !out.some((c) => c.command.includes("tsc"))
  ) {
    out.push({
      command: "npx --no-install tsc --noEmit",
      confidence: "medium",
      source: "framework_convention",
      justification: "tsconfig.json present with no package.json",
    });
  }

  return out;
}

// ─── Rung 4: repo search ─────────────────────────────────────────────────

function discoverFromRepoSearch(workspace: string): ValidatorCandidate | null {
  // Avoid invoking ripgrep every run — it's fast but adds a subprocess. Walk
  // the top two levels looking for a tests/spec directory with >= 1 file.
  try {
    const entries = readdirSyncSafe(workspace);
    for (const name of entries) {
      if (!/^(test|tests|spec|specs)$/i.test(name)) continue;
      const full = path.join(workspace, name);
      if (!existsSync(full)) continue;
      const inner = readdirSyncSafe(full);
      if (inner.length > 0) {
        // Guess framework from file extensions.
        if (inner.some((f) => f.endsWith(".py"))) {
          return {
            command: `python3 -m pytest ${shellEscape(name)} -q`,
            confidence: "low",
            source: "repo_search",
            justification: `repo_search found ${full} with .py files`,
          };
        }
        if (inner.some((f) => f.endsWith(".ts") || f.endsWith(".js"))) {
          return {
            command: `npx --no-install jest ${shellEscape(name)} --silent`,
            confidence: "low",
            source: "repo_search",
            justification: `repo_search found ${full} with .ts/.js files`,
          };
        }
      }
    }
  } catch {
    /* no-op */
  }
  return null;
}

function readdirSyncSafe(dir: string): string[] {
  try {
    return require("node:fs").readdirSync(dir) as string[];
  } catch {
    return [];
  }
}

// ─── Legacy: Harbor `/tests/` dir (rarely present at agent runtime) ──────

function discoverHarborTaskConvention(harborTestsDir: string): ValidatorCandidate | null {
  const testSh = `${harborTestsDir}/test.sh`;
  if (existsSync(testSh)) {
    return {
      command: `bash ${testSh}`,
      confidence: "high",
      source: "harbor_task_convention",
      justification: `Harbor validator script detected at ${testSh}`,
    };
  }
  const verifySh = `${harborTestsDir}/verify.sh`;
  if (existsSync(verifySh)) {
    return {
      command: `bash ${verifySh}`,
      confidence: "high",
      source: "harbor_task_convention",
      justification: `Harbor verifier script detected at ${verifySh}`,
    };
  }
  const pyTests = ["test_outputs.py", "test_output.py"];
  for (const name of pyTests) {
    const p = `${harborTestsDir}/${name}`;
    if (existsSync(p)) {
      return {
        command: `python3 -m pytest ${harborTestsDir} -q`,
        confidence: "high",
        source: "harbor_task_convention",
        justification: `Harbor pytest-style tests detected in ${harborTestsDir}`,
      };
    }
  }
  return null;
}

// Keep stat() import alive for future rungs that need mtime-based dedupe.
void stat;
void spawnSync;
