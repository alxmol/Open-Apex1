/**
 * Checkpoint storage contracts.
 * Locked per §3.4.5 and §7.6.7.
 *
 * Implementation: shadow git repository with detached worktree.
 *   Host:      $OPEN_APEX_HOME/checkpoints/<workspace-hash>/
 *   Benchmark: /var/open-apex/checkpoints/<task-id>/ (never host-mounted)
 */

export type CheckpointReason =
  | "pre_tool_batch"
  | "pre_exploratory_executor"
  | "pre_restore"
  | "user_named"
  | "post_validation_pass"
  | "patch_recovery_write_file"
  | "user_cancel";

export interface Checkpoint {
  commitSha: string;
  /** $STORE/manifest/<sha>.json */
  manifestPath: string;
  reason: CheckpointReason;
  sessionId: string;
  stepId: number;
  /** ISO 8601 */
  createdAt: string;
  bytesAdded: number;
  wallMs: number;
  /** User-visible name if `reason === "user_named"`. */
  name?: string;
}

export interface CheckpointMetadata extends Checkpoint {
  /** True if the manifest verified clean on last `verify`. */
  verified?: boolean;
}

export interface VerifyReport {
  commitSha: string;
  verified: boolean;
  /** Files whose on-disk hash doesn't match the manifest. */
  mismatches: string[];
  /** Workspace files not in the manifest and not in excluded_roots. */
  untrackedInWorkspace: string[];
  /** Files in manifest but missing from disk. */
  missingFromWorkspace: string[];
}

export interface RestoreReport {
  target: string;
  preRestoreCommit: string;
  verified: boolean;
  matched: number;
  extra: string[];
  missing: string[];
  modeMismatch: string[];
  submoduleDivergence: Array<{
    path: string;
    expected: string;
    actual: string;
  }>;
  /** Capabilities-not-reverted table from §7.6.7 for UX. */
  capabilitiesNotReverted: string[];
}

export interface CheckpointStore {
  init(workspace: string): Promise<CheckpointHandle>;
  save(
    reason: CheckpointReason,
    sessionId: string,
    stepId: number,
    opts?: { name?: string },
  ): Promise<Checkpoint>;
  restore(commitSha: string): Promise<RestoreReport>;
  list(sessionId?: string): Promise<CheckpointMetadata[]>;
  verify(commitSha: string): Promise<VerifyReport>;
}

export interface CheckpointHandle {
  workspace: string;
  workspaceHash: string;
  storePath: string;
  /** True if shadow repo was already present. */
  existed: boolean;
  /**
   * §7.6.7 "checkpoints_disabled_low_disk" — when statvfs preflight shows
   * free space < 256 MB, checkpointing is disabled for that workspace.
   */
  disabledReason?: "low_disk" | "protected_path" | "bare_repo";
}

/** §7.6.7 manifest JSON schema. */
export interface CheckpointManifest {
  schema_version: 1;
  commit_sha: string;
  workspace: string;
  workspace_realpath: string;
  /** ISO 8601 */
  created_at: string;
  reason: CheckpointReason;
  session_id: string;
  step_id: number;
  parent_commit: string;
  tree: Array<{
    path: string;
    mode: "100644" | "100755" | "120000" | "160000";
    size: number;
    sha256: string;
    git_blob_sha: string;
    symlink_target?: string;
  }>;
  empty_dirs: string[];
  submodules: Array<{
    path: string;
    head_sha: string;
    url?: string;
  }>;
  excluded_roots: string[];
  host: {
    os: "linux" | "darwin" | "windows";
    git_version: string;
    supports_symlinks: boolean;
    case_sensitive_fs: boolean;
  };
  stats: {
    file_count: number;
    total_bytes: number;
    bytes_added_since_parent: number;
    snapshot_wall_ms: number;
  };
}
