/**
 * Child-process entrypoint for M4 exploratory execution.
 *
 * The parent phase engine keeps benchmark gather responsive by moving the
 * heavyweight Episode-1 setup (checkpoint save, workspace copy, isolated tool
 * loop, validator probes) into this helper. The child writes exactly one JSON
 * SubagentResult to stdout; diagnostics go to stderr.
 */

import { mkdir, readFile } from "node:fs/promises";
import * as path from "node:path";

import { loadPreset } from "@open-apex/config";
import type { OpenApexRunContext, RequestOptions, ToolDefinition } from "@open-apex/core";
import { runExploratoryExecutorForChild } from "@open-apex/runtime";
import { SerperProvider, SerpApiProvider } from "@open-apex/search";
import {
  registerBuiltinTools,
  setSearchProviderFactory,
  ShadowGitCheckpointStore,
  ToolRegistryImpl,
} from "@open-apex/tools";

import { makeAdapter, presetToRequestOptions } from "./adapter-factory.ts";

interface ChildInput {
  workspace: string;
  openApexHome: string;
  runId: string;
  sessionId: string;
  taskInstruction: string;
  systemPrompt: string;
  requestOptions?: RequestOptions;
  presetId?: string;
}

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error("exploratory-runner requires an input JSON path");
  const input = JSON.parse(await readFile(inputPath, "utf8")) as ChildInput;
  const preset = await loadPreset(input.presetId ?? "tb2-opus46");
  const adapter = makeAdapter(preset);
  wireSearchProvider(preset);
  const registry = new ToolRegistryImpl();
  registerBuiltinTools(registry, {
    webSearch: preset.networkEnabled === true && preset.enabled.webSearch !== false,
    repoMap: preset.enabled.repoMap !== false,
    symbolIndex: preset.enabled.symbolIndex !== false,
    readAsset: preset.enabled.readAsset !== false,
  });
  const toolRegistry = new Map<string, ToolDefinition>(
    registry.list().map((tool) => [tool.name, tool]),
  );
  await mkdir(input.openApexHome, { recursive: true });
  const checkpointStore = new ShadowGitCheckpointStore({
    workspace: input.workspace,
    storeRoot: path.join(input.openApexHome, "checkpoints"),
  });
  await checkpointStore.init();
  const abort = new AbortController();
  const ctx: OpenApexRunContext = {
    userContext: {
      workspace: input.workspace,
      openApexHome: input.openApexHome,
      autonomyLevel: preset.permissionDefaults,
      sessionId: input.sessionId,
      benchmarkMode: true,
      checkpointStore,
      networkEnabled: preset.networkEnabled ?? false,
      ...(preset.allowedDomains ? { allowedDomains: preset.allowedDomains } : {}),
    } as OpenApexRunContext["userContext"],
    runId: input.runId,
    signal: abort.signal,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
  const result = await runExploratoryExecutorForChild({
    adapter,
    systemPrompt: input.systemPrompt,
    synthesisPrompt: "",
    taskInstruction: input.taskInstruction,
    initialMessages: [{ role: "user", content: input.taskInstruction }],
    tools: [...toolRegistry.values()],
    toolRegistry,
    ctx,
    benchmarkMode: true,
    requestOptions: { ...presetToRequestOptions(preset), ...(input.requestOptions ?? {}) },
    enabled: {},
  });
  await new Promise<void>((resolve, reject) =>
    process.stdout.write(JSON.stringify(result) + "\n", (err) => {
      if (err) reject(err);
      else resolve();
    }),
  );
  // The parent consumes line-delimited JSON as soon as it appears. Exit
  // explicitly so lingering sandbox/search/provider handles cannot turn a
  // finished exploratory lane into a 120s timeout.
  process.exit(0);
}

function wireSearchProvider(preset: { benchmarkMode?: boolean }): void {
  const hasSerper = Boolean(process.env.SERPER_API_KEY);
  const hasSerpApi = Boolean(process.env.SERP_API_KEY ?? process.env.SERPAPI_KEY);
  if (!hasSerper && !hasSerpApi) return;

  // The isolated child owns its own tool registry, so it must also install the
  // process-local provider factory used by web_search/fetch_url. Keeping this
  // parallel to the main CLI prevents Episode-1 exploration from silently
  // losing web evidence while the parent lanes still have it.
  setSearchProviderFactory(() => ({
    provider: hasSerper ? new SerperProvider() : new SerpApiProvider(),
    benchmark: preset.benchmarkMode === true,
  }));
}

main().catch((err) => {
  process.stderr.write(`exploratory-runner: ${(err as Error).stack ?? (err as Error).message}\n`);
  process.exit(1);
});
