/**
 * OPEN_APEX.md loader.
 * Locked per §7.6.13.
 *
 * Filename lookup order per directory:
 *   1. OPEN_APEX.override.md  (developer-local overrides, typically gitignored)
 *   2. OPEN_APEX.md            (canonical)
 *   3. Fallbacks from config.search.project_doc_fallback_filenames
 *      (default ["AGENTS.md"] for Codex interop)
 *
 * Location walk:
 *   1. Project-root detection: walk from cwd upward until config.search.project_root_markers
 *      (default [".git"]) is found. If none, project root = cwd.
 *   2. Collection order: root → cwd, root's file first.
 *   3. Global file: $OPEN_APEX_HOME/OPEN_APEX.md prepended.
 *
 * Size cap: config.search.project_doc_max_bytes (default 32768). When exhausted,
 * further files are skipped entirely, not truncated mid-file.
 *
 * Benchmark-mode hard-ignore: code-branch per §7.6.13. `benchmarkMode === true`
 * ALWAYS returns [] regardless of config or poison files.
 */

import { statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import * as path from "node:path";

import type { ProjectDocFragment } from "@open-apex/core";

export interface LoadProjectDocOpts {
  cwd: string;
  /** Required for hard-coded benchmark branch; no config value can override. */
  benchmarkMode: boolean;
  openApexHome?: string;
  projectRootMarkers?: string[];
  fallbackFilenames?: string[];
  maxBytes?: number;
}

export async function loadProjectDoc(opts: LoadProjectDocOpts): Promise<ProjectDocFragment[]> {
  // §7.6.13 hard branch.
  if (opts.benchmarkMode) return [];
  if (opts.maxBytes === 0) return [];

  const maxBytes = opts.maxBytes ?? 32768;
  const markers = opts.projectRootMarkers ?? [".git"];
  const fallbackFilenames = opts.fallbackFilenames ?? ["AGENTS.md"];

  const fragments: ProjectDocFragment[] = [];
  let remaining = maxBytes;

  // 1. Global file first.
  if (opts.openApexHome) {
    const globalPath = path.join(opts.openApexHome, "OPEN_APEX.md");
    const f = await tryLoadFile(globalPath, remaining);
    if (f) {
      fragments.push(f);
      remaining -= f.sizeBytes;
    }
  }

  if (remaining <= 0) return fragments;

  // 2. Find project root (walk up cwd until we hit a marker).
  const projectRoot = findProjectRoot(opts.cwd, markers);
  const dirs = dirsFromRootToCwd(projectRoot, opts.cwd);

  for (const dir of dirs) {
    if (remaining <= 0) break;
    const filename = await chooseFilenameForDir(dir, fallbackFilenames);
    if (!filename) continue;
    const p = path.join(dir, filename);
    const f = await tryLoadFile(p, remaining);
    if (f) {
      fragments.push(f);
      remaining -= f.sizeBytes;
    }
  }

  return fragments;
}

function findProjectRoot(cwd: string, markers: string[]): string {
  let cur = path.resolve(cwd);
  while (true) {
    for (const m of markers) {
      try {
        statSync(path.join(cur, m));
        return cur;
      } catch {
        /* keep walking */
      }
    }
    const parent = path.dirname(cur);
    if (parent === cur) return cwd; // hit filesystem root, give up
    cur = parent;
  }
}

function dirsFromRootToCwd(root: string, cwd: string): string[] {
  const r = path.resolve(root);
  const c = path.resolve(cwd);
  if (r === c) return [r];
  if (!c.startsWith(r + path.sep)) return [c];
  const dirs = [r];
  const rel = path.relative(r, c);
  const parts = rel.split(path.sep);
  let cur = r;
  for (const p of parts) {
    cur = path.join(cur, p);
    dirs.push(cur);
  }
  return dirs;
}

async function chooseFilenameForDir(dir: string, fallbacks: string[]): Promise<string | null> {
  const candidates = ["OPEN_APEX.override.md", "OPEN_APEX.md", ...fallbacks];
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const lc = new Set(entries.map((e) => e));
  for (const c of candidates) {
    if (lc.has(c)) return c;
  }
  return null;
}

async function tryLoadFile(p: string, remaining: number): Promise<ProjectDocFragment | null> {
  const file = Bun.file(p);
  if (!(await file.exists())) return null;
  const size = file.size;
  if (size === 0) return null;
  // Size cap: skip entirely if it would overshoot.
  if (size > remaining) return null;
  const content = await file.text();
  const mtime = file.lastModified ?? Date.now();
  return {
    path: p,
    content,
    mtimeMs: mtime,
    sizeBytes: size,
  };
}
