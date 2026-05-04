/**
 * Benchmark-mode prompt/config isolation helpers.
 *
 * In benchmark mode, OPEN_APEX.md/AGENTS.md and .openapex/config.toml are
 * hidden context/config inputs, not task data. Returning their contents from
 * tools would leak benchmark poison into model-visible history and artifacts.
 */

import * as path from "node:path";

import type { OpenApexRunContext } from "@open-apex/core";

const PROMPT_HINT_FILES = new Set(["OPEN_APEX.md", "OPEN_APEX.override.md", "AGENTS.md"]);

export function isBenchmarkMode(ctx: OpenApexRunContext): boolean {
  return (ctx.userContext as { benchmarkMode?: boolean }).benchmarkMode === true;
}

export function isBenchmarkIsolatedPath(workspace: string, candidate: string): boolean {
  const rel = normalizeRelPath(workspace, candidate);
  if (rel === null) return false;
  const parts = rel.split(path.sep).filter(Boolean);
  const base = parts.at(-1);
  if (base && PROMPT_HINT_FILES.has(base)) return true;
  return parts.length >= 2 && parts.at(-2) === ".openapex" && base === "config.toml";
}

export function benchmarkIsolationMessage(relPath: string): string {
  return `${relPath} is hidden in benchmark mode to prevent prompt/config contamination`;
}

function normalizeRelPath(workspace: string, candidate: string): string | null {
  const ws = path.resolve(workspace);
  const abs = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(ws, candidate);
  if (abs !== ws && !abs.startsWith(ws + path.sep)) return null;
  return path.relative(ws, abs);
}
