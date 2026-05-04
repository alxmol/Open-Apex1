/**
 * TurnRunner — runs one full agent turn against a ProviderAdapter.
 *
 * §M1 scope:
 *   - single call to adapter.generate() (or resume)
 *   - accumulate stream events into an AccumulatedTurn
 *   - run any tool calls via the §3.4.13 scheduler
 *   - feed tool results back into the next generate() call up to maxTurns
 *   - stop when the model emits a "end_turn" stop reason with no tool calls
 *
 * Not yet (M2+):
 *   - permission approval gate (auto-allow all at M1)
 *   - handoffs (M4 subagents)
 *   - compaction decisions (M5)
 *   - recovery engine (M4)
 */

import type {
  AgentRequest,
  HistoryItem,
  Message,
  ProviderAdapter,
  ProviderContinuationHandle,
  RequestOptions,
  StreamEvent,
  TokenUsage,
  ToolCallRequest,
  ToolDefinition,
  ToolResult,
  OpenApexRunContext,
  ContentPart,
  ImageContent,
  PdfContent,
  TextContent,
  RolloutItem,
  SessionStore,
} from "@open-apex/core";

import { addUsage, zeroUsage } from "@open-apex/core";
import type { ClassifierResult, GateDecision } from "@open-apex/tools";

import { StreamAccumulator, type AccumulatedTurn } from "./stream-accumulator.ts";
import {
  maybeInjectPatchRecovery,
  newPatchRecoveryState,
  type PatchRecoveryState,
} from "./patch-recovery.ts";
import { executeToolBatch, type ScheduleOptions, type SchedulerEvent } from "./tool-loop.ts";

export interface TurnRunnerOptions {
  /** Hard ceiling on model calls. Default 50. */
  maxTurns?: number;
  /** Observer for each RunEvent-equivalent emission. */
  onEvent?: (ev: RunObserverEvent) => void;
  /** Signal to abort the run. */
  abort?: AbortSignal;
  /** Per-turn adapter RequestOptions (passes through effort, verbosity, etc.). */
  requestOptions?: RequestOptions;
  /** Benchmark-mode targeted guardrails. */
  benchmarkMode?: boolean;
  /** Chat-mode approval bridge; autonomous can omit this and use gate defaults. */
  canUseTool?: ScheduleOptions["canUseTool"];
  /**
   * M5 durable session persistence. The turn runner writes provider-neutral
   * rollout items as it advances; JSONL remains canonical for resume.
   */
  session?: {
    store: SessionStore;
    sessionId: string;
    cwd: string;
    persistInitialMessages?: boolean;
  };
  /** Existing provider continuation restored from a prior chat turn/session. */
  startingProviderHandle?: ProviderContinuationHandle | null;
  /**
   * Number of initial history items already represented by startingProviderHandle.
   * Newer items are sent as the resume delta.
   */
  startingDeliveredHistoryLength?: number;
  /** Fall back to local full replay if a provider continuation handle is stale. */
  fallbackToLocalReplayOnResumeError?: boolean;
  /**
   * Called after a tool batch containing at least one mutating/serial tool
   * has completed. M4's phase engine uses this to run cheap validation
   * before the model accumulates many bad mutations.
   */
  onMutationBatch?: (
    ev: MutationBatchCompletedEvent,
  ) => Promise<MutationBatchFeedback | void> | MutationBatchFeedback | void;
  /**
   * Max consecutive hallucinated-syntax strikes before the run is marked
   * `runtime_failure`. Default 3. After strike N, the next request is
   * re-issued with `tool_choice: "required"` to force a real tool call.
   */
  maxHallucinationStrikes?: number;
}

export type RunObserverEvent =
  | { type: "turn_started"; turn: number }
  | { type: "stream_event"; event: StreamEvent }
  | { type: "assistant_message"; item: HistoryItem }
  | { type: "tool_called"; call: ToolCallRequest }
  | { type: "tool_output"; result: ToolResult }
  | MutationBatchCompletedEvent
  | {
      type: "permission_decision";
      callId: string;
      tool: string;
      classification: ClassifierResult;
      gate: GateDecision;
      outcome: "allow" | "deny";
      reason?: string;
    }
  | { type: "turn_complete"; turn: AccumulatedTurn }
  | {
      type: "search_advice_injected";
      reason: "web_search_threshold" | "fetch_url_threshold" | "duplicate_queries";
      webSearchCalls: number;
      fetchUrlCalls: number;
    }
  | { type: "nudge_fired"; strike: number; reason: "hallucinated_syntax" | "prose_only" }
  | { type: "recovery_strike"; strike: number; forcedToolChoice: boolean }
  | {
      type: "tool_bad_args_recovery_injected";
      tool: string;
      signature: string;
      attempt: number;
    }
  | {
      type: "bad_args_repair_appended";
      tool: string;
      provider: string;
      attempt: number;
    }
  | {
      type: "tool_temporarily_suppressed";
      tool: string;
      reason: "repeated_bad_args";
      nextTurn: number;
    }
  | {
      type: "tool_unavailable_this_turn";
      provider: string;
      tool: string;
      availableTools: string[];
    }
  | {
      type: "patch_recovery_read_injected";
      path: string;
      attempt: number;
    }
  | { type: "patch_apply_failed"; path: string; attempts: number }
  | { type: "run_complete"; finalAssistant: HistoryItem | null; totalUsage: TokenUsage };

