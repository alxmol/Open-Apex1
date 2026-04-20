# Open-Apex Build Plan

## Purpose

This document turns the Open-Apex implementation guide into a build plan for an engineering team. It is intentionally build-focused: what to build, in what sequence, why that sequence matters, what to test at each step, what can go wrong, and what the exit criteria are before moving on.

Open-Apex is a **terminal-native coding agent** with two modes:

1. **Chat mode**: interactive CLI coding agent for developers.
2. **Autonomous mode**: headless task runner for one-shot tasks and benchmark execution.

These are **not** separate architectures. Chat mode and autonomous mode run on the same Open-Apex orchestrator, tool runtime, permission system, validation engine, and checkpointing stack. The difference between them is preset and policy: gather aggressiveness, effort defaults, artifact verbosity, background behavior, and benchmark-isolation rules.

The project has two primary outcomes:

- Build a **usable, complete CLI coding agent** for real developer workflows.
- Build an autonomous harness designed to **top Terminal-Bench v2** and achieve **at least 70% on a full leaderboard-grade run** for each of these three configurations:
  - `tb2-gpt54`
  - `tb2-sonnet46`
  - `tb2-opus46`

Terminal-Bench v2 is an 89-task benchmark across categories including software engineering, ML/training, security, data science, system administration, debugging, data processing, video processing, and scientific computing. Tasks run in Docker containers with a 2-hour timeout and outcome-driven test verification. The current best public result is Codex CLI + GPT-5.2 at 63%. The 70% target is realistic given that Open-Apex adds a full intelligence-gathering architecture (parallel exploration, web search, environment observation, subagents, validation loop, recovery engine) on top of GPT-5.4, which is substantially stronger than GPT-5.2. The gap from 63% to 70% requires solving roughly 6 additional tasks out of 89, which is within reach given the model upgrade and architectural improvements over a single-tool scaffold like Codex CLI.

This is a **quality-first build**. Open-Apex is not cost or time constrained:

- prefer the strongest validated provider/model features when they improve solve rate
- use token/cost telemetry for observability, tuning, and regression analysis
- do **not** introduce runtime spend ceilings or cost-based throttling into the core agent or benchmark harness

This plan is grounded in the Apex2 architecture:
**predict → gather intelligence in parallel → synthesize → execute → validate**,
then extends it into a full runtime with provider adapters, a custom tool layer, safe editing, checkpoints, permissions, observability, and benchmark-native integration.

---

## 1. Project goals and locked decisions

### 1.1 Goals

- Rebuild Apex2 as **Open-Apex**, a modern CLI agent in **TypeScript + Bun**.
- Ship support for **GPT-5.4**, **Claude Sonnet 4.6**, and **Claude Opus 4.6** from day one.
- Use the **low-level provider model APIs only**:
  - OpenAI **Responses API**
  - Anthropic **Messages API**
- Official provider SDKs may be used only as thin transport clients where convenient. Open-Apex still owns retries, tool semantics, permissions, state, telemetry, and orchestration.
- Keep a **shared Open-Apex architecture**, but require **provider-tuned prompts, state handling, context-management features, rendering, and tool encodings** where they improve model performance.
- Keep **Open-Apex-owned tools and runtime**. Do not rely on provider Agent SDKs or provider-hosted shell/editor/web-search tools.
- Keep chat mode and autonomous mode on the same runtime. Benchmark/autonomous behavior and developer-chat behavior are preset/policy variants, not separate implementations.
- Support **multimodal input** for images and PDFs in terminal workflows. Both GPT-5.4 and Claude 4.6 support image and PDF input natively. Video processing tasks in TB2 are handled by the model writing code (ffmpeg, OpenCV) to process video files, not by sending video frames to the model as multimodal input. Video-as-model-input is not a v1 requirement.
- Emit **ATIF-compatible trajectories**, replay logs, and token/cost telemetry for every autonomous run.
- Pin leaderboard presets to explicit provider model identifiers, provider feature flags, and prompt revisions; any preset upgrade must be re-validated with smoke, slices, and at least one full TB2 run before it becomes the default.
- Support **Linux** as the primary benchmark/runtime target and **macOS + Linux** for the developer CLI. Windows/WSL may be added later, but are not v1 blockers.
- Product acceptance is measured at three layers:
  - **developer chat floor**: golden-path fixtures for inspect -> edit -> validate -> undo -> resume -> provider switch pass deterministically
  - **autonomous quality floor**: validation-before-finish and artifact completeness remain effectively perfect on smoke + slice runs
  - **benchmark trust floor**: preset quality is judged on repeated full runs, not on a single spike

### 1.2 Locked architectural decisions

These decisions are already made and should be treated as non-negotiable unless benchmark or product evidence shows a clearly better path. Any exception should be written down as an ADR with:

- the exact decision being changed
- benchmark evidence
- product/runtime tradeoffs
- rollback criteria

#### Core runtime

- Open-Apex owns:
  - orchestration
  - tool runtime
  - permissions
  - checkpointing
  - compaction policy layers
  - telemetry
  - replay
  - Harbor integration
- Chat mode and autonomous mode share this same runtime stack; they differ only in preset/policy.
- Local Open-Apex state -- checkpoints, session snapshots, normalized events, telemetry, and replay artifacts -- is the canonical source of truth for resume and recovery.
- Providers only supply:
  - text/reasoning generation
  - tool call generation
  - provider-native context/state features

#### Provider strategy

Provider optimization belongs inside adapters and preset definitions. The orchestrator may branch only on normalized capabilities exposed by adapters; it must not encode raw provider-specific API behavior directly. Open-Apex should use provider-native continuation, caching, compaction/context editing, multimodal ingestion, streaming, and rendering features aggressively when they improve quality or stability, provided those features do not replace Open-Apex control of tools, workspace mutation, telemetry, replay, or benchmark determinism.

Provider capabilities should be tracked in a versioned matrix per preset with four states:

- **required**
- **optional**
- **experimental**
- **fallback-defined**

Required capabilities must be present for a preset to run. Optional capabilities may improve quality but are not required. Experimental capabilities may be enabled behind explicit preset flags. Fallback-defined capabilities must have an adapter-level degradation path that preserves orchestrator semantics when the provider feature is unavailable or regresses.

- **OpenAI**
  - Use **Responses API**. The Responses API passes chain-of-thought (CoT) between turns via `previous_response_id`, which improves intelligence, reduces reasoning token generation, increases cache hit rates, and lowers latency compared to Chat Completions.
  - Use `previous_response_id` as the default same-session continuation primitive. This automatically preserves reasoning items, `phase` metadata, and tool state across turns. It is the primary mechanism for all in-session continuations.
  - Use **Conversations** only for durable cross-process resume (e.g., `/resume` after CLI restart where the original `response_id` is stored in a local session snapshot) and for background workflows. In benchmark mode, always use `previous_response_id` (foreground, fully observable); never use Conversations.
  - Preserve assistant-message `phase` metadata whenever assistant items are replayed or resumed. Use `phase: "commentary"` for intermediate assistant updates (preambles before tool calls) and `phase: "final_answer"` for the completed answer. Missing or dropped `phase` can cause preambles to be treated as final answers.
  - GPT-5.4 supports five reasoning effort levels via `reasoning: { effort: "none" | "low" | "medium" | "high" | "xhigh" }`. The default for GPT-5.4 is `none`. Open-Apex benchmark presets override this to `high` or `xhigh` as specified in the effort policy.
  - GPT-5.4 supports a `text.verbosity` parameter (`"low"`, `"medium"`, `"high"`; default `"medium"`) that controls output length independently of reasoning effort. Use `"medium"` for benchmark mode.
  - Use provider-native features such as:
    - structured outputs
    - function tools
    - custom freeform tools (type `custom` for plaintext tool inputs)
    - CFG constraints for custom tools where helpful
    - `allowed_tools` in `tool_choice` to restrict available tools per turn (e.g., enforce patch-first editing by excluding `write_file` for existing files)
    - parallel tool calling
    - token counting endpoint
    - native compaction (GPT-5.4 is trained to support compaction)
    - tool search for large tool surfaces where applicable
    - preambles for transparent tool-call reasoning
    - reasoning summaries via `reasoning.summary: "auto"` for debugging and telemetry
    - background mode where appropriate for normal CLI use
  - Use provider-side background mode only when it improves reliability for normal CLI use; benchmark mode stays foreground and fully observable.
  - Provider adapters must degrade gracefully when an optional provider capability is unavailable or regresses.
- **Anthropic**
  - Use **Messages API**.
  - Always enable **adaptive thinking** via `thinking: { type: "adaptive" }`. Adaptive thinking lets Claude dynamically determine when and how much to use extended thinking based on task complexity. It automatically enables interleaved thinking between tool calls, which is critical for agentic workflows. The older `thinking: { type: "enabled", budget_tokens: N }` approach is deprecated on Claude 4.6 models and should not be used.
  - Use the **effort parameter** via `output_config: { effort: "high" }` for leaderboard runs. Supported levels are `low`, `medium`, `high` (default), and `max`. At `high`, Claude almost always thinks. At `max`, Claude always thinks with no constraints on thinking depth. The `max` level is available on Opus 4.6 and Sonnet 4.6.
  - Preserve tool/thinking blocks exactly across tool continuations; tool loops are treated as one continuous assistant turn. Thinking blocks contain encrypted `signature` fields that must be passed back unchanged for multi-turn continuity.
  - Use **summarized thinking** (`display: "summarized"`, the default on Claude 4 models) for telemetry and debugging. Use `display: "omitted"` where faster time-to-first-text-token matters and thinking content is not surfaced to users. The `signature` field is identical regardless of `display` setting.
  - Use provider-native features such as:
    - strict tool use
    - fine-grained streaming (thinking blocks stream via `thinking_delta` events)
    - prompt caching (consecutive requests using the same `adaptive` thinking mode preserve cache breakpoints; switching between `adaptive` and `enabled`/`disabled` breaks cache breakpoints for messages but not for system prompts or tool definitions)
    - **context editing** (beta header `context-management-2025-06-27`):
      - `clear_tool_uses_20250919`: clears old tool results when input tokens exceed a configurable threshold, keeping the N most recent tool use/result pairs. Supports `trigger` (token threshold), `keep` (recent tool uses to preserve), `clear_at_least` (minimum tokens to clear per activation), `exclude_tools` (tools whose results are never cleared), and `clear_tool_inputs` (optionally clear tool call parameters too).
      - `clear_thinking_20251015`: manages thinking block accumulation across turns. Configurable `keep` parameter controls how many recent assistant turns with thinking blocks to preserve. Default keeps last 1 turn.
    - **server-side compaction** (beta header `compact-2026-01-12`): automatically summarizes conversation when approaching context limits. Returns a `compaction` block that replaces prior history. Supports `trigger` (minimum 50K tokens), `pause_after_compaction` (to inject additional context before continuing), and custom `instructions` for summarization. The `compaction` block can be cached with `cache_control: { type: "ephemeral" }` for efficient subsequent requests.
    - search result blocks for citation-friendly rendering of Open-Apex's own search results to Claude (provenance-aware format with title, URL, snippet, content)
  - Use prompt caching aggressively: add a `cache_control` breakpoint at the end of the system prompt so it remains cached separately from conversation content even across compaction events.
  - Context editing and compaction are layered: use context editing (tool result clearing + thinking block clearing) as the primary strategy, server-side compaction as the secondary strategy for conversations that are still too long, and local Open-Apex summaries and checkpoints as the source of truth. If provider context management degrades, the runtime can fall back to rebuilding context from local state.
  - Live canaries for context editing and compaction should test: (a) API call succeeds with beta headers, (b) `applied_edits` / `compaction` blocks appear in the response, (c) the model's next response is coherent and on-task after clearing/compaction.

