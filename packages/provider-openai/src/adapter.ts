/**
 * OpenAI Responses adapter — real HTTP implementation (M1).
 *
 * Transport: vanilla fetch + SSE parsing. We explicitly do NOT import the
 * official `openai` npm SDK at the adapter level — that keeps the SSE shape
 * transparent + lets the retry layer own every HTTP call.
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
  type HttpError,
  type Message,
  type ProviderAdapter,
  type ProviderCapabilities,
  type ProviderContinuationHandle,
  type RequestOptions,
  type RetryPolicy,
  type StreamEvent,
  type TokenCount,
} from "@open-apex/core";

import { openAiCapabilities } from "./capabilities.ts";
import {
  buildRequest,
  type BuildRequestOptions,
  type OpenAiRequestPayload,
} from "./request-builder.ts";
import { OpenAiEventTranslator, parseSseStream } from "./sse-parser.ts";

export interface OpenAiAdapterOptions {
  modelId: string;
  apiKey?: string;
  baseUrl?: string;
  /** Override to inject a test fetch; defaults to global `fetch`. */
  fetchFn?: typeof fetch;
  retryPolicy?: RetryPolicy;
  /** Injectable for tests. */
  rateLimiter?: typeof sharedRateLimiter;
  /** Injectable for tests. */
  circuitBreaker?: typeof sharedCircuitBreaker;
  /**
   * Per-request SSE idle watchdog. If no SSE event arrives within this many
   * ms after the last one, the adapter aborts the connection and surfaces a
   * transient error so the retry layer can restart the request. Extension of
   * §1.2 retry policy — covers the "no bytes received for N seconds" case
   * that's invisible to stream-drop / server_error classification.
   *
   * Default 120_000ms (2 min). Set to 0 to disable the watchdog.
   */
  sseIdleTimeoutMs?: number;
  /**
   * Tag function tools with `strict: true` using grammar-constrained
   * sampling (docs/guides/function-calling#strict-mode). Guarantees tool
   * `name` is always valid and `arguments` match the JSON Schema exactly —
   * the provider-level answer to hallucinated microsyntax like
   * `to=functions.X` / `multi_tool_use.parallel`.
   *
   * Default true. Tools whose schemas can't be expressed under OpenAI
   * strict (e.g., run_shell's open `env` dict) are auto-downgraded to
   * non-strict per-tool — partial strict is better than none. Set false
   * to disable globally when debugging strict rejections.
   */
  strictTools?: boolean;
}

const DEFAULT_SSE_IDLE_TIMEOUT_MS = 120_000;

export class OpenAiAdapter implements ProviderAdapter {
  private readonly opts: OpenAiAdapterOptions;
  private readonly baseUrl: string;
  private readonly fetchFn: typeof fetch;
  private readonly retry: RetryPolicy;
  private readonly rateLimiter: typeof sharedRateLimiter;
  private readonly circuitBreaker: typeof sharedCircuitBreaker;
  private readonly sseIdleTimeoutMs: number;
  private readonly strictTools: boolean;

  constructor(opts: OpenAiAdapterOptions) {
    this.opts = opts;
    this.baseUrl = opts.baseUrl ?? "https://api.openai.com/v1";
    this.fetchFn = opts.fetchFn ?? fetch;
    this.retry = opts.retryPolicy ?? new DefaultRetryPolicy();
    this.rateLimiter = opts.rateLimiter ?? sharedRateLimiter;
    this.circuitBreaker = opts.circuitBreaker ?? sharedCircuitBreaker;
    this.sseIdleTimeoutMs =
      opts.sseIdleTimeoutMs !== undefined ? opts.sseIdleTimeoutMs : DEFAULT_SSE_IDLE_TIMEOUT_MS;
    this.strictTools = opts.strictTools !== false;
  }

  getCapabilities(): ProviderCapabilities {
    return openAiCapabilities(this.opts.modelId);
  }

