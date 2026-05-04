/**
 * Preset loader.
 *
 * Loads JSON preset files from `packages/config/presets/` (or an override path),
 * validates them against §7.6.9 schema, caches the result.
 */

import { readdir } from "node:fs/promises";
import * as path from "node:path";

import { validatePreset, type Preset, type PresetValidationError } from "./preset-schema.ts";

const BUNDLED_PRESETS_DIR = new URL("../presets/", import.meta.url).pathname;

export interface PresetLoaderOptions {
  /** Override path for preset files. Defaults to bundled presets dir. */
  presetsDir?: string;
}

export class PresetLoadError extends Error {
  constructor(
    message: string,
    readonly presetId: string | undefined,
    readonly path: string,
    readonly validationErrors?: PresetValidationError[],
  ) {
    super(message);
    this.name = "PresetLoadError";
  }
}

export interface LoadedPreset extends Preset {
  /** Where this preset was loaded from. */
  sourcePath: string;
}

export async function loadPreset(
  presetId: string,
  opts: PresetLoaderOptions = {},
): Promise<LoadedPreset> {
  const dir = opts.presetsDir ?? process.env.OPEN_APEX_PRESETS_DIR ?? BUNDLED_PRESETS_DIR;
  const p = path.join(dir, `${presetId}.json`);
  const file = Bun.file(p);
  if (!(await file.exists())) {
    throw new PresetLoadError(`preset not found: ${presetId}`, presetId, p);
  }
  let parsed: unknown;
  try {
    parsed = await file.json();
  } catch (err) {
    throw new PresetLoadError(`preset JSON parse error: ${(err as Error).message}`, presetId, p);
  }
  const errs = validatePreset(parsed);
  if (errs.length > 0) {
    throw new PresetLoadError(
      `preset schema validation failed:\n${errs
        .map((e) => `  ${e.path}: ${e.message}`)
        .join("\n")}`,
      presetId,
      p,
      errs,
    );
  }
  const preset = parsed as Preset;
  if (preset.presetId !== presetId) {
    throw new PresetLoadError(
      `preset file/id mismatch: file ${presetId}.json contains presetId '${preset.presetId}'`,
      presetId,
      p,
    );
  }
  return { ...preset, sourcePath: p };
}

export async function listPresets(opts: PresetLoaderOptions = {}): Promise<LoadedPreset[]> {
  const dir = opts.presetsDir ?? process.env.OPEN_APEX_PRESETS_DIR ?? BUNDLED_PRESETS_DIR;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const ids = entries
    .filter((e) => e.endsWith(".json"))
    .map((e) => e.slice(0, -".json".length))
    .sort();
  const presets: LoadedPreset[] = [];
  for (const id of ids) {
    presets.push(await loadPreset(id, opts));
  }
  return presets;
}
