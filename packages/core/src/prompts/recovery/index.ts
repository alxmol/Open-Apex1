/**
 * §7.6.3 recovery prompt library loader.
 *
 * M2 ships the literal prompt files from §7.6.3; M4's recovery engine
 * consumes them. Keys map directly to `ToolErrorType` where they
 * correspond, plus a few orchestrator-level keys (validation_failure,
 * repeated_failures_same_approach, stuck_command) used by the
 * recovery engine's taxonomy.
 */

import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

export type RecoveryPromptKey =
  | "syntax_error"
  | "import_error"
  | "path_not_found"
  | "permission_denied"
  | "patch_apply_failed"
  | "shell_timeout"
  | "test_failure";

const RECOVERY_DIR = new URL("./", import.meta.url).pathname;

const cache = new Map<RecoveryPromptKey, string>();

/** Test utility: reset path-sensitive cache entries between env override checks. */
export function __clearRecoveryPromptCacheForTest(): void {
  cache.clear();
}

/** Load and cache a recovery prompt literal. */
export function loadRecoveryPrompt(key: RecoveryPromptKey): string {
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const raw = readFileSync(resolveRecoveryPromptPath(key), "utf8");
  cache.set(key, raw);
  return raw;
}

function resolveRecoveryPromptPath(key: RecoveryPromptKey): string {
  const fileName = `${key}.md`;
  const overrideRoot = process.env.OPEN_APEX_PROMPTS_DIR;
  if (overrideRoot) {
    // Installed-agent bundles preserve the source prompt layout under
    // /installed-agent/prompts. Prefer the recovery subdirectory first; the
    // top-level fallback keeps older local bundles readable during upgrades.
    const candidates = [
      path.join(overrideRoot, "recovery", fileName),
      path.join(overrideRoot, fileName),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return candidate;
    }
  }
  return path.join(RECOVERY_DIR, fileName);
}

/**
 * Substitute `<token>` placeholders in a recovery prompt with values.
 * Unknown tokens are left as-is so the template is robust to sparse
 * context fills.
 */
export function fillRecoveryPrompt(
  key: RecoveryPromptKey,
  values: Record<string, string | number>,
): string {
  let text = loadRecoveryPrompt(key);
  for (const [k, v] of Object.entries(values)) {
    text = text.split(`<${k}>`).join(String(v));
  }
  return text;
}
