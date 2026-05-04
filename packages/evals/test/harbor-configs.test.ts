import { readFile } from "node:fs/promises";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

const SMOKE_TASKS = [
  "fix-git",
  "configure-git-webserver",
  "hf-model-inference",
  "crack-7z-hash",
  "gcode-to-text",
  "overfull-hbox",
];

const TB2_12_PLUS_TASKS = [
  "fix-git",
  "count-dataset-tokens",
  "hf-model-inference",
  "build-pov-ray",
  "gcode-to-text",
  "overfull-hbox",
  "cobol-modernization",
  "adaptive-rejection-sampler",
  "break-filter-js-from-html",
  "build-cython-ext",
  "build-pmars",
  "financial-document-processor",
  "chess-best-move",
  "gpt2-codegolf",
  "large-scale-text-editing",
  "largest-eigenval",
  "log-summary-date-ranges",
  "make-doom-for-mips",
  "merge-diff-arc-agi-task",
  "modernize-scientific-stack",
];

const TB2_ORIGINAL_12_TASKS = [
  "fix-git",
  "count-dataset-tokens",
  "hf-model-inference",
  "build-pov-ray",
  "gcode-to-text",
  "overfull-hbox",
  "cobol-modernization",
  "adaptive-rejection-sampler",
  "break-filter-js-from-html",
  "build-cython-ext",
  "build-pmars",
  "financial-document-processor",
];

async function loadConfig(name: string): Promise<Record<string, any>> {
  const root = path.resolve(import.meta.dir, "..");
  return JSON.parse(await readFile(path.join(root, "harbor-configs", name), "utf8")) as Record<
    string,
    any
  >;
}

describe("Harbor TBench smoke configs", () => {
  test.each([
    ["tb2-smoke-gpt54-15m.json", "tb2-gpt54"],
    ["tb2-smoke-opus46-15m.json", "tb2-opus46"],
  ])("%s caps agent trials at 15 minutes and leaves verifier uncapped", async (file, preset) => {
    const cfg = await loadConfig(file);
    expect(cfg.agents).toHaveLength(1);
    expect(cfg.agents[0].import_path).toBe("open_apex_agent:OpenApexAgent");
    expect(cfg.agents[0].max_timeout_sec).toBe(900);
    expect(cfg.agents[0].kwargs.preset).toBe(preset);
    expect(cfg.verifier.max_timeout_sec).toBeNull();
    expect(cfg.datasets).toHaveLength(1);
    expect(cfg.datasets[0].name).toBe("terminal-bench");
    expect(cfg.datasets[0].version).toBe("2.0");
    expect(cfg.datasets[0].task_names).toEqual(SMOKE_TASKS);
  });

  test.each([
    ["tb2-12-gpt54-15m.json", "tb2-gpt54", 570],
    ["tb2-12-opus46-15m.json", "tb2-opus46", 570],
  ])(
    "%s matches the expanded tb2-12 task run command with shortened agent cap",
    async (file, preset, maxTimeoutSec) => {
      const cfg = await loadConfig(file);
      expect(cfg.agents).toHaveLength(1);
      expect(cfg.agents[0].import_path).toBe("open_apex_agent:OpenApexAgent");
      expect(cfg.agents[0].max_timeout_sec).toBe(maxTimeoutSec);
      expect(cfg.agents[0].kwargs).toEqual({ preset, dev_fallback: true });
      expect(cfg.verifier.max_timeout_sec).toBeNull();
      expect(cfg.datasets).toHaveLength(1);
      expect(cfg.datasets[0].name).toBe("terminal-bench");
      expect(cfg.datasets[0].version).toBe("2.0");
      expect(cfg.datasets[0].task_names).toEqual(TB2_12_PLUS_TASKS);
    },
  );

  test.each([
    ["tb2-original-12-gpt54-15m.json", "tb2-gpt54", 900, 3],
    ["tb2-original-12-opus46-15m.json", "tb2-opus46", 900, 4],
  ])(
    "%s preserves the original 12-task set",
    async (file, preset, maxTimeoutSec, nConcurrentTrials) => {
      const cfg = await loadConfig(file);
      expect(cfg.job_name).toBe(file.replace(/\.json$/, ""));
      expect(cfg.n_concurrent_trials).toBe(nConcurrentTrials);
      expect(cfg.agents).toHaveLength(1);
      expect(cfg.agents[0].import_path).toBe("open_apex_agent:OpenApexAgent");
      expect(cfg.agents[0].max_timeout_sec).toBe(maxTimeoutSec);
      expect(cfg.agents[0].kwargs).toEqual({ preset, dev_fallback: true });
      expect(cfg.verifier.max_timeout_sec).toBeNull();
      expect(cfg.datasets).toHaveLength(1);
      expect(cfg.datasets[0].name).toBe("terminal-bench");
      expect(cfg.datasets[0].version).toBe("2.0");
      expect(cfg.datasets[0].task_names).toEqual(TB2_ORIGINAL_12_TASKS);
    },
  );
});
