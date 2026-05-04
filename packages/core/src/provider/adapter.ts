/**
 * ProviderAdapter contract.
 * Locked per §3.4.1.
 *
 * The orchestrator reasons only in normalized terms; provider-specific features
 * (OpenAI `phase`, Anthropic `signature`, compaction blocks, cache hits) flow
 * through as typed StreamEvent variants or as opaque `providerMetadata` that
 * the adapter round-trips without inspection.
 *
 * Orchestrator code NEVER does `adapter instanceof OpenAIAdapter`. It branches
 * only on `getCapabilities()`.
 */

import type { Message, MultimodalInput, ToolChoice, ToolDefinitionPayload } from "./message.ts";
import type { StreamEvent, TokenCount } from "./stream.ts";

export interface ProviderAdapter {
  /**
   * Primary generation method. New or continued turn.
   * Streams normalized events; the caller reassembles them into an assistant
   * message and tool-call list.
   */
  generate(req: AgentRequest, opts: RequestOptions): AsyncIterable<StreamEvent>;

  /**
   * Same-session continuation from an existing provider handle.
   *   - OpenAI: uses exactly one state carrier per request: Conversations for
   *     conversation-backed handles, `previous_response_id` for plain response
   *     handles, or compacted output items for `openai_compacted`. `instructions`
   *     and `tools` are NOT preserved server-side by the Responses API — callers
   *     must pass them fresh in `req` on every turn.
   *   - Anthropic: replays message history (no stateful server handle exists);
   *     the implementation prepends `handle.messages` to `req.messages`.
   *     `system` and `tools` are per-request too.
   *
   * `req.messages` semantically means "new input since the previous response"
   * (typically the tool_result message from the batch just executed, plus any
   * user-injected nudges). The adapter — not the caller — is responsible for
   * combining the handle's prior state with the new input.
   */
  resume(
    handle: ProviderContinuationHandle,
    req: AgentRequest,
    opts: RequestOptions,
  ): AsyncIterable<StreamEvent>;

  /**
   * Token counting. OpenAI exposes a dedicated endpoint; Anthropic uses a
   * count-tokens API call. Result includes `cachedTokens` when the provider
   * can predict cache hits.
   */
  countTokens(messages: Message[], opts: RequestOptions): Promise<TokenCount>;

  /**
   * Normalized capability matrix. The orchestrator branches only on these
   * flags; it never inspects concrete adapter subtypes.
   */
  getCapabilities(): ProviderCapabilities;

  /**
   * Optional durable provider conversation creation.
   *
   * OpenAI Conversations work with Responses to persist state behind a stable
   * conversation id. Providers without a matching primitive return
   * `{ applicable: false }`; callers keep local JSONL as canonical state.
   */
  startConversation(opts?: ConversationStartOptions): Promise<ConversationStartResult>;

  /**
   * Compaction. OpenAI has a standalone `/responses/compact` endpoint plus
   * request-level `context_management`; Anthropic has only request-level
   * `context_management`. On Anthropic this is a no-op that returns a
   * structured "not applicable" result; the orchestrator must fall back to
   * request-level compaction via `RequestOptions.contextManagement`.
   */
  compact(handle: ProviderContinuationHandle, opts: CompactionOptions): Promise<CompactionResult>;
}

export interface AgentRequest {
  systemPrompt: string;
  messages: Message[];
  tools: ToolDefinitionPayload[];
  toolChoice?: ToolChoice;
  multimodalInputs?: MultimodalInput[];
}

export interface RequestOptions {
  /**
   * Per-turn tool restriction.
   *   OpenAI: maps to `tool_choice: { type: "allowed_tools", ... }`.
   *   Anthropic: maps to filtering the `tools` array before sending.
   */
  allowedTools?: string[];

  /** Effort level. OpenAI: `reasoning.effort`. Anthropic: `output_config.effort`. */
  effort?: EffortLevel;

  /** OpenAI only: `text.verbosity`. */
  verbosity?: "low" | "medium" | "high";

  maxOutputTokens?: number;

  /**
   * Anthropic: `context_management` config with edits array.
   * OpenAI: `context_management` config with `compact_threshold`.
   */
  contextManagement?: ContextManagementConfig;

  /** Anthropic thinking display. Ignored on OpenAI. */
  thinkingDisplay?: "summarized" | "omitted";

  /** Anthropic prompt-caching breakpoints. Ignored on OpenAI. */
  cacheBreakpoints?: CacheBreakpoint[];

  /**
   * Provider-native structured final-output request.
   *
   * OpenAI Responses: maps to `text.format: { type: "json_schema", ... }`.
   * Anthropic Messages: maps to
   * `output_config.format: { type: "json_schema", schema }`.
   */
  structuredOutput?: StructuredOutputFormat;

  /**
   * OpenAI: `reasoning.summary`. Ignored on Anthropic (summarized thinking is
   * the default on Claude 4.x models).
   */
  reasoningSummary?: "auto" | "concise" | "detailed";

  /**
   * Force the next provider call to emit at least one tool call. Recovery path
   * (hallucinated-syntax detector) sets this after a strike.
   *   OpenAI: `tool_choice: "required"`.
   *   Anthropic: `tool_choice: { type: "any" }`.
   */
  forceToolChoice?: "required";

