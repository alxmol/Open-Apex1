/**
 * Harbor trajectory_validator conformance test.
 * Required by §5.5: "CI runs `python -m harbor.utils.trajectory_validator`
 * on every emitted ATIF fixture as a contract test — a failure blocks merge."
 *
 * This is a LIVE test (it invokes Harbor's Python validator via subprocess)
 * but does NOT require API keys — it just needs the Harbor Python package.
 * We key it off the `harbor` CLI being on PATH so it runs by default when
 * Harbor is installed (uv tool install harbor) and skips otherwise.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import { AtifWriter } from "../src/atif-writer.ts";

async function harborPython(): Promise<string | null> {
  // Look for the uv-tool install at the known location first.
  const uvPath = `${process.env.HOME}/.local/share/uv/tools/harbor/bin/python`;
  const f = Bun.file(uvPath);
  if (await f.exists()) return uvPath;
  // Fallback: system python3 with `harbor` importable.
  const probe = Bun.spawn(["python3", "-c", "import harbor; print(harbor.__version__)"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await probe.exited;
  if (probe.exitCode === 0) return "python3";
  return null;
}

async function runValidator(
  pythonPath: string,
  trajectoryPath: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn([pythonPath, "-m", "harbor.utils.trajectory_validator", trajectoryPath], {
    stdout: "pipe",
    stderr: "pipe",
  });
  await p.exited;
  const stdout = await new Response(p.stdout).text();
  const stderr = await new Response(p.stderr).text();
  return { code: p.exitCode ?? -1, stdout, stderr };
}

describe("Harbor trajectory_validator conformance", () => {
  test("golden fixture passes Harbor's Python validator", async () => {
    const py = await harborPython();
    if (!py) {
      console.log(
        "  (skipped: Harbor python not importable; install via `uv tool install harbor`)",
      );
      return;
    }
    const p = new URL("./golden/trajectory-minimal.json", import.meta.url).pathname;
    const result = await runValidator(py, p);
    expect({
      code: result.code,
      stderr: result.stderr.slice(0, 2000),
    }).toEqual({
      code: 0,
      stderr: expect.any(String),
    });
  });

  test("dynamically-built trajectory from AtifWriter passes validator", async () => {
    const py = await harborPython();
    if (!py) {
      console.log("  (skipped: Harbor python not importable)");
      return;
    }
    const dir = mkdtempSync(path.join(tmpdir(), "openapex-atif-"));
    const outPath = path.join(dir, "trajectory.json");
    const w = new AtifWriter({
      sessionId: "s_harbor_conformance",
      agent: { name: "open-apex", version: "0.0.1" },
      outputPath: outPath,
      redactOnWrite: false,
    });
    w.appendStep({ source: "user", message: "fix the bug" });
    // Harbor requires tool_calls + their observation on the SAME step.
    w.appendStep({
      source: "agent",
      model_name: "claude-opus-4-6",
      reasoning_effort: "high",
      message: "I will read the file first.",
      tool_calls: [
        {
          tool_call_id: "t1",
          function_name: "read_file",
          arguments: { path: "src/a.ts" },
        },
      ],
      observation: {
        results: [
          {
            source_call_id: "t1",
            content: "export function a() { return 1; }",
          },
        ],
      },
      metrics: {
        prompt_tokens: 100,
        completion_tokens: 20,
        cached_tokens: 0,
        cost_usd: 0.001,
      },
    });
    w.setFinalMetrics({
      total_prompt_tokens: 100,
      total_completion_tokens: 20,
      total_cached_tokens: 0,
      total_cost_usd: 0.001,
      total_steps: 2,
    });
    await w.flush();

    const result = await runValidator(py, outPath);
    if (result.code !== 0) {
      console.error("validator stdout:\n" + result.stdout);
      console.error("validator stderr:\n" + result.stderr);
    }
    expect(result.code).toBe(0);
  });
});