#### Provider API retry policy

Both providers require a retry layer from Milestone 1 onward, since Open-Apex uses the provider APIs directly rather than relying on provider-managed agent runtimes or SDK-owned retry behavior.

- **Exponential backoff with jitter**: initial delay 1 second, exponential base 2, max delay 60 seconds, max 5 retries.
- **Retry on**:
  - 429 (rate limit) -- respect `Retry-After` header (OpenAI) or `retry-after` header (Anthropic) when present
  - 500, 502, 503 (server errors)
  - 529 (Anthropic overloaded)
  - Network timeouts and connection resets
- **Do NOT retry on**: 400 (bad request), 401 (auth), 402 (billing), 403 (permission), 404 (not found), 413 (request too large).
- **Streaming failures**: if a streaming response fails mid-stream (connection drop, `server_error` event), retry the full request. For OpenAI, use `previous_response_id` to avoid re-processing already-completed turns. For Anthropic, replay the full message history.
- **Rate limit headers**: OpenAI returns `x-ratelimit-remaining-requests`, `x-ratelimit-remaining-tokens`, `x-ratelimit-reset-requests`, `x-ratelimit-reset-tokens`. Anthropic returns `retry-after` on 429s and distinguishes 429 (rate limit) from 529 (overloaded). Log these headers for observability.
- This retry layer is foundational infrastructure and must be implemented in Milestone 1, not deferred to hardening.

#### Timeout policy

- Open-Apex does **not** enforce a task-level timeout internally. In benchmark mode, Harbor owns the task-level timeout via `agent.timeout_sec` in each task's `task.toml` and kills the agent process externally. In autonomous mode for non-benchmark one-shot tasks, the agent runs until it completes or the user cancels -- there is no time pressure mode.
- Open-Apex **does** enforce **per-command shell timeouts** so that a single `run_shell` call cannot hang the entire run. Default: 300 seconds. The model can request longer timeouts for known long-running operations (e.g., ML training, large builds) by passing a timeout parameter to the shell tool.
- Incremental artifact flushing (already specified in Section 5.5) is critical because Harbor's external kill means artifacts must exist on disk throughout execution, not only at the end.

#### Effort policy

- The project is **solve-rate first**, not cost-constrained.
- **Leaderboard presets are fixed-effort**, not phase-routed. Fixed effort avoids the large tuning surface and validation complexity of phase-routing, and already provides a reasoning advantage over the default configurations used by most competing agents (TB2 results use "medium" effort for both OpenAI and Anthropic models).
- Phase-routed effort may exist as an experiment flag only. The recommended experiment shape is: `low` for gather/scout subagents, `high` for synthesis/execution, `xhigh`/`max` for repair. If A/B comparisons show a statistically significant improvement on full TB2 runs, phase-routing can be promoted to the default preset.
- Build and tuning decisions should target the strongest validated quality profile for each provider. Cost is measured, but it is not a gating metric.
- Default benchmark presets with concrete API parameters:
  - GPT-5.4 (`tb2-gpt54`): `reasoning: { effort: "high" }`, `text: { verbosity: "medium" }`
  - Sonnet 4.6 (`tb2-sonnet46`): `thinking: { type: "adaptive" }`, `output_config: { effort: "high" }`
  - Opus 4.6 (`tb2-opus46`): `thinking: { type: "adaptive" }`, `output_config: { effort: "high" }`
- Chat mode may expose lower-effort user overrides for responsiveness, but the build plan optimizes around the high-quality profile rather than the lowest-cost profile.
- GPT-5.4 may use **one `xhigh` repair turn** (`reasoning: { effort: "xhigh" }`) after repeated failed validation. This is GPT-5.4's maximum reasoning effort level and should only be used when evals show a clear benefit that justifies the extra latency and cost.
- Anthropic `max` effort (`output_config: { effort: "max" }`) is available on Opus 4.6 and Sonnet 4.6 as an equivalent escalation for repair turns if needed.

#### Tools and editing

- Editing is **patch-first** using **unified diff format** (`--- a/file`, `+++ b/file`, `@@ -line,count +line,count @@`). This is the format models are most trained on (from billions of git diffs in training data) and is well-understood by both GPT-5.4 and Claude 4.6. GPT-5.4 even has a native `apply_patch` tool in its built-in tool set, confirming the format choice.
- The editing tool surface has three tiers:
  - **`apply_patch`**: primary tool for modifying existing files. Accepts unified diff, validates structurally before applying, generates reverse patch for undo. If the patch cannot be applied cleanly (e.g., context mismatch), it returns a structured error that can trigger the explicit runtime-mediated full-file fallback described below.
  - **`search_replace`**: targeted edit tool for small, precise changes. Takes `(file_path, old_text, new_text, replace_all?)`. When `replace_all` is `false` (default), validates uniqueness of `old_text` in the file and fails if multiple matches exist. When `replace_all` is `true`, replaces all occurrences and reports the count in the result. Complements `apply_patch` for single-hunk edits where generating a full diff is overkill, and covers the bulk rename case when `replace_all` is enabled.
  - **`write_file`**: for new file creation only. Not offered as a tool option for existing files unless `apply_patch` has failed on that file as a recovery fallback.
- Tool selection is **runtime-enforced**, not prompt-only:
  - For existing files: only `apply_patch`, `search_replace`, and `read_file` (range reads) are offered. `write_file` is excluded from the tool list.
  - For new file creation: `write_file` is offered.
  - Fallback: if `apply_patch` fails (reported as a structured tool error), the runtime forces a reread of the target and may temporarily offer `write_file` for that specific file as a recovery path. "Fallback to full-file write" always means this explicit runtime-mediated fallback, never a silent internal rewrite.
  - On OpenAI, this is enforced via `allowed_tools` in `tool_choice`. On Anthropic, this is enforced by including/excluding tools from the tool list per turn.
- The `run_shell` tool is for executing commands (build, test, install), **not** for file creation. Shell tool descriptions should explicitly instruct the model not to use heredoc, echo, or cat for file creation and to use the file tools instead.
- **File existence detection** is enforced at tool execution time via stat-on-demand. If `apply_patch` or `search_replace` is called on a nonexistent file, the tool returns a structured error. If `write_file` is called on an existing file without the recovery-fallback flag, the tool returns a structured error suggesting `apply_patch` or `search_replace`. No maintained workspace file index is needed -- stat-on-demand is sufficient and avoids staleness issues from concurrent edits or shell-side file operations.
- Parallel tool calls are allowed for **non-mutating tools only**.
- All writes and destructive operations are **serial**.

Patch application itself should be deterministic:

1. parse unified diff
2. resolve paths inside the workspace
3. verify file existence/type assumptions
4. verify hunk context
5. apply or return a structured error

`search_replace` requires exactly one match unless `replace_all` is explicitly set. Large files, binary files, symlinks, and shell-side mutations discovered after a failed patch must produce structured tool errors rather than best-effort fuzzy edits.

#### Permissions

Use a Droid-style permission model:

- **read-only**
- **reversible**
- **full**

`catastrophic` is not a normal permission class granted to the agent. It is a deny-only classifier used to reject high-consequence actions that Open-Apex must never auto-approve.

Permission classes must be implemented as runtime policy, not prompt hints:

- **read-only**
  - file reads
  - tree/list/search
  - process/environment observation
  - non-mutating shell commands (e.g., `cat`, `ls`, `pip list`, `node --version`, `ps aux`, `df -h`, `free -m`, `docker ps`, `which`, `env`, `uname`)
  - git inspect operations such as `diff`, `status`, `show`, `log`, `blame`
- **reversible**
  - checkpointed workspace edits that Open-Apex can undo locally
  - patch application
  - file writes/moves/deletes inside the workspace
- **full**
  - side-effecting but non-catastrophic actions such as dependency installation, service control inside the task environment, and higher-privilege git operations allowed by policy
- **catastrophic**
  - destructive operations outside the workspace
  - irreversible credential or infrastructure changes
  - force-pushes, hard resets, mass deletes, database destruction, or equivalent high-consequence commands

Catastrophic operations are never auto-approved. In autonomous mode, catastrophic commands do **not** ask the user; they return **forbidden, replan**.

Classifier precedence is:

1. catastrophic
2. full
3. reversible
4. read-only

Unknown shell commands default upward: unknown mutating/networked commands are treated as `full`, and unknown commands with destructive signatures default to `catastrophic`.

#### Search

- Web search is **Open-Apex-owned**, not provider-owned.
- Use **Google SERP** through a `SearchProvider` interface with pluggable implementations.
  - **Primary provider: Serper.dev**. Fast, affordable (~$1/1000 searches at scale), returns structured JSON including Google AI Overview / knowledge panels, and has high reliability. It is the most commonly used SERP API for agent frameworks.
  - **Fallback / alternative: SerpAPI**. More comprehensive and established (~$25/1000 searches) with broader search engine coverage. Implement as a second `SearchProvider` behind the same interface.
  - The `SearchProvider` interface normalizes results across providers so the rest of the system is provider-agnostic.
- Treat **AI Overview / AI Summary** as high-priority enrichment when available, but never as a hard dependency. Serper.dev returns AI Overview when Google serves it, which varies by query and region.
- Fall back to answer boxes, organic links, and fetched pages if AI Overview is missing or low quality.
- Source ranking should use a simple weighted score from the start:
  - source prior / authority
  - query-task match
  - task-type fit
  - freshness/version fit
- Return normalized search records with provenance:
  - query
  - source URL
  - title
  - snippet
  - fetched excerpt
  - extraction metadata
  - fetch status / failure reason when extraction fails or is blocked
- For Anthropic, render search results using **search result blocks** for citation-friendly structured formatting. For OpenAI, render the same normalized data as well-structured text within the tool result. This is a provider-adapter concern, not an orchestrator concern.
- Source ranking should prefer official documentation and other primary sources for API/framework questions, then source repos / issue trackers / StackOverflow / technical blogs when the task is implementation- or error-driven.
- Page fetch/extract failures (robots restrictions, JS-only pages, rate limits, extraction failures) should be recorded as structured metadata and trigger fallback to other results rather than aborting the search phase.
- Search should be **selective but proactive**, not blanket-triggered.
- Trigger search only for:
  - version or framework uncertainty
  - repeated failed local hypotheses
  - external API/doc tasks
  - ambiguous environment-specific errors
  - real-world knowledge that cannot safely be inferred from the model alone
- Multi-round search is allowed when uncertainty remains material after the first pass. Default fetch budget:
  - round 1: fetch up to 4 pages
  - round 2: fetch up to 3 additional pages only if uncertainty remains
  - round 3: fetch up to 2 additional pages only after failed hypotheses or conflicting evidence