export interface MutationBatchCompletedEvent {
  type: "mutation_batch_completed";
  turn: number;
  tools: string[];
  ok: boolean;
  calls: Array<Pick<ToolCallRequest, "id" | "name" | "arguments">>;
  results: ToolResult[];
}

export interface MutationBatchFeedback {
  message: string;
  /** Stop the turn loop immediately after appending this feedback. */
  stop?: boolean;
  /** Human-readable stop reason for telemetry/debugging. */
  reason?: string;
}

/** Why the turn loop ended. */
export type TerminationReason =
  | "end_turn" // model stopped emitting tool calls naturally
  | "max_turns" // maxTurns ceiling hit
  | "abort" // caller aborted via signal
  | "stream_error" // adapter surfaced a stream-level error
  | "validation_success" // runtime validator passed strongly after a mutation batch
  | "hallucinated_tool_loop"; // N consecutive hallucinated-syntax strikes exhausted

export interface TurnRunnerResult {
  /** Full conversation history, including the seed messages. */
  history: HistoryItem[];
  /** Aggregate usage across all turns. */
  usage: TokenUsage;
  /** The assistant's last message (if any). */
  finalAssistant: HistoryItem | null;
  /** Provider handle for resume. */
  providerHandle: ProviderContinuationHandle | null;
  /** Number of model turns taken. */
  turnsRun: number;
  /** True if maxTurns was hit. */
  maxTurnsHit: boolean;
  /** All tool calls executed during the run. */
  toolCalls: Array<{ call: ToolCallRequest; result: ToolResult }>;
  /** Why the loop exited. Used by the autonomous CLI to route exit codes. */
  terminationReason: TerminationReason;
  /** Total consecutive hallucination strikes observed (0 on healthy runs). */
  hallucinationStrikes: number;
}

/**
 * Drive a full run: systemPrompt + messages + tools → repeated turns until
 * the model stops emitting tool calls.
 */
