import { describe, expect, test } from "bun:test";

import { decideSearchTrigger, similarity } from "../src/trigger.ts";

describe("decideSearchTrigger (selective policy)", () => {
  test("aggressiveness=off never triggers", () => {
    const d = decideSearchTrigger({
      taskText: "look up how to install FastAPI",
      aggressiveness: "off",
    });
    expect(d.trigger).toBe(false);
  });

  test("explicit 'look up' verb triggers even at selective", () => {
    const d = decideSearchTrigger({
      taskText: "Please look up the current stable version of PyTorch.",
      aggressiveness: "selective",
    });
    expect(d.trigger).toBe(true);
    expect(d.reason).toMatch(/^explicit_search_verb/);
  });

  test("framework + question mark triggers at selective", () => {
    const d = decideSearchTrigger({
      taskText: "How does FastAPI handle websocket disconnects?",
      aggressiveness: "selective",
    });
    expect(d.trigger).toBe(true);
    expect(d.reason).toContain("framework_uncertainty:fastapi");
    expect(d.suggestedQuery).toContain("fastapi");
  });

  test("no signal returns trigger=false at selective", () => {
    const d = decideSearchTrigger({
      taskText: "fix the typo on line 17 of src/main.ts",
      aggressiveness: "selective",
    });
    expect(d.trigger).toBe(false);
  });

  test("repeated same-signature stderr triggers search", () => {
    const stderr =
      "Traceback (most recent call last):\n" +
      '  File "foo.py", line 42, in <module>\n' +
      '    raise ValueError("Operation failed: foo")\n' +
      "ValueError: Operation failed: foo";
    const d = decideSearchTrigger({
      taskText: "Fix the failing test.",
      recentStderrTails: [stderr, stderr],
      aggressiveness: "selective",
    });
    expect(d.trigger).toBe(true);
    expect(d.reason).toBe("repeated_same_signature_failure");
  });

  test("proactive mode triggers on prediction-backed framework hints", () => {
    const d = decideSearchTrigger({
      taskText: "Set up an inference endpoint.",
      aggressiveness: "proactive",
      prediction: {
        taskCategory: "machine_learning",
        keyFiles: [],
        multimodalNeeded: false,
        riskProfile: "low",
        likelyLanguages: ["python"],
        likelyFrameworks: ["pytorch"],
        notes: "",
      },
    });
    expect(d.trigger).toBe(true);
    expect(d.reason).toBe("proactive_prediction_hint");
  });
});

describe("similarity", () => {
  test("identical strings → 1", () => {
    expect(similarity("hello world", "hello world")).toBe(1);
  });
  test("disjoint tokens → 0", () => {
    expect(similarity("aaa bbb ccc", "xxx yyy zzz")).toBe(0);
  });
  test("partial overlap in (0, 1)", () => {
    const s = similarity(
      "traceback valueerror operation failed foo",
      "traceback valueerror operation succeeded bar",
    );
    expect(s).toBeGreaterThan(0);
    expect(s).toBeLessThan(1);
  });
});