- **Search caching** policy:
  - Within a single run: cache search results by normalized query string. If the model re-searches the same query, return cached results. This avoids wasted API calls and ensures determinism within a task.
  - Across repeated runs of the same task: do NOT cache by default for benchmarks. Each run should be independent. Cached results could mask regressions in search quality or query generation.
  - For development/debugging: allow an opt-in persistent cache (stored locally) that developers can enable to speed up iteration without burning SERP API credits. TTL-based invalidation (e.g., 1 hour).
- **Benchmark-contamination filtering**:
  - Filter search results whose title, URL, or snippet contains: "Terminal-Bench", "terminal-bench", "tbench.ai", "harbor-framework/terminal-bench", and any known TB2 task identifiers.
  - Filter results from domains: `tbench.ai`, `harborframework.com` (when the path relates to terminal-bench content).
  - This is a blocklist approach: simple, effective, and deterministic. If a more sophisticated approach is needed later (e.g., semantic similarity to TB2 task descriptions), it can be added as a tuning experiment.
- The contamination blocklist should live as a versioned source-of-truth artifact in the `config` package so benchmark-safe filtering is reviewable and reproducible.
- Source ranking should be part of the subsystem from the start.

#### Subagents

- Ship scoped subagents in v1:
  - repo scout
  - environment scout
  - web researcher
  - strategy planner
  - exploratory executor
  - verifier
- Subagents use the **same model and same effort preset as the parent** in benchmark mode.
- Subagents receive **compressed briefs + selected artifacts only**. Context budget per subagent brief is capped (e.g., 4K tokens for the brief + selected artifacts). Subagent output is also capped and must conform to a structured schema.
- **Permission classes by subagent role**:
  - **Repo scout, environment scout, web researcher, strategy planner, verifier**: operate under the **read-only permission class**: file reads, searches, non-mutating shell commands (e.g., `pip list`, `ps aux`, `node --version`, `cat`, `find`), and git inspect operations. They are blocked from file writes, patch application, package installation, and git mutations. This is not "read filesystem only" -- it is "no workspace mutations," which explicitly includes non-mutating shell execution for environment observation.
  - **Strategy planner**: a dedicated read-only gather lane that extracts model-native priors before execution: ranked approaches, likely validator commands, likely failure modes, risky operations, and search pivots if the first approach fails. It complements empirical gather lanes rather than replacing them.
  - **Exploratory executor**: operates under the **reversible permission class** within an **automatic checkpoint-restore cycle**. The runtime takes a checkpoint (via the shadow git snapshot system) before the exploratory executor starts, launches it inside an Open-Apex-managed isolated sandbox/worktree derived from that checkpoint, and destroys/restores that sandbox when it finishes. Its mutations never touch the live parent workspace and are never exposed to parallel read-only scouts. The executor gets reversible permissions: file writes, patch application, dependency installation, test runs. Its value is its structured observations (what commands succeeded, what tests passed, what errors appeared, environment discoveries), not its file changes. This exactly mirrors Apex2's Episode 1 behavior without violating the parent runtime's serial-write guarantees.
- **Verifier**: a read-only subagent used during validation or recovery to inspect diffs, logs, and validator output. It supplements but does not replace runtime-enforced validation and completion checks.
- The parent orchestrator owns all writes to the live workspace, final validation, and final task completion decisions.
- **Fan-out cap**: default 5 concurrent gather workers during the autonomous/benchmark gather phase (repo scout, environment scout, web researcher, strategy planner, exploratory executor). The scout/researcher/planner workers are read-only; the exploratory executor is reversible but isolated. In chat mode, the exploratory executor and strategy planner are policy-triggered rather than universal so normal developer turns stay responsive unless uncertainty, risk, or repeated failures justify them. A 6th "verifier" subagent can be spawned during validation if needed. Each subagent gets its own model call. Cap fan-out for context quality and determinism, not for cost.
- **Subagent brief and result schema**: defined in the `core` package from Milestone 0 as TypeScript types. Contract tests validate conformance. The schema is:

```typescript
interface SubagentBrief {
  taskId: string;
  role: "repo_scout" | "environment_scout" | "web_researcher" | "strategy_planner" | "exploratory_executor" | "verifier";
  taskSummary: string;
  focusAreas: string[];
  artifacts: ArtifactRef[];
  constraints: {
    maxTurns: number;
    maxTokens: number;
    permissionClass: "read_only" | "reversible";
  };
}

interface SubagentResult {
  role: string;
  findings: string;
  artifacts: NamedArtifact[];
  confidence: "high" | "medium" | "low";
  recommendations: string[];
  errors?: string[];
}
```

The generic `SubagentResult` shape should be implemented as a discriminated union with role-specific payloads. At minimum:

- `strategy_planner` returns ranked approaches, validator guesses, risk checks, failure pivots, and search pivots
- `exploratory_executor` returns commands attempted, validator outcomes, observed failures, and environment discoveries
- `verifier` returns validation findings tied to concrete diffs/logs/commands

Subagent results should be tightly budgeted (for example, ~1K output tokens each) and should prefer structured fields over freeform essays.

- **Synthesis is a dedicated model call**, not mechanical concatenation. The parent orchestrator makes a dedicated synthesis call that receives all `SubagentResult` objects + the original task + prediction metadata. The synthesis call produces an optimized execution context: a compressed, prioritized summary of everything discovered, structured for the execution phase. This preserves the Apex2 pattern where strategy synthesis was the key step that transformed raw intelligence into actionable context.

The synthesis output should also be typed rather than freeform. At minimum it should produce an `ExecutionContext` object containing:

- chosen approach
- prioritized facts
- execution plan
- files to inspect
- files to change
- validators
- risk guards
- follow-up search hooks
- completion checklist
- evidence references back to gather artifacts

#### Session behavior

- Switching provider behaves like `/new`:
  - repository state stays
  - conversation state is reset
  - no session artifacts transfer across providers
- Local checkpoints, session snapshots, normalized event logs, and tool artifacts are canonical. Provider-native conversation state accelerates continuation and resume, but Open-Apex must be able to rebuild a resumable session from local state alone.

#### Benchmark behavior

- Harbor integration is via **installed agent** running `open-apex autonomous`.
- Project-specific config exists for normal use, but **benchmark mode defaults must be clean** and should not exploit task-specific config.
- Benchmark mode must not auto-load user/global config, repository-local `OPEN_APEX.md`, `.openapex/config.toml`, or any equivalent prompt/config hint file as hidden context.
- Benchmark-safe overrides are a typed, allowlisted, version-controlled registry of preset inputs checked into the Open-Apex repo. Each override entry must declare an id, scope, allowed fields, rationale, evidence references, introduction revision, and review point. They may tune provider feature flags, prompt appendices, tool descriptions, logging/artifact behavior, retry/timeout behavior, and other generic runtime mechanics, but they may not inject repo-specific hints, hidden solution content, task-derived benchmark cheats, task IDs, task keywords, or repo fingerprints. Every benchmark run must record the exact override ids that were applied.
- Benchmark mode uses a hardcoded benchmark system prompt: the standard Open-Apex agent identity, tool descriptions, behavioral rules, and the benchmark preset's provider-specific appendix (effort level, provider-tuned guidance). The task instruction is the user message. No project context is injected. The benchmark system prompt is version-controlled in the Open-Apex repo as part of the preset definition; any change requires re-validation with benchmark smoke + slices before it becomes the default.
- Every benchmark claim must record:
  - exact model identifier / alias used at runtime
  - provider beta headers or feature flags
  - prompt/preset revision
  - dataset version
  - timeout policy
  - full artifact bundle
- Single full runs may be used for submission decisions, but repeated full runs are still required to trust score movement during tuning.

---

## 2. Non-goals for v1

These are explicitly out of scope for the initial build unless they are later promoted by benchmark evidence.

- Provider Agent SDK integration
- Provider-hosted shell/editor/web-search tools
- Browser or desktop computer use
- Full LSP integration
- Multi-model subagent mixtures
- Shared memory between separate provider sessions
- Hidden “cheat” benchmark configs derived from task-specific config files
- Rich GUI frontend

---

## 3. Reference architecture

## 3.1 Monorepo layout

```text
open-apex/
  apps/
    cli/
    harbor-installed-agent/
  packages/
    core/
    runtime/
    tools/
    provider-openai/
    provider-anthropic/
    search/
    indexer/
    telemetry/
    evals/
    config/
```

The package count is driven by the provider separation requirement: provider adapters must be isolated packages because they depend on different provider transports/SDKs, have different type systems, and evolve independently. The `indexer`, `evals`, and `config` packages may start as subdirectories within `core` or `runtime` and be promoted to standalone packages when complexity demands it. Use `bun workspaces` for monorepo management.

### Package responsibilities

- `core`
  - shared types
  - prompt spec
  - preset registry
  - event schemas
  - policy definitions
- `runtime`
  - orchestrator
  - phase engine
  - permission checks
  - session state
  - validation loop
  - checkpoint integration
- `tools`
  - tool contracts
  - filesystem tools
  - shell tools
  - git tools
  - jobs
  - asset reads
  - validation helpers
- `provider-openai`
  - Responses adapter
  - Conversations integration
  - custom tool encoding
  - usage/token-count integration
- `provider-anthropic`
  - Messages adapter
  - adaptive thinking control
  - prompt caching
  - context editing / compaction hooks
- `search`
  - Google SERP integration
  - fetch/extract
  - search result normalization
- `indexer`
  - tree-sitter symbol index via `web-tree-sitter` (WASM bindings compatible with Bun). Language grammars are loaded as `.wasm` files at runtime. Ship a curated set matching TB2 task languages: Python, TypeScript/JavaScript, C/C++, Rust, Go, Java, Ruby, Bash, OCaml, Scheme. Add more grammars on demand.
  - repo map
- `telemetry`
  - ATIF writer
  - replay logs
  - usage ledger
  - benchmark artifacts
- `evals`
  - benchmark manifests
  - local fixture tasks
  - ablation runners
- `config`
  - `OPEN_APEX.md`
  - `.openapex/config.toml`
  - benchmark-safe config overrides (versioned allowlist for runtime/preset mechanics only; never repo-specific hidden hints)

## 3.2 Runtime model

The shared runtime should be built around these abstractions:

- `ProviderAdapter`
- `ToolRuntime`
- `Orchestrator`
- `SessionStore`
- `CheckpointStore`
- `TelemetrySink`
- `BenchmarkAdapter`

The most important design constraint is this:

> The agent should never “care” which provider is underneath at the orchestration level, but provider adapters must still exploit provider-native features enough to avoid flattening both providers into the lowest common denominator.

In practice, this means the orchestrator reasons in terms of normalized capabilities (`supportsPreviousResponse`, `supportsPromptCaching`, `supportsContextEditing`, `supportsServerCompaction`, `supportsSearchResultBlocks`, `supportsAllowedTools`, etc.), while adapters map those capabilities onto provider-native APIs and beta features.

The abstraction boundary is the `ProviderAdapter` interface. The orchestrator interacts with a unified interface:

```typescript
interface ProviderAdapter {
  createResponse(request: AgentRequest, options?: RequestOptions): AsyncIterable<StreamEvent>;
  continueFromPrevious(previousId: string, newInput: Message[], options?: RequestOptions): AsyncIterable<StreamEvent>;
  countTokens(messages: Message[], options?: RequestOptions): Promise<TokenCount>;
}

interface RequestOptions {
  contextManagement?: ContextManagementConfig;  // Anthropic context editing + compaction; OpenAI adapter ignores this
  effort?: EffortLevel;                         // per-turn effort override (maps to reasoning.effort on OpenAI, output_config.effort on Anthropic)
  allowedTools?: string[];                      // per-turn tool restriction (maps to allowed_tools on OpenAI, tool list filtering on Anthropic)
  maxOutputTokens?: number;
}
```