export async function runAgenticTurns(params: {
  adapter: ProviderAdapter;
  systemPrompt: string;
  initialMessages: Message[];
  tools: ToolDefinition[];
  toolRegistry: Map<string, ToolDefinition>;
  ctx: OpenApexRunContext;
  options?: TurnRunnerOptions;
}): Promise<TurnRunnerResult> {
  const { adapter, systemPrompt, initialMessages, tools, toolRegistry, ctx } = params;
  const opts = params.options ?? {};
  const maxTurns = opts.maxTurns ?? 50;
  const onEvent = opts.onEvent ?? (() => {});
  const benchmarkMode = opts.benchmarkMode ?? false;
  const maxStrikes = opts.maxHallucinationStrikes ?? 3;

  const history: HistoryItem[] = initialMessages.map((m, i) => messageToHistory(m, i));
  if (opts.session?.persistInitialMessages) {
    for (const item of history) {
      await persistRollout(opts.session, { type: "response_item", payload: item });
    }
  }
  let usage = zeroUsage();
  let providerHandle: ProviderContinuationHandle | null = opts.startingProviderHandle ?? null;
  const toolCalls: Array<{ call: ToolCallRequest; result: ToolResult }> = [];
  let turnsRun = 0;
  let maxTurnsHit = false;
  let terminationReason: TerminationReason = "end_turn";
  /** Consecutive hallucinated-syntax / prose-only strikes. Resets on any real tool call. */
  let hallucinationStrikes = 0;
  /** When true, the next request adds `tool_choice: "required"`. Consumed once per fire. */
  let forceToolChoiceNext = false;
  /** §1.2 patch-recovery per-run ledger. */
  const patchRecovery: PatchRecoveryState = newPatchRecoveryState();
  /** Benchmark-only soft warning for search loops. */
  const searchGuard = newSearchGuardState();
  const badArgsState = newBadArgsRecoveryState();
  const badArgsPolicy = badArgsPolicyForProvider(adapter);
  let toolsSuppressedForNextTurn = new Set<string>();

  // Strip non-transferable extras when preparing messages for the provider.
  const toProviderMessages = (items: HistoryItem[]): Message[] => items.map(historyToMessage);

  // Resume-delta tracking. Everything in `history` up to (and including)
  // `lastModelCallEndIndex` has been delivered to the provider on prior
  // generate/resume calls. The next request sends only history items at
  // indices >= lastModelCallEndIndex (the delta). We snapshot this BEFORE
  // appending the assistant output each turn so the NEXT request correctly
  // ships only post-assistant items (tool_result + any injected nudges).
  let lastModelCallEndIndex = providerHandle
    ? Math.max(0, Math.min(opts.startingDeliveredHistoryLength ?? history.length, history.length))
    : history.length;

  // Loop turns.
  while (true) {
    if (opts.abort?.aborted) {
      terminationReason = "abort";
      break;
    }
    if (turnsRun >= maxTurns) {
      maxTurnsHit = true;
      terminationReason = "max_turns";
      break;
    }
    turnsRun++;
    onEvent({ type: "turn_started", turn: turnsRun });
    await persistEvent(opts.session, { type: "turn_started", turn: turnsRun });

    // Build the AgentRequest for THIS turn. On resume, `messages` is the
    // delta since the last assistant output was seen. On fresh generate, it's
    // the full history.
    const deltaMessages = providerHandle
      ? toProviderMessages(history.slice(lastModelCallEndIndex))
      : toProviderMessages(history);
    const activeTools = tools.filter((tool) => !toolsSuppressedForNextTurn.has(tool.name));
    const activeToolNames = activeTools.map((tool) => tool.name);
    toolsSuppressedForNextTurn = new Set();
    const req: AgentRequest = {
      systemPrompt,
      messages: deltaMessages,
      tools: activeTools.map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
      toolChoice: activeTools.length > 0 ? { type: "auto" } : { type: "none" },
    };

    const accum = new StreamAccumulator();
    const reqOpts: RequestOptions = { ...(opts.requestOptions ?? {}) };
    if (opts.abort) (reqOpts as { signal?: AbortSignal }).signal = opts.abort;
    if (forceToolChoiceNext && activeTools.length > 0) {
      reqOpts.forceToolChoice = "required";
      onEvent({ type: "recovery_strike", strike: hallucinationStrikes, forcedToolChoice: true });
      forceToolChoiceNext = false;
    }
    const resumeHandle = providerHandle;
    const stream = resumeHandle
      ? adapter.resume(resumeHandle, req, reqOpts)
      : adapter.generate(req, reqOpts);

    let streamErrored = false;
    let resumeFallbackReason: string | null = null;
    try {
      for await (const ev of stream) {
        onEvent({ type: "stream_event", event: ev });
        if (
          ev.type === "compaction_block" ||
          ev.type === "context_edit_applied" ||
          ev.type === "usage_update"
        ) {
          await persistEvent(opts.session, { type: "stream_event", event: ev });
          if (ev.type === "compaction_block") {
            await persistRollout(opts.session, {
              type: "compacted",
              payload: {
                trigger: "server",
                preTokens: usage.inputTokens,
                postTokens: Math.max(0, usage.inputTokens - ev.summaryTokens),
                replacedRange: ev.replacedRange,
              },
            });
          }
        }
        accum.ingest(ev);
        if (ev.type === "error") {
          streamErrored = true;
          if (resumeHandle && opts.fallbackToLocalReplayOnResumeError !== false) {
            resumeFallbackReason = ev.message;
          }
          terminationReason = "stream_error";
          break;
        }
      }
    } catch (err) {
      if (resumeHandle && opts.fallbackToLocalReplayOnResumeError !== false) {
        const conversationFallback = conversationFallbackFor(resumeHandle);
        if (conversationFallback) {
          await persistEvent(opts.session, {
            type: "provider_resume_fallback",
            providerHandleKind: resumeHandle.kind,
            fallbackAction: "openai_conversation",
            conversationId: conversationFallback.conversationId,
            reason: (err as Error).message,
          });
          providerHandle = conversationFallback;
          turnsRun--;
          continue;
        }
        await persistEvent(opts.session, {
          type: "provider_resume_fallback",
          providerHandleKind: resumeHandle.kind,
          fallbackAction: "local_replay",
          reason: (err as Error).message,
        });
        providerHandle = null;
        lastModelCallEndIndex = 0;
        turnsRun--;
        continue;
      }
      // Propagate the error; autonomous CLI wraps into OpenApexResult.error.
      throw err;
    }

    if (resumeFallbackReason) {
      const conversationFallback = resumeHandle ? conversationFallbackFor(resumeHandle) : null;
      await persistEvent(opts.session, {
        type: "provider_resume_fallback",
        providerHandleKind: resumeHandle?.kind ?? "unknown",
        fallbackAction: conversationFallback ? "openai_conversation" : "local_replay",
        ...(conversationFallback ? { conversationId: conversationFallback.conversationId } : {}),
        reason: resumeFallbackReason,
      });
      if (conversationFallback) {
        providerHandle = conversationFallback;
      } else {
        providerHandle = null;
        lastModelCallEndIndex = 0;
      }
      turnsRun--;
      continue;
    }

    if (streamErrored) break;

    if (!accum.isComplete()) {
      // Stream ended without a `done` event. Adapter should have translated
      // this into an error event; treat as stream_error regardless.
      terminationReason = "stream_error";
      break;
    }
    const turn = accum.finalize(`asst_${turnsRun}`);
    usage = addUsage(usage, turn.usage);
    // The adapter-emitted handle already carries the full replay buffer it
    // needs. For OpenAI that's a `previous_response_id` pointer (server-side
    // CoT); for Anthropic it's [...req.messages, assistantMessage] which the
    // translator materializes from the SSE stream (see AnthropicEventTranslator
    // .getAssistantMessage — Anthropic has no continuation primitive so the
    // caller must replay, and that replay lives in the adapter, not here).
    providerHandle = turn.providerHandle;
    turn.assistant.tokenUsage = turn.usage;
    history.push(turn.assistant);
    await persistRollout(opts.session, {
      type: "turn_context",
      payload: {
        turn: turnsRun,
        cwd: opts.session?.cwd ?? ctx.userContext.workspace,
        timestamp: new Date().toISOString(),
        providerHandle,
      },
    });
    await persistRollout(opts.session, { type: "response_item", payload: turn.assistant });
    // Mark this index so the NEXT turn's resume delta starts AFTER this
    // assistant message.
    lastModelCallEndIndex = history.length;

    onEvent({ type: "assistant_message", item: turn.assistant });
    onEvent({ type: "turn_complete", turn });
    await persistEvent(opts.session, { type: "turn_complete", turn: turnsRun });

    const emittedToolCalls = turn.toolCalls.length > 0;

    if (emittedToolCalls) {
      // Any real tool call resets the strike counter.
      hallucinationStrikes = 0;
    } else {
      // No tool calls: check for hallucinated-syntax / prose-only on
      // action-oriented tasks.
      const shouldNudge = shouldRepromptForBenchmarkAction(history, turn);
      const benchmarkOrChat = benchmarkMode; // M1 scope: nudge only in benchmark
      if (benchmarkOrChat && shouldNudge) {
        hallucinationStrikes++;
        const reason = containsHallucinatedToolSyntax(historyItemToText(turn.assistant))
          ? "hallucinated_syntax"
          : "prose_only";
        onEvent({ type: "nudge_fired", strike: hallucinationStrikes, reason });

        if (hallucinationStrikes >= maxStrikes) {
          terminationReason = "hallucinated_tool_loop";
          break;
        }

        // Inject an escalating nudge + force tool_choice on next request.
        const taskText = firstUserText(history);
        const toolNames = tools.map((t) => t.name);
        history.push({
          id: `bench_nudge_${turnsRun}_s${hallucinationStrikes}`,
          createdAt: new Date().toISOString(),
          role: "user",
          content: buildNudgeText(hallucinationStrikes, toolNames, taskText),
        });
        forceToolChoiceNext = true;
        continue;
      }

      // Either it's a healthy end-of-turn, or benchmark-mode nudge didn't
      // fire (non-benchmark): end the loop. The caller (chat mode) can
      // re-prompt; autonomous mode already handled the benchmark path above.
      terminationReason = "end_turn";
      break;
    }

    if (!emittedToolCalls) continue;

    // Execute tool calls.
    const callRequests: ToolCallRequest[] = turn.toolCalls.map((c) => ({
      id: c.id,
      name: c.name,
      arguments: c.args as Record<string, unknown> | string,
    }));
    const pendingEventWrites: Promise<void>[] = [];
    const results = await executeToolBatch(callRequests, toolRegistry, ctx, {
      ...(opts.abort ? { abort: opts.abort } : {}),
      activeToolNames,
      ...(opts.canUseTool ? { canUseTool: opts.canUseTool } : {}),
      recoveryWriteFileOpenFor: patchRecovery.writeFileOpenFor,
      onEvent: (sev: SchedulerEvent) => {
        if (sev.type === "tool_called") {
          onEvent({ type: "tool_called", call: sev.call });
        } else if (sev.type === "tool_output") {
          onEvent({ type: "tool_output", result: sev.result });
        } else if (sev.type === "tool_unavailable_this_turn") {
          onEvent({
            type: "tool_unavailable_this_turn",
            provider: badArgsPolicy.provider,
            tool: sev.call.name,
            availableTools: sev.availableTools,
          });
        } else if (sev.type === "permission_decision") {
          onEvent(sev);
        }
        pendingEventWrites.push(persistEvent(opts.session, { type: sev.type, event: sev }));
      },
    });
    await Promise.all(pendingEventWrites);
    for (let i = 0; i < callRequests.length; i++) {
      toolCalls.push({ call: callRequests[i]!, result: results[i]! });
    }
    const badArgsMessages: string[] = [];
    for (let i = 0; i < callRequests.length; i++) {
      const call = callRequests[i]!;
      const result = results[i]!;
      if (result.status === "ok") {
        badArgsState.byTool.delete(call.name);
        continue;
      }
      if (result.status !== "error" || result.errorType !== "bad_args") continue;
      if (isToolUnavailableThisTurn(result)) {
        const availableTools = toolUnavailableAlternatives(result);
        if (availableTools.length > 0) {
          badArgsMessages.push(buildToolUnavailableRecoveryMessage(call.name, availableTools));
          toolsSuppressedForNextTurn.add(call.name);
          onEvent({
            type: "tool_temporarily_suppressed",
            tool: call.name,
            reason: "repeated_bad_args",
            nextTurn: turnsRun + 1,
          });
        }
        continue;
      }
      const tool = toolRegistry.get(call.name);
      const alternatives = tools
        .filter((candidate) => candidate.name !== call.name)
        .map((candidate) => candidate.name);
      const update = recordBadArgsFailure(
        badArgsState,
        call,
        result,
        tool,
        badArgsPolicy,
        alternatives,
      );
      if (update.injectMessage) {
        badArgsMessages.push(update.injectMessage);
        onEvent({
          type: "tool_bad_args_recovery_injected",
          tool: call.name,
          signature: update.signature,
          attempt: update.attempt,
        });
        onEvent({
          type: "bad_args_repair_appended",
          tool: call.name,
          provider: badArgsPolicy.provider,
          attempt: update.attempt,
        });
      }
      if (update.suppressNextTurn && tools.some((candidate) => candidate.name !== call.name)) {
        toolsSuppressedForNextTurn.add(call.name);
        onEvent({
          type: "tool_temporarily_suppressed",
          tool: call.name,
          reason: "repeated_bad_args",
          nextTurn: turnsRun + 1,
        });
      }
    }
    const mutatingTools = callRequests.filter((call) => {
      const tool = toolRegistry.get(call.name);
      return tool !== undefined && tool.kind !== "function";
    });
    const mutatingToolPairs = callRequests
      .map((call, index) => ({ call, result: results[index]! }))
      .filter(({ call }) => {
        const tool = toolRegistry.get(call.name);
        return tool !== undefined && tool.kind !== "function";
      });
    let mutationFeedback: MutationBatchFeedback | void = undefined;
    const everyMutatingToolFailedBadArgs =
      mutatingToolPairs.length > 0 &&
      mutatingToolPairs.every(
        ({ result }) => result.status === "error" && result.errorType === "bad_args",
      );
    if (mutatingTools.length > 0 && !everyMutatingToolFailedBadArgs) {
      // The phase engine may run validators here and return a synthetic
      // feedback message. We wait for that before appending the next
      // tool_result turn so the next provider request sees both the tool
      // outputs and the runtime's validation observation.
      const mutationEvent: MutationBatchCompletedEvent = {
        type: "mutation_batch_completed",
        turn: turnsRun,
        tools: mutatingTools.map((call) => call.name),
        ok: results.every((result) => result.status === "ok"),
        calls: mutatingTools.map((call) => ({
          id: call.id,
          name: call.name,
          arguments: call.arguments,
        })),
        results,
      };
      onEvent(mutationEvent);
      mutationFeedback = await opts.onMutationBatch?.(mutationEvent);
    }
    // Append a user-role tool_result message for the next turn.
    const toolResultContent: ContentPart[] = results.map((r) => ({
      type: "tool_result" as const,
      toolCallId: r.toolCallId,
      content: isToolResultContentPartArray(r.content)
        ? r.content
        : stringifyToolResultContent(r.content),
      ...(r.status === "error" ? { isError: true } : {}),
    }));
    if (badArgsMessages.length > 0) {
      // Anthropic's replay rules require tool_result blocks to appear first in
      // the user message that answers an assistant tool_use. Appending the
      // repair text after those blocks keeps Opus grounded without forcing
      // tool_choice (which would disable extended/adaptive thinking).
      toolResultContent.push({ type: "text", text: badArgsMessages.join("\n\n") });
    }
    const toolResultMsg: HistoryItem = {
      id: `tr_${turnsRun}`,
      createdAt: new Date().toISOString(),
      role: "user",
      content: toolResultContent,
    };
    history.push(toolResultMsg);
    await persistRollout(opts.session, { type: "response_item", payload: toolResultMsg });
    if (mutationFeedback?.message) {
      // This is deliberately a user-role message rather than a tool_result:
      // no model tool call produced it, and providers should treat it as
      // ordinary runtime context for the next turn.
      const feedbackItem: HistoryItem = {
        id: `mutation_validation_${turnsRun}`,
        createdAt: new Date().toISOString(),
        role: "user",
        content: mutationFeedback.message,
      };
      history.push(feedbackItem);
      await persistRollout(opts.session, { type: "response_item", payload: feedbackItem });
    }
    if (mutationFeedback?.stop) {
      terminationReason = "validation_success";
      break;
    }

    // §1.2 patch-failure recovery: if any apply_patch call failed with a
    // structured error naming a path, inject a synthetic read_file result
    // and mark write_file as open for that path on the next turn. Other
    // recovery decisions (read_file already re-emitted, etc.) are emitted
    // as model_events for observability.
    const recovery = maybeInjectPatchRecovery(
      callRequests,
      results,
      patchRecovery,
      ctx.userContext.workspace,
      turnsRun,
    );
    if (recovery.inject.length > 0) {
      for (const item of recovery.inject) {
        history.push(item);
        await persistRollout(opts.session, { type: "response_item", payload: item });
        const match = /apply_patch failed on (\S+)/.exec(
          typeof item.content === "string" ? item.content : JSON.stringify(item.content),
        );
        if (match) {
          onEvent({
            type: "patch_recovery_read_injected",
            path: match[1]!,
            attempt: patchRecovery.failureCount.get(match[1]!) ?? 1,
          });
        }
      }
    }
    if (recovery.exhausted.length > 0) {
      for (const p of recovery.exhausted) {
        onEvent({
          type: "patch_apply_failed",
          path: p,
          attempts: patchRecovery.failureCount.get(p) ?? 3,
        });
      }
    }

    const searchAdvice = benchmarkMode ? maybeBuildSearchAdvice(callRequests, searchGuard) : null;
    if (searchAdvice) {
      const adviceItem: HistoryItem = {
        id: `search_advice_${turnsRun}`,
        createdAt: new Date().toISOString(),
        role: "user",
        content: searchAdvice.text,
      };
      history.push(adviceItem);
      await persistRollout(opts.session, { type: "response_item", payload: adviceItem });
      onEvent({
        type: "search_advice_injected",
        reason: searchAdvice.reason,
        webSearchCalls: searchGuard.webSearchCalls,
        fetchUrlCalls: searchGuard.fetchUrlCalls,
      });
    }
  }

  return finalizeResult(
    history,
    usage,
    providerHandle,
    turnsRun,
    maxTurnsHit,
    toolCalls,
    terminationReason,
    hallucinationStrikes,
    onEvent,
  );
}

