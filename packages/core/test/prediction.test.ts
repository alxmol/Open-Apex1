import { describe, expect, test } from "bun:test";

import { predict } from "../src/prediction/predict.ts";

describe("predict — task category", () => {
  test.each([
    [
      "Refactor the add() function in src/calculator.py so the unit test passes.",
      "software_engineering",
    ],
    [
      "Configure nginx to proxy requests to the backend service, then systemctl restart nginx.",
      "system_administration",
    ],
    ["Crack the 7z password using the provided hash file and return the key.", "security"],
    [
      "Run MCMC sampling in Stan to fit the model and report posterior means.",
      "scientific_computing",
    ],
    ["Convert the GCODE file to human-readable text and save to output.txt.", "file_operations"],
    ["Diagnose the segfault in a.out and propose a patch to the C source.", "debugging"],
    ["Train a FastText model on the provided corpus for 5 epochs.", "model_training"],
    ["Execute a SPARQL query against the university KG and return the JSON.", "data_querying"],
    [
      "Process the video.mp4 file: extract frames and count unique motion events.",
      "video_processing",
    ],
  ])("%s → %s", (text, expected) => {
    const p = predict({ taskText: text });
    expect(p.taskCategory).toBe(expected as ReturnType<typeof predict>["taskCategory"]);
  });

  test("unrelated small-talk falls back to other", () => {
    const p = predict({ taskText: "Hello, just saying hi." });
    expect(p.taskCategory).toBe("other");
  });
});

describe("predict — key file extraction", () => {
  test("captures paths mentioned verbatim", () => {
    const p = predict({
      taskText: "Edit src/calculator/__init__.py and tests/test_calc.py so pytest passes.",
    });
    expect(p.keyFiles).toContain("src/calculator/__init__.py");
    expect(p.keyFiles).toContain("tests/test_calc.py");
  });
  test("deduplicates", () => {
    const p = predict({
      taskText: "Fix src/main.ts. Now re-check src/main.ts.",
    });
    expect(p.keyFiles.filter((f) => f === "src/main.ts")).toHaveLength(1);
  });
  test("ignores sentences without recognizable extensions", () => {
    const p = predict({
      taskText: "Do the thing.",
    });
    expect(p.keyFiles).toEqual([]);
  });
});

describe("predict — multimodal detection", () => {
  test("detects PNG filename", () => {
    const p = predict({ taskText: "Summarize the content of diagram.png" });
    expect(p.multimodalNeeded).toBe(true);
    expect(p.trace.multimodalMatch?.toLowerCase()).toContain("diagram.png");
  });
  test("detects PDF filename", () => {
    const p = predict({ taskText: "Extract the total from invoice.pdf" });
    expect(p.multimodalNeeded).toBe(true);
  });
  test("detects phrases like 'this image'", () => {
    const p = predict({ taskText: "Describe the shapes shown in this image." });
    expect(p.multimodalNeeded).toBe(true);
  });
  test("does not flag plain code tasks", () => {
    const p = predict({ taskText: "Run the tests and fix failures." });
    expect(p.multimodalNeeded).toBe(false);
  });
});

describe("predict — risk profile", () => {
  test("high risk on destructive verbs against prod", () => {
    const p = predict({
      taskText: "Drop the production database and recreate it from the seed script.",
    });
    expect(p.riskProfile).toBe("high");
  });
  test("high risk on force push to main", () => {
    const p = predict({
      taskText: "Run git force-push to the main branch to resolve the conflict.",
    });
    expect(p.riskProfile).toBe("high");
  });
  test("medium risk on sudo installs", () => {
    const p = predict({
      taskText: "Use sudo to install the missing system package.",
    });
    expect(p.riskProfile).toBe("medium");
  });
  test("low risk on ordinary edits", () => {
    const p = predict({
      taskText: "Add a helper function to src/util.ts.",
    });
    expect(p.riskProfile).toBe("low");
  });
});

describe("predict — language and framework hints", () => {
  test("infers python + fastapi when mentioned", () => {
    const p = predict({
      taskText: "Add a websocket endpoint to the FastAPI app (Python).",
    });
    expect(p.likelyLanguages).toContain("python");
    expect(p.likelyFrameworks).toContain("fastapi");
  });
  test("infers languages from repo counts when task text is empty", () => {
    const p = predict({
      taskText: "Fix the test.",
      repoLanguageCounts: { rust: 40, python: 2 },
    });
    expect(p.likelyLanguages).toContain("rust");
  });
});

describe("predict — notes field summarizes", () => {
  test("notes contain category + risk + multimodal markers", () => {
    const p = predict({
      taskText: "Extract the total from invoice.pdf and update src/billing.py.",
    });
    expect(p.notes).toContain("category=");
    expect(p.notes).toContain("risk=low");
    expect(p.notes).toContain("multimodal");
  });
});
