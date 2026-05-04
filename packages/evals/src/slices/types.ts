/**
 * TB2 slice-manifest types.
 * Locked per §7.6.5.
 */

export type TaskDifficulty = "easy" | "medium" | "hard";

export type TaskCategory =
  | "software-engineering"
  | "system-administration"
  | "scientific-computing"
  | "security"
  | "data-science"
  | "debugging"
  | "file-operations"
  | "mathematics"
  | "model-training"
  | "data-processing"
  | "machine-learning"
  | "games"
  | "personal-assistant"
  | "optimization"
  | "data-querying"
  | "video-processing";

export interface Tb2TaskEntry {
  id: string;
  difficulty: TaskDifficulty;
  category: TaskCategory;
  /** Harbor task.toml [verifier].timeout_sec. */
  verifier_timeout_sec: number;
}

export type SliceKind = "smoke" | "category" | "cross-cutting" | "full";

export interface SliceManifest {
  id: string;
  description: string;
  kind: SliceKind;
  /**
   * Pinned dataset commit (§0.6 frozen artifact + §7.6.5). Every manifest
   * records the commit it was authored against so later runs know exactly
   * which task definitions the slice refers to.
   */
  pinned_commit: string;
  task_ids: string[];
}
