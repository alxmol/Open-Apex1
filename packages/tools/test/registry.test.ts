import { describe, expect, test } from "bun:test";

import type { ToolDefinition } from "@open-apex/core";

import { ToolRegistryImpl } from "../src/index.ts";

function mkTool(name: string, kind: ToolDefinition["kind"] = "function"): ToolDefinition {
  return {
    name,
    description: `test tool ${name}`,
    kind,
    parameters: { type: "object", properties: {} },
    permissionClass: "READ_ONLY",
    execute: async () => ({ content: "" }),
    errorCodes: [],
  };
}

describe("ToolRegistryImpl (§7.6.12)", () => {
  test("register + get + list", () => {
    const r = new ToolRegistryImpl();
    r.register(mkTool("read_file"));
    r.register(mkTool("list_tree"));
    expect(r.size()).toBe(2);
    expect(r.get("read_file")?.name).toBe("read_file");
    expect(r.list().map((t) => t.name)).toEqual(["list_tree", "read_file"]);
  });

  test("duplicate registration rejected", () => {
    const r = new ToolRegistryImpl();
    r.register(mkTool("read_file"));
    expect(() => r.register(mkTool("read_file"))).toThrow(/already/);
  });

  test("listAllowed intersection", () => {
    const r = new ToolRegistryImpl();
    r.register(mkTool("read_file"));
    r.register(mkTool("write_file", "editor"));
    r.register(mkTool("run_shell", "shell"));
    const out = r.listAllowed(["read_file", "run_shell"], undefined);
    expect(out.map((t) => t.name).sort()).toEqual(["read_file", "run_shell"]);
  });

  test("listAllowed with exclusion for patch-first editing on existing files", () => {
    const r = new ToolRegistryImpl();
    r.register(mkTool("read_file"));
    r.register(mkTool("write_file", "editor"));
    r.register(mkTool("apply_patch", "apply_patch"));
    r.register(mkTool("search_replace", "editor"));
    // Per §1.2: for existing files, write_file is excluded from the allowed list
    // unless patch recovery opens it as a fallback.
    const out = r.listAllowed(undefined, ["write_file"]);
    expect(out.map((t) => t.name)).not.toContain("write_file");
    expect(out.map((t) => t.name)).toContain("apply_patch");
  });

  test("clear resets registry", () => {
    const r = new ToolRegistryImpl();
    r.register(mkTool("a"));
    r.clear();
    expect(r.size()).toBe(0);
  });
});