There is no standalone `compact()` method. Both Anthropic's context editing and compaction are request-level options (`context_management.edits` in the request body, triggered by the server during normal request processing), not separate API calls. OpenAI's compaction is also a response-level feature. Context management is passed as part of `RequestOptions` on normal requests.

`StreamEvent` is a normalized union: `TextDelta`, `ToolCall`, `ToolCallDelta`, `ReasoningDelta`, `PhaseMarker`, `CompactionBlock`, `UsageUpdate`, `Done`. The orchestrator never sees provider-specific constructs like OpenAI `phase` fields or Anthropic `thinking` blocks directly -- it sees normalized events. Provider-tuned behavior (effort levels, context editing strategies, `allowed_tools`, caching headers, beta flags) lives entirely inside the adapter's request building and response parsing.

Beyond `ProviderAdapter`, the runtime should formalize the following typed orchestration contracts early:

- `PredictionResult`
- `ExecutionContext`
- `ValidationResult`
- `RecoveryDecision`
- `CompletionDecision`

These contracts are the glue between prediction, gather, synthesis, execute, validate, and recover. They should be versioned in `core` and contract-tested so the orchestrator is not driven by loose prompt text alone.

## 3.3 Config, prompt, and CLI contract

The project needs a stable contract early so the CLI product, benchmark harness, and replay tooling do not drift apart.

- Config precedence for normal use:
  - built-in defaults
  - user/global config
  - project `.openapex/config.toml`
  - session overrides
  - explicit CLI flags or slash commands
- `OPEN_APEX.md` is prompt/context material, not configuration.
- Chat mode and autonomous mode share the same runtime; benchmark mode is a stricter preset, not a separate architecture.
- Benchmark mode ignores automatic user/global/project prompt/config injection except versioned benchmark-safe overrides that are checked into the Open-Apex repo.
- The CLI must expose two first-class entrypoints:
  - interactive chat
  - headless `open-apex autonomous`
- The headless contract must define:
  - stable arguments:
    - `--workspace <path>`
    - one task source: `--task-file <path>` or `--task-stdin`
    - `--preset <id>`
    - `--output-dir <path>`
  - deterministic stdout/stderr behavior:
    - stdout emits exactly one final machine-readable result object
    - stderr is reserved for progress and human-readable logging
  - stable artifact paths
  - a pinned machine-readable output schema with, at minimum:
    - `run_id`
    - `status`
    - `validation_status`
    - `summary`
    - `artifact_paths`
    - `usage`
    - `checkpoint_count`
  - a versioned artifact bundle layout containing, at minimum:
    - `result.json`
    - `summary.json`
    - `events.jsonl`
    - `replay.md`
    - `atif.json`
    - `checkpoints/`
    - `logs/`
  - an exit-status taxonomy that distinguishes success, task failure, validation failure, permission refusal that could not be recovered, and runtime/config failure

Preset definitions must also pin the mode-policy defaults rather than leaving them implicit. At minimum, each preset must declare:

- default gather fanout
- whether strategy planner is on by default
- whether exploratory execution is on by default
- search aggressiveness
- effort defaults
- artifact verbosity
- background-mode allowance
- permission defaults

---

## 4. What must exist before optimization begins

Open-Apex should not be tuned prematurely. Before prompt tuning or benchmark chasing starts, the build must first establish:

1. **A thin end-to-end vertical slice** that can run through the full loop with real APIs.
2. **A safe mutation layer**:
   - patch engine
   - checkpoints
   - permission classifier
   - catastrophic command blocker
3. **Full telemetry**:
   - tool events
   - model events
   - costs
   - timelines
   - ATIF
4. **Deterministic local regression fixtures**
5. **Benchmark manifests** for smoke, slices, and full runs
6. **A stable benchmark-clean CLI and artifact contract**
7. **Live provider canaries** for the provider-native features the runtime depends on

In addition, the runtime needs a **baseline validation floor before Milestone 4**. Even before the full validation engine lands, Open-Apex must enforce structural checks after mutations, exit-code enforcement for validator commands, and one mandatory end-of-task validation pass in autonomous/benchmark mode. If no validator can be confidently determined from the task, fixture metadata, or repo manifests, autonomous/benchmark runs may not report success.

Without these, benchmark tuning will create unstable gains that cannot be debugged.

---

## 5. Build-wide quality strategy

## 5.1 Testing policy

Testing is not a final phase. It is part of every milestone.

Each milestone must add or extend tests at five levels:

1. **Unit tests**
   - pure functions
   - command classification
   - patch normalization
   - query generation
   - token/cost accounting
   - config parsing

2. **Contract tests**
   - tool schema conformance
   - provider adapter request/response mapping
   - event schema and ATIF structure
   - prompt section structure
   - replay log schema

3. **Integration tests**
   - tool runtime against fixture repos
   - patch application and undo
   - shell execution and job lifecycle
   - checkpoint restore
   - compaction/resume
   - session switching

4. **Online API tests**
   - real OpenAI API calls
   - real Anthropic API calls
   - real web search calls
   - real streaming behavior
   - real tool-call loop behavior
   - real multimodal/file/image/PDF requests where supported

5. **Benchmark tests**
   - Harbor smoke runs
   - Terminal-Bench v2 sample and small curated subsets
   - category slices
   - full 89-task dataset at milestone gates

## 5.2 Regression philosophy

Any change that touches runtime-critical behavior must trigger regression tests appropriate to that surface.

### Minimum regression rules

- **Any code change**
  - lint
  - typecheck
  - unit tests
  - contract tests

- **Tool/runtime changes**
  - fixture repo integration tests
  - permission tests
  - checkpoint tests
  - TB2 smoke subset

- **Provider adapter changes**
  - provider online smoke suite
  - streaming tests
  - tool round-trip tests
  - TB2 smoke subset on affected provider

- **Prompt/orchestrator/compaction/search changes**
  - local scenario integration tests
  - benchmark smoke
  - benchmark slices on all three target configs

- **Milestone completion**
  - full benchmark validation on all three configs or, where not yet practical, the largest available representative slice
  - online live API matrix across all supported providers/models

## 5.3 Benchmark strategy

Terminal-Bench testing must happen **throughout the project**, not just near release.

Maintain four benchmark layers from the start:

### A. Harbor harness smoke
Purpose: confirm installed-agent execution, artifact creation, reward reporting, and container behavior.

### B. Open-Apex local fixture suite
Purpose: deterministic debugging of runtime bugs without provider nondeterminism or benchmark noise.

Examples:
- edit one file
- fix one failing test
- install one missing dependency
- parse a log and patch code
- run long job and harvest logs
- recover from malformed patch
- refuse catastrophic command and replan

### C. TB2 smoke subset
Purpose: quick confidence check on each provider/preset.

This should be a very small set, but it must cover different failure modes:
- simple file edit
- shell/build/test
- environment discovery
- web/doc lookup
- long-running job
- multi-file fix

### D. TB2 slices and full runs
Purpose: measure actual progress and catch category-specific regressions.

Maintain category slices aligned with TB2's actual task categories:
- software engineering (largest TB2 category)
- ML/training and long-running jobs
- security tasks
- data science / data processing
- system administration
- debugging
- scientific computing
- video processing
- search-heavy/framework-uncertainty tasks (cross-cutting)
- environment discovery tasks (cross-cutting)

Run full `terminal-bench@2.0` milestone gates on:
- `tb2-gpt54`
- `tb2-sonnet46`
- `tb2-opus46`

The benchmark target for this project is explicit:

- Open-Apex should compete for the top Terminal-Bench v2 leaderboard positions.
- Open-Apex should reach **at least 70% success on a full `terminal-bench@2.0` run** for each of the three leaderboard presets above.
- Benchmark claims should always specify whether they describe:
  - a single full run
  - a repeated-run aggregate
  - a smoke or slice result

For internal trust, score movement should not be believed from a single full run alone. A practical default trust rule is 3 full runs per preset with full artifacts present and no severe outlier run before a preset change is treated as real progress.

## 5.4 Online API test strategy

Live API testing must exist from the earliest provider milestone onward.

Maintain an always-on live canary suite for:

### OpenAI
- plain response turn
- tool call round-trip (function tools + custom freeform tools)
- `previous_response_id` continuity (verify CoT/reasoning items are preserved across turns)
- `phase` metadata preservation (`"commentary"` vs `"final_answer"` round-trip)
- streaming (verify stream assembly including reasoning items and preambles)
- custom tool with CFG constraint
- `allowed_tools` in `tool_choice` (verify tool restriction per turn)
- `reasoning.effort` at each level (`none`, `low`, `medium`, `high`, `xhigh`)
- `reasoning.summary: "auto"` (verify reasoning summaries are returned)
- token counting endpoint
- compaction path (GPT-5.4 native compaction)
- conversation resume path (Conversations API)
- image/file input smoke

### Anthropic
- plain response turn
- tool call round-trip
- adaptive thinking (`thinking: { type: "adaptive" }`) + effort (`output_config: { effort: "high" }`)
- interleaved thinking between tool calls (automatic with adaptive mode)
- streaming tool-use accumulation (thinking_delta + text_delta events)
- multiple tool results returned in a single user message
- prompt caching (verify cache hits with `cache_control` breakpoints on system prompt)
- context editing (beta header `context-management-2025-06-27`):
  - `clear_tool_uses_20250919`: verify `applied_edits` in response, verify model coherence after clearing
  - `clear_thinking_20251015`: verify thinking block management across turns
- server-side compaction (beta header `compact-2026-01-12`): verify `compaction` block returned, verify model coherence from summary
- image/PDF input smoke
- search-result blocks formatting path

These tests are not optional. A CLI agent that only passes local mocks will drift from real provider behavior.

Recommended cadence:

- pull requests touching providers, prompts, search, compaction, or tool/runtime behavior run the relevant live canaries before merge
- nightly automation runs the full live provider matrix and benchmark smoke
- milestone gates run live provider matrix + benchmark smoke + representative slices, and later full runs

## 5.5 Observability requirements

Every autonomous run must emit:

- full event timeline
- model request/response metadata
- tool call details
- token usage
- cost estimates
- errors
- retries
- permission decisions
- checkpoints
- final result summary
- ATIF file
- human-readable replay log

Pin and version the artifact contracts:

- ATIF should target a pinned Harbor-supported schema version, currently `ATIF-v1.4`. The schema is fully documented in the Harbor RFC at `github.com/laude-institute/harbor/blob/main/docs/rfcs/0001-trajectory-format.md`, with Pydantic models in `harbor.models.trajectories`, a trajectory validator (`python -m harbor.utils.trajectory_validator`), and golden examples in `github.com/laude-institute/harbor/tree/main/tests/golden`. Open-Apex's TypeScript ATIF writer should mirror these Pydantic models as TypeScript types and validate against the same schema.
- replay log, summary JSON, timeline events, and checkpoint metadata should each have explicit versioned schemas
- the repo should contain golden examples for each artifact class

Incrementally flush telemetry during execution, not only at the end. Timeouts and crashes must still leave usable artifacts.

