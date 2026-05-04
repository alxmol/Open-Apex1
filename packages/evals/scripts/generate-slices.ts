#!/usr/bin/env bun
/**
 * Regenerate packages/evals/slices/tb2-slice-*.json from the TB2_TASK_INVENTORY.
 * Run whenever TB2_TASK_INVENTORY is updated (pinned-commit bump).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";

import {
  TB2_DATASET_COMMIT,
  TB2_TASK_INVENTORY,
  tasksByCategory,
  tasksByDifficulty,
} from "../src/slices/tb2-task-inventory.ts";
import type { SliceManifest, TaskCategory } from "../src/slices/types.ts";

const SLICES_DIR = new URL("../slices/", import.meta.url).pathname;
mkdirSync(SLICES_DIR, { recursive: true });

const CATEGORIES: readonly TaskCategory[] = [
  "software-engineering",
  "system-administration",
  "security",
  "data-science",
  "scientific-computing",
  "debugging",
  "file-operations",
  "mathematics",
  "model-training",
  "data-processing",
  "machine-learning",
  "games",
  "personal-assistant",
  "optimization",
  "data-querying",
  "video-processing",
];

function writeManifest(manifest: SliceManifest): void {
  const p = path.join(SLICES_DIR, `${manifest.id}.json`);
  writeFileSync(p, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log(`  ${manifest.id}.json (${manifest.task_ids.length} tasks)`);
}

console.log("Generating TB2 slice manifests from TB2_TASK_INVENTORY...");

// Category slices.
for (const cat of CATEGORIES) {
  const tasks = tasksByCategory(cat);
  if (tasks.length === 0) continue;
  writeManifest({
    id: `tb2-slice-${cat}`,
    description: `All ${cat} tasks on terminal-bench@2.0 (${tasks.length} tasks) per §7.6.5.`,
    kind: "category",
    pinned_commit: TB2_DATASET_COMMIT,
    task_ids: tasks.map((t) => t.id).sort(),
  });
}

// Cross-cutting slices.
const longRunning = TB2_TASK_INVENTORY.filter((t) => t.verifier_timeout_sec >= 1800);
writeManifest({
  id: "tb2-slice-long-running",
  description: `Tasks with verifier timeout ≥ 1800s (${longRunning.length} tasks). Cross-cutting — long-horizon stability stressor.`,
  kind: "cross-cutting",
  pinned_commit: TB2_DATASET_COMMIT,
  task_ids: longRunning.map((t) => t.id).sort(),
});

const hardOnly = tasksByDifficulty("hard");
writeManifest({
  id: "tb2-slice-hard-only",
  description: `All 'hard' difficulty tasks (${hardOnly.length} tasks). Cross-cutting — upper-bound signal.`,
  kind: "cross-cutting",
  pinned_commit: TB2_DATASET_COMMIT,
  task_ids: hardOnly.map((t) => t.id).sort(),
});

// Search-heavy slice — curated per §7.6.5.
const searchHeavyIds = [
  "hf-model-inference",
  "mteb-leaderboard",
  "mteb-retrieve",
  "caffe-cifar-10",
  "rstan-to-pystan",
  "protein-assembly",
  "modernize-scientific-stack",
  "install-windows-3.11",
  "qemu-alpine-ssh",
  "qemu-startup",
];
writeManifest({
  id: "tb2-slice-search-heavy",
  description: `Tasks known to require external docs (${searchHeavyIds.length} tasks). Curated per §7.6.5.`,
  kind: "cross-cutting",
  pinned_commit: TB2_DATASET_COMMIT,
  task_ids: [...searchHeavyIds].sort(),
});

// Full 89-task slice.
writeManifest({
  id: "tb2-full-89",
  description: `Complete terminal-bench@2.0 dataset (${TB2_TASK_INVENTORY.length} tasks) at pinned commit.`,
  kind: "full",
  pinned_commit: TB2_DATASET_COMMIT,
  task_ids: TB2_TASK_INVENTORY.map((t) => t.id).sort(),
});

console.log(`Done. Slices regenerated under ${SLICES_DIR}`);
