export { readFileTool, type ReadFileInput, type ReadFileResult } from "./read_file.ts";
export {
  listTreeTool,
  type ListTreeInput,
  type ListTreeResult,
  type ListTreeEntry,
} from "./list_tree.ts";
export {
  searchTextTool,
  type SearchTextInput,
  type SearchTextResult,
  type SearchMatch,
} from "./search_text.ts";
export {
  runShellTool,
  clampTimeoutMs,
  resolveShellTimeoutPolicy,
  HARD_MAX_TIMEOUT_MS,
  __setSpawnForTest as __setRunShellSpawnForTest,
  __resetSpawnForTest as __resetRunShellSpawnForTest,
  __REAP_DEADLINE_MS_FOR_TEST,
  type RunShellInput,
  type RunShellResult,
  type RunShellSpawnFn,
  type RunShellSpawnedProc,
} from "./run_shell.ts";
export { writeFileTool, type WriteFileInput, type WriteFileResult } from "./write_file.ts";
export { applyPatchTool, type ApplyPatchInput, type ApplyPatchResult } from "./apply_patch.ts";
export {
  searchReplaceTool,
  type SearchReplaceInput,
  type SearchReplaceResult,
} from "./search_replace.ts";
export {
  checkpointSaveTool,
  type CheckpointSaveInput,
  type CheckpointSaveResult,
} from "./checkpoint_save.ts";
export { checkpointRestoreTool, type CheckpointRestoreInput } from "./checkpoint_restore.ts";
export { deleteFileTool, type DeleteFileInput, type DeleteFileResult } from "./delete_file.ts";
export { moveFileTool, type MoveFileInput, type MoveFileResult } from "./move_file.ts";
export { shellCommandTool, type ShellCommandInput } from "./shell_command.ts";
export {
  webSearchTool,
  setSearchProviderFactory,
  __setSearchProviderFactoryForTest,
  type WebSearchInput,
  type WebSearchMetadata,
} from "./web_search.ts";
export { fetchUrlTool, type FetchUrlInput } from "./fetch_url.ts";
export {
  symbolLookupTool,
  __resetSymbolIndexCacheForTest,
  type SymbolLookupInput,
  type SymbolLookupResult,
} from "./symbol_lookup.ts";
export { repoMapTool, type RepoMapInput, type RepoMapResult } from "./repo_map.ts";
export { readAssetTool, type ReadAssetInput, type ReadAssetMetadata } from "./read_asset.ts";
export {
  runJobTool,
  listJobsTool,
  readJobLogTool,
  waitForJobTool,
  killJobTool,
  type RunJobInput,
  type ReadJobLogInput,
  type WaitForJobInput,
  type KillJobInput,
} from "./jobs.ts";

// Convenience: registerBuiltinTools(registry).
import type { ToolRegistry } from "@open-apex/core";
import { readFileTool } from "./read_file.ts";
import { listTreeTool } from "./list_tree.ts";
import { searchTextTool } from "./search_text.ts";
import { runShellTool } from "./run_shell.ts";
import { writeFileTool } from "./write_file.ts";
import { applyPatchTool } from "./apply_patch.ts";
import { searchReplaceTool } from "./search_replace.ts";
import { checkpointSaveTool } from "./checkpoint_save.ts";
import { checkpointRestoreTool } from "./checkpoint_restore.ts";
import { deleteFileTool } from "./delete_file.ts";
import { moveFileTool } from "./move_file.ts";
import { shellCommandTool } from "./shell_command.ts";
import { webSearchTool } from "./web_search.ts";
import { fetchUrlTool } from "./fetch_url.ts";
import { symbolLookupTool } from "./symbol_lookup.ts";
import { repoMapTool } from "./repo_map.ts";
import { readAssetTool } from "./read_asset.ts";
import { runJobTool, listJobsTool, readJobLogTool, waitForJobTool, killJobTool } from "./jobs.ts";

export interface RegisterBuiltinToolsOptions {
  /** Register web_search + fetch_url (requires preset.networkEnabled). */
  webSearch?: boolean;
  /** Register repo_map. */
  repoMap?: boolean;
  /** Register symbol_lookup. */
  symbolIndex?: boolean;
  /** Register read_asset. */
  readAsset?: boolean;
  /** Register process-local background job tools (M5 chat/product surface). */
  jobs?: boolean;
}

const DEFAULT_OPTIONS: Required<RegisterBuiltinToolsOptions> = {
  webSearch: true,
  repoMap: true,
  symbolIndex: true,
  readAsset: true,
  jobs: true,
};

export function registerBuiltinTools(
  registry: ToolRegistry,
  opts: RegisterBuiltinToolsOptions = {},
): void {
  const o = { ...DEFAULT_OPTIONS, ...opts };
  registry.register(readFileTool);
  registry.register(listTreeTool);
  registry.register(searchTextTool);
  registry.register(runShellTool);
  registry.register(shellCommandTool);
  registry.register(writeFileTool);
  registry.register(applyPatchTool);
  registry.register(searchReplaceTool);
  registry.register(deleteFileTool);
  registry.register(moveFileTool);
  registry.register(checkpointSaveTool);
  registry.register(checkpointRestoreTool);
  if (o.repoMap) registry.register(repoMapTool);
  if (o.symbolIndex) registry.register(symbolLookupTool);
  if (o.readAsset) registry.register(readAssetTool);
  if (o.webSearch) {
    registry.register(webSearchTool);
    registry.register(fetchUrlTool);
  }
  if (o.jobs) {
    registry.register(runJobTool);
    registry.register(listJobsTool);
    registry.register(readJobLogTool);
    registry.register(waitForJobTool);
    registry.register(killJobTool);
  }
}

export const BUILTIN_TOOL_NAMES: readonly string[] = Object.freeze([
  "read_file",
  "list_tree",
  "search_text",
  "run_shell",
  "shell_command",
  "write_file",
  "apply_patch",
  "search_replace",
  "delete_file",
  "move_file",
  "checkpoint_save",
  "checkpoint_restore",
  "repo_map",
  "symbol_lookup",
  "read_asset",
  "web_search",
  "fetch_url",
  "run_job",
  "list_jobs",
  "read_job_log",
  "wait_for_job",
  "kill_job",
]);
