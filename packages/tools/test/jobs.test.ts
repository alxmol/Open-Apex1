import { describe, expect, test } from "bun:test";

import { cleanupJobManager, getJobManager, JobManager } from "../src/jobs/job-manager.ts";
import { listJobsTool, readJobLogTool, runJobTool, waitForJobTool } from "../src/tools/jobs.ts";
import type { OpenApexRunContext } from "@open-apex/core";

function ctx(): OpenApexRunContext {
  return {
    runId: `run_${Date.now()}`,
    signal: new AbortController().signal,
    usage: { inputTokens: 0, outputTokens: 0 },
    userContext: {
      workspace: process.cwd(),
      openApexHome: process.cwd(),
      autonomyLevel: "full_auto",
      sessionId: "s_test",
    },
  };
}

describe("JobManager", () => {
  test("runs, captures log tails, and waits for completion", async () => {
    const manager = new JobManager();
    const job = manager.run({ argv: ["bash", "-lc", "echo job-ok"], cwd: process.cwd() });
    const done = await manager.wait(job.id, 5_000);
    expect(done?.exitCode).toBe(0);
    expect(done?.stdoutTail).toContain("job-ok");
  });

  test("cleanup terminates long-running children", async () => {
    const manager = new JobManager();
    const job = manager.run({
      argv: ["bash", "-lc", "trap '' TERM; sleep 30"],
      cwd: process.cwd(),
    });
    expect(typeof job.pid).toBe("number");
    expect(pidAlive(job.pid!)).toBe(true);
    await manager.cleanup({ graceMs: 20 });
    expect(pidAlive(job.pid!)).toBe(false);
  });

  test("run-scoped jobs survive same-process state changes until final cleanup", async () => {
    const runId = `run_jobs_${Date.now()}`;
    const manager = getJobManager(runId);
    for (const name of ["a", "b", "c"]) {
      manager.run({
        argv: ["bash", "-lc", "trap '' TERM; sleep 30"],
        cwd: process.cwd(),
        name,
      });
    }

    expect(
      getJobManager(runId)
        .list()
        .map((j) => j.name),
    ).toEqual(["a", "b", "c"]);
    await cleanupJobManager(runId);
    expect(getJobManager(runId).list()).toEqual([]);
  });
});

describe("job tools", () => {
  test("run_job/list_jobs/read_job_log/wait_for_job share the run job table", async () => {
    const c = ctx();
    const started = await runJobTool.execute(
      { argv: ["bash", "-lc", "echo tool-job"], name: "tool-job" },
      c,
      c.signal,
    );
    expect(started.isError).toBeUndefined();
    const jobId = JSON.parse(started.content as string).id as string;

    const waited = await waitForJobTool.execute({ jobId, timeoutMs: 5_000 }, c, c.signal);
    expect(waited.isError).toBeUndefined();
    const listed = await listJobsTool.execute({}, c, c.signal);
    expect(listed.content as string).toContain(jobId);
    const log = await readJobLogTool.execute({ jobId }, c, c.signal);
    expect(log.content as string).toContain("tool-job");
  });
});

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