---

## 6. Milestone plan

### Milestone gate policy

The team should not advance on intuition alone. Each milestone has a gate:

- **Milestone 0 gate**: schemas, CLI/autonomous contract, and fixture harness are pinned and green
- **Milestone 1 gate**: live provider/tool-loop canaries are green on all three presets
- **Milestone 2 gate**: checkpoint, undo, permission, and catastrophic-command suites are green
- **Milestone 3 gate**: search-enabled slices are non-regressive versus search-disabled baselines
- **Milestone 4 gate**: first full orchestrator baselines exist on all three presets
- **Milestone 5 gate**: resume/compact long-horizon fixtures are green with no smoke regression
- **Milestone 6 gate**: full TB2 runs complete end-to-end with complete artifacts on all presets
- **Milestone 7 gate**: repeated full runs meet release thresholds rather than producing only one-off spikes

## Milestone 0 — Foundation, repo scaffolding, and build discipline

### What to build

- Bun monorepo scaffold
- package boundaries and dependency rules
- base CLI entrypoint
- config loaders
- logging/event framework
- preset registry
- provider capability matrix and adapter capability tests
- shared type definitions, including:
  - `SubagentBrief` and `SubagentResult` schemas (defined in `core` package, contract-tested from the start)
  - `StreamEvent` normalized union type
  - `ProviderAdapter` and `RequestOptions` interface definitions
- test harness skeleton
- local fixture repos and scenario harness
- developer golden-path scenarios for chat mode (inspect -> edit -> validate -> undo -> resume -> provider switch)
- Harbor wrapper skeleton
- stable CLI contract for chat and autonomous modes, including pinned JSON schema, artifact bundle layout, and exit codes
- ATIF and replay log schemas
- benchmark-safe override registry with schema validation, forbidden-field checks, and evidence requirements for promotion
- benchmark manifest structure:
  - smoke
  - slices
  - full

### Why now

This milestone creates the rails that keep the rest of the build from collapsing into ad hoc scripts and prompt files. It also ensures that benchmark and telemetry concerns are designed in from the first commit.

### Locked design choices in this milestone

- Separate packages for provider adapters
- Chat mode and autonomous mode share the same runtime; mode differences are policy/preset differences
- Open-Apex local state remains canonical even when providers offer conversation persistence
- Benchmark presets are first-class config objects
- Project config exists, but benchmark mode ignores automatic user/global and repo-local hints unless they are explicitly whitelisted benchmark-safe overrides

### What to test

#### Unit
- config parsing
- preset validation
- event schema validation
- CLI argument parsing

#### Contract
- ATIF schema validation
- replay log schema validation
- benchmark preset schema validation
- benchmark-safe override registry schema + forbidden-field validation
- `SubagentBrief` and `SubagentResult` schema validation
- `StreamEvent` type conformance
- `ProviderAdapter` interface contract

#### Integration
- CLI boots
- package graph builds
- Harbor wrapper can invoke a stub agent
- fixture repos load and reset correctly
- developer golden-path chat scenarios execute against fixture repos

#### Online
- none required yet beyond API credential/config sanity checks

#### Benchmark
- Harbor oracle run works in the local environment
- Open-Apex installed-agent wrapper can execute a no-op/stub task and emit artifacts

### What to watch out for

- Provider-specific code creeping into shared packages
- Logging format changing before consumers exist
- Config sprawl
- Failing to define fixture repos early

### Exit criteria

- `open-apex` CLI skeleton exists for both chat and autonomous entrypoints
- monorepo builds cleanly in CI
- test harness is running
- Harbor installed-agent skeleton works
- local fixtures exist and can be reset automatically in CI
- headless CLI contract, exit codes, and artifact bundle schemas are pinned
- ATIF / replay / summary artifact schemas validate against golden examples

---

## Milestone 1 — Thin vertical slice: provider adapters + minimal tool loop

### What to build

#### OpenAI adapter
- Responses API integration
- streaming support
- `previous_response_id` chaining
- usage capture
- tool round-trip loop
- `phase` preservation
- token counting hook
- conversation object path for future `/resume`

#### Anthropic adapter
- Messages API integration
- adaptive thinking enabled
- effort controls
- streaming accumulation
- tool round-trip loop
- preservation of thinking/tool blocks in active state
- prompt-caching hook
- support for single-message multi-tool-result return path

#### Minimal runtime
- single-turn tool loop
- stop/continue decision
- shared tool invocation contract
- minimal autonomous and chat entrypoints on the same runtime/orchestrator
- stable assistant `phase` handling in provider-visible state versus internal orchestration phase
- baseline validation floor:
  - structural checks after mutations
  - exit-code enforcement for validator commands
  - mandatory end-of-task validation pass in autonomous/benchmark mode
- **provider API retry layer**: exponential backoff with jitter for 429/500/502/503/529 errors, `Retry-After` header respect, streaming mid-failure retry (as specified in the provider API retry policy)

#### Minimal tools
- `read_file` (with range reads)
- `list_tree`
- `search_text`
- `run_shell` (restricted; shell tool description must explicitly instruct the model not to use heredoc, echo, or cat for file creation and to use file tools instead)
- `write_file` (new file creation only; not offered for existing files)
- `apply_patch` (unified diff format, with structural validation before application and reverse patch generation for undo)
- `search_replace` (targeted `old_text` -> `new_text` replacement for small edits; validates uniqueness of match by default, supports `replace_all` for bulk renames)
- `checkpoint_save`
- `checkpoint_restore`

### Why now

The project needs a real, end-to-end loop on real APIs before adding a large feature surface. This milestone proves that the core “own the runtime, not the provider SDK” architecture is viable.

### Design choices

- Keep the initial tool set deliberately small.
- Do not add subagents yet.
- Do not optimize prompts yet.
- Do not fork chat and autonomous into separate runtime implementations.
- `checkpoint_save` / `checkpoint_restore` should already use the canonical shadow-checkpoint path, even if the full mutation layer arrives in Milestone 2.
- The baseline validation floor exists from this milestone onward; Milestone 4 extends it into the full validation engine rather than introducing validation for the first time.
- Keep autonomous mode thin but real enough to run benchmark smoke.

### What to test

#### Unit
- provider request builders
- response parsers
- state transition logic
- usage accounting helpers
- retry policy logic (backoff timing, jitter, header parsing, retryable vs non-retryable error classification)

#### Contract
- tool call schema mapping
- OpenAI custom vs function tool payload mapping
- Anthropic content block parsing
- event translation into internal types

#### Integration
- tool loop with mocked providers
- replay from captured model/tool traces
- tool execution against fixture repos
- minimal autonomous run with local fixtures
- baseline end-of-task validation pass in autonomous mode

#### Online
- real turn on GPT-5.4
- real turn on Sonnet 4.6
- real turn on Opus 4.6
- real streaming on both providers
- real tool-call round-trip on both providers

#### Benchmark
- Harbor smoke run with the thin vertical slice
- TB2 smoke subset on all three presets with no score target yet; only verify end-to-end correctness and artifact completeness

### What to watch out for

- incorrect stream assembly
- broken OpenAI `phase` handling
- broken Anthropic block preservation
- mismatched usage accounting
- tool loop deadlocks

### Exit criteria

- chat mode can answer and call tools on deterministic fixtures
- autonomous mode can complete simple local fixture tasks
- autonomous mode cannot report success without a validator pass
- all three model presets can run benchmark smoke end to end
- OpenAI and Anthropic live canaries for basic turn, streaming, and tool round-trip are green
- artifacts are emitted and schema-valid for every run

---

## Milestone 2 — Workspace engine, permissions, and safe shell execution

### What to build

#### Editing and filesystem
- robust range reads
- full-file fallback reads
- validated patch engine
- reverse patch generation
- write normalization (newline, encoding, permissions)
- binary-file detection
- file move and delete tools
- baseline secret redaction for logs and artifacts
- workspace boundary enforcement

#### Shell runtime

Open-Apex does not use a terminal multiplexer (tmux). Apex2 relied on tmux because it operated through a single bash tool (Terminus-style). Since Open-Apex owns its tools, shell execution uses Bun's `Bun.spawn` / `child_process` directly, giving the runtime structured control over every process lifecycle. stdout/stderr are captured as typed data, not scraped from terminal panes, and there is no risk of session corruption.

- foreground command execution: spawned, awaited, stdout/stderr captured, timeout enforced
- background job execution: spawned with a `Job` object that tracks PID, log streams, start time, and cleanup. The parent orchestrator polls or subscribes to job completion.
- working-directory control
- timeout control
- stdout/stderr capture as structured data
- structured failure reporting
- process cleanup rules (orphan process detection and kill on task completion or failure)
- safer command construction / quoting rules

#### Permission system
- read-only
- reversible
- full
- command risk classifier
- catastrophic-command deny path with **forbidden, replan**
- path sandboxing and workspace-root enforcement

#### Git integration
- inspect operations in read-only
- mutate operations gated by permission mode
- diff/status/show/log/blame
- restore/checkout/stash/worktree under higher permissions as allowed

#### Checkpoints

Checkpoints use a **shadow git repository** pattern, following the approach proven by Kilo Code and Claude Code. A dedicated git repository is created outside the project directory (e.g., `~/.open-apex/checkpoints/<project-hash>/` for CLI use, or a temp path within the container for benchmark mode) with a detached worktree pointing at the project. This stores all snapshot tree objects without touching the project's own `.git` history. Open-Apex uses this shadow checkpoint store whether or not the target workspace has its own `.git` directory; checkpoint/undo are Open-Apex features, not inherited from the user repo.

- **checkpoint_save**: use the shadow repository + manifest to capture checkpoint state, including tracked content plus whatever additional metadata/files are required for correct restoration of untracked/deleted/renamed workspace state. `git write-tree` may be one implementation primitive, but the checkpoint contract is defined by restore correctness rather than by a single git command.
- **checkpoint_restore**: restore the checkpointed workspace state from the shadow store and verify that the resulting workspace matches the checkpoint manifest before continuing.
- **undo**: restore the most recent checkpoint.
- `.gitignore` rules of the project are respected for snapshots.
- automatic checkpoint before write batches
- named checkpoints
- undo stack
- restore path
- checkpoint-restore cycle for exploratory executor (automatic checkpoint before, isolated derived worktree/sandbox during exploratory pass, restore/teardown after, keep only structured observations)

The concrete checkpoint implementation must also define:

- how untracked files are captured
- how deletes and renames are restored
- file mode and symlink policy
- restore verification (for example, digest/manifest match after restore)
- sandbox-local writable directories (`HOME`, caches, temp dirs) for exploratory execution

Checkpoint correctness is a release-critical safety guarantee, not a best-effort convenience feature.

### Why now

Benchmark and real-world failures are dominated by bad edits, shell misuse, and irreversible mistakes. Open-Apex should not grow more “intelligent” until its mutation layer is correct and safe.

### Design choices

- Patch-first editing is default.
- Full-file write is fallback only.
- Long-running jobs use explicit job objects instead of hidden shell state.
- Catastrophic commands are blocked even in autonomous mode.

### What to test

#### Unit
- patch parsing and normalization
- reverse patch generation
- command classification
- workspace path validation
- git permission gating

#### Contract
- tool schemas for all file/shell/git tools
- checkpoint metadata schema
- structured shell error schema

