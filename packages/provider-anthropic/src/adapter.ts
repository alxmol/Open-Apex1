/**
 * Anthropic Messages adapter — real HTTP implementation (M1).
 */

import {
  CircuitOpenError,
  DefaultRetryPolicy,
  isHttpError,
  parseRetryAfterHeader,
  sharedCircuitBreaker,
  sharedRateLimiter,
  type AgentRequest,
  type CompactionOptions,
  type CompactionResult,
  type ConversationStartOptions,
  type ConversationStartResult,
  type ContentPart,
  type HttpError,
  type ImageContent,
  type Message,
  type PdfContent,
  type ProviderAdapter,
  type ProviderCapabilities,
  type ProviderContinuationHandle,
  type RequestOptions,
  type RetryPolicy,
  type StreamEvent,
  type TextContent,
  type TokenCount,
} from "@open-apex/core";

import { anthropicCapabilities } from "./capabilities.ts";
import { buildRequest, type AnthropicRequestPayload } from "./request-builder.ts";
import { AnthropicEventTranslator, parseSseStream } from "./sse-parser.ts";

export interface AnthropicAdapterOptions {
  modelId: string;
  apiKey?: string;
  baseUrl?: string;
  /** Default max_tokens when the caller doesn't supply one. Anthropic requires this field. */
  defaultMaxTokens?: number;
  /**
   * Always-on beta headers. The preset's providerBetaHeaders flow through
   * `opts.providerBetaHeaders` per-call. The adapter unions them.
   */
  alwaysOnBetaHeaders?: string[];
  fetchFn?: typeof fetch;
  retryPolicy?: RetryPolicy;
  rateLimiter?: typeof sharedRateLimiter;
  circuitBreaker?: typeof sharedCircuitBreaker;
  /**
   * Per-request SSE idle watchdog (same semantics as OpenAI). Default
   * 120_000ms; 0 disables. Extension of §1.2 retry-policy streaming-failure
   * classification — covers silent hangs where the Anthropic stream stops
   * emitting deltas without surfacing an error event.
   */
  sseIdleTimeoutMs?: number;
  /**
   * Tag tools with `strict: true` (grammar-constrained sampling — docs:
   * agents-and-tools/tool-use/strict-tool-use). Default true; guarantees
   * Claude's tool `input` matches the JSON Schema exactly, eliminating
   * hallucinated tool arguments / invalid tool names. Opt out only to
   * A/B test strict rejections.
   */
  strictTools?: boolean;
}

const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MAX_TOKENS = 4096;
const DEFAULT_SSE_IDLE_TIMEOUT_MS = 120_000;

export class AnthropicAdapter implements ProviderAdapter {
  private readonly opts: AnthropicAdapterOptions;
  private readonly baseUrl: string;
  private readonly defaultMaxTokens: number;
  private readonly fetchFn: typeof fetch;
  private readonly retry: RetryPolicy;
  private readonly rateLimiter: typeof sharedRateLimiter;
  private readonly circuitBreaker: typeof sharedCircuitBreaker;
  private readonly sseIdleTimeoutMs: number;
  private readonly strictTools: boolean;

  constructor(opts: AnthropicAdapterOptions) {
    this.opts = opts;
    this.baseUrl = opts.baseUrl ?? "https://api.anthropic.com";
    this.defaultMaxTokens = opts.defaultMaxTokens ?? DEFAULT_MAX_TOKENS;
    this.fetchFn = opts.fetchFn ?? fetch;
    this.retry = opts.retryPolicy ?? new DefaultRetryPolicy();
    this.rateLimiter = opts.rateLimiter ?? sharedRateLimiter;
    this.circuitBreaker = opts.circuitBreaker ?? sharedCircuitBreaker;
    this.sseIdleTimeoutMs =
      opts.sseIdleTimeoutMs !== undefined ? opts.sseIdleTimeoutMs : DEFAULT_SSE_IDLE_TIMEOUT_MS;
    this.strictTools = opts.strictTools !== false;
  }

  getCapabilities(): ProviderCapabilities {
    return anthropicCapabilities(this.opts.modelId);
  }

  async startConversation(_opts: ConversationStartOptions = {}): Promise<ConversationStartResult> {
    return {
      applicable: false,
      reason: "Anthropic Messages has no durable Conversations API equivalent",
    };
  }

