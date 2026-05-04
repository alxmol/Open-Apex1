/**
 * §1.2 file-state map — mtime/size cache used by `search_replace`,
 * `apply_patch`, `delete_file`, and `move_file` to detect stale reads
 * (file changed on disk since the last `read_file`).
 *
 * M2 ships the in-memory map + persistence path. M5 wires the
 * `/resume`-side rehydration from `file-state-<run_id>.json`.
 *
 * Lifecycle:
 *   - `read_file` calls `record(path, stat)` after every successful read.
 *   - A mutating tool calls `await isStale(path)` BEFORE writing. If stale
 *     → return `file_stale_read` with the offending (path, old mtime, old
 *     size, new mtime, new size) so the model knows exactly what drifted.
 *   - `clear(path)` called after a successful mutation so the next mtime
 *     check isn't thrown off by our own write.
 *   - `serialize()` emits a JSON envelope written alongside the run
 *     bundle. `deserialize()` rehydrates on resume (M5 only).
 *
 * Staleness definition: mtime OR size differs from the recorded snapshot.
 * sha256 is deliberately NOT part of the stale check — that would require
 * reading the whole file on every mutation, which blows the budget on
 * large files. mtime/size is correct for 99.9% of cases; the remaining
 * rapid-mutation-with-same-size edge case manifests as a content mismatch
 * in search_replace / apply_patch, which already produces a structured
 * error the recovery flow handles.
 */

import { statSync } from "node:fs";
import * as path from "node:path";

export interface FileStateEntry {
  mtimeMs: number;
  size: number;
  /** Wall-clock time of the read. Diagnostics only. */
  lastReadAtMs: number;
}

export interface StaleReadInfo {
  path: string;
  recordedMtimeMs: number;
  recordedSize: number;
  currentMtimeMs: number;
  currentSize: number;
}

export class FileStateMap {
  private readonly entries = new Map<string, FileStateEntry>();
  /** Workspace root used to normalize paths. */
  private readonly workspace: string;

  constructor(workspace: string) {
    this.workspace = path.resolve(workspace);
  }

  /** Record a successful read's mtime + size. */
  record(absOrRelPath: string, stat: { mtimeMs: number; size: number }): void {
    const abs = this.resolve(absOrRelPath);
    this.entries.set(abs, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      lastReadAtMs: Date.now(),
    });
  }

  /**
   * Check whether the recorded snapshot is stale relative to disk. Returns
   * `null` if not stale or if there's no prior recording (no basis for
   * staleness — mutating tools must handle that via their own file
   * existence checks). Returns `StaleReadInfo` otherwise.
   */
  isStale(absOrRelPath: string): StaleReadInfo | null {
    const abs = this.resolve(absOrRelPath);
    const prior = this.entries.get(abs);
    if (!prior) return null;
    let st: { mtimeMs: number; size: number };
    try {
      st = statSync(abs);
    } catch {
      // File gone — treat as stale so mutating tools surface a cleaner
      // error to the model.
      return {
        path: abs,
        recordedMtimeMs: prior.mtimeMs,
        recordedSize: prior.size,
        currentMtimeMs: -1,
        currentSize: -1,
      };
    }
    if (st.mtimeMs !== prior.mtimeMs || st.size !== prior.size) {
      return {
        path: abs,
        recordedMtimeMs: prior.mtimeMs,
        recordedSize: prior.size,
        currentMtimeMs: st.mtimeMs,
        currentSize: st.size,
      };
    }
    return null;
  }

  /** Forget a path — typically after a successful mutating tool. */
  clear(absOrRelPath: string): void {
    this.entries.delete(this.resolve(absOrRelPath));
  }

  /** Full map size (useful for telemetry + tests). */
  size(): number {
    return this.entries.size;
  }

  /**
   * Serialize to a JSON-stable shape. Keys are workspace-relative so the
   * file survives workspace renames.
   */
  serialize(): { schema_version: 1; entries: Array<{ path: string } & FileStateEntry> } {
    const out: Array<{ path: string } & FileStateEntry> = [];
    for (const [abs, entry] of this.entries) {
      out.push({ path: path.relative(this.workspace, abs), ...entry });
    }
    return { schema_version: 1, entries: out };
  }

  /** Rebuild a map from `serialize()` output. Resume path (M5). */
  static deserialize(workspace: string, data: ReturnType<FileStateMap["serialize"]>): FileStateMap {
    const m = new FileStateMap(workspace);
    for (const e of data.entries) {
      m.entries.set(path.resolve(m.workspace, e.path), {
        mtimeMs: e.mtimeMs,
        size: e.size,
        lastReadAtMs: e.lastReadAtMs,
      });
    }
    return m;
  }

  private resolve(p: string): string {
    return path.isAbsolute(p) ? p : path.resolve(this.workspace, p);
  }
}
