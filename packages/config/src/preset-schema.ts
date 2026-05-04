/**
 * Preset schema.
 * Locked per §7.6.9.
 *
 * We do schema validation with a hand-rolled validator rather than pulling in
 * ajv/zod — keeps runtime tiny and deterministic. The schema is mirrored as a
 * JSON Schema file for external consumers.
 */

import type { AutonomyLevel } from "@open-apex/core";

export interface PresetEnabled {
  subagentFanout: boolean;
  synthesis: boolean;
  midExecReExplore: boolean;
  exploratoryExecutor: boolean;
  strategyPlanner: boolean;
  verifierSubagent: boolean;
  landlockProbe: boolean;
  promptCaching: boolean;
  contextEditing: boolean;
  serverCompaction: boolean;
  toolSearch: boolean;
  backgroundMode: boolean;
  // §M3 flags
  prediction: boolean;
  repoMap: boolean;
  symbolIndex: boolean;
  envProbe: boolean;
  webSearch: boolean;
  readAsset: boolean;
  contaminationBlocklist: boolean;
}

export interface PresetContextManagement {
  /** Minimum 10000 per schema. */
  triggerInputTokens?: number;
  keepToolUses?: number;
  clearAtLeastTokens?: number;
  excludeTools?: string[];
  /** Minimum 50000 per schema. */
  compactThreshold?: number;
}

export type PresetEffort = "none" | "low" | "medium" | "high" | "xhigh" | "max";

export type PresetRepairEffort = "high" | "xhigh" | "max";

export type SearchAggressiveness = "off" | "selective" | "proactive" | "aggressive";

export interface Preset {
  presetId: string;
  /** Independent of CLI version. Format /^r[0-9]+$/. */
  revision: string;
  description?: string;
  kind: "benchmark" | "chat";
  provider: "openai" | "anthropic";
  /** Bare alias per user directive (e.g. "claude-opus-4-6", "gpt-5.4"). */
  modelId: string;
  /** Optional fallback model alias; the user has said "no backup model" for v1. */
  modelIdFallback?: string;
  effort: PresetEffort;
  repairTurnEffort?: PresetRepairEffort;
  /** OpenAI only. */
  verbosity?: "low" | "medium" | "high";
  /** Anthropic only. */
  thinkingDisplay?: "summarized" | "omitted";
  cacheBreakpoints?: Array<"system_prompt_end" | "tools_end" | "last_user">;
  enabled: PresetEnabled;
  gatherFanout: number;
  searchAggressiveness: SearchAggressiveness;
  maxTurns: number;
  /** 0 means no ceiling per §7.6.10. */
  maxBudgetUsd?: number;
  permissionDefaults: AutonomyLevel;
  allowedDomains?: string[];
  deniedDomains?: string[];
  networkEnabled?: boolean;
  contextManagement?: PresetContextManagement;
  providerBetaHeaders?: string[];
  promptAppendixFile?: string;
  benchmarkMode: boolean;
  /** ISO date string, YYYY-MM-DD. */
  verifiedOn: string;
}

export interface PresetValidationError {
  path: string;
  message: string;
}