  async *generate(req: AgentRequest, opts: RequestOptions): AsyncIterable<StreamEvent> {
    yield* this.streamMessages(req, opts);
  }

  async *resume(
    handle: ProviderContinuationHandle,
    req: AgentRequest,
    opts: RequestOptions,
  ): AsyncIterable<StreamEvent> {
    if (handle.kind !== "anthropic_messages") {
      throw new Error(
        `AnthropicAdapter.resume: expected anthropic_messages handle, got ${handle.kind}`,
      );
    }
    // Anthropic has no server-side handle. The handle carries the full
    // serialized prior history; the adapter replays it by prepending to the
    // caller-supplied `req.messages` delta. `system` and `tools` are
    // per-request fields — must be taken from the fresh `req`, not empty.
    const replayed = (handle.messages as Message[]) ?? [];
    const merged: AgentRequest = {
      systemPrompt: req.systemPrompt,
      messages: [...replayed, ...req.messages],
      tools: req.tools,
    };
    if (req.toolChoice) merged.toolChoice = req.toolChoice;
    if (req.multimodalInputs) merged.multimodalInputs = req.multimodalInputs;
    yield* this.streamMessages(merged, opts);
  }

  async countTokens(messages: Message[], opts: RequestOptions): Promise<TokenCount> {
    const req: AgentRequest = { systemPrompt: "", messages, tools: [] };
    const payload = buildRequest(req, opts, {
      modelId: this.opts.modelId,
      defaultMaxTokens: this.defaultMaxTokens,
      automaticPromptCaching: false,
      systemPromptCacheable: false,
      toolsCacheable: false,
      stream: false,
    });
    // Strip fields the count endpoint doesn't accept.
    const body = {
      model: payload.model,
      messages: payload.messages,
      ...(payload.system ? { system: payload.system } : {}),
      ...(payload.tools ? { tools: payload.tools } : {}),
    };
    const resp = await this.httpPost("/v1/messages/count_tokens", body, opts);
    const json = (await resp.json()) as { input_tokens?: number };
    return { inputTokens: json.input_tokens ?? 0 };
  }

  async compact(
    _handle: ProviderContinuationHandle,
    _opts: CompactionOptions,
  ): Promise<CompactionResult> {
    return {
      applicable: false,
      reason:
        "Anthropic compaction is request-level via context_management; no standalone endpoint",
    };
  }

  // ─── Internal ──────────────────────────────────────────────────────────────

