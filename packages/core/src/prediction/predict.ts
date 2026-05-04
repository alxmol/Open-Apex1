/**
 * Prediction phase (§M3).
 *
 * Cheap, deterministic, offline: no model call. Runs on turn 1 to categorize
 * the task, extract key-file mentions, infer language/framework priors from
 * the instruction text, detect multimodal intent, and tag risk profile.
 *
 * Feeds the `<environment_context>` prompt block, the search-trigger policy,
 * and (in M4) the synthesis call's inputs.
 */

import type { Prediction, PredictionInputs, PredictionTrace, TaskCategory } from "./types.ts";

// ─── Category classifier ─────────────────────────────────────────────────────

interface CategoryRule {
  category: TaskCategory;
  keywords: ReadonlyArray<string | RegExp>;
  /** Multiplier applied when any keyword matches. */
  weight: number;
}

const CATEGORY_RULES: ReadonlyArray<CategoryRule> = Object.freeze([
  {
    category: "software_engineering",
    keywords: [
      "refactor",
      "implement",
      "add a feature",
      "unit test",
      "integration test",
      "bug",
      "regression",
      "function",
      "class",
      "module",
      "api endpoint",
      "rest api",
      "graphql",
      /\bpatch\b/,
    ],
    weight: 1.0,
  },
  {
    category: "system_administration",
    keywords: [
      "systemd",
      "nginx",
      "apache",
      "kubernetes",
      "docker",
      /\bmount\b/,
      "filesystem",
      "cron",
      "init script",
      "service",
      "firewall",
      /\biptables\b/,
      "qemu",
      "vm",
      "virtual machine",
    ],
    weight: 1.2,
  },
  {
    category: "scientific_computing",
    keywords: [
      "mcmc",
      "stan",
      "raman",
      "eigenvalue",
      "protein",
      "dna",
      "molecular",
      "simulation",
      "cython",
      "numerical",
    ],
    weight: 1.2,
  },
  {
    category: "security",
    keywords: [
      "vulnerab",
      "cve",
      "exploit",
      "cryptanaly",
      "password crack",
      "hash crack",
      "feal",
      "7z",
      "openssl",
      "certificate",
      "sanitize",
      "prompt injection",
    ],
    weight: 1.2,
  },
  {
    category: "data_science",
    keywords: [
      "dataframe",
      "pandas",
      "polars",
      /\bmteb\b/,
      "rstan",
      "pystan",
      "sam-cell",
      "embedding",
      "retrieval",
      "inference",
      /\bhf\b/,
      "huggingface",
    ],
    weight: 1.2,
  },
  {
    category: "debugging",
    keywords: [
      "stack trace",
      "traceback",
      "segfault",
      "coredump",
      "gdb",
      "lldb",
      "valgrind",
      "ocaml gc",
      "heap corruption",
      "hang",
      "reproduce",
    ],
    weight: 1.2,
  },
  {
    category: "file_operations",
    keywords: [
      "gcode",
      "extract archive",
      "unpack",
      /\belf\b/,
      "truncate",
      "large file",
      "rename files",
      "bulk rename",
      "wal file",
    ],
    weight: 1.2,
  },
  {
    category: "mathematics",
    keywords: [
      "differential",
      "linear algebra",
      "polynomial",
      "proof",
      "algebra",
      "coq",
      "isabelle",
      "relu",
    ],
    weight: 1.2,
  },
  {
    category: "model_training",
    keywords: [
      "train",
      "dataset",
      "epoch",
      "loss",
      "optimizer",
      "fasttext",
      "gpt2",
      "fine-tune",
      "finetune",
      "tokenizer",
    ],
    weight: 1.2,
  },
  {
    category: "data_processing",
    keywords: [
      "etl",
      "transform data",
      "merge csv",
      "log summary",
      "date range",
      "regex extract",
      "financial document",
    ],
    weight: 1.2,
  },
  {
    category: "machine_learning",
    keywords: [
      "caffe",
      "torch",
      "pytorch",
      "keras",
      "sklearn",
      "distribution",
      "inference",
      "batching",
    ],
    weight: 1.1,
  },
  {
    category: "games",
    keywords: ["chess", "corewars", "game", "doom", "pov-ray"],
    weight: 1.0,
  },
  {
    category: "personal_assistant",
    keywords: ["schedule", "calendar", "assistant", "reminders"],
    weight: 1.0,
  },
  {
    category: "optimization",
    keywords: ["portfolio", "optimize", "knapsack", "constraint", "linear program"],
    weight: 1.1,
  },
  {
    category: "data_querying",
    keywords: ["sparql", "sql query", "select from", "join", "group by"],
    weight: 1.0,
  },
  {
    category: "video_processing",
    keywords: ["video", "ffmpeg", "extract frames", "encode video", "decode video"],
    weight: 1.2,
  },
]);

