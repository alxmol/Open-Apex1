import { describe, expect, test } from "bun:test";

import { parseDurationMs } from "../src/runtime/duration.ts";

describe("parseDurationMs", () => {
  test("accepts explicit millisecond, second, and minute suffixes", () => {
    expect(parseDurationMs("570000", 1)).toBe(570_000);
    expect(parseDurationMs("900s", 1)).toBe(900_000);
    expect(parseDurationMs("15m", 1)).toBe(900_000);
    expect(parseDurationMs("250ms", 1)).toBe(250);
  });

  test("treats small bare benchmark values as seconds", () => {
    expect(parseDurationMs("900", 1)).toBe(900_000);
    expect(parseDurationMs("570000", 1)).toBe(570_000);
  });

  test("falls back on missing or invalid values", () => {
    expect(parseDurationMs(undefined, 1234)).toBe(1234);
    expect(parseDurationMs("not-a-duration", 1234)).toBe(1234);
    expect(parseDurationMs("-5s", 1234)).toBe(1234);
  });
});
