/**
 * checkpoint_save tool — thin wrapper over the CheckpointStore.
 *
 * The actual shadow-git store lives on a per-session RunContext attachment
 * (M2 formalizes session state). At M1 the CLI attaches a ShadowGitCheckpointStore
 * to `ctx.userContext.checkpointStore` — the tool reads it from there.
 */

import type {
  CheckpointStore,
  OpenApexRunContext,
  ToolDefinition,
  ToolExecuteResult,
} from "@open-apex/core";

export interface CheckpointSaveInput {
  name?: string;
  reason?:
    | "pre_tool_batch"
    | "pre_exploratory_executor"
    | "pre_restore"
    | "user_named"
    | "post_validation_pass"
    | "user_cancel";
}

export interface CheckpointSaveResult {
  commitSha: string;
  manifestPath: string;
  wallMs: number;
  name?: string;
}

export const checkpointSaveTool: ToolDefinition<CheckpointSaveInput, CheckpointSaveResult> = {
  name: "checkpoint_save",
  description:
    "Snapshot the current workspace state so a future checkpoint_restore can roll back to it. Use before risky multi-step edits or before operations whose reversibility you're unsure about. External side effects (package installs, running processes, database writes) are NOT captured — only workspace file state.",
  kind: "function",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      name: { type: "string" },
      reason: {
        type: "string",
        enum: [
          "pre_tool_batch",
          "pre_exploratory_executor",
          "pre_restore",
          "user_named",
          "post_validation_pass",
          "user_cancel",
        ],
      },
    },
  },
  permissionClass: "READ_ONLY",
  errorCodes: ["nonexistent_target"] as const,
  async execute(
    input: CheckpointSaveInput,
    ctx: OpenApexRunContext,
  ): Promise<ToolExecuteResult<CheckpointSaveResult>> {
    const store = (ctx.userContext as { checkpointStore?: CheckpointStore }).checkpointStore;
    if (!store) {
      return {
        content: "no CheckpointStore attached to this session",
        isError: true,
        errorType: "nonexistent_target",
      };
    }
    const sessionId = (ctx.userContext as { sessionId?: string }).sessionId ?? "unknown";
    const stepId = Date.now(); // ephemeral step ordering at M1; M5 wires session stepIds
    const reason = input.reason ?? (input.name ? "user_named" : "pre_tool_batch");
    const saveOpts = input.name ? { name: input.name } : undefined;
    // Graceful degradation: shadow-git can fail on hung git subprocesses
    // (TB2 gpt-fix-git class) or Bun SIGSEGVs during large `git add -A`
    // operations (TB2 crack-7z-hash). When that happens we surface the
    // error to the agent via a structured ToolExecuteResult instead of
    // throwing and aborting the whole run — the agent can decide whether
    // to continue without a checkpoint.
    let ckpt;
    try {
      ckpt = await store.save(reason, sessionId, stepId, saveOpts);
    } catch (err) {
      const msg = (err as Error).message || String(err);
      return {
        content: `checkpoint_save failed: ${msg}`,
        isError: true,
        errorType: "nonexistent_target",
      };
    }
    const out: CheckpointSaveResult = {
      commitSha: ckpt.commitSha,
      manifestPath: ckpt.manifestPath,
      wallMs: ckpt.wallMs,
    };
    if (ckpt.name !== undefined) out.name = ckpt.name;
    return { content: out };
  },
};
