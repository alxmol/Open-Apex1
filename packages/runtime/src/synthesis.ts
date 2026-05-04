import {
  EXECUTION_CONTEXT_JSON_SCHEMA,
  extractSubagentContent,
  normalizeExecutionContext,
  type ExecutionContext,
  type ContentPart,
  type Message,
  type PredictionResult,
  type ProviderAdapter,
  type RequestOptions,
  type SubagentResult,
  type ToolDefinitionPayload,
  type TokenUsage,
} from "@open-apex/core";

import { StreamAccumulator } from "./stream-accumulator.ts";

export interface RunSynthesisInput {
  adapter: ProviderAdapter;
  synthesisPrompt: string;
  taskInstruction: string;
  prediction: PredictionResult;
  subagentResults: SubagentResult[];
  requestOptions?: RequestOptions;
  abort?: AbortSignal;
  maxInputChars?: number;
  onEvent?: (event: SynthesisEvent) => void;
}

export type SynthesisEvent =
  | { type: "synthesis_started"; attempt: number; provider: "openai" | "anthropic" }
  | { type: "synthesis_schema_failed"; attempt: number; reason: string }
  | { type: "synthesis_degraded"; reason: string };

export interface SynthesisResult {
  executionContext: ExecutionContext;
  degraded: boolean;
  attempts: number;
  usage: TokenUsage;
  rawText: string;
}

const SYNTHESIS_TOOL_NAME = "emit_execution_context";

// Anthropic does not have the same native structured-text response shape as
// OpenAI Responses. For Claude, we force a strict single tool call whose input
// is the ExecutionContext; OpenAI uses `text.format` JSON schema instead.
const SYNTHESIS_TOOL: ToolDefinitionPayload = {
  name: SYNTHESIS_TOOL_NAME,
  description:
    "Emit the final ExecutionContext object for the Open-Apex execute phase. Call this exactly once.",
  parameters: {
    type: "object",
    additionalProperties: false,
    required: ["executionContext"],
    properties: {
      executionContext: EXECUTION_CONTEXT_JSON_SCHEMA,
    },
  },
};

export async function runSynthesis(input: RunSynthesisInput): Promise<SynthesisResult> {
  const capabilities = input.adapter.getCapabilities();
  const provider = capabilities.providerId;
  const onEvent = input.onEvent ?? (() => {});
  const messages = buildSynthesisMessages(input);
  const opts: RequestOptions = {
    ...(input.requestOptions ?? {}),
    maxOutputTokens: input.requestOptions?.maxOutputTokens ?? 4096,
  };

  let lastReason = "unknown synthesis failure";
  // Synthesis failures are usually schema/normalization issues, not task
  // failures. Retry once, then continue with a mechanical context and a
  // degraded event so autonomous runs keep producing diagnosable artifacts.
  for (let attempt = 1; attempt <= 2; attempt++) {
    onEvent({ type: "synthesis_started", attempt, provider });
    try {
      const result =
        provider === "openai"
          ? await runOpenAiStructuredSynthesis(input.adapter, input.synthesisPrompt, messages, opts)
          : await runAnthropicToolSynthesis(input.adapter, input.synthesisPrompt, messages, opts);
      return { ...result, attempts: attempt };
    } catch (err) {
      lastReason = (err as Error).message;
      onEvent({ type: "synthesis_schema_failed", attempt, reason: lastReason });
    }
  }

  onEvent({ type: "synthesis_degraded", reason: lastReason });
  return {
    executionContext: buildMechanicalFallback(
      input.taskInstruction,
      input.prediction,
      input.subagentResults,
    ),
    degraded: true,
    attempts: 2,
    usage: { inputTokens: 0, outputTokens: 0 },
    rawText: `mechanical fallback after schema failures: ${lastReason}`,
  };
}

function buildSynthesisMessages(input: RunSynthesisInput): Message[] {
  const maxChars = input.maxInputChars ?? 120_000;
  const rendered = input.subagentResults.map((result) => ({
    role: result.role,
    text: extractSubagentContent(result)
      .map((part) => part.text)
      .join("\n"),
  }));
  // Preserve the highest-leverage roles when trimming. Strategy gives the
  // execution approach; exploratory execution gives real environment feedback.
  const protectedRoles = new Set(["strategy_planner", "exploratory_executor"]);
  let body = renderSynthesisPayload(input.taskInstruction, input.prediction, rendered);
  if (body.length > maxChars) {
    const trimmed = rendered.map((entry) => {
      if (protectedRoles.has(entry.role)) return entry;
      return {
        ...entry,
        text: entry.text.slice(0, Math.max(1000, Math.floor(entry.text.length / 2))),
      };
    });
    body = renderSynthesisPayload(input.taskInstruction, input.prediction, trimmed);
  }
  if (body.length > maxChars) body = body.slice(0, maxChars);
  return [
    {
      role: "user",
      content: [
        "Synthesize the following Open-Apex gather artifacts into the requested ExecutionContext.",
        "",
        body,
      ].join("\n"),
    },
  ];
}

function renderSynthesisPayload(
  taskInstruction: string,
  prediction: PredictionResult,
  rendered: Array<{ role: string; text: string }>,
): string {
  return [
    "<task_instruction>",
    taskInstruction.trim(),
    "</task_instruction>",
    "",
    "<prediction>",
    JSON.stringify(prediction, null, 2),
    "</prediction>",
    "",
    "<subagent_results>",
    ...rendered.map((entry) => [`<${entry.role}>`, entry.text, `</${entry.role}>`].join("\n")),
    "</subagent_results>",
  ].join("\n");
}

