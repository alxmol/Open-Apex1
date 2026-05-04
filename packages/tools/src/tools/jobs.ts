/**
 * M5 background-job tools.
 *
 * These tools expose an Open-Apex-owned job table to the model. The table is
 * process-local by design: chat jobs can survive `/new` and provider switches,
 * but v1 does not daemonize jobs across CLI restarts.
 */

import type { OpenApexRunContext, ToolDefinition } from "@open-apex/core";

import { getJobManager } from "../jobs/job-manager.ts";

export interface RunJobInput {
  argv: string[];
  cwd?: string;
  env?: Record<string, string>;
  name?: string;
}

export interface JobIdInput {
  jobId: string;
}

export interface ReadJobLogInput extends JobIdInput {
  tailLines?: number;
  follow?: boolean;
}

export interface WaitForJobInput extends JobIdInput {
  timeoutMs?: number;
}

export interface KillJobInput extends JobIdInput {
  signal?: "SIGTERM" | "SIGKILL";
}

export const runJobTool: ToolDefinition<RunJobInput> = {
  name: "run_job",
  description:
    "Start a background process for chat-mode workflows. Jobs are process-scoped and do not survive CLI restart.",
  kind: "shell",
  permissionClass: "CLASSIFIED",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["argv"],
    properties: {
      argv: { type: "array", items: { type: "string" } },
      cwd: { type: "string" },
      env: { type: "object", additionalProperties: { type: "string" } },
      name: { type: "string" },
    },
  },
  async execute(input, ctx) {
    try {
      const record = getJobManager(ctx.runId).run({
        argv: input.argv,
        cwd: input.cwd ?? ctx.userContext.workspace,
        ...(input.env ? { env: input.env } : {}),
        ...(input.name ? { name: input.name } : {}),
      });
      return { content: JSON.stringify(record, null, 2) };
    } catch (err) {
      return jobError(err);
    }
  },
  errorCodes: ["bad_args", "job_name_conflict", "shell_not_found"],
};

export const listJobsTool: ToolDefinition<Record<string, never>> = {
  name: "list_jobs",
  description: "List Open-Apex background jobs for the current CLI process.",
  kind: "function",
  permissionClass: "READ_ONLY",
  parameters: { type: "object", additionalProperties: false, properties: {} },
  async execute(_input, ctx) {
    return { content: JSON.stringify(getJobManager(ctx.runId).list(), null, 2) };
  },
  errorCodes: ["bad_args"],
};

export const readJobLogTool: ToolDefinition<ReadJobLogInput> = {
  name: "read_job_log",
  description: "Read the captured stdout/stderr tails for a background job.",
  kind: "function",
  permissionClass: "READ_ONLY",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["jobId"],
    properties: {
      jobId: { type: "string" },
      tailLines: { type: "number" },
      follow: { type: "boolean" },
    },
  },
  async execute(input, ctx) {
    if (input.follow) {
      return {
        content:
          "follow=true is not supported in autonomous/tool output; poll read_job_log instead",
        isError: true,
        errorType: "bad_args",
      };
    }
    const record = getJobManager(ctx.runId).get(input.jobId);
    if (!record)
      return {
        content: `job_not_found: ${input.jobId}`,
        isError: true,
        errorType: "job_not_found",
      };
    const stdout = tailLines(record.stdoutTail, input.tailLines);
    const stderr = tailLines(record.stderrTail, input.tailLines);
    return {
      content: JSON.stringify({ ...record, stdoutTail: stdout, stderrTail: stderr }, null, 2),
    };
  },
  errorCodes: ["job_not_found", "bad_args"],
};

export const waitForJobTool: ToolDefinition<WaitForJobInput> = {
  name: "wait_for_job",
  description: "Wait for a background job to finish or for a timeout to elapse.",
  kind: "function",
  permissionClass: "READ_ONLY",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["jobId"],
    properties: {
      jobId: { type: "string" },
      timeoutMs: { type: "number" },
    },
  },
  async execute(input, ctx) {
    try {
      const record = await getJobManager(ctx.runId).wait(input.jobId, input.timeoutMs);
      if (!record)
        return {
          content: `job_not_found: ${input.jobId}`,
          isError: true,
          errorType: "job_not_found",
        };
      return { content: JSON.stringify(record, null, 2) };
    } catch (err) {
      if ((err as Error).message === "wait_timeout") {
        return {
          content: `wait_timeout: ${input.jobId}`,
          isError: true,
          errorType: "wait_timeout",
        };
      }
      throw err;
    }
  },
  errorCodes: ["job_not_found", "wait_timeout"],
};

export const killJobTool: ToolDefinition<KillJobInput> = {
  name: "kill_job",
  description: "Terminate an Open-Apex background job.",
  kind: "editor",
  permissionClass: "DESTRUCTIVE",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["jobId"],
    properties: {
      jobId: { type: "string" },
      signal: { enum: ["SIGTERM", "SIGKILL"] },
    },
  },
  async execute(input, ctx: OpenApexRunContext) {
    const record = getJobManager(ctx.runId).kill(input.jobId, input.signal ?? "SIGTERM");
    if (!record)
      return {
        content: `job_not_found: ${input.jobId}`,
        isError: true,
        errorType: "job_not_found",
      };
    return { content: JSON.stringify(record, null, 2) };
  },
  errorCodes: ["job_not_found"],
};

function tailLines(text: string, n: number | undefined): string {
  if (!n || n <= 0) return text;
  return text.split(/\r?\n/).slice(-n).join("\n");
}

function jobError(err: unknown) {
  const msg = (err as Error).message;
  if (msg.startsWith("job_name_conflict")) {
    return { content: msg, isError: true, errorType: "job_name_conflict" as const };
  }
  if (msg.startsWith("bad_args")) {
    return { content: msg, isError: true, errorType: "bad_args" as const };
  }
  return { content: msg, isError: true, errorType: "shell_not_found" as const };
}
