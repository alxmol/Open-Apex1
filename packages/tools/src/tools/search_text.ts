/**
 * search_text tool — ripgrep wrapper.
 */

import * as path from "node:path";

import type { OpenApexRunContext, ToolDefinition, ToolExecuteResult } from "@open-apex/core";

import { isBenchmarkIsolatedPath, isBenchmarkMode } from "./benchmark-isolation.ts";

export interface SearchTextInput {
  pattern: string;
  path?: string;
  glob?: string;
  caseInsensitive?: boolean;
  maxResults?: number;
}

export interface SearchMatch {
  path: string;
  lineNumber: number;
  line: string;
}

export interface SearchTextResult {
  pattern: string;
  matches: SearchMatch[];
  truncated: boolean;
}

export const searchTextTool: ToolDefinition<SearchTextInput, SearchTextResult> = {
  name: "search_text",
  description:
    "Search the workspace for a regex pattern using ripgrep. Returns up to maxResults (default 200) matches with file, line number, and the matching line.",
  kind: "function",
  parameters: {
    type: "object",
    required: ["pattern"],
    additionalProperties: false,
    properties: {
      pattern: { type: "string" },
      path: { type: "string" },
      glob: { type: "string" },
      caseInsensitive: { type: "boolean" },
      maxResults: { type: "integer", minimum: 1, maximum: 10000 },
    },
  },
  permissionClass: "READ_ONLY",
  errorCodes: ["invalid_regex", "path_outside_workspace"] as const,
  async execute(
    input: SearchTextInput,
    ctx: OpenApexRunContext,
  ): Promise<ToolExecuteResult<SearchTextResult>> {
    const ws = path.resolve(ctx.userContext.workspace);
    const target = input.path ? path.resolve(ws, input.path) : ws;
    if (target !== ws && !target.startsWith(ws + path.sep)) {
      return errorResult("path_outside_workspace", `${input.path} resolves outside workspace`);
    }
    const maxResults = input.maxResults ?? 200;
    const args = ["--no-heading", "-n", "--max-count", String(maxResults), "--max-columns", "500"];
    if (input.caseInsensitive) args.push("-i");
    if (input.glob) {
      args.push("-g", input.glob);
    }
    args.push("--", input.pattern, target);
    const proc = Bun.spawn(["rg", ...args], {
      cwd: ws,
      stdout: "pipe",
      stderr: "pipe",
    });
    await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    // rg exits 0 on matches, 1 on no matches, 2 on error.
    if (proc.exitCode === 2) {
      return errorResult("invalid_regex", stderr.trim() || "ripgrep error");
    }
    const matches: SearchMatch[] = [];
    const benchmarkMode = isBenchmarkMode(ctx);
    for (const line of stdout.split("\n")) {
      if (!line) continue;
      const parsed = parseRgLine(line, ws);
      if (parsed) {
        if (benchmarkMode && isBenchmarkIsolatedPath(ws, parsed.path)) continue;
        matches.push(parsed);
      }
      if (matches.length >= maxResults) break;
    }
    return {
      content: {
        pattern: input.pattern,
        matches,
        truncated: matches.length >= maxResults,
      },
    };
  },
};

function parseRgLine(line: string, workspace: string): SearchMatch | null {
  // Format: <path>:<line>:<text>
  const firstColon = line.indexOf(":");
  if (firstColon < 0) return null;
  const secondColon = line.indexOf(":", firstColon + 1);
  if (secondColon < 0) return null;
  const absPath = line.slice(0, firstColon);
  const lineNumStr = line.slice(firstColon + 1, secondColon);
  const lineNum = Number.parseInt(lineNumStr, 10);
  if (!Number.isFinite(lineNum)) return null;
  const text = line.slice(secondColon + 1);
  const relPath = path.relative(workspace, absPath);
  return { path: relPath || absPath, lineNumber: lineNum, line: text };
}

function errorResult<T>(
  code: import("@open-apex/core").ToolErrorType,
  message: string,
): ToolExecuteResult<T> {
  return { content: message, isError: true, errorType: code };
}
