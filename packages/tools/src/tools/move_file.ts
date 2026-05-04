/**
 * move_file — workspace-bounded rename.
 *
 * §7.6.12: permission class REVERSIBLE when both paths inside the
 * workspace (the reverse is a simple move back), DESTRUCTIVE otherwise.
 * For M2 we always require both paths to be workspace-relative and
 * refuse cross-workspace moves with path_outside_workspace.
 */

import { existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import * as path from "node:path";

import type { OpenApexRunContext, ToolDefinition, ToolExecuteResult } from "@open-apex/core";

export interface MoveFileInput {
  fromPath: string;
  toPath: string;
}

export interface MoveFileResult {
  fromPath: string;
  toPath: string;
}

export const moveFileTool: ToolDefinition<MoveFileInput, MoveFileResult> = {
  name: "move_file",
  description:
    "Move (rename) a file from `fromPath` to `toPath`, both workspace-relative. Creates intermediate destination directories as needed. Refuses to overwrite an existing destination — the model should delete it explicitly first.",
  kind: "editor",
  parameters: {
    type: "object",
    required: ["fromPath", "toPath"],
    additionalProperties: false,
    properties: {
      fromPath: { type: "string" },
      toPath: { type: "string" },
    },
  },
  permissionClass: "REVERSIBLE",
  errorCodes: [
    "file_not_found",
    "destination_exists",
    "path_outside_workspace",
    "file_stale_read",
  ] as const,
  async execute(
    input: MoveFileInput,
    ctx: OpenApexRunContext,
  ): Promise<ToolExecuteResult<MoveFileResult>> {
    const ws = path.resolve(ctx.userContext.workspace);
    const from = path.resolve(ws, input.fromPath);
    const to = path.resolve(ws, input.toPath);
    if (
      (from !== ws && !from.startsWith(ws + path.sep)) ||
      (to !== ws && !to.startsWith(ws + path.sep))
    ) {
      return {
        content: `path resolves outside workspace: fromPath=${input.fromPath} toPath=${input.toPath}`,
        isError: true,
        errorType: "path_outside_workspace",
      };
    }
    try {
      statSync(from);
    } catch {
      return {
        content: `no such file: ${input.fromPath}`,
        isError: true,
        errorType: "file_not_found",
      };
    }
    if (existsSync(to)) {
      return {
        content: `destination already exists: ${input.toPath}`,
        isError: true,
        errorType: "destination_exists",
      };
    }
    const fsMap = (ctx.userContext as { fileStateMap?: FileStateMapLike }).fileStateMap;
    if (fsMap) {
      const stale = fsMap.isStale(input.fromPath);
      if (stale) {
        return {
          content: `file ${input.fromPath} changed on disk since last read; re-read before moving.`,
          isError: true,
          errorType: "file_stale_read",
        };
      }
    }
    mkdirSync(path.dirname(to), { recursive: true });
    renameSync(from, to);
    fsMap?.clear(input.fromPath);
    return { content: { fromPath: input.fromPath, toPath: input.toPath } };
  },
};

interface FileStateMapLike {
  isStale(path: string): {
    recordedMtimeMs: number;
    recordedSize: number;
    currentMtimeMs: number;
    currentSize: number;
  } | null;
  clear(path: string): void;
}