#### Integration
- apply patch to fixture repos
- undo after multiple edits
- restore named checkpoint
- run tests/builds in foreground and background
- job log harvesting
- blocked catastrophic command returns “forbidden, replan”
- git ops by permission level

#### Online
- real provider execution over:
  - patch application tasks
  - shell/build/test tasks
  - permission failure and recovery path
- verify providers can recover from structured tool errors

#### Benchmark
- TB2 file-edit slice on all models
- TB2 build/test slice on all models
- synthetic destructive-command tasks that must refuse and replan

### What to watch out for

- newline and encoding edge cases
- shell injection through argument construction
- binary file corruption
- path traversal outside repo root
- jobs left running after failure
- provider confusion between shell state and repo state

### Exit criteria

- deterministic edit / undo / checkpoint fixture scenarios pass end to end
- permission system is enforced in runtime rather than prompt-only
- catastrophic-command deny path is deterministic and covered by tests
- shell and git behavior is stable under benchmark smoke
- baseline redaction and workspace-boundary protections are active

---

## Milestone 3 — Intelligence layer: search, repo map, symbol index, environment observation, assets

### What to build

#### Prediction phase
- task categorization
- key file extraction from instructions
- multimodal need detection
- risk profile tagging

#### Repo intelligence
- repo map
- language detection
- test/build system detection
- validator command discovery candidates promoted into an ordered pre-M4 validation ladder
- package manager detection
- tree-sitter symbol index
- lightweight symbol lookup tool

#### Environment intelligence
- installed tool/package detection
- running process observation
- disk/memory/process probes
- container/runtime context capture
- heuristics for likely entrypoints and relevant config files

#### Search layer
- Google SERP adapter
- AI Overview / AI Summary extraction when available
- answer box extraction
- organic result ranking
- source ranking policy by task type
- top-link fetch and extract
- structured handling of blocked/failed fetches
- multi-round search capped by policy
- mandatory benchmark contamination filtering in benchmark mode, configurable in normal product presets
- query generation guided by task category and uncertainty
- normalized result schema with provenance and extraction metadata
- search result caching

#### Asset handling
- raw model-native image/PDF/document input when provider supports it
- local metadata extraction and caching for replay/debug
- `read_asset` tool for targeted follow-up

### Why now

Apex2’s main advantage came from better intelligence gathering, not just better prompting. This milestone reintroduces that advantage on top of a stable runtime.

### Design choices

- Search is selective, but the threshold should be low enough to exploit real-world knowledge when it improves solve rate.
- Search belongs to Open-Apex, not the providers.
- AI Overview is a high-priority enrichment path, not a dependency.
- Source ranking should prefer official docs and other primary sources for APIs/frameworks, then implementation-oriented sources for operational debugging and error recovery.
- Repo intelligence is lightweight:
  - ripgrep
  - file tree
  - tree-sitter
  - symbol index
- No LSP yet.

### What to test

#### Unit
- task category classifier
- key file extraction
- search trigger logic
- query generation
- HTML/text extraction
- repo map generation
- symbol index lookup

#### Contract
- search result object schema
- Anthropic search-result block mapping
- OpenAI search-context rendering format
- asset metadata schema

#### Integration
- search end-to-end with mocked SERP responses
- search fallback when AI Overview is missing
- repo scan on multi-language fixture repos
- multimodal asset load path
- symbol lookup in large fixture repos

#### Online
- real Google SERP request path
- real extracted result formatting
- live image/PDF/document input smoke on providers that support it
- live provider behavior when external docs are added into context

#### Benchmark
- TB2 search-heavy slice on all models
- TB2 framework/version-uncertainty slice
- A/B runs with search disabled vs enabled on same tasks

### What to watch out for

- search overuse
- poor HTML extraction quality
- stale or noisy web sources
- symbol index drift after edits
- too much environment probing creating wasted context

### Exit criteria

- search outputs always include provenance and survive provider formatting
- search-heavy slice shows a positive or neutral net effect versus search-disabled baseline; if not, the trigger policy remains more restrictive until it does
- repo map and symbol lookup reduce blind file reads on local fixtures
- multimodal input works in real provider requests

---

## Milestone 4 — Full orchestrator: phased execution, subagents, synthesis, validation, recovery

### What to build

#### Shared phase engine
Implement the Apex2-inspired loop as a real runtime:

1. predict
2. gather intelligence in parallel (including exploratory execution)
3. synthesize (dedicated model call)
4. execute
5. validate
6. recover or finish (may re-enter gather for mid-execution re-exploration)

The runtime must preserve the Apex2 spirit of **explore early, then execute with synthesized context**. In Apex2, this was the Episode 1 / Episode 2 pattern: Episode 1 ran a quick "Terminus-style" execution attempt as part of intelligence gathering, then everything was synthesized into optimized context for Episode 2 (the real execution). Open-Apex preserves this as a first-class pattern, not an optional feature.

#### Parallel gather phase
- parallel read-only tool scheduling
- scoped subagent execution (default 5 concurrent gather workers):
  - **repo scout**: file tree, language detection, test/build system detection, key file contents, symbol index
  - **environment scout**: installed packages, running processes, disk/memory, container context, runtime versions (via non-mutating shell commands)
  - **web researcher**: multi-round Google SERP search with AI Overview extraction, guided by prediction phase output
  - **strategy planner**: a read-only strategic reasoning lane that proposes ranked approaches, failure pivots, validator guesses, and risk checks before the main execution pass. It preserves the Apex2 pattern of extracting model knowledge in parallel with empirical observation.
  - **exploratory executor** (the spiritual Episode 1): a short, capped execution pass that runs the task through a quick attempt with a limited turn/token budget, returning structured observations (what worked, what failed, environment discoveries, quick feedback). It runs inside the isolated checkpoint/worktree sandbox defined in Milestone 2, so its mutations never affect the live workspace or parallel read-only gathers. This is **enabled by default in autonomous/benchmark mode** because Apex2 results show Episode 1 was a major contributor to solve rate by providing the model with real environmental feedback before the main execution pass. In chat mode it is policy-triggered rather than universal.
- exploratory execution is a required capability for autonomous/benchmark mode; if the isolation backend cannot be created, benchmark mode fails fast rather than silently skipping Episode 1. In chat mode, exploratory execution remains policy-triggered.
- **synthesis of gathered results into optimized context**: a dedicated model call that receives all subagent results + the original task + prediction metadata and produces a compressed, prioritized summary structured for the execution phase. This is NOT mechanical concatenation -- it is the key step that transforms raw intelligence into actionable context, preserving the Apex2 pattern.

#### Mid-execution re-exploration
After N turns (configurable, e.g., 10) during the execute phase, or when the validation engine detects repeated failures on the same approach, the orchestrator can pause execution and re-enter a scoped mini-gather phase:
- re-search with refined queries based on execution failures
- re-scan changed files and environment state
- re-check assumptions that may have been invalidated
This preserves Apex2's "Second Parallel Exploration (Turn 10)" pattern. It is a specific recovery strategy: gather more intelligence before trying again, rather than spinning on the same failing approach.

#### Validation engine
- cheap structural validation after every write batch
- targeted milestone validation after significant changes
- full task validation before completion
- runtime-owned validation-command discovery ladder: explicit user/task instructions -> repo manifests/scripts -> detected framework conventions -> repo search -> minimal safe fallback
- verifier subagent may assist with analysis, but runtime validation policy decides task completion

Completion policy is strict:

- autonomous/benchmark mode may only return success when the requested outcome exists, the best-known validator set has passed, no unresolved runtime/tool error remains, and final artifacts have flushed successfully
- if no validator can be confidently determined, autonomous/benchmark mode must return a structured incomplete/failure status rather than optimistic success
- validator discovery should record both the chosen validators and the confidence level that produced them so false completions can be audited

#### Recovery engine
- structured recovery prompts and paths for:
  - syntax errors
  - import errors
  - missing file/path
  - failed tests
  - stuck long-running commands
  - permission denials
  - malformed patches
  - search failures
  - repeated failures on the same approach (triggers mid-execution re-exploration)
- bounded retry policy so the same failed plan cannot spin indefinitely
- recovery strategy selection: escalation ladder from local fix -> checkpoint restore -> re-exploration -> alternative approach -> give up with structured failure report

#### Prompt system
- shared Open-Apex prompt spec
- provider-specific appendices
- explicit Claude guidance to parallelize independent read-only tool calls
- no blanket “always use tools” over-prompting

#### Experimental flags
- phase-routed effort mode
- alternate validation cadence
- search aggressiveness experiments

### Why now

At this point, the runtime, tools, and intelligence substrate exist. This milestone turns them into a benchmark-capable agent.

### Design choices

- Use subagents for distinct questions, not for every action.
- Keep subagent context narrow.
- Chat mode uses the same phase engine; gather aggressiveness is policy-controlled for responsiveness rather than implemented as a separate orchestrator.
- Default leaderboard runs remain fixed-effort.
- Validation is runtime-enforced, not prompt-optional.
- The parent orchestrator owns all writes and final task completion decisions.
- Preserve the Apex2 gather → synthesize → execute shape rather than flattening everything into one generic loop.

### What to test

#### Unit
- phase transitions
- scheduler policies
- strategy-planner scoring / ranking assembly
- validation policy routing
- validation-command discovery ladder
- recovery strategy selection

#### Contract
- subagent brief schema
- role-specific subagent result schemas
- synthesis schema
- final answer/result schema
- prompt section structure snapshots

#### Integration
- end-to-end local fixture tasks requiring multiple phases
- parallel read-only gather with serial writes
- exploratory executor isolation from live workspace
- failed validation causing recovery rather than false completion
- subagent scoped context behavior
- long-running task monitoring and verification

#### Online
- real provider runs with:
  - parallel read-only gathers
  - recovery after failed tests
  - strategy synthesis then successful patch
- verify Anthropic multiple tool-result return format and block continuity
- verify OpenAI `previous_response_id` reasoning continuity across tool loops

#### Benchmark
- first serious benchmark slice runs with the full orchestrator
- establish baseline full-run scores per model
- categorize failures into:
  - search failures
  - navigation failures
  - bad edits
  - validation failures
  - premature completion
  - command refusal / permission mismatch
  - provider formatting bugs

### What to watch out for

- context explosion from subagents
- duplicate investigation work
- over-parallelization causing noisy context
- recovery loops spinning without changing plan
- validation becoming too expensive or too weak

### Exit criteria

- orchestrator can solve multi-step fixture tasks on deterministic local scenarios
- validation materially reduces false positives on fixture and smoke runs
- benchmark slices show improvement over the thin slice on at least one provider without regressions severe enough to disable the feature
- failure taxonomy is usable for tuning

---

## Milestone 5 — Session management, compaction, resume, UX commands, and long-horizon stability

### What to build

#### Session UX
Implement the day-one command surface:

- `/new`
- `/clear`
- `/compact`
- `/checkpoint`
- `/resume`
- `/provider`
- `/model`
- `/effort`
- `/permissions`
- `/diff`
- `/undo`
- `/cost`
- `/tokens`
- `/timeline`
- `/jobs`
- `/agents`
- `/benchmark`

Chat UX should feel explicit rather than magical:

- every tool batch gets a short preamble
- after mutating work, the agent reports files changed, validators run, and whether more work remains
- long-running exploratory execution should be surfaced to the developer rather than launched invisibly

