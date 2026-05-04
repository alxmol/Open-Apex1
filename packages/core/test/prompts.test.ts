/**
 * Prompt-assembly tests.
 *   - Frontmatter parser: happy + unhappy
 *   - All four provider appendices load with correct version ids
 *   - System prompt assembly round-trips and records prompt_versions
 *   - Tool section renders each tool's description
 */

import { describe, expect, test } from "bun:test";

import {
  assembleSystemPrompt,
  loadPromptFromFile,
  parsePromptText,
  PromptParseError,
  resolvePromptPaths,
} from "../src/prompts/index.ts";

describe("parsePromptText (frontmatter)", () => {
  test("parses prompt_version + body", () => {
    const src = "---\nprompt_version: test.v3\n---\nhello\n";
    const p = parsePromptText(src, "test.md");
    expect(p.version).toBe("test.v3");
    expect(p.body).toBe("hello");
    expect(p.frontmatter.prompt_version).toBe("test.v3");
  });

  test("rejects missing frontmatter", () => {
    expect(() => parsePromptText("no frontmatter", "x.md")).toThrow(PromptParseError);
  });

  test("rejects unterminated frontmatter", () => {
    expect(() => parsePromptText("---\nprompt_version: x\n", "x.md")).toThrow(PromptParseError);
  });

  test("rejects missing prompt_version", () => {
    expect(() => parsePromptText("---\nother: foo\n---\nbody", "x.md")).toThrow(PromptParseError);
  });

  test("tolerates comment lines in frontmatter", () => {
    const src = "---\n# comment\nprompt_version: v1\n---\nbody\n";
    expect(parsePromptText(src, "x.md").version).toBe("v1");
  });
});

describe("shipped prompt files", () => {
  test("identity.v1.md loads with correct version", async () => {
    const paths = resolvePromptPaths("openai-gpt-5.4");
    const p = await loadPromptFromFile(paths.identityPath);
    expect(p.version).toBe("identity.v1");
    expect(p.body).toContain("Open-Apex");
  });

  test("base-instructions.v2.md loads with correct version", async () => {
    const paths = resolvePromptPaths("openai-gpt-5.4");
    const p = await loadPromptFromFile(paths.baseInstructionsPath);
    expect(p.version).toBe("base-instructions.v2");
    expect(p.body).toContain("Tool use");
    expect(p.body).toContain("Use only tools that are actually listed");
    expect(p.body).toContain("functions.exec_command");
    // §M3 additions — must survive as contract anchors.
    expect(p.body).toContain("Orientation and lookup");
    expect(p.body).toContain("symbol_lookup");
    expect(p.body).toContain("read_asset");
    expect(p.body).toContain("web_search");
    expect(p.body).toContain("sourceTier");
  });

  test.each([
    ["openai-gpt-5.4", "appendix.openai-gpt-5.4.v2"],
    ["anthropic-sonnet-4.6", "appendix.anthropic-sonnet-4.6.v1"],
    ["anthropic-opus-4.6", "appendix.anthropic-opus-4.6.v1"],
    ["anthropic-opus-4.7", "appendix.anthropic-opus-4.7.v1"],
  ] as const)("provider appendix %s version pin", async (key, expected) => {
    const paths = resolvePromptPaths(key);
    const p = await loadPromptFromFile(paths.providerAppendixPath);
    expect(p.version).toBe(expected);
    if (key === "openai-gpt-5.4") {
      // v2 tightens the language around hallucinated tool syntax while
      // deferring to the live manifest instead of a stale hardcoded list.
      expect(p.body).toContain("NEVER executed");
      expect(p.body).toContain("multi_tool_use.parallel");
      expect(p.body).toContain("authoritative manifest");
      expect(p.body).toContain("`web_search`");
      expect(p.body).toContain("`fetch_url`");
      expect(p.body).toContain("`read_asset`");
      expect(p.body).not.toContain("M1 benchmark run");
      expect(p.body).not.toContain("Tools outside this list do not exist");
    }
    if (key === "anthropic-opus-4.6" || key === "anthropic-opus-4.7") {
      expect(p.body).toContain("Keep searches narrow");
      expect(p.body).toContain("parallel queries must ask different questions");
      expect(p.body).toContain("After 2-3 low-yield broad searches");
      expect(p.body).toContain("local/package/API inspection");
    }
  });
});

