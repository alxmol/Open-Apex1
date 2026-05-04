import { describe, expect, test } from "bun:test";

import { ArgError, parseArgs } from "../src/index.ts";

function argv(...rest: string[]): string[] {
  return ["bun", "/path/to/bin.ts", ...rest];
}

describe("parseArgs (§3.3 CLI contract)", () => {
  test("no args → chat", () => {
    expect(parseArgs(argv())).toEqual({ kind: "chat" });
  });

  test("--version", () => {
    expect(parseArgs(argv("--version"))).toEqual({ kind: "version" });
    expect(parseArgs(argv("-v"))).toEqual({ kind: "version" });
  });

  test("--help with topic", () => {
    expect(parseArgs(argv("--help", "autonomous"))).toEqual({
      kind: "help",
      topic: "autonomous",
    });
  });

  test("verify-gate subcommand", () => {
    expect(parseArgs(argv("verify-gate"))).toEqual({ kind: "verify-gate" });
  });

  test("autonomous with all required flags", () => {
    const r = parseArgs(
      argv(
        "autonomous",
        "--workspace",
        "/ws",
        "--preset",
        "tb2-opus46",
        "--output-dir",
        "/out",
        "--task-file",
        "/t.txt",
      ),
    );
    expect(r).toEqual({
      kind: "autonomous",
      workspace: "/ws",
      preset: "tb2-opus46",
      outputDir: "/out",
      taskFile: "/t.txt",
      benchmark: false,
    });
  });

  test("autonomous --benchmark and --task-stdin flags", () => {
    const r = parseArgs(
      argv(
        "autonomous",
        "--workspace",
        "/ws",
        "--preset",
        "tb2-gpt54",
        "--output-dir",
        "/out",
        "--task-stdin",
        "--benchmark",
        "--max-turns",
        "80",
      ),
    );
    expect(r.kind).toBe("autonomous");
    if (r.kind !== "autonomous") throw new Error("unreachable");
    expect(r.benchmark).toBe(true);
    expect(r.taskStdin).toBe(true);
    expect(r.maxTurns).toBe(80);
  });

  test("autonomous rejects both --task-file and --task-stdin", () => {
    expect(() =>
      parseArgs(
        argv(
          "autonomous",
          "--workspace",
          "/ws",
          "--preset",
          "tb2-gpt54",
          "--output-dir",
          "/out",
          "--task-file",
          "/t",
          "--task-stdin",
        ),
      ),
    ).toThrow(ArgError);
  });

  test("autonomous rejects missing --workspace", () => {
    expect(() =>
      parseArgs(
        argv("autonomous", "--preset", "tb2-gpt54", "--output-dir", "/out", "--task-file", "/t"),
      ),
    ).toThrow(/--workspace/);
  });

  test("autonomous rejects bad --max-turns", () => {
    expect(() =>
      parseArgs(
        argv(
          "autonomous",
          "--workspace",
          "/ws",
          "--preset",
          "tb2-gpt54",
          "--output-dir",
          "/out",
          "--task-file",
          "/t",
          "--max-turns",
          "zero",
        ),
      ),
    ).toThrow(/positive integer/);
  });

  test("autonomous rejects bad --trajectory-schema-version", () => {
    expect(() =>
      parseArgs(
        argv(
          "autonomous",
          "--workspace",
          "/ws",
          "--preset",
          "tb2-gpt54",
          "--output-dir",
          "/out",
          "--task-file",
          "/t",
          "--trajectory-schema-version",
          "ATIF-v9.9",
        ),
      ),
    ).toThrow(/ATIF-v1\./);
  });
});