async function runOpenAiStructuredSynthesis(
  adapter: ProviderAdapter,
  synthesisPrompt: string,
  messages: Message[],
  opts: RequestOptions,
): Promise<Omit<SynthesisResult, "attempts">> {
  const accum = new StreamAccumulator();
  // OpenAI Responses can enforce a JSON-schema final text payload directly,
  // which keeps synthesis output out of the normal tool loop.
  const stream = adapter.generate(
    {
      systemPrompt: synthesisPrompt,
      messages,
      tools: [],
      toolChoice: { type: "none" },
    },
    {
      ...opts,
      structuredOutput: {
        type: "json_schema",
        name: "execution_context",
        strict: true,
        schema: EXECUTION_CONTEXT_JSON_SCHEMA,
      },
    },
  );
  for await (const event of stream) accum.ingest(event);
  if (!accum.isComplete()) throw new Error("synthesis stream ended before done");
  const turn = accum.finalize("synthesis_openai");
  const rawText = extractText(turn.assistant.content);
  const parsed = parseJsonObject(rawText);
  return {
    executionContext: normalizeExecutionContext(parsed),
    degraded: false,
    usage: turn.usage,
    rawText,
  };
}

async function runAnthropicToolSynthesis(
  adapter: ProviderAdapter,
  synthesisPrompt: string,
  messages: Message[],
  opts: RequestOptions,
): Promise<Omit<SynthesisResult, "attempts">> {
  const accum = new StreamAccumulator();
  // Claude's strict-tool path gives us the same normalized contract without
  // depending on provider-hosted agent/tool semantics.
  const stream = adapter.generate(
    {
      systemPrompt: `${synthesisPrompt}\n\nCall emit_execution_context exactly once with the ExecutionContext.`,
      messages,
      tools: [SYNTHESIS_TOOL],
      toolChoice: { type: "specific", toolName: SYNTHESIS_TOOL_NAME },
    },
    opts,
  );
  for await (const event of stream) accum.ingest(event);
  if (!accum.isComplete()) throw new Error("synthesis stream ended before done");
  const turn = accum.finalize("synthesis_anthropic");
  const call = turn.toolCalls.find((toolCall) => toolCall.name === SYNTHESIS_TOOL_NAME);
  if (!call) throw new Error("Anthropic synthesis did not call emit_execution_context");
  const args = typeof call.args === "string" ? parseJsonObject(call.args) : call.args;
  const payload =
    args && typeof args === "object" && "executionContext" in args
      ? (args as { executionContext: unknown }).executionContext
      : args;
  return {
    executionContext: normalizeExecutionContext(payload),
    degraded: false,
    usage: turn.usage,
    rawText: JSON.stringify(args),
  };
}

function buildMechanicalFallback(
  taskInstruction: string,
  prediction: PredictionResult,
  subagentResults: SubagentResult[],
): ExecutionContext {
  // Last-resort fallback: never drop synthesis entirely. We preserve the task,
  // prediction, high-signal repo files, and any planner validators so execution
  // still has a bounded context and telemetry shows the degradation.
  const strategy = subagentResults.find((r) => r.role === "strategy_planner");
  const validators =
    strategy?.role === "strategy_planner" && strategy.likelyValidators.length > 0
      ? strategy.likelyValidators
      : [];
  const files = new Set<string>(prediction.keyFiles);
  for (const result of subagentResults) {
    if (result.role === "repo_scout") {
      for (const key of result.keyFileContents) files.add(key.path);
    }
  }
  return {
    chosenApproach:
      strategy?.role === "strategy_planner" && strategy.rankedApproaches[0]
        ? strategy.rankedApproaches[0].approach
        : "Use gathered repository and environment facts to make the smallest validated change.",
    prioritizedFacts: [
      `Task category: ${prediction.taskCategory}`,
      `Risk profile: ${prediction.riskProfile}`,
      `Task: ${taskInstruction.trim().slice(0, 500)}`,
    ],
    executionPlan: [
      {
        id: "inspect",
        description: "Inspect the highest-signal files and current validator state.",
        preconditions: [],
        expectedOutcome: "The executor understands the concrete change surface.",
      },
      {
        id: "change",
        description: "Apply the smallest safe workspace change.",
        preconditions: ["Relevant files have been inspected."],
        expectedOutcome: "The requested behavior is implemented.",
      },
      {
        id: "validate",
        description: "Run the best-known validators before completion.",
        preconditions: ["Implementation changes are complete."],
        expectedOutcome: "Validators pass or produce actionable recovery evidence.",
      },
    ],
    filesToInspect: [...files],
    filesToChange: [...files],
    validators,
    riskGuards:
      prediction.riskProfile === "high"
        ? ["Avoid destructive operations; prefer reversible edits and checkpoint before mutation."]
        : ["Keep edits scoped and validate before reporting success."],
    searchPivotHooks: strategy?.role === "strategy_planner" ? strategy.searchPivots : [],
    completionChecklist: ["Requested outcome implemented", "Best-known validators passed"],
    evidenceRefs: subagentResults.map((r) => ({
      sourceRole: r.role,
      quote: `${r.role} completed with confidence=${r.confidence}`,
    })),
  };
}

function extractText(content: Message["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function parseJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
    if (fenced) return JSON.parse(fenced.trim());
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    throw new Error("synthesis output was not valid JSON");
  }
}