#### State management
- OpenAI:
  - ordinary chains use `previous_response_id`
  - durable resume uses Conversations where useful
- Anthropic:
  - local session snapshots
  - preserved thinking/tool blocks
  - summary + checkpoint layering
- every turn persists normalized events, tool IO, checkpoint references, and provider continuation handles so local resume works even if provider-native state is unavailable
- `/resume` rebuilds local session state first, then reattaches provider-native identifiers when available

#### Context management
- OpenAI:
  - native compaction (GPT-5.4 is trained to support compaction)
  - `previous_response_id` automatically preserves CoT and reasoning items, reducing redundant reasoning tokens and improving cache hit rates
  - token counting endpoint before risky large turns
  - local summaries layered on top of provider state
- Anthropic:
  - prompt caching with `cache_control: { type: "ephemeral" }` breakpoints on system prompts (preserved across compaction events) and compaction blocks
  - context editing (beta header `context-management-2025-06-27`):
    - `clear_tool_uses_20250919` to clear stale tool results when input tokens exceed threshold, keeping recent N tool use/result pairs
    - `clear_thinking_20251015` to manage thinking block accumulation, keeping last N assistant turns' thinking
  - server-side compaction (beta header `compact-2026-01-12`):
    - triggers when input tokens approach threshold (configurable, minimum 50K)
    - returns `compaction` block that replaces prior history
    - `pause_after_compaction` allows injecting additional context before continuing
  - preserve block integrity across tool use (thinking signatures must be passed back unchanged)
- Layered strategy: context editing is the primary approach (surgical removal of stale data), server-side compaction is the secondary approach (full summarization), and local Open-Apex checkpoints + summaries are the canonical source of truth. If provider context management degrades, rebuild from local state.
- Use provider-native context features aggressively when they improve long-horizon quality, but never let them become the only source of truth for a resumable session

#### Background execution
- background job orchestration for CLI use
- provider-side background mode where appropriate and supported for long-running OpenAI tasks
- keep benchmark mode foreground and fully observable

#### Timeline and usage views
- live event timeline
- token/cost ledgers
- command durations
- checkpoint history
- replay inspection commands

### Why now

The core agent should already work. Now it must become a durable CLI product that can survive long sessions, restarts, and large contexts without collapsing.

### Design choices

- Provider switch resets conversation state.
- Local state stays canonical.
- Cost/tokens are visible on demand, not forced into every normal chat turn.
- Benchmark mode remains more verbose than normal chat mode.
- `/undo` only guarantees rollback of workspace mutations captured by checkpoints; it does not promise reversal of arbitrary external side effects.

### What to test

#### Unit
- session serialization
- command routing
- compaction policy selection
- cost/token ledger math

#### Contract
- timeline event schema
- session snapshot schema
- resume manifest schema
- provider switch semantics

#### Integration
- resume after crash
- provider switch resets context but keeps repo edits
- manual compact then continue
- automatic compact on long tasks
- background jobs across session resume
- `/undo` after compact and resume

#### Online
- OpenAI conversation resume path
- OpenAI compaction path
- Anthropic caching path
- Anthropic long tool-use continuation path
- multimodal resume/session continuity smoke

#### Benchmark
- long-horizon TB2 slice
- repeated-turn slice
- ensure compaction/resume do not regress smoke subset

### What to watch out for

- compaction dropping critical instructions
- corrupting Anthropic thinking/tool blocks
- OpenAI `phase` metadata loss
- mismatch between local checkpoints and provider state
- background features leaking into benchmark mode

### Exit criteria

- long sessions remain stable on long-horizon fixture scenarios
- `/resume`, `/compact`, `/checkpoint`, `/timeline`, `/tokens`, and `/cost` work reliably
- compaction and resume do not materially degrade benchmark smoke
- provider switch semantics are deterministic and tested

---

## Milestone 6 — Harbor integration, benchmark-mode hardening, and trajectory completeness

### What to build

#### Installed-agent integration
- `BaseInstalledAgent` implementation
- environment install path for Bun/Open-Apex
- headless benchmark entrypoint
- clean CLI contract for Harbor invocation
- benchmark artifact bundle rooted at Harbor-collected artifact paths (e.g., `/logs/artifacts/` inside Harbor task environments)

#### Benchmark mode
- benchmark-safe config mode
- fixed leaderboard presets:
  - `tb2-gpt54`
  - `tb2-sonnet46`
  - `tb2-opus46`
- strict artifact paths
- deterministic logging layout
- explicit timeout / retry / artifact behavior via config

#### Trajectory and artifacts
- incremental ATIF writer
- replay log writer
- human-readable summary JSON
- benchmark metadata
- error classification
- partial artifact persistence on timeout/failure

#### Benchmark tooling
- local dataset manifests
- slice runner
- ablation runner
- comparison tooling against previous baselines
- regression dashboards from ATIF/replay data

### Why now

The agent already exists. This milestone makes it benchmark-native and debuggable inside Harbor, which is required for the target success metric.

### Design choices

- Installed-agent integration instead of external shim control
- Incremental artifact flush during execution
- Benchmark mode ignores automatic user/global and repo-specific prompt/config injection except versioned benchmark-safe overrides

### What to test

#### Unit
- benchmark preset loading
- artifact path resolution
- ATIF event mapping

#### Contract
- ATIF conformance
- replay log format
- benchmark summary schema

#### Integration
- install Open-Apex inside Harbor container
- run and collect artifacts
- timeout behavior with partial artifacts
- reward parsing and final result mapping
- benchmark mode config isolation

#### Online
- run Harbor with live provider keys on sample tasks
- verify all three presets emit valid trajectories
- verify installed-agent wrapper works across task environments

#### Benchmark
- repeated TB2 smoke and slice runs on all presets
- first full 89-task runs on all three presets
- variance tracking by preset
- regression comparisons against prior full milestone gate

### What to watch out for

- Bun installation issues inside containers
- path assumptions in different task environments
- missing artifact cleanup or overwriting
- timeout paths dropping logs
- benchmark mode accidentally using project-specific hints

### Exit criteria

- Harbor installed-agent runs are stable
- full ATIF + replay are always emitted
- all three leaderboard presets can run full TB2 end to end
- benchmark mode is demonstrably isolated from repo-local hidden hints

---

## Milestone 7 — Tuning, hardening, packaging, and release readiness

### What to build

#### Benchmark tuning loop
- failure taxonomy dashboards
- prompt appendix tuning per provider
- tool description tuning
- search trigger tuning
- validation threshold tuning
- compaction/caching tuning
- recovery prompt tuning
- checkpoint/retry heuristics

#### Hardening
- expanded secret redaction
- prompt injection guards
- hardened workspace boundary enforcement
- hardened command construction
- retry/backoff policy
- provider outage handling
- better malformed-action reporting

#### Packaging
- compile standalone CLI with Bun
- package benchmark-installed artifact path
- cross-platform smoke packaging where practical
- versioned config and migration support

#### Documentation
- user docs
- benchmark docs
- config docs
- troubleshooting docs
- telemetry interpretation docs

### Why now

This milestone converts a capable prototype into a strong benchmark entrant and practical CLI tool.

### Design choices

- Optimize only after telemetry and regression foundations exist.
- Favor improvements that help both product use and benchmark performance.
- Avoid benchmark-only hacks that reduce generality unless they are exposed as clearly isolated presets.

### What to test

#### Unit
- secret redaction
- prompt injection filters
- retry policy

#### Contract
- config migration compatibility
- CLI output schemas used by docs or wrappers

#### Integration
- packaging/install smoke
- failure recovery after provider/network interruptions
- replay inspection on intentionally broken runs
- secret redaction in logs and ATIF

#### Online
- real provider degradation tests where possible
- high-token long-horizon runs
- search failure fallback runs
- packaging + live run smoke on compiled artifact

#### Benchmark
- repeated full TB2 runs on all three presets
- compare to milestone 6 baselines
- confirm no regression in smoke or slices while tuning
- keep full replay artifacts for every tuning change that beats baseline

### What to watch out for

- benchmark overfitting
- silent regressions hidden by average score
- prompt drift across providers
- changing tool descriptions and unintentionally shifting model behavior
- packaging removing runtime assumptions needed in Harbor

### Exit criteria

- stable packaged CLI
- stable Harbor integration
- benchmark runs are repeatable and debuggable
- at least one full `terminal-bench@2.0` run reaches **70%+** on each of `tb2-gpt54`, `tb2-sonnet46`, and `tb2-opus46`
- remaining benchmark gaps are understood through artifact evidence, not guesswork

---

## 7. Regression suites that should exist from the start

These suites should be created early and grow with the project.

## 7.1 Local fixture repos

Create deterministic local repos representing recurring task patterns:

- Python app with failing tests
- Node/TypeScript app with lint/build/test failure
- mixed-language repo with confusing structure
- large-context / pseudo-monorepo fixture
- small ML repo with training script and slow job
- infra/scripts repo with shell-heavy tasks
- flaky-validator / retry-sensitive repo
- network-restricted repo
- docs/image/pdf repo for multimodal cases

Each fixture repo should support:
- reset to clean state
- seeded failure modes
- expected final outputs
- expected validation command(s)

## 7.2 Runtime regression scenarios

Examples:

- patch applies cleanly
- patch fails then model repairs
- full-file rewrite fallback works
- checkpoint restore recovers bad edit
- background job log read works
- catastrophic command blocked
- permission escalation denied/handled
- developer chat golden path: inspect repo -> edit -> validate -> undo -> resume -> provider switch
- provider switch resets context only
- compact then continue
- resume after interruption
- search returns noisy results and model still continues

## 7.3 Provider live canaries

Maintain a stable live canary suite across all supported models that checks:

- tool call generation
- tool result continuation
- usage reporting
- streaming assembly
- long-context continuity
- file/image/PDF support
- search result formatting path
- compaction or caching hooks

## 7.4 Benchmark slices

Maintain curated TB2 slices aligned with the benchmark's actual task categories:

- software engineering (largest TB2 category)
- ML/training and long-running jobs
- security tasks
- data science / data processing
- system administration
- debugging
- scientific computing
- video processing
- search-heavy/framework-uncertainty tasks (cross-cutting)
- environment discovery tasks (cross-cutting)
- permission-sensitive tasks (cross-cutting)

## 7.5 Artifact regression

Validate that every run still emits:

- ATIF
- replay log
- summary JSON
- cost/tokens ledger
- checkpoint metadata
- error classification
- final status

---

## 8. Metrics to track throughout the build

Do not rely on success rate alone. Track:

### Runtime quality
- patch application success rate
- malformed tool call rate
- command classifier false positive / false negative rate
- checkpoint restore success rate
- job cleanup success rate

### Agent behavior
- average tools per task
- average read-only parallel fan-out
- search trigger frequency
- search usefulness rate
- strategy-planner usage rate
- strategy-planner recommendation adoption rate
- validation-before-finish rate
- recovery-loop success rate
- premature completion rate
- exploratory execution usage rate

### Provider behavior
- streaming parse failures
- continuation failures after tool use
- compaction frequency
- caching effectiveness proxies
- token count deltas before/after compaction
- phase/metadata preservation errors
- live canary pass rate by capability

