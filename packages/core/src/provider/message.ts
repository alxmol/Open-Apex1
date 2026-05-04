/**
 * Normalized message / content types that the orchestrator passes to ProviderAdapter.
 * Adapters translate these to provider-native shapes (OpenAI Responses `input[]`,
 * Anthropic Messages `messages[]`).
 *
 * Locked per §3.4.1 AgentRequest + §3.4.2 TokenUsage + §3.4.12 HistoryItem.
 */

export type Role = "system" | "user" | "assistant" | "tool" | "developer";

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  /** Provider-neutral reference. Adapters resolve to native source shape. */
  source:
    | { kind: "path"; path: string; mediaType: ImageMediaType }
    | { kind: "base64"; data: string; mediaType: ImageMediaType }
    | { kind: "url"; url: string };
}

export type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

export interface PdfContent {
  type: "pdf";
  source:
    | { kind: "path"; path: string }
    | { kind: "base64"; data: string }
    | { kind: "url"; url: string };
}

/**
 * Per §1.2 (Search): structured search result formatted for citation-friendly rendering.
 * Maps directly to Anthropic `search_result` block; rendered as fenced text for OpenAI.
 */
export interface SearchResultContent {
  type: "search_result";
  title: string;
  url: string;
  snippet: string;
  content?: string;
  /** Arbitrary provenance attached to result (fetch status, rank, etc.). */
  metadata?: Record<string, unknown>;
}

export interface ToolUseContent {
  type: "tool_use";
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown> | string;
}

export interface ToolResultContent {
  type: "tool_result";
  toolCallId: string;
  /** Either string (common) or structured content parts (multimodal tool results). */
  content: string | Array<TextContent | ImageContent | PdfContent>;
  isError?: boolean;
}

/**
 * OpenAI-native reasoning summary (`reasoning.summary: "auto"`) is rendered as this.
 * Anthropic-native thinking blocks are rendered as ThinkingContent.
 */
export interface ReasoningContent {
  type: "reasoning";
  summary: string;
}

/** Anthropic-native thinking block. `signature` MUST round-trip unchanged per §1.2. */
export interface ThinkingContent {
  type: "thinking";
  text: string;
  signature?: string;
  display?: "summarized" | "omitted";
}

export type ContentPart =
  | TextContent
  | ImageContent
  | PdfContent
  | SearchResultContent
  | ToolUseContent
  | ToolResultContent
  | ReasoningContent
  | ThinkingContent;

/**
 * Normalized Message. Adapters flatten these into provider-native `input[]` / `messages[]`.
 */
export interface Message {
  role: Role;
  content: string | ContentPart[];
  /** OpenAI `phase` metadata preservation (§1.2). */
  phase?: "commentary" | "final_answer";
  /** Reserved: adapter-specific identifiers the orchestrator round-trips opaquely. */
  providerMetadata?: Record<string, unknown>;
}

/**
 * `HistoryItem` is the rolled-out version of Message persisted by SessionStore.
 * Adds step id and timestamps. Still provider-neutral.
 */
export interface HistoryItem extends Message {
  id: string;
  createdAt: string; // ISO 8601
  tokenUsage?: Partial<import("./stream.ts").TokenUsage>;
}

export interface MultimodalInput {
  kind: "image" | "pdf" | "asset";
  path: string;
  /** Explicit media type; required when path extension is ambiguous. */
  mediaType?: string;
  /** If true, asset is inlined as base64 (default for <5 MB); otherwise provider-hosted path. */
  inline?: boolean;
}

export interface ToolDefinitionPayload {
  name: string;
  description: string;
  /** JSON Schema draft-2020-12 for tool parameters. */
  parameters: Record<string, unknown>;
  /** OpenAI `type: "custom"` freeform tool with optional CFG grammar. */
  custom?: {
    format?: { type: "grammar"; grammar: string };
  };
}

export type ToolChoice =
  | { type: "auto" }
  | { type: "none" }
  | { type: "required" }
  | { type: "specific"; toolName: string }
  | { type: "allowed_tools"; mode: "required" | "auto"; tools: string[] };
