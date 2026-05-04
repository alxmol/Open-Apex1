/**
 * repo_map — summarize the workspace structure + languages + size.
 *
 * Backed by `@open-apex/indexer.buildRepoMap`. Output is a compact
 * text-and-counts rendering capped at ~400 file entries by default to avoid
 * blowing up the model context on large workspaces.
 */

import type { OpenApexRunContext, ToolDefinition, ToolExecuteResult } from "@open-apex/core";
import { buildRepoMap, renderRepoMapSummary } from "@open-apex/indexer";

export interface RepoMapInput {
  maxFiles?: number;
  includeExtensions?: string[];
}

export interface RepoMapResult {
  root: string;
  totalFiles: number;
  totalBytes: number;
  truncated: boolean;
  languageCounts: Record<string, number>;
  summary: string;
}

export const repoMapTool: ToolDefinition<RepoMapInput, RepoMapResult> = {
  name: "repo_map",
  description:
    "Produce a lightweight map of the workspace: all non-ignored files, their detected languages, and aggregate language counts. Useful at the start of a task to orient yourself. Respects `.gitignore` + default excludes (node_modules, target, .venv, dist, etc.). Capped at 400 files by default.",
  kind: "function",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      maxFiles: { type: "integer", minimum: 10, maximum: 5000 },
      includeExtensions: {
        type: "array",
        items: { type: "string", minLength: 1, maxLength: 12 },
        maxItems: 20,
      },
    },
  },
  permissionClass: "READ_ONLY",
  errorCodes: ["bad_args"] as const,
  async execute(
    input: RepoMapInput,
    ctx: OpenApexRunContext,
    signal: AbortSignal,
  ): Promise<ToolExecuteResult<RepoMapResult>> {
    const opts: Parameters<typeof buildRepoMap>[0] = {
      workspace: ctx.userContext.workspace,
      signal,
      maxFiles: input.maxFiles ?? 5000,
    };
    if (input.includeExtensions !== undefined) {
      opts.includeExtensions = input.includeExtensions;
    }
    const map = await buildRepoMap(opts);
    const summary = renderRepoMapSummary(map, { maxFiles: input.maxFiles ?? 400 });
    return {
      content: {
        root: map.root,
        totalFiles: map.totalFiles,
        totalBytes: map.totalBytes,
        truncated: map.truncated,
        languageCounts: map.languageCounts,
        summary,
      },
    };
  },
};