async function persistRollout(
  session: TurnRunnerOptions["session"] | undefined,
  item: RolloutItem,
): Promise<void> {
  if (!session) return;
  await session.store.appendRolloutItem(session.sessionId, item);
}

async function persistEvent(
  session: TurnRunnerOptions["session"] | undefined,
  event: Record<string, unknown>,
): Promise<void> {
  if (!session) return;
  await persistRollout(session, {
    type: "event_msg",
    payload: {
      type: String(event.type ?? "event"),
      ts: new Date().toISOString(),
      ...event,
    },
  });
}

function finalizeResult(
  history: HistoryItem[],
  usage: TokenUsage,
  providerHandle: ProviderContinuationHandle | null,
  turnsRun: number,
  maxTurnsHit: boolean,
  toolCalls: Array<{ call: ToolCallRequest; result: ToolResult }>,
  terminationReason: TerminationReason,
  hallucinationStrikes: number,
  onEvent: (ev: RunObserverEvent) => void,
): TurnRunnerResult {
  const finalAssistant = [...history].reverse().find((h) => h.role === "assistant") ?? null;
  onEvent({ type: "run_complete", finalAssistant, totalUsage: usage });
  return {
    history,
    usage,
    finalAssistant,
    providerHandle,
    turnsRun,
    maxTurnsHit,
    toolCalls,
    terminationReason,
    hallucinationStrikes,
  };
}

