/**
 * Minimal system-prompt assembler (M1).
 *
 * §7.6.11 specifies a 7-layer assembly. M1 ships a 4-layer subset:
 *   1. Identity
 *   2. Base instructions
 *   3. Tool descriptions (rendered from the active tool manifest)
 *   4. Provider appendix (per-preset)
 *
 * Deferred to M5: capabilities-not-reverted table, `<environment_context>`
 * per-turn regeneration, OPEN_APEX.md injection, developer_instructions,
 * Anthropic cache_control breakpoint placement, per-turn allowed_tools
 * tool-list rebuilds.
 */

import type { ToolDefinitionPayload } from "../provider/message.ts";
import type { AssembledSystemPrompt, LoadedPrompt } from "../prompt/types.ts";

import { loadPromptFromFile } from "./loader.ts";

const BUNDLED_PROMPTS_DIR = new URL("./", import.meta.url).pathname;

export interface AssembleOptions {
  /** Absolute paths to the four layer prompts. */
  identityPath: string;
  baseInstructionsPath: string;
  providerAppendixPath: string;
  /** Optional: additional top-level layers (future use). */
  extraLayers?: LoadedPrompt[];
  /** Tools rendered into position 3. */
  tools: ToolDefinitionPayload[];
}

export async function assembleSystemPrompt(opts: AssembleOptions): Promise<AssembledSystemPrompt> {
  const identity = await loadPromptFromFile(opts.identityPath);
  const base = await loadPromptFromFile(opts.baseInstructionsPath);
  const appendix = await loadPromptFromFile(opts.providerAppendixPath);

  const toolsSection = renderToolsSection(opts.tools);

  const sections: string[] = [identity.body, base.body, toolsSection, appendix.body];
  for (const extra of opts.extraLayers ?? []) sections.push(extra.body);

  const text = sections.join("\n\n").trim() + "\n";

  const versions: Record<string, string> = {
    identity: identity.version,
    base_instructions: base.version,
    appendix: appendix.version,
  };
  for (const extra of opts.extraLayers ?? []) {
    versions[`extra_${extra.version}`] = extra.version;
  }

  return {
    text,
    versions,
    // §7.6.11 Anthropic places one breakpoint at the END of the system prompt.
    // We emit the offset for adapters that care; the OpenAI adapter ignores it
    // (Responses API handles prefix caching automatically).
    cacheBreakpointOffsets: [text.length],
  };
}

function renderToolsSection(tools: ToolDefinitionPayload[]): string {
  if (tools.length === 0) {
    return "## Tools\n\n(no tools available in this turn)";
  }
  const lines = ["## Tools available this turn", ""];
  for (const t of tools) {
    lines.push(`### \`${t.name}\``);
    lines.push("");
    lines.push(t.description.trim());
    lines.push("");
  }
  return lines.join("\n").trim();
}

/**
 * Convenience: resolve the canonical on-disk prompt paths for a given provider.
 * Packages that depend on `@open-apex/core` can import this directly rather
 * than hard-coding paths.
 */
/**
 * Map each appendix key to its current default revision. Bumping an
 * appendix revision is a prompt change; we pin the revision here so all
 * preset loaders pick up the same version at once.
 */
const APPENDIX_REVISIONS: Record<string, string> = {
  "openai-gpt-5.4": "v2",
  "anthropic-sonnet-4.6": "v1",
  "anthropic-opus-4.6": "v1",
  "anthropic-opus-4.7": "v1",
};

export function resolvePromptPaths(
  providerAppendixKey:
    | "openai-gpt-5.4"
    | "anthropic-sonnet-4.6"
    | "anthropic-opus-4.6"
    | "anthropic-opus-4.7",
): {
  identityPath: string;
  baseInstructionsPath: string;
  providerAppendixPath: string;
  synthesisPath: string;
} {
  const base = process.env.OPEN_APEX_PROMPTS_DIR ?? BUNDLED_PROMPTS_DIR;
  const rev = APPENDIX_REVISIONS[providerAppendixKey] ?? "v1";
  return {
    identityPath: `${base}identity.v1.md`,
    baseInstructionsPath: `${base}base-instructions.v2.md`,
    providerAppendixPath: `${base}appendix/${providerAppendixKey}.${rev}.md`,
    synthesisPath: `${base}synthesis.md`,
  };
}