// ─── Patterns + helpers ──────────────────────────────────────────────────────

const MULTIMODAL_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /\b[\w./-]+\.(?:png|jpe?g|gif|webp|bmp|tiff?)\b/i,
  /\b[\w./-]+\.pdf\b/i,
  /\bthis\s+image\b/i,
  /\bthe\s+pdf\b/i,
  /\bthis\s+screenshot\b/i,
  /\bdiagram\b/i,
  /\bchart\b/i,
]);

const HIGH_RISK_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /\brm\s+-[a-z]*r[a-z]*\s+(?:\/|~|\$HOME)/i,
  /\bforce[-\s]push\b/i,
  /\bhard\s+reset\b/i,
  /\bdrop\s+(?:table|database)\b/i,
  /\bproduction\b/i,
  /\bprod\s+(?:database|db|cluster)\b/i,
  /\bmain\s+branch\b/i,
  /\b(?:wipe|purge|destroy)\b/i,
  /\bdelete\s+(?:namespace|project|cluster)\b/i,
  /\bchown\s+-R\s+\//i,
]);

const MEDIUM_RISK_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /\bsudo\b/i,
  /\binstall\s+(?:globally|-g|--user)\b/i,
  /\bsystemctl\s+(?:start|stop|restart|enable|disable)\b/i,
  /\bdocker\s+(?:rm|rmi|prune)\b/i,
  /\bgit\s+push\b/i,
  /\bmigrate\b/i,
]);

