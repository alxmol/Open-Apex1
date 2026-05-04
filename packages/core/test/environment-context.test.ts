import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { renderEnvironmentContext } from "../src/prompts/environment-context.ts";

function tmpWs(seed: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openapex-envctx-"));
  for (const [rel, content] of Object.entries(seed)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

describe("renderEnvironmentContext (§M3 enrichment)", () => {
  test("includes preset + benchmark flag + top-level listing", async () => {
    const ws = tmpWs({ "src/main.py": "", "README.md": "" });
    const out = await renderEnvironmentContext({
      workspace: ws,
      presetId: "tb2-gpt54",
      benchmarkMode: true,
      networkEnabled: true,
    });
    expect(out).toContain("preset: tb2-gpt54");
    expect(out).toContain("benchmark_mode: true");
    expect(out).toContain("network_enabled: true");
    expect(out).toMatch(/workspace top-level/);
  });

  test("appends prediction block when supplied", async () => {
    const ws = tmpWs({ "a.py": "" });
    const out = await renderEnvironmentContext({
      workspace: ws,
      presetId: "tb2-opus46",
      benchmarkMode: false,
      networkEnabled: true,
      prediction: {
        taskCategory: "software_engineering",
        multimodalNeeded: false,
        riskProfile: "low",
        likelyLanguages: ["python"],
        likelyFrameworks: ["fastapi"],
        keyFiles: ["src/app.py", "tests/test_app.py"],
      },
    });
    expect(out).toContain("prediction: category=software_engineering");
    expect(out).toContain("risk=low");
    expect(out).toContain("likely_languages: python");
    expect(out).toContain("likely_frameworks: fastapi");
    expect(out).toContain("key_files:");
  });

  test("appends targeted search advice for external-doc-heavy tasks", async () => {
    const ws = tmpWs({ "a.py": "" });
    const out = await renderEnvironmentContext({
      workspace: ws,
      presetId: "tb2-gpt54",
      benchmarkMode: true,
      networkEnabled: true,
      taskText:
        "Use the MTEB leaderboard and Hugging Face model inference docs to produce results.",
      prediction: {
        taskCategory: "data_science",
        multimodalNeeded: false,
        riskProfile: "low",
        likelyFrameworks: ["mteb", "huggingface"],
      },
    });
    expect(out).toContain("search_advice: external docs likely useful");
    expect(out).toContain(
      "query_hint: MTEB official package source leaderboard results data files",
    );
    expect(out).toContain(
      "query_hint: Hugging Face org Space dataset files model inference API official docs",
    );
  });

  test("appends targeted search advice for protein/API and QEMU tasks", async () => {
    const ws = tmpWs({ "a.py": "" });
    const protein = await renderEnvironmentContext({
      workspace: ws,
      presetId: "tb2-opus46",
      benchmarkMode: true,
      networkEnabled: true,
      taskText: "Assemble protein data from PDB/RCSB and FPbase identifiers.",
      prediction: {
        taskCategory: "data_science",
        multimodalNeeded: false,
        riskProfile: "medium",
        likelyFrameworks: ["rcsb", "fpbase"],
      },
    });
    expect(protein).toContain("query_hint: RCSB PDB REST API official docs batch structure query");
    expect(protein).toContain("query_hint: FPbase API official docs fluorescent protein data");

    const qemu = await renderEnvironmentContext({
      workspace: ws,
      presetId: "tb2-gpt54",
      benchmarkMode: true,
      networkEnabled: true,
      taskText: "Boot an Alpine VM with QEMU and SSH hostfwd.",
      prediction: {
        taskCategory: "system_administration",
        multimodalNeeded: false,
        riskProfile: "high",
        likelyFrameworks: ["qemu"],
      },
    });
    expect(qemu).toContain("query_hint: QEMU user networking hostfwd SSH official documentation");
    expect(qemu).toContain(
      "query_hint: QEMU serial console nographic boot ISO monitor official documentation",
    );
  });

  test("does not append search advice for local-only tasks or network-disabled runs", async () => {
    const ws = tmpWs({ "a.py": "" });
    const localOnly = await renderEnvironmentContext({
      workspace: ws,
      presetId: "tb2-opus46",
      benchmarkMode: true,
      networkEnabled: true,
      taskText: "Fix the failing unit test in src/app.py.",
      prediction: {
        taskCategory: "software_engineering",
        multimodalNeeded: false,
        riskProfile: "low",
        likelyLanguages: ["python"],
      },
    });
    expect(localOnly).not.toContain("search_advice:");

    const networkOff = await renderEnvironmentContext({
      workspace: ws,
      presetId: "tb2-opus46",
      benchmarkMode: true,
      networkEnabled: false,
      taskText: "Use QEMU docs to configure hostfwd SSH.",
      prediction: {
        taskCategory: "system_administration",
        multimodalNeeded: false,
        riskProfile: "low",
        likelyFrameworks: ["qemu"],
      },
    });
    expect(networkOff).not.toContain("search_advice:");
  });

  test("appends repo_map block when supplied", async () => {
    const ws = tmpWs({ "a.py": "" });
    const out = await renderEnvironmentContext({
      workspace: ws,
      presetId: "tb2-opus46",
      benchmarkMode: false,
      networkEnabled: false,
      repoSummary: {
        totalFiles: 42,
        totalBytes: 1024,
        languageCounts: { python: 30, markdown: 12 },
        testFrameworks: ["pytest"],
        buildSystems: ["tsc"],
        packageManagers: ["pip"],
      },
    });
    expect(out).toContain("repo_map: 42 files");
    expect(out).toContain("python=30");
    expect(out).toContain("test_frameworks: pytest");
    expect(out).toContain("package_managers: pip");
  });
});
