/**
 * delete_file — workspace-bounded rm.
 *
 * §7.6.12: permission class DESTRUCTIVE. At `full_auto` autonomy this auto-
 * runs; under `high` it prompts, under `medium`/`low` it's denied.
 * Workspace-boundary enforcement is runtime policy (never prompt-only).
 */

import { statSync, unlinkSync } from "node:fs";
import * as path from "node:path";

import type { OpenApexRunContext, ToolDefinition, ToolExecuteResult } from "@open-apex/core";

export interface DeleteFileInput {
  path: string;
}

export interface DeleteFileResult {
  path: string;
  bytesDeleted: number;
}

export const deleteFileTool: ToolDefinition<DeleteFileInput, DeleteFileResult> = {
  name: "delete_file",
  description:
    "Delete a file at a workspace-relative path. Refuses directories (use run_shell `rm -r` with care) and symlinks whose target resolves outside the workspace. Checkpointed before the delete so the operation is undoable via checkpoint_restore.",
  kind: "editor",
  parameters: {
    type: "object",
    required: ["path"],
    additionalProperties: false,
    properties: {
      path: { type: "string" },
    },
  },
  permissionClass: "DESTRUCTIVE",
  errorCodes: [
    "file_not_found",
    "path_outside_workspace",
    "is_directory",
    "file_stale_read",
  ] as const,
  async execute(
    input: DeleteFileInput,
    ctx: OpenApexRunContext,
  ): Promise<ToolExecuteResult<DeleteFileResult>> {
    const ws = path.resolve(ctx.userContext.workspace);
    const abs = path.resolve(ws, input.path);
    if (abs !== ws && !abs.startsWith(ws + path.sep)) {
      return {
        content: `${input.path} resolves outside workspace`,
        isError: true,
        errorType: "path_outside_workspace",
      };
    }
    let st;
    try {
      st = statSync(abs);
    } catch {
      return {
        content: `no such file: ${input.path}`,
        isError: true,
        errorType: "file_not_found",
      };
    }
    if (st.isDirectory()) {
      return {
        content: `${input.path} is a directory`,
        isError: true,
        errorType: "is_directory",
      };
    }
    const fsMap = (ctx.userContext as { fileStateMap?: FileStateMapLike }).fileStateMap;
    if (fsMap) {
      const stale = fsMap.isStale(input.path);
      if (stale) {
        return {
          content: `file ${input.path} changed on disk since last read (mtime ${stale.recordedMtimeMs}→${stale.currentMtimeMs}, size ${stale.recordedSize}→${stale.currentSize}); re-read before deleting.`,
          isError: true,
          errorType: "file_stale_read",
        };
      }
    }
    const bytes = st.size;
    unlinkSync(abs);
    fsMap?.clear(input.path);
    return { content: { path: input.path, bytesDeleted: bytes } };
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
