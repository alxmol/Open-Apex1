import type { ValidatorCandidate } from "../subagent/types.ts";
import type { ExecutionContext } from "./types.ts";

// Shared schema used at the provider boundary. It intentionally mirrors the
// TypeScript ExecutionContext contract so OpenAI structured outputs and the
// Anthropic synthesis tool both validate the same shape.
export const VALIDATOR_CANDIDATE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["command", "confidence", "source", "justification"],
  properties: {
    command: { type: "string" },
    confidence: { enum: ["high", "medium", "low"] },
    source: {
      enum: [
        "task_instruction",
        "repo_manifest",
        "framework_convention",
        "repo_search",
        "minimal_safe_fallback",
        "harbor_task_convention",
      ],
    },
    justification: { type: "string" },
  },
};

export const EXECUTION_CONTEXT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: [
    "chosenApproach",
    "prioritizedFacts",
    "executionPlan",
    "filesToInspect",
    "filesToChange",
    "validators",
    "riskGuards",
    "searchPivotHooks",
    "completionChecklist",
    "evidenceRefs",
  ],
  properties: {
    chosenApproach: { type: "string" },
    prioritizedFacts: { type: "array", items: { type: "string" } },
    executionPlan: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "description", "preconditions", "expectedOutcome", "validatorHook"],
        properties: {
          id: { type: "string" },
          description: { type: "string" },
          preconditions: { type: "array", items: { type: "string" } },
          expectedOutcome: { type: "string" },
          validatorHook: { type: ["string", "null"] },
        },
      },
    },
    filesToInspect: { type: "array", items: { type: "string" } },
    filesToChange: { type: "array", items: { type: "string" } },
    validators: { type: "array", items: VALIDATOR_CANDIDATE_JSON_SCHEMA },
    riskGuards: { type: "array", items: { type: "string" } },
    searchPivotHooks: { type: "array", items: { type: "string" } },
    completionChecklist: { type: "array", items: { type: "string" } },
    evidenceRefs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["sourceRole", "artifactPath", "quote"],
        properties: {
          sourceRole: {
            enum: [
              "repo_scout",
              "environment_scout",
              "web_researcher",
              "strategy_planner",
              "exploratory_executor",
              "verifier",
              "task",
              "prediction",
            ],
          },
          artifactPath: { type: ["string", "null"] },
          quote: { type: "string" },
        },
      },
    },
  },
};

export function normalizeExecutionContext(value: unknown): ExecutionContext {
  if (!isRecord(value)) {
    throw new Error("ExecutionContext must be an object");
  }
  // Normalize instead of trusting provider JSON blindly. Providers can satisfy
  // a schema loosely, mocks can drift, and Anthropic tool inputs may omit nulls;
  // this function is the last typed boundary before the executor uses context.
  const ctx: ExecutionContext = {
    chosenApproach: requireString(value, "chosenApproach"),
    prioritizedFacts: requireStringArray(value, "prioritizedFacts"),
    executionPlan: requireArray(value, "executionPlan").map((item, index) => {
      if (!isRecord(item)) throw new Error(`executionPlan[${index}] must be an object`);
      const hook = item.validatorHook;
      const step = {
        id: requireString(item, "id"),
        description: requireString(item, "description"),
        preconditions: requireStringArray(item, "preconditions"),
        expectedOutcome: requireString(item, "expectedOutcome"),
      };
      if (typeof hook === "string" && hook.length > 0) {
        return { ...step, validatorHook: hook };
      }
      return step;
    }),
    filesToInspect: requireStringArray(value, "filesToInspect"),
    filesToChange: requireStringArray(value, "filesToChange"),
    validators: requireArray(value, "validators").map(normalizeValidatorCandidate),
    riskGuards: requireStringArray(value, "riskGuards"),
    searchPivotHooks: requireStringArray(value, "searchPivotHooks"),
    completionChecklist: requireStringArray(value, "completionChecklist"),
    evidenceRefs: requireArray(value, "evidenceRefs").map((item, index) => {
      if (!isRecord(item)) throw new Error(`evidenceRefs[${index}] must be an object`);
      const sourceRole = requireString(
        item,
        "sourceRole",
      ) as ExecutionContext["evidenceRefs"][number]["sourceRole"];
      const artifactPath = item.artifactPath;
      const ref = {
        sourceRole,
        quote: requireString(item, "quote"),
      };
      if (typeof artifactPath === "string" && artifactPath.length > 0) {
        return { ...ref, artifactPath };
      }
      return ref;
    }),
  };
  return ctx;
}

export function normalizeValidatorCandidate(value: unknown): ValidatorCandidate {
  if (!isRecord(value)) throw new Error("ValidatorCandidate must be an object");
  return {
    command: requireString(value, "command"),
    confidence: requireEnum(value, "confidence", ["high", "medium", "low"]),
    source: requireEnum(value, "source", [
      "task_instruction",
      "repo_manifest",
      "framework_convention",
      "repo_search",
      "minimal_safe_fallback",
      "harbor_task_convention",
    ]),
    justification: requireString(value, "justification"),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

function requireStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = requireArray(record, key);
  if (!value.every((item): item is string => typeof item === "string")) {
    throw new Error(`${key} must contain only strings`);
  }
  return value;
}

function requireArray(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  if (!Array.isArray(value)) throw new Error(`${key} must be an array`);
  return value;
}

function requireEnum<const T extends readonly string[]>(
  record: Record<string, unknown>,
  key: string,
  values: T,
): T[number] {
  const value = record[key];
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(`${key} must be one of ${values.join(", ")}`);
  }
  return value;
}
