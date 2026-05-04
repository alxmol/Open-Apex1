/**
 * list_tree tool — directory listing with default excludes + .gitignore respect.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import * as path from "node:path";

import type { OpenApexRunContext, ToolDefinition, ToolExecuteResult } from "@open-apex/core";

import { isBenchmarkIsolatedPath, isBenchmarkMode } from "./benchmark-isolation.ts";

export interface ListTreeInput {
  path: string;
  maxDepth?: number;
  respectGitignore?: boolean;
}

export interface ListTreeEntry {
  path: string;
  type: "file" | "dir" | "symlink";
  sizeBytes?: number;
  depth: number;
}

export interface ListTreeResult {
  root: string;
  entries: ListTreeEntry[];
}

const DEFAULT_EXCLUDES = new Set<string>([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  ".DS_Store",
]);

export const listTreeTool: ToolDefinition<ListTreeInput, ListTreeResult> = {
  name: "list_tree",
  description:
    "List files and directories under a path (relative to workspace). Respects .gitignore by default and always skips common excluded dirs (node_modules, dist, __pycache__, .git, etc.).",
  kind: "function",
  parameters: {
    type: "object",
    required: ["path"],
    additionalProperties: false,
    properties: {
      path: { type: "string" },
      maxDepth: { type: "integer", minimum: 1, maximum: 20 },
      respectGitignore: { type: "boolean" },
    },
  },
  permissionClass: "READ_ONLY",
  errorCodes: ["file_not_found", "path_outside_workspace"] as const,
  async execute(
    input: ListTreeInput,
    ctx: OpenApexRunContext,
  ): Promise<ToolExecuteResult<ListTreeResult>> {
    const ws = path.resolve(ctx.userContext.workspace);
    const absRoot = path.resolve(ws, input.path);
    if (absRoot !== ws && !absRoot.startsWith(ws + path.sep)) {
      return errorResult("path_outside_workspace", `${input.path} resolves outside workspace`);
    }
    if (!existsSync(absRoot)) return errorResult("file_not_found", `no such path: ${input.path}`);
    const maxDepth = input.maxDepth ?? 6;
    const gitignore = input.respectGitignore !== false ? loadGitignore(ws) : null;
    const entries: ListTreeEntry[] = [];
    await walk(absRoot, ws, 0, maxDepth, gitignore, entries, isBenchmarkMode(ctx));
    return { content: { root: input.path, entries } };
  },
};

async function walk(
  abs: string,
  workspace: string,
  depth: number,
  maxDepth: number,
  gitignore: GitignoreMatcher | null,
  out: ListTreeEntry[],
  benchmarkMode: boolean,
): Promise<void> {
  if (depth > maxDepth) return;
  let items: string[];
  try {
    items = await readdir(abs);
  } catch {
    return;
  }
  items.sort();
  for (const name of items) {
    if (DEFAULT_EXCLUDES.has(name)) continue;
    const childAbs = path.join(abs, name);
    const rel = path.relative(workspace, childAbs);
    if (benchmarkMode && (isBenchmarkConfigDir(rel) || isBenchmarkIsolatedPath(workspace, rel))) {
      continue;
    }
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(childAbs);
    } catch {
      continue;
    }
    const isDir = st.isDirectory();
    if (gitignore?.ignores(rel, isDir)) continue;
    const entry: ListTreeEntry = {
      path: rel,
      type: st.isSymbolicLink() ? "symlink" : isDir ? "dir" : "file",
      depth,
    };
    if (!isDir) entry.sizeBytes = st.size;
    out.push(entry);
    if (isDir) await walk(childAbs, workspace, depth + 1, maxDepth, gitignore, out, benchmarkMode);
  }
}

function isBenchmarkConfigDir(rel: string): boolean {
  return rel === ".openapex" || rel.startsWith(`.openapex${path.sep}`);
}

/** Tiny gitignore matcher — supports plain patterns, trailing /, leading !. */
interface GitignoreMatcher {
  ignores(relPath: string, isDir: boolean): boolean;
}

function loadGitignore(workspace: string): GitignoreMatcher | null {
  const p = path.join(workspace, ".gitignore");
  if (!existsSync(p)) return null;
  const lines = readFileSync(p, "utf8").split(/\r?\n/);
  const rules: Array<{ neg: boolean; dirOnly: boolean; regex: RegExp }> = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let pattern = line;
    let neg = false;
    if (pattern.startsWith("!")) {
      neg = true;
      pattern = pattern.slice(1);
    }
    const dirOnly = pattern.endsWith("/");
    if (dirOnly) pattern = pattern.slice(0, -1);
    const regex = globToRegex(pattern);
    rules.push({ neg, dirOnly, regex });
  }
  return {
    ignores(rel: string, isDir: boolean): boolean {
      let ignored = false;
      for (const r of rules) {
        if (r.dirOnly && !isDir) continue;
        if (r.regex.test(rel)) ignored = !r.neg;
      }
      return ignored;
    },
  };
}

function globToRegex(glob: string): RegExp {
  // Very small subset: * matches [^/]*, ** matches any, otherwise literal.
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += ".";
    } else if (c === ".") {
      re += "\\.";
    } else if (c === "/") {
      re += "/";
    } else if (/[a-zA-Z0-9_\-]/.test(c)) {
      re += c;
    } else {
      re += `\\${c}`;
    }
  }
  // Anchored match: pattern matches either a leading-dir or exact file.
  return new RegExp(`(^|/)${re}($|/)`);
}

function errorResult<T>(
  code: import("@open-apex/core").ToolErrorType,
  message: string,
): ToolExecuteResult<T> {
  return { content: message, isError: true, errorType: code };
}