function conversationFallbackFor(
  handle: ProviderContinuationHandle,
): Extract<ProviderContinuationHandle, { kind: "openai_conversation" }> | null {
  if (handle.kind === "openai_conversation") return null;
  if (handle.kind === "openai_response" || handle.kind === "openai_compacted") {
    return handle.conversationId
      ? { kind: "openai_conversation", conversationId: handle.conversationId }
      : null;
  }
  return null;
}

function buildNudgeText(strike: number, toolNames: string[], taskText: string): string {
  const toolsList = toolNames.length > 0 ? toolNames.join(", ") : "(none)";
  if (strike === 1) {
    return [
      "Your previous reply did not invoke any tool. The available tools are:",
      `  ${toolsList}`,
      "",
      "Emit tool calls via the native function-calling channel ONLY. Text patterns like",
      "`to=functions.X`, `<assistant recipient=...>`, `multi_tool_use.parallel`,",
      '`{"tool_uses":[...]}`, `{"recipient_name":"...","parameters":...}`, or',
      "`<function=...>...</function>` are NOT executed and count as hallucinated output.",
      "Act with the available tools NOW. You have no other channel.",
    ].join("\n");
  }
  if (strike === 2) {
    return [
      "Second warning: no tool was invoked on your last two assistant turns.",
      "",
      `Task: ${taskText.slice(0, 400)}`,
      "",
      `Available tools: ${toolsList}`,
      "",
      "The next response MUST contain at least one tool call via the function-calling",
      "channel. If you genuinely cannot proceed, call `run_shell` with `['echo','blocked']`",
      "and explain why in the assistant text after the tool call — do NOT write prose-only",
      "answers that pretend to invoke tools.",
    ].join("\n");
  }
  return [
    "Final warning: you are about to be marked as broken.",
    "Make one real tool call on your next response or the run will terminate.",
  ].join("\n");
}

