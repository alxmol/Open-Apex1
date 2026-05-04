/**
 * TB2 task inventory — all 89 tasks at commit
 *   69671fbaac6d67a7ef0dfec016cc38a64ef7a77c
 * Locked per §7.6.5.
 *
 * The counts per category match §6 Purpose: SE 26, sysadmin 9, sci-comp 8,
 * security 8, data-science 8, debugging 5, file-ops 5, math 4, model-training 4,
 * data-processing 4, machine-learning 3, games 1, personal-assistant 1,
 * optimization 1, data-querying 1, video-processing 1 — total 89.
 */

import type { Tb2TaskEntry } from "./types.ts";

export const TB2_DATASET_COMMIT = "69671fbaac6d67a7ef0dfec016cc38a64ef7a77c";

export const TB2_TASK_INVENTORY: readonly Tb2TaskEntry[] = Object.freeze([
  {
    id: "adaptive-rejection-sampler",
    difficulty: "medium",
    category: "scientific-computing",
    verifier_timeout_sec: 900,
  },
  {
    id: "bn-fit-modify",
    difficulty: "hard",
    category: "scientific-computing",
    verifier_timeout_sec: 3600,
  },
  {
    id: "break-filter-js-from-html",
    difficulty: "medium",
    category: "security",
    verifier_timeout_sec: 1200,
  },
  {
    id: "build-cython-ext",
    difficulty: "medium",
    category: "debugging",
    verifier_timeout_sec: 900,
  },
  {
    id: "build-pmars",
    difficulty: "medium",
    category: "software-engineering",
    verifier_timeout_sec: 900,
  },
  {
    id: "build-pov-ray",
    difficulty: "medium",
    category: "software-engineering",
    verifier_timeout_sec: 12000,
  },
  {
    id: "caffe-cifar-10",
    difficulty: "medium",
    category: "machine-learning",
    verifier_timeout_sec: 1200,
  },
  {
    id: "cancel-async-tasks",
    difficulty: "hard",
    category: "software-engineering",
    verifier_timeout_sec: 900,
  },
  { id: "chess-best-move", difficulty: "medium", category: "games", verifier_timeout_sec: 900 },
  {
    id: "circuit-fibsqrt",
    difficulty: "hard",
    category: "software-engineering",
    verifier_timeout_sec: 3600,
  },
  {
    id: "cobol-modernization",
    difficulty: "easy",
    category: "software-engineering",
    verifier_timeout_sec: 900,
  },
  {
    id: "code-from-image",
    difficulty: "medium",
    category: "software-engineering",
    verifier_timeout_sec: 1200,
  },
  {
    id: "compile-compcert",
    difficulty: "medium",
    category: "system-administration",
    verifier_timeout_sec: 2400,
  },
  {
    id: "configure-git-webserver",
    difficulty: "hard",
    category: "system-administration",
    verifier_timeout_sec: 900,
  },
  {
    id: "constraints-scheduling",
    difficulty: "medium",
    category: "personal-assistant",
    verifier_timeout_sec: 1200,
  },
  {
    id: "count-dataset-tokens",
    difficulty: "medium",
    category: "model-training",
    verifier_timeout_sec: 900,
  },
  { id: "crack-7z-hash", difficulty: "medium", category: "security", verifier_timeout_sec: 900 },
  {
    id: "custom-memory-heap-crash",
    difficulty: "medium",
    category: "debugging",
    verifier_timeout_sec: 1800,
  },
  {
    id: "db-wal-recovery",
    difficulty: "medium",
    category: "file-operations",
    verifier_timeout_sec: 900,
  },
  {
    id: "distribution-search",
    difficulty: "medium",
    category: "machine-learning",
    verifier_timeout_sec: 3600,
  },
  {
    id: "dna-assembly",
    difficulty: "hard",
    category: "scientific-computing",
    verifier_timeout_sec: 1800,
  },
  {
    id: "dna-insert",
    difficulty: "medium",
    category: "scientific-computing",
    verifier_timeout_sec: 1800,
  },
  {
    id: "extract-elf",
    difficulty: "medium",
    category: "file-operations",
    verifier_timeout_sec: 900,
  },
  {
    id: "extract-moves-from-video",
    difficulty: "hard",
    category: "file-operations",
    verifier_timeout_sec: 1800,
  },
  {
    id: "feal-differential-cryptanalysis",
    difficulty: "hard",
    category: "mathematics",
    verifier_timeout_sec: 1800,
  },
  {
    id: "feal-linear-cryptanalysis",
    difficulty: "hard",
    category: "mathematics",
    verifier_timeout_sec: 1800,
  },
  {
    id: "filter-js-from-html",
    difficulty: "medium",
    category: "security",
    verifier_timeout_sec: 900,
  },
  {
    id: "financial-document-processor",
    difficulty: "medium",
    category: "data-processing",
    verifier_timeout_sec: 1200,
  },
  {
    id: "fix-code-vulnerability",
    difficulty: "hard",
    category: "security",
    verifier_timeout_sec: 900,
  },
  {
    id: "fix-git",
    difficulty: "easy",
    category: "software-engineering",
    verifier_timeout_sec: 900,
  },
  {
    id: "fix-ocaml-gc",
    difficulty: "hard",
    category: "software-engineering",
    verifier_timeout_sec: 3600,
  },
  {
    id: "gcode-to-text",
    difficulty: "medium",
    category: "file-operations",
    verifier_timeout_sec: 900,
  },
  {
    id: "git-leak-recovery",
    difficulty: "medium",
    category: "software-engineering",
    verifier_timeout_sec: 900,
  },
  {
    id: "git-multibranch",
    difficulty: "medium",
    category: "system-administration",
    verifier_timeout_sec: 900,
  },
  {
    id: "gpt2-codegolf",
    difficulty: "hard",
    category: "software-engineering",
    verifier_timeout_sec: 900,
  },
  {
    id: "headless-terminal",
    difficulty: "medium",
    category: "software-engineering",
    verifier_timeout_sec: 900,
  },
  {
    id: "hf-model-inference",
    difficulty: "medium",
    category: "data-science",
    verifier_timeout_sec: 900,
  },
  {
    id: "install-windows-3.11",
    difficulty: "hard",
    category: "system-administration",
    verifier_timeout_sec: 3600,
  },
  {
    id: "kv-store-grpc",
    difficulty: "medium",
    category: "software-engineering",
    verifier_timeout_sec: 900,
  },
  {
    id: "large-scale-text-editing",
    difficulty: "medium",
    category: "file-operations",
    verifier_timeout_sec: 1200,
  },
  {
    id: "largest-eigenval",
    difficulty: "medium",
    category: "mathematics",
    verifier_timeout_sec: 900,
  },
  {
    id: "llm-inference-batching-scheduler",
    difficulty: "hard",
    category: "machine-learning",
    verifier_timeout_sec: 1800,
  },
  {
    id: "log-summary-date-ranges",
    difficulty: "medium",
    category: "data-processing",
    verifier_timeout_sec: 900,
  },
  {
    id: "mailman",
    difficulty: "medium",
    category: "system-administration",
    verifier_timeout_sec: 1800,
  },
  {
    id: "make-doom-for-mips",
    difficulty: "hard",
    category: "software-engineering",
    verifier_timeout_sec: 900,
  },
  {
    id: "make-mips-interpreter",
    difficulty: "hard",
    category: "software-engineering",
    verifier_timeout_sec: 1800,
  },
  {
    id: "mcmc-sampling-stan",
    difficulty: "hard",
    category: "data-science",
    verifier_timeout_sec: 1800,
  },
  {
    id: "merge-diff-arc-agi-task",
    difficulty: "medium",
    category: "debugging",
    verifier_timeout_sec: 900,
  },
  {
    id: "model-extraction-relu-logits",
    difficulty: "hard",
    category: "mathematics",
    verifier_timeout_sec: 900,
  },
  {
    id: "modernize-scientific-stack",
    difficulty: "medium",
    category: "scientific-computing",
    verifier_timeout_sec: 600,
  },
  {
    id: "mteb-leaderboard",
    difficulty: "medium",
    category: "data-science",
    verifier_timeout_sec: 3600,
  },
  {
    id: "mteb-retrieve",
    difficulty: "medium",
    category: "data-science",
    verifier_timeout_sec: 1800,
  },
  {
    id: "multi-source-data-merger",
    difficulty: "medium",
    category: "data-processing",
    verifier_timeout_sec: 900,
  },
  {
    id: "nginx-request-logging",
    difficulty: "medium",
    category: "system-administration",
    verifier_timeout_sec: 900,
  },
  {
    id: "openssl-selfsigned-cert",
    difficulty: "medium",
    category: "security",
    verifier_timeout_sec: 900,
  },
  { id: "overfull-hbox", difficulty: "easy", category: "debugging", verifier_timeout_sec: 360 },
  { id: "password-recovery", difficulty: "hard", category: "security", verifier_timeout_sec: 900 },
  {
    id: "path-tracing",
    difficulty: "hard",
    category: "software-engineering",
    verifier_timeout_sec: 1800,
  },
  {
    id: "path-tracing-reverse",
    difficulty: "hard",
    category: "software-engineering",
    verifier_timeout_sec: 1800,
  },
  {
    id: "polyglot-c-py",
    difficulty: "medium",
    category: "software-engineering",
    verifier_timeout_sec: 900,
  },
  {
    id: "polyglot-rust-c",
    difficulty: "hard",
    category: "software-engineering",
    verifier_timeout_sec: 900,
  },
  {
    id: "portfolio-optimization",
    difficulty: "medium",
    category: "optimization",
    verifier_timeout_sec: 3600,
  },
  {
    id: "protein-assembly",
    difficulty: "hard",
    category: "scientific-computing",
    verifier_timeout_sec: 1800,
  },
  {
    id: "prove-plus-comm",
    difficulty: "easy",
    category: "software-engineering",
    verifier_timeout_sec: 900,
  },
  {
    id: "pypi-server",
    difficulty: "medium",
    category: "software-engineering",
    verifier_timeout_sec: 900,
  },
  {
    id: "pytorch-model-cli",
    difficulty: "medium",
    category: "model-training",
    verifier_timeout_sec: 900,
  },
  {
    id: "pytorch-model-recovery",
    difficulty: "medium",
    category: "model-training",
    verifier_timeout_sec: 900,
  },
  {
    id: "qemu-alpine-ssh",
    difficulty: "medium",
    category: "system-administration",
    verifier_timeout_sec: 900,
  },
  {
    id: "qemu-startup",
    difficulty: "medium",
    category: "system-administration",
    verifier_timeout_sec: 900,
  },
  {
    id: "query-optimize",
    difficulty: "medium",
    category: "data-science",
    verifier_timeout_sec: 900,
  },
  {
    id: "raman-fitting",
    difficulty: "medium",
    category: "scientific-computing",
    verifier_timeout_sec: 900,
  },
  {
    id: "regex-chess",
    difficulty: "hard",
    category: "software-engineering",
    verifier_timeout_sec: 3600,
  },
  { id: "regex-log", difficulty: "medium", category: "data-processing", verifier_timeout_sec: 900 },
  {
    id: "reshard-c4-data",
    difficulty: "medium",
    category: "data-science",
    verifier_timeout_sec: 3600,
  },
  {
    id: "rstan-to-pystan",
    difficulty: "medium",
    category: "data-science",
    verifier_timeout_sec: 1800,
  },
  { id: "sam-cell-seg", difficulty: "hard", category: "data-science", verifier_timeout_sec: 7200 },
  {
    id: "sanitize-git-repo",
    difficulty: "medium",
    category: "security",
    verifier_timeout_sec: 900,
  },
  {
    id: "schemelike-metacircular-eval",
    difficulty: "medium",
    category: "software-engineering",
    verifier_timeout_sec: 2400,
  },
  {
    id: "sparql-university",
    difficulty: "hard",
    category: "data-querying",
    verifier_timeout_sec: 900,
  },
  {
    id: "sqlite-db-truncate",
    difficulty: "medium",
    category: "debugging",
    verifier_timeout_sec: 900,
  },
  {
    id: "sqlite-with-gcov",
    difficulty: "medium",
    category: "system-administration",
    verifier_timeout_sec: 900,
  },
  {
    id: "torch-pipeline-parallelism",
    difficulty: "hard",
    category: "software-engineering",
    verifier_timeout_sec: 900,
  },
  {
    id: "torch-tensor-parallelism",
    difficulty: "hard",
    category: "software-engineering",
    verifier_timeout_sec: 900,
  },
  {
    id: "train-fasttext",
    difficulty: "hard",
    category: "model-training",
    verifier_timeout_sec: 3600,
  },
  {
    id: "tune-mjcf",
    difficulty: "medium",
    category: "scientific-computing",
    verifier_timeout_sec: 900,
  },
  {
    id: "video-processing",
    difficulty: "hard",
    category: "video-processing",
    verifier_timeout_sec: 3600,
  },
  {
    id: "vulnerable-secret",
    difficulty: "medium",
    category: "security",
    verifier_timeout_sec: 900,
  },
  {
    id: "winning-avg-corewars",
    difficulty: "medium",
    category: "software-engineering",
    verifier_timeout_sec: 3600,
  },
  {
    id: "write-compressor",
    difficulty: "hard",
    category: "software-engineering",
    verifier_timeout_sec: 900,
  },
]);

export function getTaskEntry(id: string): Tb2TaskEntry | undefined {
  return TB2_TASK_INVENTORY.find((t) => t.id === id);
}

export function tasksByCategory(category: Tb2TaskEntry["category"]): Tb2TaskEntry[] {
  return TB2_TASK_INVENTORY.filter((t) => t.category === category);
}

export function tasksByDifficulty(difficulty: Tb2TaskEntry["difficulty"]): Tb2TaskEntry[] {
  return TB2_TASK_INVENTORY.filter((t) => t.difficulty === difficulty);
}
