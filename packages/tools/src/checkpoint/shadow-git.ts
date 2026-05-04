/**
 * Minimal shadow-git CheckpointStore (M1).
 *
 * Locked per §7.6.7 — M1 scope (user directive):
 *   ✔ git init with exact §7.6.7 config
 *   ✔ save: git add -A + commit --allow-empty --no-verify
 *   ✔ restore: pre-restore self-checkpoint + git clean -fdx + git reset --hard
 *   ✔ protected-path guard ($HOME, /, /tmp, /var, user top-level dirs)
 *   ✔ bare-repo guard
 *   ✔ env sanitation (strip GIT_* and set only shadow-specific vars)
 *
 *   ✘ manifest hash-verify (full RestoreReport)   → M2
 *   ✘ LFS patterns                                 → M2
 *   ✘ submodule walking                            → M2
 *   ✘ empty-dir detection                          → M2
 *   ✘ symlink-mode preservation on restore        → M2
 *   ✘ statvfs preflight + checkpoints_disabled_low_disk → M2
 */

import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  lstatSync,
  statfsSync,
} from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import * as path from "node:path";

import type {
  Checkpoint,
  CheckpointHandle,
  CheckpointMetadata,
  CheckpointReason,
  CheckpointStore,
  RestoreReport,
  VerifyReport,
} from "@open-apex/core";

// §7.6.7: protected paths refuse shadow-repo init.
const PROTECTED_PATHS = new Set<string>([
  "/",
  "/tmp",
  "/var",
  "/etc",
  "/usr",
  "/opt",
  "/Applications",
  "/Library",
  "/System",
  "/home",
  "/root",
  "/Users",
]);

/**
 * Per-git-command hard timeout. None of our legitimate shadow-git
 * operations should ever take this long — `git init`, `git config`,
 * `git add -A` on a typical TB2 workspace all run in <1 s. When we hit
 * the timeout the Bun subprocess is almost certainly stuck (observed on
 * gpt5.4/fix-git: 900 s silent hang with zero events, consistent with a
 * Bun.spawn("git", ...) that never reaped). Timeout → kill → throw,
 * letting checkpoint_save's graceful-degradation path surface the error
 * to the agent instead of blocking the whole run.
 */
const GIT_CMD_TIMEOUT_MS = 30_000;
/**
 * Hard deadline on waiting for `proc.exited` after we SIGKILL a git
 * subprocess. Mirrors run_shell's reap deadline — bash/git children can
 * hold pipes open past SIGKILL, so we cap the wait regardless.
 */
const GIT_REAP_DEADLINE_MS = 5_000;

// Env vars to strip when spawning shadow git (§7.6.7 env sanitation).
const STRIP_ENV = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CEILING_DIRECTORIES",
  "GIT_TEMPLATE_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
];

export interface ShadowGitOptions {
  /** Absolute path to the workspace under version control. */
  workspace: string;
  /** Root for the shadow git store. Defaults to $OPEN_APEX_HOME/checkpoints. */
  storeRoot?: string;
  /**
   * Minimum free-disk floor before checkpointing is disabled for this
   * store. Default 256 MB per §7.6.7 line 4338. Set smaller in tests.
   */
  minFreeDiskBytes?: number;
}

export interface CheckpointManifestTreeEntry {
  path: string;
  /** `100644` regular file, `100755` executable, `120000` symlink. */
  mode: string;
  size: number;
  sha256: string;
  /** Symlink target (when mode is 120000). */
  symlinkTarget?: string;
  /** True if the file is an LFS-tracked placeholder (filter=lfs). */
  lfs?: boolean;
  /**
   * When sha256 was skipped to bound manifest cost, why. Values:
   *   - `"file_too_large"`: single file exceeded MANIFEST_MAX_FILE_BYTES
   *   - `"budget_exhausted"`: aggregate sha256 budget exceeded (§Fix C.1)
   *   - `"lfs_tracked"`: file matched a .gitattributes LFS pattern
   */
  hash_skipped_reason?: "file_too_large" | "budget_exhausted" | "lfs_tracked";
}

/**
 * Full §7.6.7 checkpoint manifest. Emitted on every save; the restore
 * path uses it for hash-verification + mismatch rollback.
 */
export interface CheckpointManifest {
  schema_version: 1;
  commit_sha: string;
  workspace: string;
  workspace_realpath: string;
  created_at: string;
  reason: CheckpointReason;
  session_id: string;
  step_id: number;
  parent_commit: string;
  tree: CheckpointManifestTreeEntry[];
  empty_dirs: string[];
  submodules: Array<{ path: string; head_sha: string }>;
  excluded_roots: string[];
  host: {
    os: string;
    git_version: string;
    supports_symlinks: boolean;
    case_sensitive_fs: boolean;
  };
  stats: {
    file_count: number;
    total_bytes: number;
    bytes_added_since_parent: number;
    snapshot_wall_ms: number;
    /**
     * True when the manifest tree is incomplete: either the aggregate
     * sha256 budget (MANIFEST_MAX_TOTAL_BYTES) was hit during
     * buildManifestTree, or a per-file cap forced LFS-placeholder
     * recording. Consumers should treat entries with `hash_skipped_reason`
     * as unverified (restore skips hash check for these paths).
     */
    partial: boolean;
    /** Total bytes actually sha256-hashed in this manifest. */
    hashed_bytes: number;
  };
}

/** Back-compat alias used by M1 callers; identical schema now. */
export type MinimalCheckpointManifest = CheckpointManifest;

/**
 * Per \u00a77.6.7 line 4391: the empty-dir walk can exceed the 5-second
 * budget on pathological workspaces. When it does, we skip populating
 * `empty_dirs` and emit a `checkpoint_slow` telemetry marker via the
 * console (a proper TelemetrySink hookup lives at a higher layer).
 */