/** Validator that mirrors the JSON Schema in §7.6.9. */
export function validatePreset(input: unknown): PresetValidationError[] {
  const errors: PresetValidationError[] = [];
  if (typeof input !== "object" || input === null) {
    return [{ path: "$", message: "preset must be an object" }];
  }
  const p = input as Record<string, unknown>;
  const required = [
    "presetId",
    "revision",
    "provider",
    "modelId",
    "kind",
    "enabled",
    "effort",
    "gatherFanout",
    "searchAggressiveness",
    "maxTurns",
    "permissionDefaults",
    "benchmarkMode",
  ] as const;
  for (const k of required) {
    if (!(k in p)) errors.push({ path: `$.${k}`, message: "required" });
  }
  if (typeof p.presetId === "string" && !/^[a-z0-9-]+$/.test(p.presetId)) {
    errors.push({ path: "$.presetId", message: "must match /^[a-z0-9-]+$/" });
  }
  if (typeof p.revision === "string" && !/^r[0-9]+$/.test(p.revision)) {
    errors.push({ path: "$.revision", message: "must match /^r[0-9]+$/" });
  }
  if (p.kind !== "benchmark" && p.kind !== "chat") {
    errors.push({ path: "$.kind", message: "must be 'benchmark' or 'chat'" });
  }
  if (p.provider !== "openai" && p.provider !== "anthropic") {
    errors.push({
      path: "$.provider",
      message: "must be 'openai' or 'anthropic'",
    });
  }
  const efforts = ["none", "low", "medium", "high", "xhigh", "max"] as const;
  if (!efforts.includes(p.effort as PresetEffort)) {
    errors.push({
      path: "$.effort",
      message: `must be one of ${efforts.join(", ")}`,
    });
  }
  const autonomies = ["readonly", "low", "medium", "high", "full_auto"];
  if (!autonomies.includes(p.permissionDefaults as AutonomyLevel)) {
    errors.push({
      path: "$.permissionDefaults",
      message: `must be one of ${autonomies.join(", ")}`,
    });
  }
  if (typeof p.gatherFanout !== "number" || p.gatherFanout < 1 || p.gatherFanout > 5) {
    errors.push({ path: "$.gatherFanout", message: "must be integer 1–5" });
  }
  if (typeof p.maxTurns !== "number" || p.maxTurns < 10) {
    errors.push({ path: "$.maxTurns", message: "must be integer >= 10" });
  }
  const aggr = ["off", "selective", "proactive", "aggressive"];
  if (!aggr.includes(p.searchAggressiveness as SearchAggressiveness)) {
    errors.push({
      path: "$.searchAggressiveness",
      message: `must be one of ${aggr.join(", ")}`,
    });
  }
  if (typeof p.benchmarkMode !== "boolean") {
    errors.push({ path: "$.benchmarkMode", message: "must be boolean" });
  }
  // enabled: object with known keys
  if (typeof p.enabled !== "object" || p.enabled === null) {
    errors.push({ path: "$.enabled", message: "must be object" });
  } else {
    const knownKeys = [
      "subagentFanout",
      "synthesis",
      "midExecReExplore",
      "exploratoryExecutor",
      "strategyPlanner",
      "verifierSubagent",
      "landlockProbe",
      "promptCaching",
      "contextEditing",
      "serverCompaction",
      "toolSearch",
      "backgroundMode",
      // §M3
      "prediction",
      "repoMap",
      "symbolIndex",
      "envProbe",
      "webSearch",
      "readAsset",
      "contaminationBlocklist",
    ];
    for (const k of knownKeys) {
      if (!(k in (p.enabled as object))) {
        errors.push({ path: `$.enabled.${k}`, message: "required" });
      } else if (typeof (p.enabled as Record<string, unknown>)[k] !== "boolean") {
        errors.push({
          path: `$.enabled.${k}`,
          message: "must be boolean",
        });
      }
    }
    for (const k of Object.keys(p.enabled as object)) {
      if (!knownKeys.includes(k)) {
        errors.push({
          path: `$.enabled.${k}`,
          message: "unknown key (additionalProperties: false)",
        });
      }
    }
  }
  // contextManagement bounds
  if (p.contextManagement !== undefined) {
    const cm = p.contextManagement as Record<string, unknown>;
    if (
      cm.triggerInputTokens !== undefined &&
      typeof cm.triggerInputTokens === "number" &&
      cm.triggerInputTokens < 10_000
    ) {
      errors.push({
        path: "$.contextManagement.triggerInputTokens",
        message: "must be >= 10000",
      });
    }
    if (
      cm.compactThreshold !== undefined &&
      typeof cm.compactThreshold === "number" &&
      cm.compactThreshold < 50_000
    ) {
      errors.push({
        path: "$.contextManagement.compactThreshold",
        message: "must be >= 50000",
      });
    }
  }
  // verifiedOn ISO date
  if (typeof p.verifiedOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(p.verifiedOn)) {
    errors.push({
      path: "$.verifiedOn",
      message: "must be ISO date YYYY-MM-DD",
    });
  }
  return errors;
}