  async startConversation(opts: ConversationStartOptions = {}): Promise<ConversationStartResult> {
    if (!this.hasApiKey()) {
      return {
        applicable: false,
        reason: "OpenAiAdapter: OPENAI_API_KEY is not set (pass apiKey or set env var)",
      };
    }
    try {
      const body: Record<string, unknown> = {};
      if (opts.metadata && Object.keys(opts.metadata).length > 0) {
        body.metadata = opts.metadata;
      }
      const resp = await this.httpPost("/conversations", body);
      const json = (await resp.json()) as { id?: unknown };
      if (typeof json.id !== "string" || json.id.length === 0) {
        return {
          applicable: false,
          reason: "conversation create response did not include an id",
        };
      }
      return {
        applicable: true,
        providerHandle: { kind: "openai_conversation", conversationId: json.id },
      };
    } catch (err) {
      return {
        applicable: false,
        reason: `conversation create unavailable: ${(err as Error).message}`,
      };
    }
  }

  async *generate(req: AgentRequest, opts: RequestOptions): AsyncIterable<StreamEvent> {
    yield* this.streamResponses(req, opts, {
      modelId: this.opts.modelId,
      systemPrompt: req.systemPrompt,
      stream: true,
      strictTools: this.strictTools,
    });
  }

  async *resume(
    handle: ProviderContinuationHandle,
    req: AgentRequest,
    opts: RequestOptions,
  ): AsyncIterable<StreamEvent> {
    if (
      handle.kind !== "openai_response" &&
      handle.kind !== "openai_compacted" &&
      handle.kind !== "openai_conversation"
    ) {
      throw new Error(
        `OpenAiAdapter.resume: expected openai_response/openai_compacted/openai_conversation handle, got ${handle.kind}`,
      );
    }
    // §1.2: previous_response_id preserves CoT + reasoning items server-side,
    // but `instructions` and `tools` are PER-REQUEST fields on the Responses
    // API — they are not inherited across calls. Callers MUST pass them fresh
    // in `req` on every resume or the model loses its guardrails and tool
    // manifest. `req.messages` is the new-input delta (typically the
    // tool_result block from the batch just executed).
    if (handle.kind === "openai_conversation") {
      yield* this.streamResponses(
        req,
        withConversation(withoutConversation(opts), handle.conversationId),
        {
          modelId: this.opts.modelId,
          systemPrompt: req.systemPrompt,
          stream: true,
          strictTools: this.strictTools,
        },
      );
      return;
    }
    if (handle.kind === "openai_response") {
      if (handle.conversationId) {
        yield* this.streamResponses(
          req,
          withConversation(withoutConversation(opts), handle.conversationId),
          {
            modelId: this.opts.modelId,
            systemPrompt: req.systemPrompt,
            stream: true,
            strictTools: this.strictTools,
          },
        );
        return;
      }
      yield* this.streamResponses(req, withoutConversation(opts), {
        modelId: this.opts.modelId,
        systemPrompt: req.systemPrompt,
        previousResponseId: handle.responseId,
        stream: true,
        strictTools: this.strictTools,
      });
      return;
    }
    const compactedOpts = handle.conversationId
      ? withConversation(withoutConversation(opts), handle.conversationId)
      : withoutConversation(opts);
    yield* this.streamResponses(req, compactedOpts, {
      modelId: this.opts.modelId,
      systemPrompt: req.systemPrompt,
      inputPrefix: handle.input,
      stream: true,
      strictTools: this.strictTools,
    });
  }

  async countTokens(messages: Message[], opts: RequestOptions): Promise<TokenCount> {
    const req: AgentRequest = { systemPrompt: "", messages, tools: [] };
    const payload = buildRequest(req, opts, {
      modelId: this.opts.modelId,
      systemPrompt: "",
      stream: false,
    });
    const body = {
      model: payload.model,
      input: payload.input,
      instructions: payload.instructions,
      ...(payload.tools ? { tools: payload.tools } : {}),
    };
    const endpoint = "/responses/input_tokens";
    const resp = await this.httpPost(endpoint, body);
    const json = (await resp.json()) as {
      input_tokens?: number;
      cached_tokens?: number;
    };
    const out: TokenCount = { inputTokens: json.input_tokens ?? 0 };
    if (json.cached_tokens !== undefined) out.cachedTokens = json.cached_tokens;
    return out;
  }