const EMPTY_DIR_WALK_BUDGET_MS = 5_000;
/** §7.6.7 line 4338: disable checkpointing when free disk < this. */
const DEFAULT_MIN_FREE_DISK_BYTES = 256 * 1024 * 1024;
/** Cap per-file sha256 hashing so pathological large files don't stall. */
const MANIFEST_MAX_FILE_BYTES = 50 * 1024 * 1024;
/**
 * Aggregate sha256 budget across the entire manifest walk. Once exceeded,
 * remaining files are recorded as LFS-style placeholders (mode + size only,
 * no sha256). Observed on tb2-12 sonnet4.6/build-cython-ext: the
 * pyknotid source tree drove Bun to segfault during / right after the
 * manifest hash loop. 50 MB is small enough to avoid pathological
 * workloads but large enough to fully hash typical workspaces.
 */
const MANIFEST_MAX_TOTAL_BYTES = 50 * 1024 * 1024;
/**
 * Hard timeout for the save-runner child process (§Fix C.2). Must be
 * greater than the worst-case in-process save (~35s on tb2-12
 * build-cython-ext). 180s gives headroom; the child gets SIGKILL'd past
 * this and the parent surfaces a graceful-degradation error.
 */
const CHECKPOINT_CHILD_TIMEOUT_MS = 180_000;
const CHILD_STREAM_READ_DEADLINE_MS = 5_000;

/**
 * §Fix C.2 env-flag check. Enable via `OPEN_APEX_CHECKPOINT_ISOLATION=1`
 * in benchmark mode. Tests and chat mode leave it unset for fast in-process
 * saves. The env check is dynamic so tests can flip it between cases.
 */
function shouldIsolateCheckpointSave(): boolean {
  return process.env.OPEN_APEX_CHECKPOINT_ISOLATION === "1";
}

/**
 * Resolve the save-runner entry script. Installed-agent packaging ships a
 * bundled helper next to the CLI and points OPEN_APEX_SAVE_RUNNER_PATH at it;
 * source/test runs fall back to the TypeScript sibling.
 */
function saveRunnerEntryPath(): string {
  const configured = process.env.OPEN_APEX_SAVE_RUNNER_PATH;
  if (configured && configured.trim().length > 0) return configured;
  return new URL("./save-runner.ts", import.meta.url).pathname;
}

/**
 * Read a ReadableStream to string with a cap. Used for child stdout/stderr
 * where we don't want to memory-balloon on runaway output. 256 KB is
 * enough for a checkpoint JSON (~10-50 KB) plus stderr diagnostics.
 */