  private async *streamMessages(
    req: AgentRequest,
    opts: RequestOptions,
  ): AsyncIterable<StreamEvent> {
    /**
     * Current strict flag for the in-flight payload. Starts at the adapter's
     * `strictTools` setting. If Anthropic returns a "Schema is too complex
     * for compilation" 400 (a server-side grammar-compilation budget ceiling
     * that fires when the *combined* size of all strict-tagged tools is too
     * large — not catchable at build time), we flip this to false once and
     * rebuild the payload. This preserves strict-mode benefits on small
     * manifests while keeping production 9-tool manifests working.
     */
    let currentStrict = this.strictTools;
    let payload = buildRequest(req, opts, {
      modelId: this.opts.modelId,
      defaultMaxTokens: this.defaultMaxTokens,
      automaticPromptCaching: true,
      systemPromptCacheable: true,
      toolsCacheable: true,
      strictTools: currentStrict,
      stream: true,
    });
    const endpoint = "/v1/messages";
    this.circuitBreaker.beforeCall(`anthropic${endpoint}`);
    let attempt = 0;
    let strictFallbackUsed = false;
    const maxRetries = this.retry.maxRetries;
    const betaHeaders = this.betaHeadersFor(opts);
    while (true) {
      if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");

      // Per-request SSE idle watchdog (mirrors OpenAi adapter). Silent
      // Anthropic stalls get aborted and re-tried as transient 503s.
      const fetchAbort = new AbortController();
      const watchdogAbort = new AbortController();
      let watchdogFired = false;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const onCallerAbort = () => fetchAbort.abort();
      const onWatchdogAbort = () => {
        watchdogFired = true;
        fetchAbort.abort();
      };
      if (opts.signal) {
        if (opts.signal.aborted) fetchAbort.abort();
        else opts.signal.addEventListener("abort", onCallerAbort, { once: true });
      }
      watchdogAbort.signal.addEventListener("abort", onWatchdogAbort, { once: true });
      const resetIdle = () => {
        if (this.sseIdleTimeoutMs <= 0) return;
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => watchdogAbort.abort(), this.sseIdleTimeoutMs);
      };
      const clearIdle = () => {
        if (idleTimer) {
          clearTimeout(idleTimer);
          idleTimer = undefined;
        }
      };
      const detachCallerAbort = () => {
        opts.signal?.removeEventListener?.("abort", onCallerAbort);
      };

      try {
        await this.rateLimiter.reserve("anthropic");
        resetIdle();
        const resp = await this.fetchFn(`${this.baseUrl}${endpoint}`, {
          method: "POST",
          headers: this.authHeaders(betaHeaders),
          body: JSON.stringify(payload),
          signal: fetchAbort.signal,
        });
        this.rateLimiter.updateFromHeaders("anthropic", headersToObject(resp.headers));
        if (!resp.ok) {
          const errBody = await resp.text();
          // Anthropic strict-mode schemas compile into a grammar server-side;
          // with many tools (e.g., our production 9-tool manifest) the
          // combined grammar can exceed the compilation budget and the API
          // returns a specific 400. Anthropic may also reject the combined
          // manifest for too many optional parameters in strict schemas.
          // Auto-downgrade this request to
          // non-strict ONCE and retry — preserves strict on small manifests
          // while keeping production live.
          if (
            resp.status === 400 &&
            currentStrict &&
            !strictFallbackUsed &&
            isStrictSchemaBudgetError(errBody)
          ) {
            strictFallbackUsed = true;
            currentStrict = false;
            payload = buildRequest(req, opts, {
              modelId: this.opts.modelId,
              defaultMaxTokens: this.defaultMaxTokens,
              automaticPromptCaching: true,
              systemPromptCacheable: true,
              toolsCacheable: true,
              strictTools: false,
              stream: true,
            });
            clearIdle();
            detachCallerAbort();
            continue; // retry with strict disabled
          }
          const httpErr: HttpError = {
            httpStatus: resp.status,
            rawMessage: errBody,
          };
          const retryAfter = parseRetryAfterHeader(resp.headers.get("retry-after"));
          if (retryAfter !== undefined) httpErr.retryAfterMs = retryAfter;
          throw httpErr;
        }
        if (!resp.body) throw new Error("Anthropic response body was null");
        const translator = new AnthropicEventTranslator(betaHeaders);
        try {
          for await (const sse of parseSseStream(resp.body)) {
            resetIdle();
            for (const ev of translator.translate(sse)) {
              if (ev.type === "done") {
                // Anthropic Messages has NO server-side continuation
                // primitive (no `previous_response_id` equivalent — see
                // docs/agents-and-tools/tool-use/handle-tool-calls: the
                // caller must replay the full conversation including the
                // assistant's own tool_use / text / thinking blocks). The
                // adapter owns that replay buffer: we emit the handle with
                // [...req.messages, assistantMessage] so the next resume()
                // ships a well-formed conversation.
                const assistant = translator.getAssistantMessage();
                const replayMessages = pruneMultimodalForReplay(req.messages);
                const messages: Message[] = assistant
                  ? [...replayMessages, assistant]
                  : [...replayMessages];
                const enriched: StreamEvent = {
                  type: "done",
                  stopReason: ev.stopReason,
                  providerHandle: {
                    kind: "anthropic_messages",
                    messages: messages as unknown[],
                    betaHeaders,
                  },
                };
                yield enriched;
                clearIdle();
                detachCallerAbort();
                this.circuitBreaker.recordSuccess(`anthropic${endpoint}`);
                return;
              }
              if (ev.type === "error") {
                const httpErr: HttpError = {
                  httpStatus: ev.retryable ? 503 : 599,
                  providerCode: ev.code,
                  rawMessage: ev.message,
                  transient: ev.retryable,
                };
                throw httpErr;
              }
              yield ev;
            }
          }
        } catch (err) {
          if (watchdogFired) {
            throw {
              httpStatus: 503,
              transient: true,
              rawMessage: `sse_idle_timeout: no SSE event for ${this.sseIdleTimeoutMs}ms`,
              providerCode: "sse_idle_timeout",
            } satisfies Partial<HttpError> as HttpError;
          }
          throw err;
        }
        if (watchdogFired) {
          throw {
            httpStatus: 503,
            transient: true,
            rawMessage: `sse_idle_timeout: no SSE event for ${this.sseIdleTimeoutMs}ms`,
            providerCode: "sse_idle_timeout",
          } satisfies Partial<HttpError> as HttpError;
        }
        throw {
          transient: true,
          rawMessage: "stream ended without message_stop",
        } satisfies Partial<HttpError> as HttpError;
      } catch (err) {
        clearIdle();
        detachCallerAbort();
        this.circuitBreaker.recordFailure(`anthropic${endpoint}`);
        if (err instanceof CircuitOpenError) throw err;
        const decision = isHttpError(err) ? this.retry.classify(err) : this.retry.classify(err);
        if (!decision.retry || attempt >= maxRetries) throw err;
        const delay = this.retry.nextDelayMs(attempt, decision.retryAfterMs);
        attempt++;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  private async httpPost(endpoint: string, body: unknown, opts: RequestOptions): Promise<Response> {
    this.circuitBreaker.beforeCall(`anthropic${endpoint}`);
    const betaHeaders = this.betaHeadersFor(opts);
    const resp = await this.retry.execute(async () => {
      await this.rateLimiter.reserve("anthropic");
      const r = await this.fetchFn(`${this.baseUrl}${endpoint}`, {
        method: "POST",
        headers: this.authHeaders(betaHeaders),
        body: JSON.stringify(body),
      });
      this.rateLimiter.updateFromHeaders("anthropic", headersToObject(r.headers));
      if (!r.ok) {
        const errBody = await r.text();
        const httpErr: HttpError = { httpStatus: r.status, rawMessage: errBody };
        const retryAfter = parseRetryAfterHeader(r.headers.get("retry-after"));
        if (retryAfter !== undefined) httpErr.retryAfterMs = retryAfter;
        throw httpErr;
      }
      return r;
    });
    this.circuitBreaker.recordSuccess(`anthropic${endpoint}`);
    return resp;
  }

  private authHeaders(betaHeaders: string[]): Record<string, string> {
    const key = this.opts.apiKey ?? process.env.ANTHROPIC_API_KEY ?? "";
    if (!key) {
      throw new Error(
        "AnthropicAdapter: ANTHROPIC_API_KEY is not set (pass apiKey or set env var)",
      );
    }
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      "x-api-key": key,
      "anthropic-version": ANTHROPIC_VERSION,
    };
    if (betaHeaders.length > 0) {
      headers["anthropic-beta"] = betaHeaders.join(",");
    }
    return headers;
  }

  private betaHeadersFor(opts: RequestOptions): string[] {
    const set = new Set(this.opts.alwaysOnBetaHeaders ?? []);
    for (const h of opts.providerBetaHeaders ?? []) set.add(h);
    return Array.from(set);
  }
}

function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

function pruneMultimodalForReplay(messages: Message[]): Message[] {
  return messages.map((m) => {
    if (typeof m.content === "string") return m;
    return { ...m, content: pruneContentPartsForReplay(m.content) };
  });
}

function pruneContentPartsForReplay(parts: ContentPart[]): ContentPart[] {
  const out: ContentPart[] = [];
  for (const p of parts) {
    if (p.type === "image") {
      out.push({
        type: "text",
        text: "[image asset already sent to provider; omitted from replay]",
      });
    } else if (p.type === "pdf") {
      out.push({
        type: "text",
        text: "[PDF asset already sent to provider; omitted from replay]",
      });
    } else if (p.type === "tool_result" && Array.isArray(p.content)) {
      out.push({ ...p, content: pruneToolResultContentForReplay(p.content) });
    } else {
      out.push(p);
    }
  }
  return out;
}

type ToolResultStructuredPart = TextContent | ImageContent | PdfContent;

function pruneToolResultContentForReplay(
  parts: ToolResultStructuredPart[],
): ToolResultStructuredPart[] {
  return pruneContentPartsForReplay(parts).filter(
    (p): p is ToolResultStructuredPart =>
      p.type === "text" || p.type === "image" || p.type === "pdf",
  );
}

function isStrictSchemaBudgetError(body: string): boolean {
  return (
    /schema is too complex for compilation/i.test(body) ||
    /schemas? contains too many optional parameters/i.test(body)
  );
}

// Re-export for tests.
export type { AnthropicRequestPayload };
