/**
 * Selective search-trigger policy.
 *
 * Per §1.2 ("Search should be selective but proactive, not blanket-triggered").
 * Emits a boolean + reason string so the runtime can surface the decision in
 * telemetry and metrics (`search_trigger_frequency`,
 * `search_usefulness_rate`).
 *
 * Signals:
 *   - framework / version / library names the task mentions with uncertainty
 *     ("how does X work", "latest", "current version of …")
 *   - repeated same-signature failures (stderr tail similarity ≥ 0.85 twice)
 *   - explicit "search the web" / "look up" verbs in the task text
 *   - documentation requests ("docs for …", "reference for …")
 */

import type { PredictionResult } from "@open-apex/core";

export interface TriggerSignals {
  /** The raw task instruction. */
  taskText: string;
  /** Optional prediction (if already computed). */
  prediction?: PredictionResult;
  /** Stderr tails from recent tool failures — used for repeated-failure detection. */
  recentStderrTails?: string[];
  /** Preset aggressiveness. */
  aggressiveness: "off" | "selective" | "proactive" | "aggressive";
}

export interface TriggerDecision {
  trigger: boolean;
  reason: string;
  /** If `trigger === true`, suggested initial query (caller may refine). */
  suggestedQuery?: string;
}

const EXPLICIT_SEARCH_VERBS = [
  /\b(look\s+up|search\s+(?:the\s+)?web|web\s+search|google\b|documentation\s+for|docs?\s+for|official\s+docs?)\b/i,
  /\b(latest\s+(?:version|release)|current\s+version|release\s+notes)\b/i,
  /\b(how\s+(?:do|does|to)\s+.{3,60}?\s+(?:work|handle|implement))\b/i,
];

const FRAMEWORK_NAMES = [
  "django",
  "fastapi",
  "flask",
  "react",
  "vue",
  "svelte",
  "angular",
  "next.js",
  "nuxt",
  "gatsby",
  "pytorch",
  "tensorflow",
  "transformers",
  "huggingface",
  "sklearn",
  "pandas",
  "numpy",
  "opencv",
  "ffmpeg",
  "postgres",
  "postgresql",
  "mongodb",
  "redis",
  "sqlite",
  "nginx",
  "docker",
  "kubernetes",
  "kubectl",
  "terraform",
  "ansible",
  "rails",
  "express",
  "fastify",
  "axum",
  "actix",
  "tokio",
];

export function decideSearchTrigger(sig: TriggerSignals): TriggerDecision {
  if (sig.aggressiveness === "off") {
    return { trigger: false, reason: "aggressiveness=off" };
  }
  const text = sig.taskText;

  // Framework-name uncertainty hit ⇒ trigger with the more-specific reason
  // even at `selective`. Checked before generic explicit-verb matches so that
  // "how does FastAPI …" produces `framework_uncertainty:fastapi` rather than
  // the broad "how does …" match.
  const lc = text.toLowerCase();
  for (const fw of FRAMEWORK_NAMES) {
    if (lc.includes(fw)) {
      const hasUncertainty = /\bhow\b|\bwhat\b|\bwhy\b|\bdoes\b|\bdoesn[''`]?t\b|\?/i.test(text);
      if (hasUncertainty) {
        return {
          trigger: true,
          reason: `framework_uncertainty:${fw}`,
          suggestedQuery: `${fw} ${extractKeyVerbs(text)}`.trim(),
        };
      }
    }
  }

  // Explicit user-intent signals always trigger regardless of aggressiveness.
  for (const re of EXPLICIT_SEARCH_VERBS) {
    if (re.test(text)) {
      return {
        trigger: true,
        reason: `explicit_search_verb:${re.source.slice(0, 40)}`,
        suggestedQuery: extractExplicitQuery(text) ?? text.slice(0, 120),
      };
    }
  }

  // Repeated same-signature failure: two identical stderr tails within window.
  if (sig.recentStderrTails && sig.recentStderrTails.length >= 2) {
    const last = sig.recentStderrTails[sig.recentStderrTails.length - 1] ?? "";
    const prev = sig.recentStderrTails[sig.recentStderrTails.length - 2] ?? "";
    if (last && prev && similarity(last, prev) >= 0.85) {
      return {
        trigger: true,
        reason: "repeated_same_signature_failure",
        suggestedQuery: `${firstErrorLine(last)} site:stackoverflow.com`,
      };
    }
  }

  // Prediction-backed multimodal/framework hints trigger at proactive+.
  if (sig.aggressiveness === "proactive" || sig.aggressiveness === "aggressive") {
    if (
      sig.prediction &&
      (sig.prediction.likelyFrameworks.length > 0 || sig.prediction.likelyLanguages.length > 0)
    ) {
      return {
        trigger: true,
        reason: "proactive_prediction_hint",
        suggestedQuery: `${sig.prediction.likelyFrameworks.join(" ")} ${text.slice(0, 80)}`.trim(),
      };
    }
  }

  return { trigger: false, reason: "no_signal" };
}

function extractExplicitQuery(text: string): string | undefined {
  const m = text.match(/(?:look\s+up|search\s+for|docs?\s+for|how\s+(?:do|does|to))\s+(.{5,120})/i);
  return m?.[1]?.trim();
}

function extractKeyVerbs(text: string): string {
  const m = text.match(/\b(install|configure|run|debug|fix|build|deploy|train|serve)\b[^.?!]*/i);
  return (m?.[0] ?? "").slice(0, 80);
}

function firstErrorLine(stderrTail: string): string {
  const line =
    stderrTail.split("\n").find((l) => /(?:error|traceback|exception|failed)/i.test(l)) ??
    stderrTail.split("\n").find(Boolean) ??
    "";
  return line.slice(0, 120);
}

/** Cheap similarity: shared-token Jaccard over non-trivial tokens. */
export function similarity(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 && tb.size === 0) return 1;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

function tokenize(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9_]+/)
      .filter((t) => t.length > 2),
  );
}