async function readCappedStream(
  stream: ReadableStream<Uint8Array> | number | undefined,
  deadlineMs = CHILD_STREAM_READ_DEADLINE_MS,
): Promise<string> {
  const MAX = 256 * 1024;
  if (!stream || typeof stream === "number") return "";
  const reader = (stream as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const deadline = Symbol("deadline");
  const read = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      buf += decoder.decode(value, { stream: true });
      if (total > MAX) {
        buf = buf.slice(0, MAX) + "\n... [truncated]";
        break;
      }
    }
    return buf;
  })();
  try {
    const winner = await Promise.race([
      read,
      new Promise<typeof deadline>((resolve) => {
        timer = setTimeout(() => resolve(deadline), deadlineMs);
      }),
    ]);
    if (winner === deadline) {
      try {
        await reader.cancel("deadline");
      } catch {
        /* stream may already be closing */
      }
      return `${buf}\n... [child output read deadline exceeded]`;
    }
    return winner;
  } finally {
    if (timer) clearTimeout(timer);
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

/** Test hook: override the child-process spawn for save-runner isolation. */
let shadowGitSaveChildSpawnOverride: ((argv: string[]) => ShadowGitSpawnedProc) | null = null;
export function __setShadowGitSaveChildSpawnForTest(
  fn: (argv: string[]) => ShadowGitSpawnedProc,
): void {
  shadowGitSaveChildSpawnOverride = fn;
}
export function __resetShadowGitSaveChildSpawnForTest(): void {
  shadowGitSaveChildSpawnOverride = null;
}

/**
 * M1 shadow-git checkpoint store. Single-workspace: one instance per
 * (workspace, storeRoot) pair. Not designed for concurrent multi-process
 * use; M5 wires the session-level advisory lock (§3.4.5 flock).
 */
export class ShadowGitCheckpointStore implements CheckpointStore {
  private readonly workspace: string;
  private readonly storeRoot: string;
  private readonly workspaceHash: string;
  private readonly storePath: string;
  private readonly gitDir: string;
  private readonly manifestDir: string;
  private readonly sessionsDir: string;
  private readonly minFreeDiskBytes: number;
  private initialized = false;
  private disabled: CheckpointHandle["disabledReason"] | undefined;

  constructor(opts: ShadowGitOptions) {
    this.workspace = path.resolve(opts.workspace);
    this.storeRoot = opts.storeRoot ?? defaultStoreRoot();
    this.workspaceHash = hashWorkspace(this.workspace);
    this.storePath = path.join(this.storeRoot, this.workspaceHash);
    this.gitDir = path.join(this.storePath, ".git");
    this.manifestDir = path.join(this.storePath, "manifest");
    this.sessionsDir = path.join(this.storePath, "sessions");
    this.minFreeDiskBytes = opts.minFreeDiskBytes ?? DEFAULT_MIN_FREE_DISK_BYTES;
  }

  async init(_workspace?: string): Promise<CheckpointHandle> {
    // §7.6.7 guards.
    const realWs = this.workspace;
    if (isProtectedPath(realWs)) {
      this.disabled = "protected_path";
      return {
        workspace: this.workspace,
        workspaceHash: this.workspaceHash,
        storePath: this.storePath,
        existed: false,
        disabledReason: "protected_path",
      };
    }
    if (isBareRepo(realWs)) {
      this.disabled = "bare_repo";
      return {
        workspace: this.workspace,
        workspaceHash: this.workspaceHash,
        storePath: this.storePath,
        existed: false,
        disabledReason: "bare_repo",
      };
    }
    // §7.6.7 line 4338: statvfs preflight. Skip in tests by passing a
    // smaller minFreeDiskBytes; the helper handles unsupported platforms
    // silently (returns a large value so the check always passes).
    const freeBytes = statFreeBytes(this.storeRoot);
    if (freeBytes !== null && freeBytes < this.minFreeDiskBytes) {
      this.disabled = "low_disk";
      console.error(
        `[open-apex/shadow-git] checkpoints_disabled_low_disk: free=${freeBytes} min=${this.minFreeDiskBytes} store=${this.storeRoot}`,
      );
      return {
        workspace: this.workspace,
        workspaceHash: this.workspaceHash,
        storePath: this.storePath,
        existed: false,
        disabledReason: "low_disk",
      };
    }

    const existed = existsSync(this.gitDir);
    if (!existed) {
      mkdirSync(this.storePath, { recursive: true });
      mkdirSync(this.manifestDir, { recursive: true });
      mkdirSync(this.sessionsDir, { recursive: true });
      // git init with shadow-specific template (§7.6.7 init sequence).
      await this.runGit(["init", "--template="]);
      // Write `.git/config` directly instead of invoking `git config` 13
      // times. Each subprocess spawn was bounded by GIT_CMD_TIMEOUT_MS but
      // any one of them hanging tripped the whole init (observed on tb2-
      // smoke sonnet4.6/hf-model-inference: `git config commit.gpgSign
      // false` stalled 30s at Bun.spawn and aborted the run before the
      // first model turn). One spawn is 13x fewer failure points, and the
      // resulting config is a strict superset of what `git init` writes
      // by default.
      const configBody = [
        "[core]",
        `\tworktree = ${this.workspace}`,
        "\tbare = false",
        "\tsymlinks = true",
        "\tautocrlf = false",
        "\tfileMode = true",
        "\tlongpaths = true",
        "\tquotepath = false",
        "[commit]",
        "\tgpgSign = false",
        "[tag]",
        "\tgpgSign = false",
        "[gc]",
        "\tauto = 0",
        "[user]",
        "\tname = Open-Apex",
        "\temail = checkpoint@open-apex.local",
        "",
      ].join("\n");
      await Bun.write(path.join(this.gitDir, "config"), configBody);
      // Nested .git inside the workspace should be excluded so we don't
      // descend. LFS-tracked paths are also appended on every save.
      const excludeLines = [
        ".DS_Store",
        "node_modules/",
        "dist/",
        "build/",
        ".venv/",
        "venv/",
        "target/",
        "__pycache__/",
        ...this.collectLfsPatternsFromAttributes(),
        "",
      ];
      const exclude = path.join(this.gitDir, "info", "exclude");
      mkdirSync(path.dirname(exclude), { recursive: true });
      await Bun.write(exclude, excludeLines.join("\n"));
      // Write workspace-meta.json on first init.
      await Bun.write(
        path.join(this.storePath, "workspace-meta.json"),
        JSON.stringify(
          {
            schema_version: 1,
            workspace_realpath: this.workspace,
            created_at: new Date().toISOString(),
          },
          null,
          2,
        ) + "\n",
      );
    } else {
      mkdirSync(this.sessionsDir, { recursive: true });
    }
    this.initialized = true;
    this.disabled = undefined;
    return {
      workspace: this.workspace,
      workspaceHash: this.workspaceHash,
      storePath: this.storePath,
      existed,
    };
  }

  async save(
    reason: CheckpointReason,
    sessionId: string,
    stepId: number,
    opts?: { name?: string },
  ): Promise<Checkpoint> {
    if (!this.initialized) await this.init(this.workspace);
    if (this.disabled) {
      throw new ShadowGitError(
        `checkpoints disabled: ${this.disabled}`,
        ["save"],
        -1,
        `checkpoints_disabled=${this.disabled}`,
      );
    }
    // §Fix C.2 — opt-in child-process isolation. When the env flag is set,
    // run save() in an isolated Bun child so that a Bun SIGSEGV (observed
    // on tb2-12 sonnet4.6/build-cython-ext during the manifest walk)
    // doesn't kill the parent agent. Parent catches non-zero exit and
    // throws ShadowGitError, which checkpoint_save.ts translates into a
    // structured ToolExecuteResult (graceful degradation).
    if (shouldIsolateCheckpointSave()) {
      return this.saveInChild(reason, sessionId, stepId, opts);
    }
    return this.saveInProcess(reason, sessionId, stepId, opts);
  }

  private async saveInProcess(
    reason: CheckpointReason,
    sessionId: string,
    stepId: number,
    opts?: { name?: string },
  ): Promise<Checkpoint> {
    const started = Date.now();
    const parentSha = await this.safeHead();

    // §7.6.7 save sequence:
    //   1. discover nested .git submodules; exclude each; record HEAD.
    const submodules = await this.discoverSubmodules();

    // git add -A --ignore-errors captures tracked + untracked respecting excludes.
    await this.runGit(["add", "-A", "--ignore-errors", "."]);
    const nameTag = opts?.name ? ` name=${opts.name}` : "";
    const message = `checkpoint:${reason}${nameTag} session=${sessionId} step=${stepId}`;
    await this.runGit(["commit", "--allow-empty", "--no-verify", "--quiet", "-m", message]);
    const commitSha = (await this.runGit(["rev-parse", "HEAD"])).stdout.trim();

    // §7.6.7 line 4391: emit empty_dirs, but bail and mark `checkpoint_slow`
    // if the walk exceeds the 5s budget.
    const emptyDirs = this.walkEmptyDirs(this.workspace, EMPTY_DIR_WALK_BUDGET_MS);

    // Per-file manifest tree. Stream each file through sha256; skip files
    // larger than MANIFEST_MAX_FILE_BYTES to bound latency, and cap the
    // aggregate hashed bytes at MANIFEST_MAX_TOTAL_BYTES (§Fix C.1).
    const treeStarted = Date.now();
    const treeResult = await this.buildManifestTree();
    const tree = treeResult.entries;
    const treeWallMs = Date.now() - treeStarted;

    const wallMs = Date.now() - started;
    const totalBytes = tree.reduce((a, t) => a + (t.size || 0), 0);

    const manifest: CheckpointManifest = {
      schema_version: 1,
      commit_sha: commitSha,
      workspace: this.workspace,
      workspace_realpath: this.workspace,
      created_at: new Date().toISOString(),
      reason,
      session_id: sessionId,
      step_id: stepId,
      parent_commit: parentSha,
      tree,
      empty_dirs: emptyDirs,
      submodules,
      excluded_roots: [
        "node_modules/",
        "dist/",
        "build/",
        ".venv/",
        "venv/",
        "target/",
        "__pycache__/",
      ],
      host: {
        os: process.platform,
        git_version: await this.getGitVersion(),
        supports_symlinks: process.platform !== "win32",
        case_sensitive_fs: process.platform !== "darwin" && process.platform !== "win32",
      },
      stats: {
        file_count: tree.length,
        total_bytes: totalBytes,
        bytes_added_since_parent: 0, // M5 fills via diff --numstat
        snapshot_wall_ms: treeWallMs,
        partial: treeResult.partial,
        hashed_bytes: treeResult.hashedBytes,
      },
    };
    const manifestPath = path.join(this.manifestDir, `${commitSha}.json`);
    await Bun.write(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

    // Append session JSONL entry.
    try {
      const line =
        JSON.stringify({ t: new Date().toISOString(), commit: commitSha, reason, step: stepId }) +
        "\n";
      appendFileSync(path.join(this.sessionsDir, `${sessionId}.jsonl`), line);
    } catch {
      /* best effort */
    }

    const out: Checkpoint = {
      commitSha,
      manifestPath,
      reason,
      sessionId,
      stepId,
      createdAt: manifest.created_at,
      bytesAdded: 0,
      wallMs,
    };
    if (opts?.name !== undefined) out.name = opts.name;
    return out;
  }

  async restore(commitSha: string): Promise<RestoreReport> {
    if (!this.initialized) await this.init(this.workspace);
    if (this.disabled) {
      throw new ShadowGitError(
        `restore unavailable: checkpoints disabled (${this.disabled})`,
        ["restore"],
        -1,
        `checkpoints_disabled=${this.disabled}`,
      );
    }
    // §7.6.7: self-checkpoint first so the restore is itself undoable.
    const preRestore = await this.save("pre_restore", "restore", 0);
    // Verify target exists.
    const exists = await this.commitExists(commitSha);
    if (!exists) {
      return {
        target: commitSha,
        preRestoreCommit: preRestore.commitSha,
        verified: false,
        matched: 0,
        extra: [],
        missing: [],
        modeMismatch: [],
        submoduleDivergence: [],
        capabilitiesNotReverted: capabilitiesNotReverted(),
      };
    }
    // Wipe untracked + reset hard to target.
    const nestedGitExcludes = this.discoverNestedGitExcludes();
    await this.runGit(["clean", "-f", "-d", "-x", ...nestedGitExcludes.flatMap((p) => ["-e", p])]);
    await this.runGit(["reset", "--hard", commitSha]);

    // §7.6.7 line 4403: hash-verify every entry in manifest.tree; on any
    // mismatch, roll back to pre_restore.
    const manifest = this.loadManifest(commitSha);
    const report: RestoreReport = {
      target: commitSha,
      preRestoreCommit: preRestore.commitSha,
      verified: true,
      matched: 0,
      extra: [],
      missing: [],
      modeMismatch: [],
      submoduleDivergence: [],
      capabilitiesNotReverted: capabilitiesNotReverted(),
    };
    if (manifest) {
      const verified = await this.verifyManifest(manifest);
      report.matched = verified.matched;
      report.missing = verified.missing;
      report.modeMismatch = verified.mismatches;
      report.extra = verified.extra;
      if (report.missing.length > 0 || report.modeMismatch.length > 0 || report.extra.length > 0) {
        // Rollback to pre_restore and mark unverified.
        try {
          await this.runGit(["reset", "--hard", preRestore.commitSha]);
        } catch {
          /* best effort */
        }
        report.verified = false;
      }
    }
    return report;
  }

  async list(sessionId?: string): Promise<CheckpointMetadata[]> {
    if (!this.initialized) await this.init(this.workspace);
    const log = await this.runGit(["log", "--pretty=format:%H%x01%s%x01%aI", "HEAD"]);
    const entries: CheckpointMetadata[] = [];
    for (const line of log.stdout.split("\n")) {
      if (!line) continue;
      const [sha, msg, iso] = line.split("\x01");
      if (!sha || !msg || !iso) continue;
      const reason = parseReason(msg);
      if (!reason) continue;
      const parsedSession = parseSession(msg);
      if (sessionId && parsedSession !== sessionId) continue;
      const meta: CheckpointMetadata = {
        commitSha: sha,
        manifestPath: path.join(this.manifestDir, `${sha}.json`),
        reason,
        sessionId: parsedSession ?? "",
        stepId: parseStep(msg) ?? 0,
        createdAt: iso,
        bytesAdded: 0,
        wallMs: 0,
      };
      const parsedName = parseName(msg);
      if (parsedName !== undefined) meta.name = parsedName;
      entries.push(meta);
    }
    return entries;
  }

  async verify(commitSha: string): Promise<VerifyReport> {
    const exists = await this.commitExists(commitSha);
    if (!exists) {
      return {
        commitSha,
        verified: false,
        mismatches: [],
        untrackedInWorkspace: [],
        missingFromWorkspace: [],
      };
    }
    const manifest = this.loadManifest(commitSha);
    if (!manifest) {
      return {
        commitSha,
        verified: false,
        mismatches: ["manifest_missing"],
        untrackedInWorkspace: [],
        missingFromWorkspace: [],
      };
    }
    const report = await this.verifyManifest(manifest);
    return {
      commitSha,
      verified:
        report.missing.length === 0 && report.mismatches.length === 0 && report.extra.length === 0,
      mismatches: report.mismatches,
      untrackedInWorkspace: report.extra,
      missingFromWorkspace: report.missing,
    };
  }

  private async verifyManifest(manifest: CheckpointManifest): Promise<{
    matched: number;
    missing: string[];
    mismatches: string[];
    extra: string[];
  }> {
    const missing: string[] = [];
    const mismatches: string[] = [];
    let matched = 0;
    const expected = new Set(manifest.tree.map((entry) => entry.path));

    for (const entry of manifest.tree) {
      const abs = path.join(this.workspace, entry.path);
      if (!existsSync(abs)) {
        missing.push(entry.path);
        continue;
      }
      try {
        const ls = lstatSync(abs);
        const actualMode = modeFromStat(ls.mode);
        if (ls.isSymbolicLink()) {
          const target = readlinkSync(abs);
          if (entry.mode !== "120000" || entry.symlinkTarget !== target) {
            mismatches.push(entry.path);
            continue;
          }
          matched++;
          continue;
        }
        if (entry.mode !== actualMode) {
          mismatches.push(entry.path);
          continue;
        }
      } catch {
        missing.push(entry.path);
        continue;
      }
      if (entry.hash_skipped_reason !== undefined || entry.sha256 === "") {
        matched++;
        continue;
      }
      const actualSha = sha256File(abs);
      if (actualSha !== entry.sha256) mismatches.push(entry.path);
      else matched++;
    }

    const current = await this.buildManifestTree();
    const extra = current.entries
      .map((entry) => entry.path)
      .filter((p) => !expected.has(p) && !isExcludedManifestPath(p, manifest.excluded_roots));

    return { matched, missing, mismatches, extra };
  }

  // ─── Internals ─────────────────────────────────────────────────────────────

  private async runGit(args: string[]): Promise<{ stdout: string; stderr: string }> {
    const env = sanitizedEnv(this.gitDir, this.workspace, this.storePath);
    const spawnFn = shadowGitSpawnOverride ?? (Bun.spawn as unknown as ShadowGitSpawnFn);
    const proc = spawnFn(["git", ...args], {
      cwd: this.workspace,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    // Race the exit against our per-command timeout. On timeout we kill
    // the git subprocess and race THAT against a reap deadline so the
    // overall call is bounded even when Bun.spawn's exit-tracking is
    // broken.
    let timedOut = false;
    await Promise.race([
      (async () => {
        await proc.exited;
      })(),
      new Promise<void>((r) =>
        setTimeout(() => {
          timedOut = true;
          r();
        }, GIT_CMD_TIMEOUT_MS),
      ),
    ]);
    if (timedOut && proc.exitCode === null) {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* best effort */
      }
      await Promise.race([
        (async () => {
          await proc.exited;
        })(),
        new Promise<void>((r) => setTimeout(() => r(), GIT_REAP_DEADLINE_MS)),
      ]);
      throw new ShadowGitError(
        `git ${args.join(" ")} timed out after ${GIT_CMD_TIMEOUT_MS}ms`,
        args,
        -1,
        `git command timed out after ${GIT_CMD_TIMEOUT_MS}ms`,
      );
    }

    // Response accepts a BodyInit; `proc.stdout`/`proc.stderr` narrow to
    // `ReadableStream | number | undefined` on our test-friendly interface.
    // In practice both are ReadableStreams here; the spawn override never
    // returns number (that's only for "inherit" / "ignore" spawn modes we
    // don't use).
    const stdout = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
    const stderr = await new Response(proc.stderr as ReadableStream<Uint8Array>).text();
    if (proc.exitCode !== 0) {
      throw new ShadowGitError(
        `git ${args.join(" ")} failed (exit ${proc.exitCode}): ${stderr.trim()}`,
        args,
        proc.exitCode ?? -1,
        stderr,
      );
    }
    return { stdout, stderr };
  }

  private async safeHead(): Promise<string> {
    try {
      const r = await this.runGit(["rev-parse", "HEAD"]);
      return r.stdout.trim();
    } catch {
      return "";
    }
  }

  private async commitExists(sha: string): Promise<boolean> {
    try {
      await this.runGit(["cat-file", "-e", `${sha}^{commit}`]);
      return true;
    } catch {
      return false;
    }
  }

  private async getGitVersion(): Promise<string> {
    try {
      const r = await this.runGit(["--version"]);
      return r.stdout.trim();
    } catch {
      return "";
    }
  }

  /**
   * §Fix C.2 — run save() in an isolated Bun child process. The helper at
   * `./save-runner.ts` imports the store, runs .save(), and prints the
   * resulting Checkpoint JSON to stdout. A SIGSEGV in the child leaves
   * the parent process (the agent turn-loop) intact.
   *
   * Test hook: `shadowGitSaveChildSpawnOverride` lets us inject a mock
   * child to simulate crashes without spawning a real Bun subprocess.
   */
  private async saveInChild(
    reason: CheckpointReason,
    sessionId: string,
    stepId: number,
    opts?: { name?: string },
  ): Promise<Checkpoint> {
    const argv = [
      process.execPath,
      "run",
      saveRunnerEntryPath(),
      "--workspace",
      this.workspace,
      "--store",
      this.storeRoot,
      "--reason",
      reason,
      "--session",
      sessionId,
      "--step",
      String(stepId),
      "--min-free-bytes",
      String(this.minFreeDiskBytes),
      ...(opts?.name ? ["--name", opts.name] : []),
    ];
    const timeoutMs = CHECKPOINT_CHILD_TIMEOUT_MS;
    const proc = shadowGitSaveChildSpawnOverride
      ? shadowGitSaveChildSpawnOverride(argv)
      : (Bun.spawn(argv, {
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, OPEN_APEX_CHECKPOINT_ISOLATION: "0" },
        }) as unknown as ShadowGitSpawnedProc);
    const timeout = setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, timeoutMs);
    let exitCode: number | null;
    let killedByTimeout = false;
    try {
      const exitDeadline = Symbol("checkpoint_child_timeout");
      const ec = await Promise.race([
        proc.exited,
        new Promise<typeof exitDeadline>((resolve) =>
          setTimeout(() => resolve(exitDeadline), timeoutMs + GIT_REAP_DEADLINE_MS),
        ),
      ]);
      if (ec === exitDeadline) {
        killedByTimeout = true;
        try {
          proc.kill("SIGKILL");
        } catch {
          /* already gone or not killable */
        }
        exitCode = -1;
      } else {
        exitCode = typeof ec === "number" ? ec : (proc.exitCode ?? -1);
      }
    } finally {
      clearTimeout(timeout);
    }
    const stdout = await readCappedStream(proc.stdout);
    const stderr = await readCappedStream(proc.stderr);
    if (exitCode === 0) {
      try {
        return JSON.parse(stdout.trim()) as Checkpoint;
      } catch (err) {
        throw new ShadowGitError(
          `save-runner child exited 0 but stdout was not a Checkpoint JSON: ${(err as Error).message}`,
          ["save-runner"],
          0,
          stderr,
        );
      }
    }
    // Non-zero: surface a ShadowGitError with a clear message. The tool
    // (checkpoint_save.ts) translates this into a structured
    // ToolExecuteResult so the agent loop continues.
    const signalHint =
      exitCode === 139
        ? " (SIGSEGV — child crashed, parent survives)"
        : exitCode === -1 || killedByTimeout
          ? " (likely killed by timeout)"
          : "";
    throw new ShadowGitError(
      `checkpoint_save child exited ${exitCode}${signalHint}: ${stderr.trim() || "(no stderr)"}`,
      ["save-runner"],
      exitCode ?? -1,
      stderr,
    );
  }

  /**
   * Walk workspace (one level shy of `excluded_roots`) and sha256-hash every
   * file. Returns a manifest tree with mode, size, sha256, and symlink
   * targets, plus a `partial` flag and the total bytes actually hashed.
   *
   * Skip conditions:
   *   - LFS-tracked files (excluded at init time via .git/info/exclude)
   *   - files > MANIFEST_MAX_FILE_BYTES (single-file cap)
   *   - once aggregate hashed bytes >= MANIFEST_MAX_TOTAL_BYTES: remaining
   *     files are recorded as LFS-style placeholders without a sha256
   *     (§Fix C.1 — prevents Bun SIGSEGV on very large workspaces like
   *     tb2-12 build-cython-ext).
   */
  private async buildManifestTree(): Promise<{
    entries: CheckpointManifestTreeEntry[];
    partial: boolean;
    hashedBytes: number;
  }> {
    const out: CheckpointManifestTreeEntry[] = [];
    let hashedBytes = 0;
    let budgetHit = false;
    const excludeDirs = new Set([
      ".git",
      "node_modules",
      "dist",
      "build",
      ".venv",
      "venv",
      "target",
      "__pycache__",
      ".DS_Store",
    ]);
    const walk = async (abs: string, rel: string): Promise<void> => {
      let entries: string[];
      try {
        entries = (await readdir(abs, { withFileTypes: true })).map((d) => d.name);
      } catch {
        return;
      }
      for (const name of entries) {
        if (excludeDirs.has(name)) continue;
        const childAbs = path.join(abs, name);
        const childRel = rel ? `${rel}/${name}` : name;
        let ls;
        try {
          ls = lstatSync(childAbs);
        } catch {
          continue;
        }
        if (ls.isSymbolicLink()) {
          let target = "";
          try {
            target = readlinkSync(childAbs);
          } catch {
            /* ignore */
          }
          out.push({
            path: childRel,
            mode: "120000",
            size: ls.size,
            sha256: sha256String(target),
            symlinkTarget: target,
          });
          continue;
        }
        if (ls.isDirectory()) {
          if (isNestedGitWorktree(childAbs, childRel)) continue;
          await walk(childAbs, childRel);
          continue;
        }
        if (!ls.isFile()) continue;
        if (ls.size > MANIFEST_MAX_FILE_BYTES) {
          // Per-file cap: skip sha256 but keep the path in the manifest.
          out.push({
            path: childRel,
            mode: modeFromStat(ls.mode),
            size: ls.size,
            sha256: "",
            lfs: true,
            hash_skipped_reason: "file_too_large",
          });
          continue;
        }
        // Aggregate byte-budget: once we'd exceed MANIFEST_MAX_TOTAL_BYTES,
        // switch every remaining regular file to LFS-placeholder mode.
        if (budgetHit || hashedBytes + ls.size > MANIFEST_MAX_TOTAL_BYTES) {
          if (!budgetHit) {
            budgetHit = true;
            console.error(
              `[open-apex/shadow-git] checkpoint_manifest_truncated: hashed ${hashedBytes} bytes ` +
                `before exceeding ${MANIFEST_MAX_TOTAL_BYTES}; remaining files recorded as ` +
                `placeholders (sha256=""). tb2-12 Fix C.1.`,
            );
          }
          out.push({
            path: childRel,
            mode: modeFromStat(ls.mode),
            size: ls.size,
            sha256: "",
            lfs: true,
            hash_skipped_reason: "budget_exhausted",
          });
          continue;
        }
        const sha = sha256File(childAbs);
        hashedBytes += ls.size;
        out.push({
          path: childRel,
          mode: modeFromStat(ls.mode),
          size: ls.size,
          sha256: sha,
        });
      }
    };
    await walk(this.workspace, "");
    return { entries: out, partial: budgetHit, hashedBytes };
  }

  /** §7.6.7 line 4391: find empty directories, bail on timeout budget. */
  private walkEmptyDirs(root: string, budgetMs: number): string[] {
    const out: string[] = [];
    const start = Date.now();
    const walk = (abs: string, rel: string): boolean => {
      if (Date.now() - start > budgetMs) return false;
      let entries: string[];
      try {
        const { readdirSync } = require("node:fs") as typeof import("node:fs");
        entries = readdirSync(abs);
      } catch {
        return true;
      }
      const filtered = entries.filter(
        (n) => !n.startsWith(".") && n !== "node_modules" && n !== "dist" && n !== "build",
      );
      if (filtered.length === 0 && rel !== "") out.push(`${rel}/`);
      for (const name of filtered) {
        const childAbs = path.join(abs, name);
        let st;
        try {
          st = lstatSync(childAbs);
        } catch {
          continue;
        }
        if (st.isDirectory() && !st.isSymbolicLink()) {
          const childRel = rel ? `${rel}/${name}` : name;
          if (!walk(childAbs, childRel)) return false;
        }
      }
      return true;
    };
    const finished = walk(root, "");
    if (!finished) {
      console.error(
        `[open-apex/shadow-git] checkpoint_slow: empty_dirs walk exceeded ${budgetMs}ms; skipping`,
      );
      return [];
    }
    return out;
  }

  /** Discover nested `.git` directories and return {path, head_sha} pairs. */
  private async discoverSubmodules(): Promise<Array<{ path: string; head_sha: string }>> {
    // M2 shortcut: use `git -C workspace submodule status` as a cheap probe,
    // falling back to a simple recursive .git/HEAD scan when no config.
    const out: Array<{ path: string; head_sha: string }> = [];
    try {
      const r = await this.runGit(["submodule", "status", "--recursive"]);
      for (const ln of r.stdout.split("\n")) {
        const m = /^[\s+-]*([0-9a-f]{40})\s+(\S+)/.exec(ln);
        if (m) out.push({ path: m[2]!, head_sha: m[1]! });
      }
    } catch {
      /* no submodule config — fall back to heuristic scan */
    }
    for (const rel of this.discoverNestedGitRoots()) {
      if (out.some((s) => s.path === rel)) continue;
      const head = readNestedGitHead(path.join(this.workspace, rel));
      out.push({ path: rel, head_sha: head });
    }
    return out;
  }

  private discoverNestedGitExcludes(): string[] {
    return this.discoverNestedGitRoots().map((rel) => `${rel}/`);
  }

  private discoverNestedGitRoots(): string[] {
    const out: string[] = [];
    const skip = new Set([
      "node_modules",
      "dist",
      "build",
      ".venv",
      "venv",
      "target",
      "__pycache__",
    ]);
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const walk = (abs: string, rel: string): void => {
      let names: string[];
      try {
        names = readdirSync(abs);
      } catch {
        return;
      }
      if (rel !== "" && names.includes(".git")) {
        out.push(rel.split(path.sep).join("/"));
        return;
      }
      for (const name of names) {
        if (name === ".git" || skip.has(name)) continue;
        const childAbs = path.join(abs, name);
        let st;
        try {
          st = lstatSync(childAbs);
        } catch {
          continue;
        }
        if (st.isDirectory() && !st.isSymbolicLink()) {
          walk(childAbs, rel ? path.join(rel, name) : name);
        }
      }
    };
    walk(this.workspace, "");
    return out.sort();
  }

  /**
   * Read `.gitattributes` to discover LFS-tracked patterns and return them
   * so init can append to `.git/info/exclude`. Parser is intentionally
   * narrow: lines shaped `PATTERN filter=lfs ...`.
   */
  private collectLfsPatternsFromAttributes(): string[] {
    const attrs = path.join(this.workspace, ".gitattributes");
    if (!existsSync(attrs)) return [];
    try {
      const body = readFileSync(attrs, "utf8");
      const out: string[] = [];
      for (const ln of body.split("\n")) {
        const m = /^\s*(\S+)\s+.*\bfilter=lfs\b/.exec(ln);
        if (m) out.push(m[1]!);
      }
      return out;
    } catch {
      return [];
    }
  }

  /** Load + parse a manifest. Returns null when missing/malformed. */
  private loadManifest(commitSha: string): CheckpointManifest | null {
    const p = path.join(this.manifestDir, `${commitSha}.json`);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, "utf8")) as CheckpointManifest;
    } catch {
      return null;
    }
  }
}

