/**
 * Prompt loader.
 * Parses frontmatter-versioned markdown prompts into `LoadedPrompt`.
 *
 * Frontmatter shape:
 *   ---
 *   prompt_version: identity.v1
 *   ---
 *   <markdown body>
 */

import type { LoadedPrompt, PromptFrontmatter } from "../prompt/types.ts";

export class PromptParseError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(message);
    this.name = "PromptParseError";
  }
}

export function parsePromptText(text: string, path: string): LoadedPrompt {
  if (!text.startsWith("---\n") && !text.startsWith("---\r\n")) {
    throw new PromptParseError("missing frontmatter", path);
  }
  const afterFirst = text.indexOf("\n", 4); // skip "---\n"
  const endIdx = text.indexOf("\n---", afterFirst);
  if (endIdx < 0) {
    throw new PromptParseError("unterminated frontmatter block", path);
  }
  const fmText = text.slice(4, endIdx + 1);
  const bodyStart = text.indexOf("\n", endIdx + 4);
  const body = bodyStart >= 0 ? text.slice(bodyStart + 1) : "";
  const frontmatter: PromptFrontmatter = parseYamlFrontmatter(fmText, path);
  if (typeof frontmatter.prompt_version !== "string") {
    throw new PromptParseError("frontmatter must include `prompt_version: <id>`", path);
  }
  return {
    path,
    version: frontmatter.prompt_version,
    frontmatter,
    body: body.trim(),
  };
}

/**
 * Tiny YAML subset parser — supports top-level `key: value` lines.
 * Values are unquoted strings or numbers. Good enough for our frontmatter.
 */
function parseYamlFrontmatter(text: string, path: string): PromptFrontmatter {
  const out: Record<string, unknown> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const colon = trimmed.indexOf(":");
    if (colon < 0) {
      throw new PromptParseError(`malformed frontmatter line: ${trimmed}`, path);
    }
    const key = trimmed.slice(0, colon).trim();
    let value = trimmed.slice(colon + 1).trim();
    // Strip quotes if present.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out as PromptFrontmatter;
}

export async function loadPromptFromFile(path: string): Promise<LoadedPrompt> {
  const f = Bun.file(path);
  if (!(await f.exists())) {
    throw new PromptParseError("prompt file not found", path);
  }
  return parsePromptText(await f.text(), path);
}