  /**
   * Beta headers the adapter should send. The adapter owns the list of
   * always-on headers; this is for experimental preset-level opt-ins.
   */
  providerBetaHeaders?: string[];

  /** Abort signal the caller can flip to cancel an in-flight stream. */
  signal?: AbortSignal;

  /**
   * OpenAI Responses API storage switch. Benchmark/autonomous callers should
   * keep this false unless they explicitly opt into a provider-side durable
   * feature; local Open-Apex session storage remains canonical.
   */
  store?: boolean;

  /**
   * OpenAI Conversations API durable handle. Used only after local session
   * resume state has been rebuilt and workspace divergence has been resolved.
   */
  conversationId?: string;

  /**
   * OpenAI background mode. Chat-only in v1 because it requires provider-side
   * storage and polling; benchmark mode must remain foreground/observable.
   */
  background?: boolean;
}

export type EffortLevel =
  | "none" // OpenAI only
  | "low"
  | "medium"
  | "high"
  | "xhigh" // OpenAI gpt-5.4, Anthropic Opus 4.7
  | "max"; // Anthropic Opus 4.6/4.7, Sonnet 4.6

/**
 * Normalized capability matrix. See §3.6 provider fallback matrix for
 * per-feature state (required / optional / experimental / fallback-defined).
 */
export interface ProviderCapabilities {
  providerId: "openai" | "anthropic";
  modelId: string;
  supportsPreviousResponseId: boolean;
  supportsConversations: boolean;
  supportsAdaptiveThinking: boolean;
  supportsEffortXhigh: boolean;
  supportsEffortMax: boolean;
  supportsNativeCompaction: boolean;
  supportsContextEditingToolUses: boolean;
  supportsContextEditingThinking: boolean;
  supportsServerCompaction: boolean;
  supportsAllowedTools: boolean;
  supportsCustomTools: boolean;
  supportsCFG: boolean;
  supportsToolSearch: boolean;
  supportsSearchResultBlocks: boolean;
  supportsPromptCaching: boolean;
  supportsPhaseMetadata: boolean;
  supportsParallelToolCalls: boolean;
  supportsMultimodalImages: boolean;
  supportsMultimodalPdfs: boolean;
  supportsBackgroundMode: boolean;
  contextWindowTokens: number;
}

export type ProviderContinuationHandle =
  | {
      kind: "openai_response";
      responseId: string;
      reasoningItemsIncluded: boolean;
      /** Durable Conversations API id attached to this response, when used. */
      conversationId?: string;
    }
  | {
      kind: "openai_compacted";
      /** Opaque Responses API compacted output items. Pass forward unchanged. */
      input: unknown[];
      reasoningItemsIncluded: boolean;
      /** Fresh durable Conversations API id to attach when continuing compacted input. */
      conversationId?: string;
    }
  | { kind: "openai_conversation"; conversationId: string }
  | {
      kind: "anthropic_messages";
      /** Opaque; adapter deserializes. Includes thinking blocks w/ signatures. */
      messages: unknown[];
      betaHeaders: string[];
    };

export interface ContextManagementConfig {
  /** Anthropic: `context_management.edits[].trigger` (in input tokens). */
  triggerInputTokens?: number;
  keepToolUses?: number;
  clearAtLeastTokens?: number;
  excludeTools?: string[];
  clearToolInputs?: boolean;
  /** Anthropic thinking clearing. */
  keepThinking?: number;
  /** Both providers: compaction threshold in input tokens. */
  compactThreshold?: number;
  /** Anthropic `compaction.pause_after_compaction`. */
  pauseAfterCompaction?: boolean;
  /** Custom compaction summarization instructions. */
  compactionInstructions?: string;
}

export interface CacheBreakpoint {
  /** Where in the prompt the breakpoint sits. */
  location: "system_prompt_end" | "tools_end" | "last_user" | "custom";
  /** `custom` only: arbitrary marker the adapter uses to place the cache_control block. */
  marker?: string;
}

export interface StructuredOutputFormat {
  type: "json_schema";
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
}

export interface CompactionOptions {
  threshold?: number;
  instructions?: string;
  pauseAfter?: boolean;
  /**
   * Standalone compaction needs the full local context window. Request-level
   * provider compaction should continue to use RequestOptions.contextManagement.
   */
  request?: AgentRequest;
  requestOptions?: RequestOptions;
}

export interface CompactionResult {
  applicable: boolean;
  /** Populated when applicable. */
  summaryTokens?: number;
  replacedRange?: [number, number];
  /** Provider continuation state produced by compaction, if any. */
  providerHandle?: ProviderContinuationHandle;
  /** Opaque compacted provider output. Do not edit before passing forward. */
  output?: unknown[];
  /** Provider diagnostic when not applicable. */
  reason?: string;
}

export interface ConversationStartOptions {
  metadata?: Record<string, string>;
}

export type ConversationStartResult =
  | {
      applicable: true;
      providerHandle: Extract<ProviderContinuationHandle, { kind: "openai_conversation" }>;
    }
  | {
      applicable: false;
      reason?: string;
    };
