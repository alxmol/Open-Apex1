/**
 * Slice-manifest loader. Validates every manifest against the pinned
 * TB2_TASK_INVENTORY — every referenced task_id must exist in the inventory,
 * the pinned_commit must match TB2_DATASET_COMMIT, and the kind must be one
 * of the enum values.
 */

import { readdir } from "node:fs/promises";
import * as path from "node:path";

import { TB2_DATASET_COMMIT, TB2_TASK_INVENTORY } from "./tb2-task-inventory.ts";
import type { SliceKind, SliceManifest } from "./types.ts";

const SLICES_DIR = new URL("../../slices/", import.meta.url).pathname;

const TASK_ID_SET = new Set(TB2_TASK_INVENTORY.map((t) => t.id));
const SLICE_KINDS: readonly SliceKind[] = ["smoke", "category", "cross-cutting", "full"];

export interface SliceValidationError {
  path: string;
  message: string;
}

export class SliceLoadError extends Error {
  constructor(
    message: string,
    readonly sliceId: string,
    readonly validationErrors?: SliceValidationError[],
  ) {
    super(message);
    this.name = "SliceLoadError";
  }
}

export function validateManifest(m: unknown): SliceValidationError[] {
  const errs: SliceValidationError[] = [];
  if (typeof m !== "object" || m === null) {
    return [{ path: "$", message: "manifest must be object" }];
  }
  const s = m as Record<string, unknown>;
  if (typeof s.id !== "string" || !/^[a-z0-9-]+$/.test(s.id)) {
    errs.push({ path: "$.id", message: "required, /^[a-z0-9-]+$/" });
  }
  if (typeof s.description !== "string" || s.description.length < 5) {
    errs.push({ path: "$.description", message: "required, min length 5" });
  }
  if (!SLICE_KINDS.includes(s.kind as SliceKind)) {
    errs.push({ path: "$.kind", message: `must be one of ${SLICE_KINDS.join(", ")}` });
  }
  if (s.pinned_commit !== TB2_DATASET_COMMIT) {
    errs.push({
      path: "$.pinned_commit",
      message: `must equal TB2_DATASET_COMMIT (${TB2_DATASET_COMMIT.slice(0, 8)}...)`,
    });
  }
  if (!Array.isArray(s.task_ids) || s.task_ids.length === 0) {
    errs.push({ path: "$.task_ids", message: "required non-empty array" });
  } else {
    s.task_ids.forEach((tid, i) => {
      if (typeof tid !== "string") {
        errs.push({ path: `$.task_ids[${i}]`, message: "must be string" });
      } else if (!TASK_ID_SET.has(tid)) {
        errs.push({
          path: `$.task_ids[${i}]`,
          message: `task_id '${tid}' not in TB2_TASK_INVENTORY (typo or drift from pinned commit)`,
        });
      }
    });
    // Check for duplicates.
    const seen = new Set<string>();
    for (const tid of s.task_ids) {
      if (typeof tid === "string") {
        if (seen.has(tid)) {
          errs.push({
            path: "$.task_ids",
            message: `duplicate task_id '${tid}'`,
          });
        }
        seen.add(tid);
      }
    }
  }
  return errs;
}

export async function loadSlice(id: string): Promise<SliceManifest> {
  const p = path.join(SLICES_DIR, `${id}.json`);
  const f = Bun.file(p);
  if (!(await f.exists())) {
    throw new SliceLoadError(`slice not found: ${id}`, id);
  }
  let parsed: unknown;
  try {
    parsed = await f.json();
  } catch (err) {
    throw new SliceLoadError(`JSON parse error: ${(err as Error).message}`, id);
  }
  const errs = validateManifest(parsed);
  if (errs.length > 0) {
    throw new SliceLoadError(
      `slice schema validation failed:\n${errs.map((e) => `  ${e.path}: ${e.message}`).join("\n")}`,
      id,
      errs,
    );
  }
  const manifest = parsed as SliceManifest;
  if (manifest.id !== id) {
    throw new SliceLoadError(`file/id mismatch: file ${id}.json contains id '${manifest.id}'`, id);
  }
  return manifest;
}

export async function listSlices(): Promise<SliceManifest[]> {
  let entries: string[];
  try {
    entries = await readdir(SLICES_DIR);
  } catch {
    return [];
  }
  const ids = entries
    .filter((e) => e.endsWith(".json"))
    .map((e) => e.slice(0, -".json".length))
    .sort();
  const out: SliceManifest[] = [];
  for (const id of ids) {
    out.push(await loadSlice(id));
  }
  return out;
}