### Benchmark behavior
- success rate by model
- success rate by task category
- score deltas between slices and full runs
- variance across repeated runs
- failure taxonomy counts
- benchmark-clean run pass rate
- artifact completeness rate

### Product behavior
- interactive responsiveness
- session resume success rate
- background job reliability
- multimodal task success on local fixtures
- CLI contract compatibility across chat and autonomous modes

For chat mode, the highest-value product-trust signals are responsiveness, undo trust, resume reliability, and validation transparency after mutations.

These metrics should be visible in local reports and benchmark summaries.

Release-significant thresholds should be tracked explicitly:

- `artifact_completeness_rate = 100%`
- `validation_before_finish_rate = 100%` in autonomous/benchmark mode
- `checkpoint_restore_success_rate >= 99%`
- `job_cleanup_success_rate >= 98%`
- `premature_completion_rate < 2%` on smoke + slices
- `benchmark_clean_run_pass_rate = 100%`

---

## 9. Risks and failure modes to plan for

### 9.1 Provider drift
Low-level API behavior can evolve. Provider adapter tests must be live and continuous, and benchmark presets should be pinned and re-validated whenever model aliases or beta headers change.

### 9.2 Search over-triggering
Search can slow the loop and inject noisy context. Keep trigger policy explicit, measurable, and justified by A/B data rather than instinct.

### 9.3 Compaction damage
Compaction can silently remove task-critical state. Always keep local summaries and checkpoints.

### 9.4 Anthropic block corruption
Incorrect preservation of thinking/tool blocks can degrade Claude behavior in subtle ways.

### 9.5 OpenAI phase misuse
If commentary/final-answer state is mishandled, follow-up turns may degrade.

### 9.6 Patch unreliability
Patch bugs will cascade into benchmark failures and poor developer trust.

### 9.7 Overfitting to Terminal-Bench
The agent should remain a good CLI tool, not just a benchmark specialist. Benchmark presets may be specialized, but the runtime should remain general.

### 9.8 Hidden regressions from tuning
Prompt or tool-description tuning can cause regressions outside the tested slice. Always rerun smoke + slices + representative full runs.

### 9.9 Checkpoint or sandbox drift
If checkpoint restore or exploratory sandboxes are even slightly incorrect, the agent can synthesize from misleading evidence or fail to undo mutations reliably.

### 9.10 Chat trust erosion
If chat mode hides long-running exploratory work, misreports validation state, or makes undo/resume feel unreliable, developer confidence will collapse even if benchmark scores improve.

---

## 10. Release criteria for v1

Open-Apex v1 should not be considered ready until all of the following are true:

- Chat mode is usable for real repo work and passes developer golden-path scenarios (inspect, edit, validate, undo, resume, provider switch).
- Autonomous mode is stable and fully observable.
- All three target provider/model presets run end to end.
- Harbor installed-agent integration is stable.
- ATIF + replay are emitted on every autonomous run.
- Checkpoints, undo, permissions, and catastrophic-command blocking work.
- Search is selective and has fallback behavior.
- Multimodal file/image/PDF input works in practice.
- Regression suites cover runtime, provider, and benchmark surfaces.
- Full TB2 runs are repeatable enough to trust score movement.
- The benchmark harness can produce at least one **70%+ full-run result** on each of `tb2-gpt54`, `tb2-sonnet46`, and `tb2-opus46`, with repeated full runs sufficient to trust the result rather than treating it as a one-off spike.
- Preset quality is trusted only after repeated full runs; a good default standard is 3 full runs per preset with no artifact/schema regressions.
- Release-significant quality metrics meet their thresholds: artifact completeness remains 100%, validation-before-finish remains 100% in autonomous/benchmark mode, checkpoint restore success remains very high, and premature completion remains rare.

---

## 11. Future enhancements and upgrades

These should not block v1, but the architecture should leave room for them.

### 11.1 Code intelligence upgrades
- LSP integration
- richer symbol graph
- dependency graph
- test-to-file mapping
- semantic code navigation

### 11.2 Execution upgrades
- worktree-based alternate plan search
- disposable branch testing
- safer destructive-operation sandboxes
- richer process supervision

### 11.3 Intelligence upgrades
- learned search triggers
- learned query optimization
- task-category-specific planners
- failure-memory retrieval from past trajectories

### 11.4 Benchmark upgrades for TB3
- stronger verifier planning
- more robust long-horizon context strategies
- broader multimodal understanding
- task-adaptive validation plans
- smarter alternative-plan search and rollback

### 11.5 Product upgrades
- richer status line
- better diff UI
- richer plugin/tool extension system
- optional remote execution backends

---

## 12. Reference documentation

### Apex2
- Apex2 README (project source document used to derive the rebuild direction)

### OpenAI
- Responses API migration guide  
  https://developers.openai.com/api/docs/guides/migrate-to-responses/
- Conversation state  
  https://developers.openai.com/api/docs/guides/conversation-state/
- Phase parameter  
  https://developers.openai.com/api/docs/guides/prompt-guidance#phase-parameter
- GPT-5.4 model guide  
  https://developers.openai.com/api/docs/guides/latest-model/
- GPT-5.4 model page  
  https://developers.openai.com/api/docs/models/gpt-5.4
- Function calling  
  https://developers.openai.com/api/docs/guides/function-calling/
- Reasoning models  
  https://developers.openai.com/api/docs/guides/reasoning/
- Streaming responses  
  https://developers.openai.com/api/docs/guides/streaming-responses/
- WebSocket mode  
  https://developers.openai.com/api/docs/guides/websocket-mode/
- Token counting  
  https://developers.openai.com/api/docs/guides/token-counting/
- Input token count endpoint  
  https://developers.openai.com/api/reference/resources/responses/subresources/input_tokens/methods/count/
- Prompt caching  
  https://developers.openai.com/api/docs/guides/prompt-caching/
- Background mode  
  https://developers.openai.com/api/docs/guides/background/
- Tool search  
  https://developers.openai.com/api/docs/guides/tools-tool-search
- Compaction  
  https://developers.openai.com/api/docs/guides/compaction
- Reasoning best practices  
  https://developers.openai.com/api/docs/guides/reasoning-best-practices
- GPT-5.4 prompt guidance  
  https://developers.openai.com/api/docs/guides/prompt-guidance
- Allowed tools / tool_choice  
  https://developers.openai.com/api/docs/guides/function-calling/

### Anthropic
- Claude API docs  
  https://docs.anthropic.com/
- Tool use  
  https://docs.anthropic.com/en/docs/build-with-claude/tool-use
- Define tools / tool descriptions  
  https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/implement-tool-use
- Extended thinking  
  https://docs.anthropic.com/en/docs/build-with-claude/extended-thinking
- Adaptive thinking  
  https://docs.anthropic.com/en/docs/build-with-claude/adaptive-thinking
- Prompt caching  
  https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching
- Context editing  
  https://docs.anthropic.com/en/docs/build-with-claude/context-editing
- Compaction  
  https://docs.anthropic.com/en/docs/build-with-claude/compaction
- Search result blocks  
  https://docs.anthropic.com/en/docs/build-with-claude/search-results
- Streaming messages  
  https://docs.anthropic.com/en/api/messages-streaming
- Models overview  
  https://docs.anthropic.com/en/docs/about-claude/models
- API release notes  
  https://docs.anthropic.com/en/release-notes/api
- Effort parameter  
  https://docs.anthropic.com/en/docs/build-with-claude/effort
- Claude Opus 4.6 release  
  https://www.anthropic.com/news/claude-opus-4-6
- Claude Sonnet 4.6 / what's new in Claude 4.6  
  https://platform.claude.com/docs/en/about-claude/models/whats-new-claude-4-6
- Context windows  
  https://docs.anthropic.com/en/docs/build-with-claude/context-windows
- Effective context engineering  
  https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents

### Harbor / Terminal-Bench
- Harbor agents  
  https://harborframework.com/docs/agents
- Harbor ATIF  
  https://harborframework.com/docs/agents/trajectory-format
- Harbor datasets  
  https://harborframework.com/docs/datasets
- Harbor task structure  
  https://harborframework.com/docs/tasks
- Harbor differences from Terminal-Bench  
  https://harborframework.com/docs/tasks/task-difference
- Harbor Terminal-Bench tutorial  
  https://harborframework.com/docs/tutorials/running-terminal-bench
- Harbor registry  
  https://harborframework.com/registry
- Harbor installed agents  
  https://harborframework.com/docs/agents#installed-agents
- ATIF RFC specification  
  https://github.com/laude-institute/harbor/blob/main/docs/rfcs/0001-trajectory-format.md
- ATIF golden examples  
  https://github.com/laude-institute/harbor/tree/main/tests/golden
- ATIF Pydantic models  
  https://github.com/laude-institute/harbor/tree/main/src/harbor/models/trajectories
- Trajectory validator  
  https://github.com/laude-institute/harbor/blob/main/src/harbor/utils/trajectory_validator.py
- Terminal-Bench v2 paper  
  https://arxiv.org/html/2601.11868v1
- Terminal-Bench v2 GitHub  
  https://github.com/harbor-framework/terminal-bench-2
- Terminal-Bench v2 experiment configs  
  https://github.com/laude-institute/terminal-bench-experiments/tree/main/configs/tb2

### Search APIs
- Serper.dev (primary SERP provider)  
  https://serper.dev/
- SerpAPI (fallback SERP provider)  
  https://serpapi.com/

### Tree-sitter
- web-tree-sitter (WASM bindings for JS/TS)  
  https://www.npmjs.com/package/web-tree-sitter
- tree-sitter-typescript grammar  
  https://www.npmjs.com/package/tree-sitter-typescript
- node-tree-sitter  
  https://github.com/tree-sitter/node-tree-sitter

### Error handling and rate limits
- OpenAI rate limits  
  https://developers.openai.com/api/docs/guides/rate-limits
- Anthropic API errors  
  https://docs.anthropic.com/en/api/errors
- OpenAI error mitigation (exponential backoff)  
  https://developers.openai.com/cookbook/examples/how_to_handle_rate_limits

### Checkpoint patterns
- Kilo Code checkpoints (shadow git)  
  https://kilocode.ai/docs/features/checkpoints
- Claude Code file checkpointing  
  https://platform.claude.com/docs/en/agent-sdk/file-checkpointing
- Claude Code /rewind guide  
  https://claudelab.net/en/articles/claude-code/claude-code-rewind-checkpoint-guide

### Factory / Droid
- CLI reference  
  https://docs.factory.ai/reference/cli-reference
- Auto-run mode  
  https://docs.factory.ai/cli/user-guides/auto-run
- Droid exec overview  
  https://docs.factory.ai/cli/droid-exec/overview
- Security overview  
  https://docs.factory.ai/cli/account/security

### Bun
- Bun docs  
  https://bun.sh/docs
- Bun runtime  
  https://bun.sh/docs/runtime
- Bun TypeScript runtime  
  https://bun.sh/docs/runtime/typescript
- Bun bundler  
  https://bun.sh/docs/bundler
- Standalone executables  
  https://bun.sh/docs/bundler/executables

---

## 13. Final build principle

Open-Apex should win by being **disciplined**, not flashy.

The core lesson from Apex2 still holds: intelligence gathering and synthesis matter. The missing piece is runtime engineering. The build plan above is designed to add that missing runtime layer without losing the architectural advantages that made Apex2 strong in the first place.