export class ShadowGitError extends Error {
  constructor(
    message: string,
    readonly argv: string[],
    readonly exitCode: number,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "ShadowGitError";
  }
}

/** Shape we rely on from `Bun.spawn` — small enough for tests to mock. */
export interface ShadowGitSpawnedProc {
  exited: Promise<number | void>;
  exitCode: number | null;
  stdout: ReadableStream<Uint8Array> | number | undefined;
  stderr: ReadableStream<Uint8Array> | number | undefined;
  kill(signal?: string | number): void;
}
export type ShadowGitSpawnFn = (
  argv: string[],
  opts: {
    cwd: string;
    env: Record<string, string>;
    stdout: "pipe";
    stderr: "pipe";
  },
) => ShadowGitSpawnedProc;

let shadowGitSpawnOverride: ShadowGitSpawnFn | undefined;
export function __setShadowGitSpawnForTest(fn: ShadowGitSpawnFn): void {
  shadowGitSpawnOverride = fn;
}
export function __resetShadowGitSpawnForTest(): void {
  shadowGitSpawnOverride = undefined;
}
export const __GIT_CMD_TIMEOUT_MS_FOR_TEST = GIT_CMD_TIMEOUT_MS;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function defaultStoreRoot(): string {
  const env = process.env.OPEN_APEX_HOME;
  if (env) return path.join(env, "checkpoints");
  const home = process.env.HOME ?? homedir();
  if (home) return path.join(home, ".local", "share", "open-apex", "checkpoints");
  return path.join(tmpdir(), `open-apex-${process.getuid?.() ?? 0}`, "checkpoints");
}

