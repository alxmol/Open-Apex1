/**
 * write_file tool — new-file-only creator.
 *
 * Locked per §1.2: write_file is for NEW files only. If called on an existing
 * file, it returns file_exists. M2 adds the runtime-mediated patch-recovery
 * fallback that can temporarily allow write_file on an existing path.
 */

import { existsSync, mkdirSync, statSync } from "node:fs";
import * as path from "node:path";

import type { OpenApexRunContext, ToolDefinition, ToolExecuteResult } from "@open-apex/core";

export interface WriteFileInput {
  path: string;
  content: string;
  encoding?: string;
  /**
   * Internal flag set by the runtime during patch-recovery (M2). Models
   * should not set this directly — the tool description does not expose it.
   */
  __recovery?: boolean;
}

export interface WriteFileResult {
  path: string;
  bytesWritten: number;
}

export const writeFileTool: ToolDefinition<WriteFileInput, WriteFileResult> = {
  name: "write_file",
  description:
    "Create a new text file at a path relative to the workspace. If the file already exists, returns file_exists — use apply_patch or search_replace to modify existing files. Intermediate directories are created as needed.",
  kind: "editor",
  parameters: {
    type: "object",
    required: ["path", "content"],
    additionalProperties: false,
    properties: {
      path: { type: "string" },
      content: { type: "string" },
      encoding: { type: "string" },
    },
  },
  permissionClass: "REVERSIBLE",
  errorCodes: ["file_exists", "path_outside_workspace", "encoding_error", "is_directory"] as const,
  async execute(
    input: WriteFileInput,
    ctx: OpenApexRunContext,
  ): Promise<ToolExecuteResult<WriteFileResult>> {
    const ws = path.resolve(ctx.userContext.workspace);
    const abs = path.resolve(ws, input.path);
    if (abs !== ws && !abs.startsWith(ws + path.sep)) {
      return errorResult("path_outside_workspace", `${input.path} resolves outside workspace`);
    }
    if (existsSync(abs)) {
      const st = statSync(abs);
      if (st.isDirectory()) {
        return errorResult("is_directory", `${input.path} is a directory`);
      }
      if (!input.__recovery) {
        return errorResult(
          "file_exists",
          `${input.path} already exists — use apply_patch or search_replace to modify existing files`,
        );
      }
    }
    const encoding = (input.encoding ?? "utf-8").toLowerCase();
    if (encoding !== "utf-8" && encoding !== "utf8") {
      return errorResult("encoding_error", `only utf-8 is supported at M1 (got ${encoding})`);
    }
    mkdirSync(path.dirname(abs), { recursive: true });
    await Bun.write(abs, input.content);
    return {
      content: {
        path: input.path,
        bytesWritten: Buffer.byteLength(input.content, "utf8"),
      },
    };
  },
};

function errorResult<T>(
  code: import("@open-apex/core").ToolErrorType,
  message: string,
): ToolExecuteResult<T> {
  return { content: message, isError: true, errorType: code };
}