const FILE_PATH_PATTERN =
  /(?:^|[\s`'"(])((?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:py|pyi|ts|tsx|js|jsx|mjs|cjs|rs|go|java|rb|sh|md|json|yaml|yml|toml|c|h|cc|cpp|hpp|ml|mli|rkt|scm))(?=[\s`'"):,.?!;]|$)/g;

const LANGUAGE_KEYWORDS: Record<string, string> = {
  python: "python",
  py: "python",
  typescript: "typescript",
  ts: "typescript",
  javascript: "javascript",
  js: "javascript",
  rust: "rust",
  golang: "go",
  "go ": "go",
  ruby: "ruby",
  java: "java",
  "c++": "cpp",
  "cpp ": "cpp",
  " c ": "c",
  ocaml: "ocaml",
  scheme: "scheme",
};

const FRAMEWORK_KEYWORDS: string[] = [
  "django",
  "flask",
  "fastapi",
  "rails",
  "react",
  "vue",
  "svelte",
  "angular",
  "next.js",
  "nextjs",
  "express",
  "fastify",
  "axum",
  "actix",
  "tokio",
  "pytorch",
  "mteb",
  "rstan",
  "pystan",
  "caffe",
  "tensorflow",
  "keras",
  "transformers",
  "huggingface",
  "sklearn",
  "pandas",
  "polars",
  "numpy",
  "scipy",
  "opencv",
  "ffmpeg",
  "qemu",
  "docker",
  "kubernetes",
  "nginx",
  "postgres",
  "postgresql",
  "redis",
  "sqlite",
  "mongo",
  "mongodb",
  "grpc",
  "protobuf",
];

export function predict(inputs: PredictionInputs): Prediction {
  const text = inputs.taskText;
  const lc = text.toLowerCase();

  // 1) Category scoring.
  const categoryScores: Array<{ category: TaskCategory; score: number }> = [];
  const matchedKeywords: string[] = [];
  for (const rule of CATEGORY_RULES) {
    let score = 0;
    for (const kw of rule.keywords) {
      if (typeof kw === "string") {
        if (lc.includes(kw)) {
          score += 1 * rule.weight;
          matchedKeywords.push(kw);
        }
      } else {
        if (kw.test(text)) {
          score += 1 * rule.weight;
          matchedKeywords.push(kw.source);
        }
      }
    }
    if (score > 0) categoryScores.push({ category: rule.category, score });
  }
  categoryScores.sort((a, b) => b.score - a.score);

  const taskCategory: TaskCategory = categoryScores[0]?.category ?? "other";

  // 2) Key files (paths mentioned verbatim).
  const keyFiles = Array.from(
    new Set(
      Array.from(text.matchAll(FILE_PATH_PATTERN))
        .map((m) => m[1])
        .filter((v): v is string => Boolean(v)),
    ),
  );

  // 3) Multimodal detection.
  let multimodalMatch: string | undefined;
  let multimodalNeeded = false;
  for (const re of MULTIMODAL_PATTERNS) {
    const m = text.match(re);
    if (m) {
      multimodalNeeded = true;
      multimodalMatch = m[0];
      break;
    }
  }

  // 4) Risk profile.
  let riskMatch: string | undefined;
  let riskProfile: "low" | "medium" | "high" = "low";
  for (const re of HIGH_RISK_PATTERNS) {
    const m = text.match(re);
    if (m) {
      riskProfile = "high";
      riskMatch = m[0];
      break;
    }
  }
  if (riskProfile === "low") {
    for (const re of MEDIUM_RISK_PATTERNS) {
      const m = text.match(re);
      if (m) {
        riskProfile = "medium";
        riskMatch = m[0];
        break;
      }
    }
  }

  // 5) Languages + frameworks.
  const likelyLanguages = detectLikelyLanguages(lc, inputs.repoLanguageCounts);
  const likelyFrameworks: string[] = [];
  for (const fw of FRAMEWORK_KEYWORDS) {
    if (lc.includes(fw) && !likelyFrameworks.includes(fw)) likelyFrameworks.push(fw);
  }

  // 6) Notes — small human-readable summary for telemetry.
  const noteParts: string[] = [];
  const topScore = categoryScores[0]?.score ?? 0;
  noteParts.push(`category=${taskCategory} (score ${topScore.toFixed(1)})`);
  if (keyFiles.length) noteParts.push(`keyFiles=${keyFiles.slice(0, 5).join(",")}`);
  if (multimodalNeeded) noteParts.push("multimodal");
  noteParts.push(`risk=${riskProfile}`);

  const trace: PredictionTrace = {
    categoryScores,
    matchedKeywords: [...new Set(matchedKeywords)].slice(0, 10),
  };
  if (multimodalMatch !== undefined) trace.multimodalMatch = multimodalMatch;
  if (riskMatch !== undefined) trace.riskMatch = riskMatch;

  return {
    taskCategory,
    keyFiles,
    multimodalNeeded,
    riskProfile,
    likelyLanguages,
    likelyFrameworks,
    notes: noteParts.join("; "),
    trace,
  };
}

function detectLikelyLanguages(lc: string, repoCounts?: Record<string, number>): string[] {
  const out = new Set<string>();
  for (const [keyword, language] of Object.entries(LANGUAGE_KEYWORDS)) {
    if (lc.includes(keyword)) out.add(language);
  }
  if (repoCounts) {
    const sorted = Object.entries(repoCounts).sort((a, b) => b[1] - a[1]);
    for (const [lang, count] of sorted.slice(0, 3)) {
      if (count > 0) out.add(lang);
    }
  }
  return [...out];
}