function hashWorkspace(ws: string): string {
  return createHash("sha256").update(ws).digest("hex").slice(0, 16);
}

function isProtectedPath(p: string): boolean {
  const abs = path.resolve(p);
  if (PROTECTED_PATHS.has(abs)) return true;
  // Exact match for $HOME.
  const home = process.env.HOME ?? homedir();
  if (home && path.resolve(home) === abs) return true;
  // Exact match for top-level user dirs (~/Desktop, ~/Documents, ~/Downloads).
  if (home) {
    for (const sub of ["Desktop", "Documents", "Downloads"]) {
      if (path.join(home, sub) === abs) return true;
    }
  }
  return false;
}

function isBareRepo(ws: string): boolean {
  const bareCfg = path.join(ws, "HEAD");
  // A bare repo has HEAD + objects/ at the top level without a .git subdir.
  if (!existsSync(bareCfg)) return false;
  try {
    const st = statSync(path.join(ws, "objects"));
    if (st.isDirectory() && !existsSync(path.join(ws, ".git"))) return true;
  } catch {
    /* not bare */
  }
  return false;
}

function sanitizedEnv(
  gitDir: string,
  workspace: string,
  storePath: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (STRIP_ENV.includes(k)) continue;
    if (v !== undefined) env[k] = v;
  }
  env.GIT_DIR = gitDir;
  env.GIT_WORK_TREE = workspace;
  env.HOME = storePath;
  env.XDG_CONFIG_HOME = path.join(storePath, "xdg");
  return env;
}

