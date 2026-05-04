/**
 * <environment_context> first-user-message block per §7.6.11 position 7.i.
 *
 * Rendered as a `user`-role message prepended to conversation history so the
 * model knows its cwd, shell, date, network enablement, and a lightweight
 * top-level workspace listing BEFORE the real task instruction arrives.
 *
 * Without this block the model has no orientation — real failures observed
 * in TB2 smoke: a task whose repo lived at `/app/personal-site/` produced
 * `fatal: not a git repository` because the model assumed cwd was the repo
 * root. The environment_context tells it where it is and what's adjacent.
 *
 * Kept provider-agnostic. Both OpenAI and Anthropic receive an identical
 * `<environment_context>...</environment_context>` fenced block.
 */

import { readdir, stat } from "node:fs/promises";
import * as path from "node:path";

export interface EnvironmentContextInputs {
  /** Absolute workspace root (from CLI `--workspace`). */
  workspace: string;
  /** Preferred shell. Default "bash". */
  shell?: string;
  /** Resolved at call time; defaults to `new Date().toISOString()`. */
  nowIso?: string;
  /** Whether network is enabled per preset. */
  networkEnabled: boolean;
  /** Whether the run is benchmark-mode. */
  benchmarkMode: boolean;
  /** Preset id (e.g. `tb2-gpt54`). */
  presetId: string;
  /** Allowed HTTP domains (summarized). Optional. */
  allowedDomains?: readonly string[];
  /**
   * Optional task text, used only to derive terse search hints. The task is
   * still sent as its own user message; we do not render it wholesale here.
   */
  taskText?: string;
  /** If set, include this many top-level workspace entries (default 40). */
  topLevelLimit?: number;
  /**
   * Optional §M3 prediction-phase summary. When present, the block appends
   * a `prediction:` section so the model gets early hints about task
   * category, multimodal need, risk, likely languages/frameworks.
   */
  prediction?: {
    taskCategory: string;
    multimodalNeeded: boolean;
    riskProfile: "low" | "medium" | "high";
    likelyLanguages?: readonly string[];
    likelyFrameworks?: readonly string[];
    keyFiles?: readonly string[];
  };
  /** Optional §M3 repo-map summary (languages + file count). */
  repoSummary?: {
    totalFiles: number;
    totalBytes: number;
    languageCounts: Record<string, number>;
    testFrameworks?: readonly string[];
    buildSystems?: readonly string[];
    packageManagers?: readonly string[];
  };
}

/**
 * Synchronously assemble the environment_context body as a single string.
 * The caller wraps it in a user-role message.
 */
export async function renderEnvironmentContext(inputs: EnvironmentContextInputs): Promise<string> {
  const limit = inputs.topLevelLimit ?? 40;
  const listing = await listTopLevel(inputs.workspace, limit, inputs.benchmarkMode);
  const now = inputs.nowIso ?? new Date().toISOString();
  const shell = inputs.shell ?? "bash";

  const lines: string[] = ["<environment_context>"];
  lines.push(`cwd: ${inputs.workspace}`);
  lines.push(`shell: ${shell}`);
  lines.push(`date: ${now}`);
  lines.push(`preset: ${inputs.presetId}`);
  lines.push(`benchmark_mode: ${inputs.benchmarkMode ? "true" : "false"}`);
  lines.push(`network_enabled: ${inputs.networkEnabled ? "true" : "false"}`);
  if (inputs.allowedDomains && inputs.allowedDomains.length > 0) {
    const shown = inputs.allowedDomains.slice(0, 8).join(", ");
    const more =
      inputs.allowedDomains.length > 8 ? ` (+${inputs.allowedDomains.length - 8} more)` : "";
    lines.push(`allowed_domains: ${shown}${more}`);
  }
  lines.push("");
  lines.push(`workspace top-level (${listing.length} entries, up to ${limit}):`);
  if (listing.length === 0) {
    lines.push("  (workspace is empty or unreadable)");
  } else {
    for (const entry of listing) {
      lines.push(`  ${entry.kind === "dir" ? "d" : "f"} ${entry.name}`);
    }
  }
  if (inputs.repoSummary) {
    const r = inputs.repoSummary;
    const topLangs = Object.entries(r.languageCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([l, c]) => `${l}=${c}`)
      .join(", ");
    lines.push("");
    lines.push(`repo_map: ${r.totalFiles} files, languages [${topLangs || "n/a"}]`);
    if (r.testFrameworks?.length) lines.push(`  test_frameworks: ${r.testFrameworks.join(", ")}`);
    if (r.buildSystems?.length) lines.push(`  build_systems: ${r.buildSystems.join(", ")}`);
    if (r.packageManagers?.length)
      lines.push(`  package_managers: ${r.packageManagers.join(", ")}`);
  }
  if (inputs.prediction) {
    const p = inputs.prediction;
    lines.push("");
    lines.push(
      `prediction: category=${p.taskCategory}, risk=${p.riskProfile}, multimodal=${p.multimodalNeeded}`,
    );
    if (p.likelyLanguages?.length) {
      lines.push(`  likely_languages: ${p.likelyLanguages.join(", ")}`);
    }
    if (p.likelyFrameworks?.length) {
      lines.push(`  likely_frameworks: ${p.likelyFrameworks.join(", ")}`);
    }
    if (p.keyFiles?.length) {
      lines.push(`  key_files: ${p.keyFiles.slice(0, 8).join(", ")}`);
    }
    const searchAdvice = deriveSearchAdvice(inputs.taskText, p, inputs.networkEnabled);
    if (searchAdvice) {
      lines.push(`  search_advice: ${searchAdvice.reason}`);
      for (const query of searchAdvice.queries) {
        lines.push(`    query_hint: ${query}`);
      }
    }
  }
  lines.push("");
  lines.push(
    "Your tools run against this workspace; relative paths resolve to cwd. Note the directory structure before running shell commands — nested repos and subdirectories are common.",
  );
  lines.push("</environment_context>");
  return lines.join("\n");
}