describe("assembleSystemPrompt", () => {
  test("layers identity + base + tools + appendix and records prompt_versions", async () => {
    const paths = resolvePromptPaths("openai-gpt-5.4");
    const result = await assembleSystemPrompt({
      identityPath: paths.identityPath,
      baseInstructionsPath: paths.baseInstructionsPath,
      providerAppendixPath: paths.providerAppendixPath,
      tools: [
        {
          name: "read_file",
          description: "Read file contents at a path",
          parameters: { type: "object", properties: {} },
        },
        {
          name: "list_tree",
          description: "List files and directories",
          parameters: { type: "object", properties: {} },
        },
      ],
    });
    expect(result.text).toContain("Open-Apex");
    expect(result.text).toContain("Tool use");
    expect(result.text).toContain("`read_file`");
    expect(result.text).toContain("Read file contents at a path");
    expect(result.text).toContain("`list_tree`");
    expect(result.text).toContain("GPT-5.4");
    expect(result.versions.identity).toBe("identity.v1");
    expect(result.versions.base_instructions).toBe("base-instructions.v2");
    expect(result.versions.appendix).toBe("appendix.openai-gpt-5.4.v2");
    expect(result.cacheBreakpointOffsets).toEqual([result.text.length]);
  });

  test("different provider appendices produce different prompt texts", async () => {
    const oa = resolvePromptPaths("openai-gpt-5.4");
    const an = resolvePromptPaths("anthropic-opus-4.6");
    const a = await assembleSystemPrompt({
      identityPath: oa.identityPath,
      baseInstructionsPath: oa.baseInstructionsPath,
      providerAppendixPath: oa.providerAppendixPath,
      tools: [],
    });
    const b = await assembleSystemPrompt({
      identityPath: an.identityPath,
      baseInstructionsPath: an.baseInstructionsPath,
      providerAppendixPath: an.providerAppendixPath,
      tools: [],
    });
    expect(a.text).not.toBe(b.text);
    expect(a.versions.appendix).toBe("appendix.openai-gpt-5.4.v2");
    expect(b.versions.appendix).toBe("appendix.anthropic-opus-4.6.v1");
  });

  test("tools-less assembly still succeeds (first-turn fallback)", async () => {
    const paths = resolvePromptPaths("anthropic-sonnet-4.6");
    const result = await assembleSystemPrompt({
      identityPath: paths.identityPath,
      baseInstructionsPath: paths.baseInstructionsPath,
      providerAppendixPath: paths.providerAppendixPath,
      tools: [],
    });
    expect(result.text).toContain("no tools available");
  });

  test("OpenAI prompt keeps M3 tools consistent with the live manifest", async () => {
    const paths = resolvePromptPaths("openai-gpt-5.4");
    const result = await assembleSystemPrompt({
      identityPath: paths.identityPath,
      baseInstructionsPath: paths.baseInstructionsPath,
      providerAppendixPath: paths.providerAppendixPath,
      tools: [
        {
          name: "web_search",
          description: "Search the web with benchmark contamination filtering",
          parameters: { type: "object", properties: {} },
        },
        {
          name: "fetch_url",
          description: "Fetch a specific URL",
          parameters: { type: "object", properties: {} },
        },
        {
          name: "read_asset",
          description: "Attach an image or PDF",
          parameters: { type: "object", properties: {} },
        },
        {
          name: "symbol_lookup",
          description: "Find symbols",
          parameters: { type: "object", properties: {} },
        },
        {
          name: "repo_map",
          description: "Map the repository",
          parameters: { type: "object", properties: {} },
        },
      ],
    });
    expect(result.text).toContain("`web_search`");
    expect(result.text).toContain("`fetch_url`");
    expect(result.text).toContain("`read_asset`");
    expect(result.text).toContain("`symbol_lookup`");
    expect(result.text).toContain("`repo_map`");
    expect(result.text).toContain(
      "The `## Tools available this turn` section above is the authoritative manifest",
    );
    expect(result.text).not.toContain("M1 benchmark run");
    expect(result.text).not.toContain("Tools outside this list do not exist");
  });
});