function capabilitiesNotReverted(): string[] {
  // §7.6.7 capabilities-not-reverted table (abbreviated for M1; full list
  // surfaced in the UX at M2).
  return [
    "package installs (apt/brew/pip/npm-global) not rolled back",
    "running processes and background jobs not rolled back",
    "database mutations outside the workspace not rolled back",
    "network side effects (API calls, webhook deliveries, uploads) not rolled back",
    "shell env state (exported variables, cd) not rolled back — each tool call gets a fresh env",
  ];
}

function parseReason(msg: string): CheckpointReason | null {
  const m = /^checkpoint:([a-z_]+)/.exec(msg);
  if (!m) return null;
  return m[1] as CheckpointReason;
}

function parseSession(msg: string): string | null {
  const m = /session=(\S+)/.exec(msg);
  return m ? (m[1] ?? null) : null;
}

function parseName(msg: string): string | undefined {
  const m = /\bname=(.*?)\s+session=/.exec(msg);
  const raw = m?.[1]?.trim();
  return raw ? raw : undefined;
}

function parseStep(msg: string): number | null {
  const m = /step=(\d+)/.exec(msg);
  if (!m) return null;
  return Number.parseInt(m[1]!, 10);
}

function sha256File(abs: string): string {
  const h = createHash("sha256");
  h.update(readFileSync(abs));
  return h.digest("hex");
}

