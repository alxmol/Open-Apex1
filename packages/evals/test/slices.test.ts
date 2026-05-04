import { describe, expect, test } from "bun:test";

import {
  getTaskEntry,
  listSlices,
  loadSlice,
  TB2_DATASET_COMMIT,
  TB2_TASK_INVENTORY,
  tasksByCategory,
  tasksByDifficulty,
  validateManifest,
} from "../src/slices/index.ts";

describe("TB2_TASK_INVENTORY (§7.6.5)", () => {
  test("contains exactly 89 tasks", () => {
    expect(TB2_TASK_INVENTORY.length).toBe(89);
  });

  test("pinned commit matches §0.6 frozen artifact", () => {
    expect(TB2_DATASET_COMMIT).toBe("69671fbaac6d67a7ef0dfec016cc38a64ef7a77c");
  });

  test("no duplicate task ids", () => {
    const ids = TB2_TASK_INVENTORY.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("category counts match §6 Purpose (26 SE, 9 sysadmin, 8 security, etc.)", () => {
    expect(tasksByCategory("software-engineering").length).toBe(26);
    expect(tasksByCategory("system-administration").length).toBe(9);
    expect(tasksByCategory("security").length).toBe(8);
    expect(tasksByCategory("data-science").length).toBe(8);
    expect(tasksByCategory("scientific-computing").length).toBe(8);
    expect(tasksByCategory("debugging").length).toBe(5);
    expect(tasksByCategory("file-operations").length).toBe(5);
    expect(tasksByCategory("mathematics").length).toBe(4);
    expect(tasksByCategory("model-training").length).toBe(4);
    expect(tasksByCategory("data-processing").length).toBe(4);
    expect(tasksByCategory("machine-learning").length).toBe(3);
    expect(tasksByCategory("games").length).toBe(1);
    expect(tasksByCategory("personal-assistant").length).toBe(1);
    expect(tasksByCategory("optimization").length).toBe(1);
    expect(tasksByCategory("data-querying").length).toBe(1);
    expect(tasksByCategory("video-processing").length).toBe(1);
  });

  test("difficulty distribution", () => {
    const easy = tasksByDifficulty("easy").length;
    const medium = tasksByDifficulty("medium").length;
    const hard = tasksByDifficulty("hard").length;
    expect(easy + medium + hard).toBe(89);
    expect(hard).toBe(30); // matches §7.6.5 tb2-slice-hard-only = 30
  });

  test("verifier_timeout_sec falls within the documented 360-12000s range", () => {
    for (const t of TB2_TASK_INVENTORY) {
      expect(t.verifier_timeout_sec).toBeGreaterThanOrEqual(360);
      expect(t.verifier_timeout_sec).toBeLessThanOrEqual(12_000);
    }
  });

  test("getTaskEntry returns entry for known id, undefined otherwise", () => {
    expect(getTaskEntry("fix-git")?.difficulty).toBe("easy");
    expect(getTaskEntry("nope-nonexistent")).toBeUndefined();
  });
});

describe("SliceManifest validator (§7.6.5)", () => {
  test("valid manifest passes", () => {
    const errs = validateManifest({
      id: "tb2-smoke-6",
      description: "smoke manifest",
      kind: "smoke",
      pinned_commit: TB2_DATASET_COMMIT,
      task_ids: ["fix-git", "overfull-hbox"],
    });
    expect(errs).toEqual([]);
  });

  test("rejects unknown task_id", () => {
    const errs = validateManifest({
      id: "bad",
      description: "xxxxx",
      kind: "smoke",
      pinned_commit: TB2_DATASET_COMMIT,
      task_ids: ["fake-task-that-doesnt-exist"],
    });
    expect(errs.some((e) => e.path === "$.task_ids[0]")).toBe(true);
  });

  test("rejects wrong pinned_commit (prevents drift against inventory)", () => {
    const errs = validateManifest({
      id: "drifted",
      description: "xxxxx",
      kind: "smoke",
      pinned_commit: "deadbeef",
      task_ids: ["fix-git"],
    });
    expect(errs.some((e) => e.path === "$.pinned_commit")).toBe(true);
  });

  test("rejects duplicate task_ids in the same manifest", () => {
    const errs = validateManifest({
      id: "dupes",
      description: "xxxxx",
      kind: "smoke",
      pinned_commit: TB2_DATASET_COMMIT,
      task_ids: ["fix-git", "fix-git"],
    });
    expect(errs.some((e) => e.message.includes("duplicate"))).toBe(true);
  });

  test("rejects empty task_ids", () => {
    const errs = validateManifest({
      id: "empty",
      description: "xxxxx",
      kind: "smoke",
      pinned_commit: TB2_DATASET_COMMIT,
      task_ids: [],
    });
    expect(errs.some((e) => e.path === "$.task_ids")).toBe(true);
  });
});

describe("shipped slice manifests (§7.6.5)", () => {
  test("loadSlice tb2-smoke-6 has exactly 6 tasks, all from the inventory", async () => {
    const m = await loadSlice("tb2-smoke-6");
    expect(m.kind).toBe("smoke");
    expect(m.task_ids).toHaveLength(6);
    expect(m.task_ids).toContain("fix-git");
    expect(m.task_ids).toContain("overfull-hbox");
  });

  test("loadSlice tb2-full-89 has exactly 89 tasks", async () => {
    const m = await loadSlice("tb2-full-89");
    expect(m.kind).toBe("full");
    expect(m.task_ids).toHaveLength(89);
  });

  test("loadSlice tb2-slice-software-engineering has 26 tasks", async () => {
    const m = await loadSlice("tb2-slice-software-engineering");
    expect(m.kind).toBe("category");
    expect(m.task_ids).toHaveLength(26);
    for (const tid of m.task_ids) {
      expect(getTaskEntry(tid)?.category).toBe("software-engineering");
    }
  });

  test("cross-cutting slices use kind=cross-cutting", async () => {
    for (const id of ["tb2-slice-long-running", "tb2-slice-hard-only", "tb2-slice-search-heavy"]) {
      const m = await loadSlice(id);
      expect(m.kind).toBe("cross-cutting");
    }
  });

  test("listSlices returns every shipped manifest (20 total)", async () => {
    const slices = await listSlices();
    // 16 category slices + 3 cross-cutting + 1 full + 1 smoke = 21.
    // Actual: 1 smoke + 16 category + 3 cross-cutting + 1 full = 21.
    // Only categories with non-zero tasks are generated (all 16 have tasks).
    expect(slices.length).toBeGreaterThanOrEqual(21);
    const ids = slices.map((s) => s.id);
    expect(ids).toContain("tb2-smoke-6");
    expect(ids).toContain("tb2-full-89");
    expect(ids).toContain("tb2-slice-software-engineering");
    expect(ids).toContain("tb2-slice-long-running");
    expect(ids).toContain("tb2-slice-hard-only");
    expect(ids).toContain("tb2-slice-search-heavy");
  });

  test("every shipped manifest passes validator", async () => {
    const slices = await listSlices();
    for (const s of slices) {
      const errs = validateManifest(s);
      expect(errs).toEqual([]);
    }
  });
});
