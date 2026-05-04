/**
 * apply_patch tool — patch-first editing with reverse-patch undo.
 *
 * On failure, returns a structured error the model can react to (re-read the
 * file, rewrite the patch, or fall back to search_replace). The runtime-
 * mediated recovery flow (auto-emit fresh read_file + allow write_file for
 * the failed path) is M2.
 */

import { writeFileSync } from "node:fs";
import * as path from "node:path";

import type {
  OpenApexRunContext,
  ToolDefinition,
  ToolErrorType,
  ToolExecuteResult,
} from "@open-apex/core";

import { PatchError, planApply } from "../patch/index.ts";

export interface ApplyPatchInput {
  patch: string;
}

export interface ApplyPatchResult {
  filesModified: Array<{ path: string; action: "modify" | "create" | "delete" }>;
  reversePatch: string;
}

export const applyPatchTool: ToolDefinition<ApplyPatchInput, ApplyPatchResult> = {
  name: "apply_patch",
  description:
    "Apply a unified-diff patch (--- a/file / +++ b/file / @@ hunks) to one or more files in the workspace. The patch must match byte-for-byte; context mismatches return a structured error so you can re-read and rewrite. Returns a reverse patch for undo. Binary files are rejected.",
  kind: "apply_patch",
  parameters: {
    type: "object",
    required: ["patch"],
    additionalProperties: false,
    properties: {
      patch: { type: "string", minLength: 10 },
    },
  },
  permissionClass: "REVERSIBLE",
  errorCodes: [
    "patch_parse_error",
    "patch_context_mismatch",
    "path_missing",
    "hunk_offset_exhausted",
    "binary_file",
    "path_outside_workspace",
    "encoding_error",
    "file_stale_read",
  ] as const,
  async execute(
    input: ApplyPatchInput,
    ctx: OpenApexRunContext,
  ): Promise<ToolExecuteResult<ApplyPatchResult>> {
    const fsMap = (ctx.userContext as { fileStateMap?: FileStateMapLike }).fileStateMap;
    try {
      const plan = planApply({
        workspace: ctx.userContext.workspace,
        patch: input.patch,
      });
      // §1.2 file-state-map stale-read guard — surface file_stale_read
      // BEFORE touching disk if any target drifted since the last read.
      if (fsMap) {
        for (const f of plan.files) {
          if (f.action !== "modify") continue;
          const rel = relativizePath(ctx.userContext.workspace, f.path);
          const stale = fsMap.isStale(rel);
          if (stale) {
            return {
              content: `file ${rel} changed on disk since last read (mtime ${stale.recordedMtimeMs}→${stale.currentMtimeMs}, size ${stale.recordedSize}→${stale.currentSize}); re-read before applying patch.`,
              isError: true,
              errorType: "file_stale_read",
              metadata: { path: rel },
            };
          }
        }
      }
      // Persist each file's new contents to disk (or delete).
      for (const f of plan.files) {
        if (f.action === "delete") {
          // M1 doesn't handle deletes via apply_patch — surfaced as not supported.
          return {
            content:
              "delete action not supported via apply_patch at M1; use run_shell with rm <file>",
            isError: true,
            errorType: "patch_parse_error",
          };
        }
        const text = maybeAddBom(f.newContents ?? "", f.hadBom);
        writeFileSync(f.path, text, "utf8");
        fsMap?.clear(relativizePath(ctx.userContext.workspace, f.path));
      }
      return {
        content: {
          filesModified: plan.files.map((f) => ({
            path: relativizePath(ctx.userContext.workspace, f.path),
            action: f.action,
          })),
          reversePatch: plan.reversePatch,
        },
      };
    } catch (err) {
      if (err instanceof PatchError) {
        // Return a readable message + structured detail in metadata so the
        // model gets a descriptive summary and the runtime can act on the
        // structured error class (M2 recovery flow keys off this).
        return {
          content: `${err.code}: ${err.detail.message}`,
          isError: true,
          errorType: err.code as ToolErrorType,
          metadata: { detail: err.detail },
        };
      }
      throw err;
    }
  },
};

function maybeAddBom(text: string, hadBom: boolean): string {
  if (hadBom && !text.startsWith("\uFEFF")) return "\uFEFF" + text;
  return text;
}

function relativizePath(workspace: string, absOrRel: string): string {
  if (!path.isAbsolute(absOrRel)) return absOrRel;
  const rel = path.relative(path.resolve(workspace), absOrRel);
  return rel || absOrRel;
}

interface FileStateMapLike {
  isStale(path: string): {
    recordedMtimeMs: number;
    recordedSize: number;
    currentMtimeMs: number;
    currentSize: number;
  } | null;
  clear(path: string): void;
}
