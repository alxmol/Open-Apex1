/**
 * Prompt versioning contract.
 * Locked per §5.5 + §7.6.11.
 *
 * Every prompt artifact in `packages/core/src/prompts/` carries a
 * `prompt_version` in YAML frontmatter. The assembler collects the versions
 * it loaded into `AtifAgent.extra.prompt_versions`.
 */

export interface PromptFrontmatter {
  prompt_version: string;
  [k: string]: unknown;
}

export interface LoadedPrompt {
  path: string;
  version: string;
  frontmatter: PromptFrontmatter;
  body: string;
}

export interface AssembledSystemPrompt {
  /** Final rendered system prompt (identity + personality + base + tools + appendix). */
  text: string;
  /** Map of section name → prompt_version, for ATIF `agent.extra.prompt_versions`. */
  versions: Record<string, string>;
  /** Byte offsets of cache breakpoints (anthropic `cache_control`). */
  cacheBreakpointOffsets: number[];
}

/** §7.6.13 OPEN_APEX.md fragments collected from workspace walk. */
export interface ProjectDocFragment {
  /** Absolute path. */
  path: string;
  /** File content (trimmed to size budget). */
  content: string;
  mtimeMs: number;
  sizeBytes: number;
}