function sha256String(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function isExcludedManifestPath(rel: string, excludedRoots: string[]): boolean {
  return excludedRoots.some((root) => rel === root.replace(/\/$/, "") || rel.startsWith(root));
}

function isNestedGitWorktree(abs: string, rel: string): boolean {
  return rel !== "" && existsSync(path.join(abs, ".git"));
}

function readNestedGitHead(abs: string): string {
  try {
    const gitPath = path.join(abs, ".git");
    const st = lstatSync(gitPath);
    if (st.isDirectory()) {
      const head = readFileSync(path.join(gitPath, "HEAD"), "utf8").trim();
      if (/^[0-9a-f]{40}$/.test(head)) return head;
      const m = /^ref:\s+(.+)$/.exec(head);
      if (m) {
        const refPath = path.join(gitPath, m[1]!);
        const ref = readFileSync(refPath, "utf8").trim();
        if (/^[0-9a-f]{40}$/.test(ref)) return ref;
      }
    } else {
      const body = readFileSync(gitPath, "utf8");
      const m = /^gitdir:\s*(.+)$/m.exec(body);
      if (m) {
        const realGit = path.resolve(abs, m[1]!);
        const head = readFileSync(path.join(realGit, "HEAD"), "utf8").trim();
        if (/^[0-9a-f]{40}$/.test(head)) return head;
        const refMatch = /^ref:\s+(.+)$/.exec(head);
        if (refMatch) {
          const ref = readFileSync(path.join(realGit, refMatch[1]!), "utf8").trim();
          if (/^[0-9a-f]{40}$/.test(ref)) return ref;
        }
      }
    }
  } catch {
    /* best effort */
  }
  return "";
}

/**
 * Resolve free bytes on the filesystem hosting `anchor`. Uses
 * `fs.statfsSync` (Bun supports it). Returns null on platforms / kernels
 * where the syscall fails, in which case the preflight is skipped.
 */
function statFreeBytes(anchor: string): number | null {
  try {
    // Resolve upward until we find a directory that actually exists.
    let p = anchor;
    while (!existsSync(p)) {
      const parent = path.dirname(p);
      if (parent === p) return null;
      p = parent;
    }
    const s = statfsSync(p);
    // Bun returns bigint for bavail + bsize; convert safely.
    const bavail =
      typeof s.bavail === "bigint" ? Number(s.bavail) : (s.bavail as unknown as number);
    const bsize = typeof s.bsize === "bigint" ? Number(s.bsize) : (s.bsize as unknown as number);
    if (!Number.isFinite(bavail) || !Number.isFinite(bsize)) return null;
    return bavail * bsize;
  } catch {
    return null;
  }
}

/** Map a `lstat` mode field to a git tree mode string. */
function modeFromStat(mode: number): string {
  // Executable bit set on owner? → 100755. Otherwise → 100644.
  return mode & 0o100 ? "100755" : "100644";
}