interface BadArgsRecoveryState {
  byTool: Map<string, { signature: string; count: number; injected: boolean }>;
}

function newBadArgsRecoveryState(): BadArgsRecoveryState {
  return { byTool: new Map() };
}

interface BadArgsPolicy {
  provider: string;
  suppressAfter: number;
  suppressOnlyEmptyRequiredArgs: boolean;
  recommendAlternatives: boolean;
}

function badArgsPolicyForProvider(adapter: ProviderAdapter): BadArgsPolicy {
  const capabilities = adapter.getCapabilities();
  const isOpus =
    capabilities.providerId === "anthropic" && /opus/i.test(capabilities.modelId ?? "");
  return {
    provider: capabilities.providerId,
    suppressAfter: isOpus ? 2 : 3,
    suppressOnlyEmptyRequiredArgs: isOpus,
    recommendAlternatives: isOpus,
  };
}

function recordBadArgsFailure(
  state: BadArgsRecoveryState,
  call: ToolCallRequest,
  result: ToolResult,
  tool: ToolDefinition | undefined,
  policy: BadArgsPolicy,
  alternatives: string[],
): { signature: string; attempt: number; injectMessage?: string; suppressNextTurn: boolean } {
  const signature = normalizeBadArgsSignature(result.content);
  const previous = state.byTool.get(call.name);
  const entry =
    previous && previous.signature === signature
      ? previous
      : { signature, count: 0, injected: false };
  entry.count++;
  let injectMessage: string | undefined;
  if (entry.count === 2 && !entry.injected) {
    entry.injected = true;
    injectMessage = buildBadArgsRecoveryMessage(call.name, result, tool, policy, alternatives);
  }
  state.byTool.set(call.name, entry);
  const canSuppress =
    entry.count >= policy.suppressAfter &&
    (!policy.suppressOnlyEmptyRequiredArgs || isEmptyRequiredArgsFailure(call, result));
  return {
    signature,
    attempt: entry.count,
    ...(injectMessage ? { injectMessage } : {}),
    suppressNextTurn: canSuppress,
  };
}

function normalizeBadArgsSignature(content: unknown): string {
  return stringifyToolResultContent(content).replace(/\s+/g, " ").trim().slice(0, 300);
}

