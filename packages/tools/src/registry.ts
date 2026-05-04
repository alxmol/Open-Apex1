/**
 * ToolRegistry — per-run central registry of tool definitions.
 * Locked per §7.6.12.
 *
 * Tools register themselves at startup. The orchestrator pulls a filtered
 * subset per turn based on:
 *   - preset `enabled` flags
 *   - per-turn `allowedTools` restrictions
 *   - subagent role (read-only subset for scouts)
 *   - network enablement
 *
 * M0 ships the registry class and tests only. Individual tool implementations
 * land in M1 (read_file, list_tree, search_text, run_shell, write_file,
 * apply_patch, search_replace, checkpoint_save/restore) and M2 (permission
 * classifier, patch engine, shell runtime, shadow-git checkpoints).
 */

import type { ToolDefinition, ToolRegistry } from "@open-apex/core";

export class ToolRegistryImpl implements ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>();

  register<TParams, TResult>(tool: ToolDefinition<TParams, TResult>): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`tool '${tool.name}' already registered`);
    }
    // ToolDefinition<TParams, TResult> is a supertype of ToolDefinition
    // (with unknowns); erasure is safe for registry lookup.
    this.tools.set(tool.name, tool as unknown as ToolDefinition);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): ToolDefinition[] {
    return Array.from(this.tools.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  listAllowed(allowed: string[] | undefined, excluded: string[] | undefined): ToolDefinition[] {
    const all = this.list();
    let out = all;
    if (allowed && allowed.length > 0) {
      const set = new Set(allowed);
      out = out.filter((t) => set.has(t.name));
    }
    if (excluded && excluded.length > 0) {
      const set = new Set(excluded);
      out = out.filter((t) => !set.has(t.name));
    }
    return out;
  }

  /** Test utility: drop all registered tools. */
  clear(): void {
    this.tools.clear();
  }

  /** Test utility: count of registered tools. */
  size(): number {
    return this.tools.size;
  }
}

/** Default shared registry — one per process. M1+ tool modules register into this. */
export const defaultRegistry: ToolRegistry & {
  clear(): void;
  size(): number;
} = new ToolRegistryImpl();
