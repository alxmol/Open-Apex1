/**
 * Benchmark adapter contracts.
 * Locked per §3.4.7.
 *
 * Harbor is Python-first and uses `importlib.import_module`. Open-Apex is
 * Bun/TypeScript, so we ship a thin Python wrapper package at
 * `apps/harbor-installed-agent/open_apex_agent/` that installs the Open-Apex
 * binary and invokes the Bun CLI. The TypeScript side sees `BenchmarkAdapter`;
 * the wrapper's side is defined in §3.4.7 Python sketch.
 */

import type { AtifTrajectory } from "../atif/types.ts";

export interface BenchmarkAdapter {
  readonly presetId: string;
  readonly harborContext: HarborContext;
  start(taskInstruction: string): Promise<void>;
  finalize(opts: { partial: boolean }): Promise<AtifTrajectory>;
}

export interface McpServerConfig {
  name: string;
  transport: "stdio" | "http" | "sse" | "tcp";
  command?: string;
  args?: string[];
  url?: string;
  /** Any other keys the task.toml declares; retained but never executed. */
  extra?: Record<string, unknown>;
}

export interface HarborContext {
  /** Host path set by Harbor. */
  logsDir: string;
  /** /logs/agent (in container). */
  agentDir: string;
  /** /logs/verifier */
  verifierDir: string;
  /** /logs/artifacts */
  artifactsDir: string;
  /** /tests */
  testsDir: string;
  /** From task.toml [environment].workdir */
  workspace: string;
  /** Merged by every exec_as_*. */
  extraEnv: Record<string, string>;
  /** From task.toml [agent].timeout_sec */
  agentTimeoutSec: number;
  verifierTimeoutSec: number;
  taskId: string;
  /** Declared MCP servers — logged + recorded, NEVER launched (§2 non-goals). */
  mcpServers: McpServerConfig[];
}
