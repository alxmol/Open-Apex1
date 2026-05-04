/**
 * checkpoint_restore tool — thin wrapper over CheckpointStore.restore.
 */

import type {
  CheckpointStore,
  OpenApexRunContext,
  RestoreReport,
  ToolDefinition,
  ToolExecuteResult,
} from "@open-apex/core";

export interface CheckpointRestoreInput {
  commitSha?: string;
  /** Named restore: pick the most recent checkpoint with this name. */
  name?: string;
}

export const checkpointRestoreTool: ToolDefinition<CheckpointRestoreInput, RestoreReport> = {
  name: "checkpoint_restore",
  description:
    "Roll the workspace back to a previous checkpoint. Accepts a commitSha OR a name (uses the most recent checkpoint with that name). Before restoring, a pre_restore checkpoint is saved automatically so the restore itself is undoable. Capabilities NOT reverted: installed packages, running processes, database mutations, and other shell-side effects — only workspace file state rolls back.",
  kind: "editor",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      commitSha: { type: "string", minLength: 4 },
      name: { type: "string" },
    },
  },
  permissionClass: "REVERSIBLE",
  errorCodes: ["nonexistent_target"] as const,
  async execute(
    input: CheckpointRestoreInput,
    ctx: OpenApexRunContext,
  ): Promise<ToolExecuteResult<RestoreReport>> {
    const store = (ctx.userContext as { checkpointStore?: CheckpointStore }).checkpointStore;
    if (!store) {
      return {
        content: "no CheckpointStore attached to this session",
        isError: true,
        errorType: "nonexistent_target",
      };
    }
    let targetSha = input.commitSha;
    if (!targetSha && input.name) {
      const list = await store.list();
      const match = list.find((c) => c.reason === "user_named" && c.name === input.name);
      if (match) targetSha = match.commitSha;
    }
    if (!targetSha) {
      return {
        content: "must provide either commitSha or name",
        isError: true,
        errorType: "nonexistent_target",
      };
    }
    const report = await store.restore(targetSha);
    if (!report.verified) {
      return {
        content: report,
        isError: true,
        errorType: "nonexistent_target",
      };
    }
    return { content: report };
  },
};