function buildBadArgsRecoveryMessage(
  toolName: string,
  result: ToolResult,
  tool: ToolDefinition | undefined,
  policy: BadArgsPolicy,
  alternatives: string[],
): string {
  const schema = tool ? toolSchemaSummary(tool.parameters) : "(schema unavailable)";
  const example = tool ? toolInputExample(tool) : "{}";
  const lines = [
    `<tool_argument_repair tool="${toolName}">`,
    `The last ${toolName} call was rejected before execution: ${stringifyToolResultContent(
      result.content,
    )}`,
    "Call the tool again only with valid JSON arguments matching this schema summary.",
    schema,
    `Example valid arguments: ${example}`,
    "Do not repeat an empty object or omit required fields.",
  ];
  if (policy.recommendAlternatives && alternatives.length > 0) {
    const preferred = alternatives
      .filter((name) =>
        ["apply_patch", "search_replace", "shell_command", "run_shell"].includes(name),
      )
      .concat(
        alternatives.filter(
          (name) => !["apply_patch", "search_replace", "shell_command", "run_shell"].includes(name),
        ),
      )
      .slice(0, 4);
    lines.push(
      `If ${toolName} keeps failing, use a valid alternative for the next action: ${preferred.join(
        ", ",
      )}.`,
    );
  }
  lines.push("</tool_argument_repair>");
  return lines.join("\n");
}

function isToolUnavailableThisTurn(result: ToolResult): boolean {
  const metadata = result.metadata;
  return (
    metadata !== undefined &&
    typeof metadata === "object" &&
    (metadata as { toolUnavailableThisTurn?: unknown }).toolUnavailableThisTurn === true
  );
}

function toolUnavailableAlternatives(result: ToolResult): string[] {
  const metadata = result.metadata;
  if (!metadata || typeof metadata !== "object") return [];
  const raw = (metadata as { availableTools?: unknown }).availableTools;
  return Array.isArray(raw) ? raw.filter((name): name is string => typeof name === "string") : [];
}

function buildToolUnavailableRecoveryMessage(toolName: string, availableTools: string[]): string {
  const preferred = availableTools
    .filter((name) =>
      ["apply_patch", "search_replace", "shell_command", "run_shell", "write_file"].includes(name),
    )
    .concat(
      availableTools.filter(
        (name) =>
          !["apply_patch", "search_replace", "shell_command", "run_shell", "write_file"].includes(
            name,
          ),
      ),
    )
    .slice(0, 6);
  return [
    `<tool_argument_repair tool="${toolName}">`,
    `${toolName} is unavailable for this turn because the runtime temporarily suppressed it after repeated invalid arguments.`,
    `Use one of the currently available tools instead: ${preferred.join(", ")}.`,
    "Do not repeat the unavailable tool until it appears again in the tool manifest.",
    "</tool_argument_repair>",
  ].join("\n");
}

function isEmptyRequiredArgsFailure(call: ToolCallRequest, result: ToolResult): boolean {
  const args = call.arguments;
  const emptyArgs =
    args === "" ||
    args === null ||
    args === undefined ||
    (typeof args === "object" && !Array.isArray(args) && Object.keys(args).length === 0);
  return emptyArgs && /\brequired\b|missing/i.test(stringifyToolResultContent(result.content));
}

function toolSchemaSummary(schema: Record<string, unknown>): string {
  const properties =
    schema.properties && typeof schema.properties === "object" ? schema.properties : undefined;
  const required = Array.isArray(schema.required) ? schema.required : [];
  return JSON.stringify({ required, properties }, null, 2).slice(0, 1400);
}

function toolInputExample(tool: ToolDefinition): string {
  if (tool.name === "write_file") {
    return JSON.stringify({ path: "relative/path.ext", content: "file contents\n" });
  }
  const schema = tool.parameters;
  const properties =
    schema.properties && typeof schema.properties === "object"
      ? (schema.properties as Record<string, Record<string, unknown>>)
      : {};
  const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
  const example: Record<string, unknown> = {};
  for (const key of required) {
    const property = properties[key] ?? {};
    example[key] = exampleValueForSchema(property);
  }
  return JSON.stringify(example);
}

function exampleValueForSchema(schema: Record<string, unknown>): unknown {
  const type = schema.type;
  if (type === "array") return [];
  if (type === "boolean") return false;
  if (type === "integer" || type === "number") return 0;
  if (type === "object") return {};
  return "value";
}

function messageToHistory(m: Message, idx: number): HistoryItem {
  const h: HistoryItem = {
    id: `seed_${idx}`,
    createdAt: new Date().toISOString(),
    role: m.role,
    content: m.content,
  };
  if (m.phase !== undefined) h.phase = m.phase;
  return h;
}

function historyToMessage(h: HistoryItem): Message {
  const m: Message = { role: h.role, content: h.content as string | ContentPart[] };
  if (h.phase !== undefined) m.phase = h.phase;
  return m;
}

type ToolResultStructuredPart = TextContent | ImageContent | PdfContent;

function isToolResultContentPartArray(value: unknown): value is ToolResultStructuredPart[] {
  return (
    Array.isArray(value) &&
    value.every(
      (p) =>
        p !== null &&
        typeof p === "object" &&
        "type" in p &&
        ((p as { type?: unknown }).type === "text" ||
          (p as { type?: unknown }).type === "image" ||
          (p as { type?: unknown }).type === "pdf"),
    )
  );
}

