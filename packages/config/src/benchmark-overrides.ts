/**
 * Benchmark-safe override registry.
 *
 * Locked per §1.2 "Benchmark behavior" and §6 M0 exit criterion:
 *   "benchmark-safe override registry with schema validation, forbidden-field
 *    checks, and evidence requirements for promotion"
 *
 * Each override entry declares:
 *   - id
 *   - scope (which presets it applies to)
 *   - allowed fields (what preset inputs it may tune)
 *   - rationale
 *   - evidence references
 *   - introduction revision
 *   - review point
 *
 * Forbidden: repo-specific hints, hidden solution content, task-derived
 * benchmark cheats, task IDs, task keywords, repo fingerprints.
 */

export type OverrideScope =
  | "tb2-gpt54"
  | "tb2-sonnet46"
  | "tb2-opus46"
  | "tb2-opus47"
  | "all_benchmark";

export type OverrideField =
  | "effort"
  | "repairTurnEffort"
  | "verbosity"
  | "thinkingDisplay"
  | "cacheBreakpoints"
  | "gatherFanout"
  | "searchAggressiveness"
  | "maxTurns"
  | "contextManagement"
  | "providerBetaHeaders"
  | "promptAppendixFile"
  | "enabled.serverCompaction"
  | "enabled.contextEditing"
  | "enabled.promptCaching"
  | "enabled.toolSearch"
  | "enabled.strategyPlanner"
  | "enabled.exploratoryExecutor"
  | "enabled.midExecReExplore"
  | "enabled.verifierSubagent";

export interface BenchmarkOverride {
  id: string;
  scope: OverrideScope[];
  allowedFields: OverrideField[];
  rationale: string;
  evidenceRefs: string[];
  introducedAtRevision: string;
  reviewPoint: string;
  /** The actual field path -> value map. Keys must be in allowedFields. */
  values: Partial<Record<OverrideField, unknown>>;
}

/**
 * Forbidden content markers. A benchmark override whose `values` or `rationale`
 * contains any of these patterns is rejected as task-derived.
 */
const FORBIDDEN_SUBSTRINGS: RegExp[] = [
  // TB2 task identifiers (sample; full list is in the contamination blocklist §7.6.4)
  /\bterminal-bench\b/i,
  /\btbench\b/i,
  /\btb2\b/i,
  // Direct solution leakage markers
  /\bsolution[:\-]/i,
  /\banswer[:\-]/i,
];

/**
 * Pattern of keys that are ABSOLUTELY forbidden in override values.
 * These would inject repo-specific or task-specific content:
 */
const FORBIDDEN_VALUE_KEYS: RegExp[] = [/^task/i, /^repo/i, /^fingerprint/i, /^solution/i];

export interface OverrideValidationError {
  path: string;
  message: string;
}

export function validateOverride(
  o: BenchmarkOverride,
  presetIdInScope: string,
): OverrideValidationError[] {
  const errs: OverrideValidationError[] = [];
  if (!o.id || !/^[a-z0-9-]+$/.test(o.id)) {
    errs.push({ path: "id", message: "required /^[a-z0-9-]+$/" });
  }
  if (!Array.isArray(o.scope) || o.scope.length === 0) {
    errs.push({ path: "scope", message: "required non-empty array" });
  }
  const scopeMatches =
    o.scope.includes("all_benchmark") ||
    (presetIdInScope && o.scope.includes(presetIdInScope as OverrideScope));
  if (!scopeMatches) {
    errs.push({
      path: "scope",
      message: `override does not apply to preset '${presetIdInScope}'`,
    });
  }
  if (!Array.isArray(o.allowedFields) || o.allowedFields.length === 0) {
    errs.push({ path: "allowedFields", message: "required non-empty array" });
  }
  if (!o.rationale || o.rationale.length < 10) {
    errs.push({ path: "rationale", message: "required, at least 10 chars" });
  }
  if (!Array.isArray(o.evidenceRefs) || o.evidenceRefs.length === 0) {
    errs.push({
      path: "evidenceRefs",
      message: "required non-empty — promotion needs evidence per §1.2",
    });
  }
  // Scan rationale + values for forbidden markers (task-derived content).
  for (const re of FORBIDDEN_SUBSTRINGS) {
    if (re.test(o.rationale)) {
      errs.push({
        path: "rationale",
        message: `contains forbidden pattern ${re.source}`,
      });
    }
  }
  // Values: keys must all be in allowedFields.
  for (const k of Object.keys(o.values)) {
    if (!o.allowedFields.includes(k as OverrideField)) {
      errs.push({
        path: `values.${k}`,
        message: `key not listed in allowedFields`,
      });
    }
  }
  // Values: string content must not contain forbidden patterns.
  const scanValue = (v: unknown, path: string): void => {
    if (typeof v === "string") {
      for (const re of FORBIDDEN_SUBSTRINGS) {
        if (re.test(v)) {
          errs.push({
            path,
            message: `string value contains forbidden pattern ${re.source}`,
          });
        }
      }
    } else if (Array.isArray(v)) {
      v.forEach((x, i) => scanValue(x, `${path}[${i}]`));
    } else if (v && typeof v === "object") {
      for (const [k, inner] of Object.entries(v)) {
        for (const re of FORBIDDEN_VALUE_KEYS) {
          if (re.test(k)) {
            errs.push({
              path: `${path}.${k}`,
              message: `object key matches forbidden pattern ${re.source}`,
            });
          }
        }
        scanValue(inner, `${path}.${k}`);
      }
    }
  };
  scanValue(o.values, "values");
  return errs;
}

/** Apply a set of overrides to a preset; returns the applied override ids. */
export function applyOverrides<T extends Record<string, unknown>>(
  preset: T,
  overrides: BenchmarkOverride[],
  presetId: string,
): { preset: T; applied: string[]; errors: OverrideValidationError[] } {
  const applied: string[] = [];
  const errors: OverrideValidationError[] = [];
  const out = structuredClone(preset) as T;
  for (const o of overrides) {
    const errs = validateOverride(o, presetId);
    if (errs.length > 0) {
      errors.push(
        ...errs.map((e) => ({
          path: `override[${o.id}].${e.path}`,
          message: e.message,
        })),
      );
      continue;
    }
    for (const [field, value] of Object.entries(o.values)) {
      const segs = field.split(".");
      let cur = out as Record<string, unknown>;
      for (let i = 0; i < segs.length - 1; i++) {
        const k = segs[i]!;
        if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
        cur = cur[k] as Record<string, unknown>;
      }
      cur[segs[segs.length - 1]!] = value;
    }
    applied.push(o.id);
  }
  return { preset: out, applied, errors };
}
