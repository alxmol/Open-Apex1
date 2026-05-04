import { describe, expect, test } from "bun:test";
import { greet } from "../src/index.ts";

describe("greet", () => {
  test("returns hello, <name>", () => {
    expect(greet("world")).toBe("hello, world");
  });
});