  async compact(
    handle: ProviderContinuationHandle,
    opts: CompactionOptions,
  ): Promise<CompactionResult> {
    if (handle.kind !== "openai_response" && handle.kind !== "openai_compacted") {
      return { applicable: false, reason: "handle is not an OpenAI continuation handle" };
    }
    if (!opts.request) {
      return {
        applicable: false,
        reason: "standalone compact requires full local AgentRequest context",
      };
    }
    // Standalone compaction is stateless: send the full context window and pass
    // the returned compacted output forward unchanged on the next Responses call.
    const endpoint = "/responses/compact";
    try {
      const payload = buildRequest(opts.request, opts.requestOptions ?? {}, {
        modelId: this.opts.modelId,
        systemPrompt: opts.request.systemPrompt,
        stream: false,
        strictTools: this.strictTools,
      });
      const body: Record<string, unknown> = {
        model: payload.model,
        input: payload.input,
        instructions: payload.instructions,
      };
      if (payload.tools) body.tools = payload.tools;
      if (payload.tool_choice) body.tool_choice = payload.tool_choice;
      const resp = await this.httpPost(endpoint, body);
      const json = (await resp.json()) as {
        output?: unknown[];
        input?: unknown[];
        compacted_input?: unknown[];
        summary_tokens?: number;
        replaced_range?: [number, number];
      };
      const output = firstArray(json.output, json.input, json.compacted_input);
      if (!output) {
        return {
          applicable: false,
          reason: "standalone compact response did not include compacted output",
        };
      }
      const out: CompactionResult = {
        applicable: true,
        output,
        providerHandle: {
          kind: "openai_compacted",
          input: output,
          reasoningItemsIncluded: true,
        },
      };
      if (json.summary_tokens !== undefined) out.summaryTokens = json.summary_tokens;
      if (json.replaced_range) out.replacedRange = json.replaced_range;
      return out;
    } catch (err) {
      return {
        applicable: false,
        reason: `standalone compact endpoint unavailable: ${(err as Error).message}`,
      };
    }
  }

  // ─── Internal: streaming + HTTP plumbing ───────────────────────────────────