function stringifyToolResultContent(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function shouldRepromptForBenchmarkAction(history: HistoryItem[], turn: AccumulatedTurn): boolean {
  const taskText = firstUserText(history);
  if (!isActionOrientedTask(taskText)) return false;
  const assistantText = historyItemToText(turn.assistant).toLowerCase();
  if (!assistantText) return false;
  if (containsHallucinatedToolSyntax(assistantText)) return true;
  return looksLikeOperationalProse(assistantText);
}

function firstUserText(history: HistoryItem[]): string {
  const firstUser = history.find((h) => h.role === "user");
  return firstUser ? historyItemToText(firstUser) : "";
}

function historyItemToText(item: HistoryItem): string {
  if (typeof item.content === "string") return item.content;
  return item.content
    .map((p) => {
      switch (p.type) {
        case "text":
          return p.text;
        case "reasoning":
          return p.summary;
        case "thinking":
          return p.text;
        default:
          return "";
      }
    })
    .join("\n")
    .trim();
}

function isActionOrientedTask(task: string): boolean {
  return /\b(fix|configure|create|run|install|compile|ensure|merge|write|add|update|start|serve|recover)\b/i.test(
    task,
  );
}

export function containsHallucinatedToolSyntax(text: string): boolean {
  // ChatGPT microsyntax, Agents-SDK leakage, Anthropic-style pseudo-XML,
  // and fine-tune trigger-token corpus leakage (e.g., the Chinese "天天彩票"
  // / "大发" strings that show up when the model falls back to pre-training
  // tool-calling training data instead of the actual function-call channel).
  // Patterns are intentionally broad — a false positive here only triggers a
  // nudge, which is cheap compared to letting a hallucinated final answer
  // slip through.
  return (
    /\bto=functions?\.[a-z_]+/i.test(text) ||
    /\bfunctions?\.[a-z_]+\s*\(/i.test(text) ||
    /\bmulti_tool_use\.parallel\b/i.test(text) ||
    /\brecipient_name\b/i.test(text) ||
    /"tool_uses"\s*:/i.test(text) ||
    /<\s*assistant\s+recipient=/i.test(text) ||
    /<\s*function=[a-z_.]+\s*>/i.test(text) ||
    /<\s*tool_use\s*>/i.test(text) ||
    /<\s*function_call\s*>/i.test(text) ||
    /"function_call"\s*:\s*\{/i.test(text) ||
    /\bexec_command\b/i.test(text) ||
    /天天|彩票|彩神|神彩|开号|大发|亚洲|无码|日本一本道|影音先锋/.test(text)
  );
}

function looksLikeOperationalProse(text: string): boolean {
  return /\b(next i(?:'|’)ll|i(?:'|’)m going to|i will|compiling now|running now|writing now|creating now|using the shell|i’ll add|here(?:'|’)s a minimal setup)\b/i.test(
    text,
  );
}

interface SearchGuardState {
  webSearchCalls: number;
  fetchUrlCalls: number;
  normalizedQueries: string[];
  injected: boolean;
}

function newSearchGuardState(): SearchGuardState {
  return {
    webSearchCalls: 0,
    fetchUrlCalls: 0,
    normalizedQueries: [],
    injected: false,
  };
}

function maybeBuildSearchAdvice(
  calls: ToolCallRequest[],
  state: SearchGuardState,
): {
  reason: "web_search_threshold" | "fetch_url_threshold" | "duplicate_queries";
  text: string;
} | null {
  let duplicateTrigger = false;
  for (const call of calls) {
    if (call.name === "web_search") {
      state.webSearchCalls++;
      const query = extractSearchQuery(call.arguments);
      if (query) {
        const normalized = normalizeSearchQuery(query);
        if (
          normalized &&
          state.normalizedQueries.filter((prior) => queriesAreNearDuplicate(prior, normalized))
            .length >= 2
        ) {
          duplicateTrigger = true;
        }
        if (normalized) state.normalizedQueries.push(normalized);
      }
    } else if (call.name === "fetch_url") {
      state.fetchUrlCalls++;
    }
  }
  if (state.injected) return null;

  let reason: "web_search_threshold" | "fetch_url_threshold" | "duplicate_queries" | null = null;
  if (duplicateTrigger) reason = "duplicate_queries";
  else if (state.webSearchCalls >= 6) reason = "web_search_threshold";
  else if (state.fetchUrlCalls >= 12) reason = "fetch_url_threshold";
  if (!reason) return null;

  state.injected = true;
  return {
    reason,
    text: [
      "Search loop advisory: you have already spent several web-search/fetch turns.",
      "Stop broad reformulations. Use the official/source/API evidence already fetched,",
      "pivot to local package/source/API inspection, and search again only for one",
      "specific missing fact that would materially change the solution.",
    ].join("\n"),
  };
}

function extractSearchQuery(args: ToolCallRequest["arguments"]): string | null {
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args) as unknown;
      return extractSearchQuery(parsed as ToolCallRequest["arguments"]);
    } catch {
      return null;
    }
  }
  const value = args?.query;
  return typeof value === "string" ? value : null;
}

function normalizeSearchQuery(query: string): string {
  const stop = new Set([
    "the",
    "a",
    "an",
    "and",
    "or",
    "for",
    "to",
    "of",
    "in",
    "on",
    "with",
    "official",
    "docs",
    "documentation",
    "latest",
    "current",
  ]);
  return query
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1 && !stop.has(token))
    .sort()
    .join(" ");
}

function queriesAreNearDuplicate(a: string, b: string): boolean {
  if (a === b) return true;
  const left = new Set(a.split(/\s+/).filter(Boolean));
  const right = new Set(b.split(/\s+/).filter(Boolean));
  if (left.size === 0 || right.size === 0) return false;
  let overlap = 0;
  for (const token of left) {
    if (right.has(token)) overlap++;
  }
  return overlap / Math.min(left.size, right.size) >= 0.75;
}
