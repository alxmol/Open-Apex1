#!/usr/bin/env bun
/**
 * checkpoint_save child-process entrypoint (tb2-12 regression Fix C.2).
 *
 * Runs a single `ShadowGitCheckpointStore.save()` in an isolated process
 * and writes the resulting `Checkpoint` JSON to stdout (single-line).
 *
 * Usage:
 *   bun run save-runner.ts \
 *     --workspace <abs-path> \
 *     --store <abs-path> \
 *     --reason <checkpoint-reason> \
 *     --session <session-id> \
 *     --step <int> \
 *     [--name <human-name>] \
 *     [--min-free-bytes <int>]
 *
 * Exit codes:
 *   0   — success (stdout has JSON)
 *   1   — missing / invalid args
 *   2   — save() threw a non-crash exception (stderr has the message)
 *   139 — Bun SIGSEGV (parent handles via exit code)
 *
 * NOTE: This script must be self-sufficient and import only from stable
 * paths. A crash here does NOT abort the parent agent run — the parent's
 * safeCheckpointSave() wrapper catches non-zero exits and returns a
 * structured "failed" result.
 */

import { ShadowGitCheckpointStore } from "./shadow-git.ts";
import type { CheckpointReason } from "@open-apex/core";

function arg(flag: string, args: string[]): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1 || i === args.length - 1) return undefined;
  return args[i + 1];
}

async function main(): Promise<void> {
  // The parent enables OPEN_APEX_CHECKPOINT_ISOLATION to route saves into this
  // child. Clear it here so the child performs the actual in-process save
  // instead of recursively spawning another save-runner.
  delete process.env.OPEN_APEX_CHECKPOINT_ISOLATION;

  const args = process.argv.slice(2);
  const workspace = arg("--workspace", args);
  const store = arg("--store", args);
  const reason = arg("--reason", args) as CheckpointReason | undefined;
  const session = arg("--session", args);
  const stepRaw = arg("--step", args);
  const name = arg("--name", args);
  const minFreeBytesRaw = arg("--min-free-bytes", args);

  if (!workspace || !store || !reason || !session || !stepRaw) {
    process.stderr.write(
      "save-runner: missing required --workspace/--store/--reason/--session/--step\n",
    );
    process.exit(1);
  }
  const stepId = Number.parseInt(stepRaw, 10);
  if (!Number.isFinite(stepId)) {
    process.stderr.write(`save-runner: invalid --step value: ${stepRaw}\n`);
    process.exit(1);
  }
  const opts: {
    workspace: string;
    storeRoot: string;
    minFreeDiskBytes?: number;
  } = { workspace, storeRoot: store };
  if (minFreeBytesRaw !== undefined) {
    const n = Number.parseInt(minFreeBytesRaw, 10);
    if (Number.isFinite(n)) opts.minFreeDiskBytes = n;
  }

  const s = new ShadowGitCheckpointStore(opts);
  await s.init();
  try {
    const cp = await s.save(reason, session, stepId, name !== undefined ? { name } : undefined);
    process.stdout.write(JSON.stringify(cp));
    process.exit(0);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    process.stderr.write(`save-runner: save() threw: ${msg}\n`);
    process.exit(2);
  }
}

void main();