  private async *streamResponses(
    req: AgentRequest,
    opts: RequestOptions,
    build: BuildRequestOptions,
  ): AsyncIterable<StreamEvent> {
    const payload = buildRequest(req, opts, build);
    const conversationId = opts.conversationId;
    const endpoint = "/responses";
    this.circuitBreaker.beforeCall(`openai${endpoint}`);
    // NOTE: we don't wrap the streaming call in retry.execute because
    // mid-stream retry restarts the whole request. §1.2 streaming-failures:
    // on mid-stream drop we retry at the HTTP-request level above the stream.
    // That outer retry is implemented here as a loop.
    let attempt = 0;
    const maxRetries = this.retry.maxRetries;
    while (true) {
      if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");

      // Per-request SSE idle watchdog. Combines the caller's abort signal
      // with an internal controller that fires when no SSE event arrives
      // within sseIdleTimeoutMs. The combined signal is passed to fetch,
      // so a watchdog abort cancels the HTTP request cleanly.
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
        await this.rateLimiter.reserve("openai");
        resetIdle();
        const resp = await this.fetchFn(`${this.baseUrl}${endpoint}`, {
          method: "POST",
          headers: this.authHeaders("text/event-stream"),
          body: JSON.stringify(payload),
          signal: fetchAbort.signal,
        });
        this.rateLimiter.updateFromHeaders("openai", headersToObject(resp.headers));
        if (!resp.ok) {
          const errBody = await resp.text();
          const httpErr: HttpError = {
            httpStatus: resp.status,
            rawMessage: errBody,
          };
          const retryAfter = parseRetryAfterHeader(resp.headers.get("retry-after"));
          if (retryAfter !== undefined) httpErr.retryAfterMs = retryAfter;
          throw httpErr;
        }
        if (!resp.body) {
          throw new Error("OpenAI response body was null");
        }
        const translator = new OpenAiEventTranslator();
        try {
          for await (const sse of parseSseStream(resp.body)) {
            // Any SSE byte from the server resets the idle watchdog.
            resetIdle();
            for (const ev of translator.translate(sse)) {
              yield withDoneConversation(ev, conversationId);
              if (ev.type === "done") {
                clearIdle();
                detachCallerAbort();
                this.circuitBreaker.recordSuccess(`openai${endpoint}`);
                return;
              }
              if (ev.type === "error") {
                // Mid-stream error. If the translator classified it as
                // transient, map to 503 so the retry policy retries. Otherwise
                // 599 with transient:false → classified non-retryable.
                const httpErr: HttpError = {
                  httpStatus: ev.retryable ? 503 : 599,
                  providerCode: ev.code,
                  rawMessage: ev.message,
                  transient: ev.retryable,
                };
                throw httpErr;
              }
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
        // If the stream ended without a done event, treat as transient.
        throw {
          transient: true,
          rawMessage: "stream ended without done",
        } satisfies Partial<HttpError> as HttpError;
      } catch (err) {
        clearIdle();
        detachCallerAbort();
        this.circuitBreaker.recordFailure(`openai${endpoint}`);
        if (err instanceof CircuitOpenError) throw err;
        const decision = isHttpError(err) ? this.retry.classify(err) : this.retry.classify(err);
        if (!decision.retry || attempt >= maxRetries) {
          throw err;
        }
        const delay = this.retry.nextDelayMs(attempt, decision.retryAfterMs);
        attempt++;
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  private async httpPost(endpoint: string, body: unknown): Promise<Response> {
    this.circuitBreaker.beforeCall(`openai${endpoint}`);
    const resp = await this.retry.execute(async () => {
      await this.rateLimiter.reserve("openai");
      const r = await this.fetchFn(`${this.baseUrl}${endpoint}`, {
        method: "POST",
        headers: this.authHeaders("application/json"),
        body: JSON.stringify(body),
      });
      this.rateLimiter.updateFromHeaders("openai", headersToObject(r.headers));
      if (!r.ok) {
        const errBody = await r.text();
        const httpErr: HttpError = { httpStatus: r.status, rawMessage: errBody };
        const retryAfter = parseRetryAfterHeader(r.headers.get("retry-after"));
        if (retryAfter !== undefined) httpErr.retryAfterMs = retryAfter;
        throw httpErr;
      }
      return r;
    });
    this.circuitBreaker.recordSuccess(`openai${endpoint}`);
    return resp;
  }

  private authHeaders(accept: string): Record<string, string> {
    const key = this.opts.apiKey ?? process.env.OPENAI_API_KEY ?? "";
    if (!key) {
      throw new Error("OpenAiAdapter: OPENAI_API_KEY is not set (pass apiKey or set env var)");
    }
    return {
      "Content-Type": "application/json",
      Accept: accept,
      Authorization: `Bearer ${key}`,
    };
  }

  private hasApiKey(): boolean {
    return Boolean(this.opts.apiKey ?? process.env.OPENAI_API_KEY);
  }
}

function firstArray(...values: unknown[]): unknown[] | null {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return null;
}

function withConversation(
  opts: RequestOptions,
  conversationId: string | undefined,
): RequestOptions {
  if (!conversationId) return opts;
  return { ...opts, conversationId, store: opts.store ?? true };
}

function withoutConversation(opts: RequestOptions): RequestOptions {
  if (opts.conversationId === undefined) return opts;
  const { conversationId: _conversationId, ...rest } = opts;
  return rest;
}

function withDoneConversation(ev: StreamEvent, conversationId: string | undefined): StreamEvent {
  if (!conversationId || ev.type !== "done" || ev.providerHandle.kind !== "openai_response") {
    return ev;
  }
  return {
    ...ev,
    providerHandle: {
      ...ev.providerHandle,
      conversationId,
    },
  };
}

function headersToObject(h: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  h.forEach((v, k) => {
    out[k.toLowerCase()] = v;
  });
  return out;
}

// Avoid the TS warning about an unused `OpenAiRequestPayload` re-export in test files.
export type { OpenAiRequestPayload };