interface SearchAdvicePrediction {
  taskCategory: string;
  multimodalNeeded: boolean;
  riskProfile: "low" | "medium" | "high";
  likelyLanguages?: readonly string[];
  likelyFrameworks?: readonly string[];
  keyFiles?: readonly string[];
}

interface SearchAdvice {
  reason: string;
  queries: string[];
}

function deriveSearchAdvice(
  taskText: string | undefined,
  prediction: SearchAdvicePrediction,
  networkEnabled: boolean,
): SearchAdvice | null {
  if (!networkEnabled) return null;
  const text = `${taskText ?? ""} ${(prediction.likelyFrameworks ?? []).join(" ")}`.toLowerCase();
  const queries: string[] = [];

  if (/\b(?:mteb|embedding|leaderboard|retriev(?:e|al)|hugging ?face|hf)\b/.test(text)) {
    queries.push("MTEB official package source leaderboard results data files");
    queries.push("Hugging Face org Space dataset files model inference API official docs");
  }
  if (/\b(?:protein|pdb|rcsb|fpbase|fluorescent|assembly|antibody|uniprot)\b/.test(text)) {
    queries.push("RCSB PDB REST API official docs batch structure query");
    queries.push("FPbase API official docs fluorescent protein data");
  }
  if (/\b(?:rstan|pystan|stan)\b/.test(text)) {
    queries.push("RStan to PyStan migration official documentation examples");
  }
  if (/\bcaffe\b/.test(text)) {
    queries.push("Caffe CIFAR-10 training solver prototxt official examples");
  }
  if (/\b(?:qemu|alpine|virtual machine|vm|boot|ssh|windows)\b/.test(text)) {
    queries.push("QEMU user networking hostfwd SSH official documentation");
    queries.push("QEMU serial console nographic boot ISO monitor official documentation");
  }
  if (
    /\b(?:moderni[sz]e|migration|upgrade|current docs|latest docs|official docs|api docs)\b/.test(
      text,
    )
  ) {
    queries.push("official migration guide API documentation");
  }

  if (queries.length === 0) return null;
  return {
    reason:
      "external docs likely useful; start with one targeted web_search unless local files already answer it",
    queries: Array.from(new Set(queries)).slice(0, 3),
  };
}

interface TopLevelEntry {
  name: string;
  kind: "file" | "dir";
}

async function listTopLevel(
  workspace: string,
  limit: number,
  benchmarkMode: boolean,
): Promise<TopLevelEntry[]> {
  let names: string[];
  try {
    names = await readdir(workspace);
  } catch {
    return [];
  }
  names.sort((a, b) => a.localeCompare(b));
  // Exclude noisy hidden dirs + build outputs; if a task's critical content
  // is in one of these the agent can still list_tree into them explicitly.
  const hide = new Set([
    ".git",
    ".venv",
    "node_modules",
    "__pycache__",
    ".pytest_cache",
    "dist",
    "build",
    "target",
    ".DS_Store",
  ]);
  if (benchmarkMode) {
    hide.add("OPEN_APEX.md");
    hide.add("OPEN_APEX.override.md");
    hide.add("AGENTS.md");
    hide.add(".openapex");
  }
  const kept = names.filter((n) => !hide.has(n));
  const truncated = kept.slice(0, limit);
  const out: TopLevelEntry[] = [];
  for (const name of truncated) {
    try {
      const st = await stat(path.join(workspace, name));
      out.push({ name, kind: st.isDirectory() ? "dir" : "file" });
    } catch {
      out.push({ name, kind: "file" });
    }
  }
  return out;
}
