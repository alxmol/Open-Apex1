# Open-Apex

**Terminal-native coding agent.** Chat + autonomous modes on one shared Bun/TypeScript runtime, targeting Terminal-Bench v2 leaderboard competition.

*Still under construction*

![Terminal Bench run screenshot](<./Screenshot 2026-05-03 at 11.14.20 PM.png>)

This README summarizes what is shipped in the repository today.

## Terminal Bench Runs

Latest tbench runs following M5

| Run | Success Rate |
| --- | ---: |
| Open-Apex-gpt54-1 | 78.4% |
| Open-Apex-gpt54-2 | 77.3% |
| Open-Apex-opus46-1 | 74.8% |

## Delivered

### Delivered in M5

- **Concrete session storage** (`@open-apex/runtime`): `JsonlSqliteSessionStore` writes canonical rollout JSONL under Open-Apex home and maintains a `bun:sqlite` thread index for resume pickers. Snapshots rebuild provider-neutral history, provider continuation handles, and compaction markers from JSONL.
- **Turn-runner persistence hooks**: `runAgenticTurns` can now persist `response_item`, `turn_context`, selected stream events, scheduler events, and runtime-injected recovery/search messages into a session store as the run advances. This gives M5 resume tooling a real local transcript instead of a memory-only chat history.
- **GPT context-management request wiring**: OpenAI Responses payloads now support request-level server compaction via `context_management`, durable `conversation` identifiers, explicit `store`, and chat-only `background` mode request fields. The SSE translator recognizes compaction output items as normalized `compaction_block` events.
- **M5 slash-command registry**: chat commands are registered through a UI-agnostic `CommandRegistry`, covering the day-one command surface (`/new`, `/clear`, `/compact`, `/checkpoint`, `/resume`, `/provider`, `/model`, `/effort`, `/permissions`, `/diff`, `/undo`, `/cost`, `/tokens`, `/timeline`, `/jobs`, `/agents`, `/benchmark`, `/help`). The current line-mode chat entrypoint routes slash commands through the same registry that the future Ink TUI will render.
- **Background job tools**: `run_job`, `list_jobs`, `read_job_log`, `wait_for_job`, and `kill_job` are backed by a process-local `JobManager` using `Bun.spawn`. Jobs survive chat conversation resets/provider switches within the same process and are not daemonized across CLI restarts.
- **M5 gate** (`bun run gate:m5`): adds local/test/build discipline checks plus targeted M5 tests and live-gated GPT continuation canaries. It explicitly skips Harbor/Terminal-Bench so benchmark execution remains a user-run step.

### Delivered in M4

- **New M4 phase engine** (`@open-apex/runtime`): autonomous mode now runs through a real phased harness instead of the earlier flat `runAgenticTurns` path. The engine predicts task metadata, gathers structured observations, synthesizes an `ExecutionContext`, executes with the existing provider/tool loop, validates, and enters bounded recovery on task failures. `runAgenticTurns` remains the execute-phase primitive so provider continuation, tool scheduling, patch recovery, search advisories, file-state tracking, and telemetry behavior stay compatible with M1-M3.
- **Structured synthesis layer**: `packages/core/src/prompts/synthesis.md` defines the synthesis prompt, and `packages/core/src/orchestration/schema.ts` ships the `ExecutionContext` JSON Schema plus runtime normalization. OpenAI Responses uses native `text.format: { type: "json_schema" }`; Anthropic uses the existing strict tool-call path (`emit_execution_context`) so both providers produce typed execution context before live workspace mutation. Schema failure retries once, then emits a degraded mechanical context rather than silently dropping synthesis.
- **Gather-role outputs**: the phase engine emits typed `SubagentResult`-compatible observations for `repo_scout`, `environment_scout`, `web_researcher`, `strategy_planner`, and `exploratory_executor`. Repo/environment roles consume M3 libraries directly (`buildRepoMap`, `detectStack`, `symbolIndexStats`, `probeEnvironment`); web research consumes the configured `web_search` tool path so benchmark contamination filtering and provider rendering stay centralized.
- **Exploratory executor consumption of M2 sandbox/checkpoint substrate**: M4 now records a `pre_exploratory_executor` checkpoint when a checkpoint store is available, creates a temporary exploratory copy under Open-Apex home, runs discovered validators there with a short timeout, records attempted commands/outcomes, reports the detected sandbox backend (`landlock` / `seatbelt` / `soft`), and tears down the exploratory workspace before synthesis.
- **Validation and recovery routing**: validation is owned by the phase engine via the existing §7.6.2 discoverer, validator runner, and completion router. Failures enter a bounded local-fix recovery loop with validator evidence included in the recovery prompt; success still requires real validator evidence and weak/minimal validators continue to route to `validation_unknown`.
- **Mid-execution re-exploration**: when enabled, the first execute pass runs up to turn **20** before scoped re-exploration. The re-exploration path gathers updated `web_researcher` + `strategy_planner` observations and refreshes execution context before continuing with the remaining turn budget.
- **M4 verification gate** (`bun run gate:m4`): adds a milestone runner that checks the local suite/build discipline, phase-engine coverage, OpenAI structured-output request shaping, and explicitly skips Harbor/Terminal-Bench as user-gated entries. The gate writes `gates/M4/gate-result-M4.json`.

### Delivered in M3

- **New `@open-apex/search` package**: `SearchProvider` interface with `SerperProvider` (Serper.dev primary; `POST https://google.serper.dev/search`) and `SerpApiProvider` (SerpAPI fallback + `google_ai_overview` deferred-token redemption when the first response returns a `page_token`). Normalizer folds organic results + `answerBox` + `knowledgeGraph` + `peopleAlsoAsk` + `relatedSearches` + AI Overview into a typed `SearchBundle` with per-result `rankScore` + `sourceTier` (`official_docs` / `source_repo` / `so` / `blog` / `other`). `runWebResearch` implements the §1.2 multi-round policy (r1=4 / r2=3 / r3=2 fetch budget with pivots via `peopleAlsoAsk` and `relatedQueries`; short-circuits on official-docs / answer-box hits). Per-run `InMemorySearchCache` always-on; opt-in `PersistentSearchCache` (config-gated, never used in benchmark mode). Lightweight `fetchAndExtract` HTML→text via `node-html-parser` (strips scripts/styles/nav, keeps `<main>`/`<article>`, 8 KB excerpt cap). Selective `decideSearchTrigger` signals (explicit verbs, framework uncertainty, repeated-same-signature stderr via `similarity`). **53 tests green.**
- **New `@open-apex/indexer` package**: `buildRepoMap` (gitignore-aware walk, default excludes, 50 000-file / 500 MiB caps, `truncated` sentinel). `detectStack` recognises pytest / jest / vitest / cypress / cargo / go-test / rspec, plus npm / pnpm / yarn / bun / pip / poetry / uv / pipenv / cargo / go-modules / bundler / maven / gradle / make / cmake / ninja / tsc. `detectLanguage` covers Python, TypeScript (+ tsx), JavaScript, Rust, Go, Bash, C, C++, Ruby, Java, OCaml, plus Makefile/Dockerfile by filename and shebang fallback. Tree-sitter backed `SymbolIndex` via `web-tree-sitter` + `tree-sitter-wasms` (resolved through `Bun.resolveSync`, no copy step needed) with `Parser.init()` memoised and per-grammar `Language.load(...)` cached. Per-language `SYMBOL_QUERIES` capture functions/classes/methods/traits/structs/interfaces/types/enums/modules; every `Tree` and `Query` released with `.delete()` in `try/finally`. Incremental re-index via mtime+size cache. `symbolIndexStats` returns `SymbolIndexStats` matching §3.4.4. `probeEnvironment` captures installed packages via `npm ls --json` / `pip list -f json` / `cargo metadata`, plus `df -h`, `free -h` / `vm_stat`, top-CPU processes, and container context (`/proc/1/cgroup`, `/.dockerenv`, `$KUBERNETES_SERVICE_HOST`). **38 tests green.**
- **§M3 prediction phase** (`@open-apex/core` `predict`): regex+keyword category classifier covering all 17 `TaskCategory` values (weighted against the §7.6.5 TB2 inventory). Key-file extractor pulls verbatim paths from the instruction. Multimodal-need detector flags `.png|.jpeg|.pdf|.webp|.gif` references + phrases like "this image" / "the PDF". Risk-profile tagger flags `high` on destructive verbs against prod / main branch / `rm -rf ~|/|$HOME`, `medium` on `sudo` / global installs / systemctl / `docker prune` / `git push` / migrations. Language + framework hints merge instruction mentions with the repo-map language histogram. **24 fixture-backed tests green.**
- **Five new tools** registered via `registerBuiltinTools(registry, { webSearch, repoMap, symbolIndex, readAsset })`:
  - `web_search` (`READ_ONLY_NETWORK`) — delegates to `@open-apex/search.runSearch`; emits `SearchResultContent` parts plus auxiliary `answerBox` / `aiOverview` / `knowledgeGraph` text. Benchmark mode strips blocklisted results before they reach the model.
  - `fetch_url` (`READ_ONLY_NETWORK` for allow-listed domains, `MUTATING` otherwise) — mirrors §7.6.1 `classifyNetworkInvocation`; HEAD + GET supported; extraction-on-read with 8 KB cap.
  - `symbol_lookup` (`READ_ONLY`) — lazy per-workspace `SymbolIndex`, substring + case-insensitive matches with `exact` / `kind` / `language` / `limit` filters, exact matches score 1.
  - `repo_map` (`READ_ONLY`) — capped JSON summary + human-readable rendering.
  - `read_asset` (`READ_ONLY`) — loads PNG / JPEG / GIF / WEBP / PDF as provider-native multimodal content with a 10 MiB per-asset cap plus a 4-asset / 20 MiB per-turn runtime budget.
- **Provider-native multimodal I/O**:
  - Anthropic: `document` blocks for base64 PDFs (`media_type: "application/pdf"`), `image` blocks for base64 PNG / JPEG / GIF / WEBP, native `search_result` blocks with `source` / `title` / `content[]` / `citations: { enabled: true }` (aligned with current Messages API — the prior `{ url, content: string }` shape returned HTTP 400).
  - OpenAI Responses: `input_image` accepts base64 via `data:<media>;base64,<data>` URL; `input_file` supports `file_data` + `filename` for inline PDFs plus the existing `file_id` / `file_url` paths; `search_result` content parts render as fenced `<search_result source=… title=… tier=… provider=… rank=…>` blocks so the model can cite without losing provenance.
- **§7.6.4 contamination blocklist v1** ships as `packages/config/contamination-blocklist.v1.json`: 6 denied domains, 7 denied URL substrings, 5 denied title substrings, 3 denied snippet substrings, and all **89 TB2 task ids** gated by word-boundary regex so `build-pmars` doesn't false-positive on arbitrary substrings. Unconditional in benchmark mode; preset/config-configurable outside benchmark.
- **Environment-context enrichment** (§7.6.11 pos 7.i): `renderEnvironmentContext` now appends a `repo_map` section (total files, bytes, top 6 language counts, detected test frameworks / build systems / package managers) and a `prediction` section (category, risk profile, multimodal flag, likely languages / frameworks, key files) when the runtime supplies them. For external-doc-heavy predictions (MTEB / Hugging Face / Stan / Caffe / QEMU / migration tasks, plus protein/API data assembly), it adds terse `search_advice` + targeted official-source/API query hints so the model reaches for `web_search` early without Open-Apex auto-running search. Autonomous CLI runs the cheap repo-map + prediction pre-turn and feeds both into the first user message.
- **Four preset revisions bumped to `r2`** (`tb2-gpt54`, `tb2-sonnet46`, `tb2-opus46`, `tb2-opus47`) with the new `enabled.{prediction,repoMap,symbolIndex,envProbe,webSearch,readAsset,contaminationBlocklist}` flags wired into `registerBuiltinTools`. Preset schema validator extended to match.
- **Prompt v2** (`base-instructions.v2.md`): adds explicit `symbol_lookup` / `repo_map` / `read_asset` / `web_search` / `fetch_url` guidance, selective-search policy, narrow/diverse search discipline, parallelise-read-only-tool-calls directive, and a "`sourceTier` priority" rule. Provider appendices keep the live tool manifest authoritative; the GPT-5.4 appendix no longer carries a stale M1-only tool list, and Opus guidance now pushes official-source, non-duplicative searches. Benchmark mode also emits a one-shot soft advisory if a run starts looping on broad/repeated `web_search` / `fetch_url` calls; it warns the model to pivot, but never blocks the tools. The advisory and scheduler `permission_decision` events are persisted in `events.jsonl` for TB forensics.
- **Two new fixtures** (`docs-image-pdf` with a generated 32×32 RGB PNG + minimal 1-page PDF carrying the `OPEN-APEX-CANARY-2026-04-24` sentinel for multimodal canaries; `mixed-monorepo` with Python + TypeScript + Rust + Go modules that feed a dedicated indexer integration test). Registered in `FIXTURES`; `resetAllFixtures()` green across all five M0/M2/M3 fixtures.
- **Five new live canaries** (budgeted under the existing `CANARY_BUDGET_USD`):
  - `openai-multimodal-image-pdf` — PDF + PNG via `input_file` + `input_image`, asserts GPT-5.4 echoes the sentinel.
  - `anthropic-multimodal-image-pdf` — same fixture via `document` + `image`, asserts Opus 4.6 echoes the sentinel.
  - `anthropic-search-result-block` — synthetic `search_result` block; asserts the model cites the source URL verbatim.
  - `search-serper-live` — real Serper.dev query; asserts non-empty `organic` + at least one `official_docs` tier hit.
  - `search-serpapi-ai-overview` — real SerpAPI query; asserts either inline `ai_overview` or deferred `page_token` redemption returns text.
- **M3 milestone gate** (`bun run gate:m3`): 17/19 pass (14 offline checks across search / indexer / prediction / env-context / new tools / provider multimodal / integration / blocklist / fixtures / preset revisions, plus the 3 live canary batches when `RUN_LIVE=1`), with TB2 A/B search-heavy + smoke-6 documented as the two skipped entries.

### Delivered in M2

- **Full §7.6.1 five-tier permission classifier**: `READ_ONLY` / `REVERSIBLE` / `MUTATING` / `DESTRUCTIVE` / `CATASTROPHIC`, plus `READ_ONLY_NETWORK` and `UNKNOWN`. ~40-command rule table with packed-short-flag detection (`rm -fdx` matches `-f`/`-d`/`-x`) plus benchmark infrastructure coverage for QEMU (`qemu-system-*`, `qemu-img`, etc.), SSH inspection, socket helpers (`socat`, `nc`, `telnet`, `websockify`), VNC screenshots, tmux/strace/podman VM-debug helpers, system inspection (`arch`, `compgen`, `ss`, `netstat`, `nproc`), nginx checks/reloads, partition/image helpers (`fdisk`, `sfdisk`, `gdisk`, `parted`, `mount`, `umount`), mtools, process cleanup (`pkill`, `killall`), and archive/ISO inspection (`bsdtar`, `7z`, `xorriso`). Composition law handles shell-wrapper unwrap, grouped fallback commands, sudo elevation (+1 tier, capped below `CATASTROPHIC`), process-wrapper stripping (`timeout`/`nice`/`nohup`/`stdbuf`/`xargs`), pipeline-to-interpreter elevation (pipe to `sh`/`python`/`bash`/`tee` → `DESTRUCTIVE` minimum), heredoc/substitution opacity. Network analyzer classifies `curl`/`wget`/`httpie` by HTTP method × domain allowlist. 5×5 autonomy gate maps tier + autonomy level → `auto` / `prompt` / `sandbox` / `reject`.
- **Scheduler classifier gate**: shell-kind tools now flow `validate_args → classify → gate_approval → dispatch`. Default `full_auto` auto-allows known tiers below `CATASTROPHIC`; `UNKNOWN` sandbox-runs only when a sandbox consumer is available and otherwise prompts/denies in noninteractive mode. Optional `canUseTool` callback for chat-mode confirmation cards; structured `permission_denied` result on reject. Telemetry emits `tool_called` → `permission_decision` → `tool_output` even on deny (no more "tool: (unknown)" in forensics). Generated local executables under the workspace or `/tmp` classify as `MUTATING`, which lets benchmark/dev build workflows run compiled artifacts without broadly allowing unknown binaries.
- **Runtime-mediated `apply_patch` recovery** (§1.2): on context-mismatch / hunk-offset-exhausted / binary-file / path-missing, the runtime injects a synthetic `read_file` result with ±10 lines of fresh on-disk content for the failed path, opens exactly one hidden recovery `write_file` overwrite for that specific path on the next turn, and tracks a 3-attempt ledger with `patch_apply_failed` on exhaustion. `patch_recovery_read_injected` + `patch_apply_failed` events emitted.
- **Three new tools**: `delete_file` (`DESTRUCTIVE`), `move_file` (`REVERSIBLE`), `shell_command` (shell-wrapped single-string command, classified identically to `run_shell`). `run_shell` refactored to expose a shared `executeShell` primitive. `BUILTIN_TOOL_NAMES` widened to 12.
- **File-state map** (mtime/size cache attached to run context): `read_file` records on every successful read; `search_replace` / `apply_patch` / `delete_file` / `move_file` return `file_stale_read` with recorded-vs-current mtime+size on drift and clear the map entry on successful write. Serialized to `file-state-<run_id>.json` at flush so M5's `/resume` can rehydrate.
- **Full §7.6.7 shadow-git manifest**: per-file tree with sha256 + mode + size + symlink targets + LFS placeholders; `empty_dirs`, `submodules`, `excluded_roots`; `statvfs` preflight emitting `checkpoints_disabled_low_disk` when free bytes < 256 MB; per-session `sessions/<session_id>.jsonl` log with user checkpoint names; `.gitattributes` LFS-pattern append to `.git/info/exclude`; restore does sha256 + extra-file verify against manifest with auto-rollback to `pre_restore` on any mismatch.
- **Checkpoint-save hardened against Bun segfault**: 50 MB aggregate sha256 budget (`MANIFEST_MAX_TOTAL_BYTES`) → remaining files recorded as LFS-style placeholders with `hash_skipped_reason: "budget_exhausted"`. Optional child-process isolation via `OPEN_APEX_CHECKPOINT_ISOLATION=1` (auto-on in benchmark mode): `save()` runs in an isolated Bun child with recursion guarded by clearing the isolation flag, so SIGSEGV during the manifest walk returns a structured `ShadowGitError` instead of killing the parent agent run. Restore skips hash-verify for placeholder entries.
- **Shadow-git init single-write `.git/config`**: replaces 13 sequential `git config KEY VALUE` subprocess calls with one direct INI file write. Eliminates a class of startup stalls (TB2 smoke-6 Sonnet/hf-model-inference died here previously).
- **Harbor installed-agent packaging hardening**: installed-agent upload now includes the checkpoint save runner, and Harbor runtime env points `OPEN_APEX_SAVE_RUNNER_PATH` at the installed copy. This keeps child-process checkpoint isolation working inside task containers instead of depending on source-tree-relative paths.
- **Sandbox scaffolding** (no live consumer at M2; M4 exploratory-executor subagent consumes): Landlock probe via `--probe` flag on the Rust helper, Seatbelt detection on macOS, `createRestrictedRunShell` factory with §M2 block-list (sudo / chroot / env overrides of `GIT_DIR`/`GIT_WORK_TREE`/`HOME` / `cd` outside worktree / redirect outside worktree / absolute paths outside worktree, with `/usr`/`/bin`/`/dev/null` allowlist). Backend detection cached per-process.
- **Recovery prompt library** (§7.6.3, M4 consumes): seven frozen literals (`syntax_error`, `import_error`, `path_not_found`, `permission_denied`, `patch_apply_failed`, `shell_timeout`, `test_failure`) with a placeholder-fill loader keyed on `ToolErrorType`.
- **New evals fixtures**: `recovery-malformed-patch` (exercises §1.2 recovery ladder with whitespace-trap source) and `catastrophic-command-blocker` (CANARY.txt + trap `cleanup.sh` proving §7.6.1 CATASTROPHIC deny). Both ship with `reset.sh` + `expected.json` + README.
- **Anthropic adapter hardening**:
  - sse-parser flushes any still-open `tool_use` / `text` / `thinking` blocks on `message_stop` — defensive against Anthropic omitting `content_block_stop` for empty-input tool calls (tb2-12 regression: opus/adaptive-rejection-sampler, sonnet/gcode-to-text, opus/gcode-to-text).
  - request-builder emits `thinking: {type:"disabled"}` whenever `tool_choice` forces tool use (`forceToolChoice: "required"` / caller `toolChoice.type === "required"` / `specific`) — Anthropic rejects extended thinking with forced tool use per their docs.
  - strict-tool tagging is capped at 20 tools per Anthropic's structured-output limit; excess representable tools are sent non-strict instead of risking a provider 400.
  - replayed `tool_use.input` values are normalized to plain objects before request build. Malformed model tool args still produce local structured `bad_args` errors, but they cannot poison the next Anthropic request with invalid assistant `tool_use.input`.
- **Validator discoverer hardening**:
  - `curl_pipe_interpreter` CATASTROPHIC regex narrowed: only matches bare `| python` or `| python -` at end-of-invocation. Safe idioms (`| python -m json.tool` / `| python -c CODE` / `| python - <<HEREDOC` / `| python script.py`) now pass.
  - LaTeX warning-grep validator: script is now shell-escaped as a single unit (previous hand-concat was quote-broken) and uses `grep -qiE` with a backslash-tolerant regex so it correctly matches TeX's actual `Overfull \hbox` output.
  - Weak-validator downgrade generalized from `test -s` only to also cover `[ -[sfde] PATH ]`, `python -m py_compile`, `python -c "import X"`, `node -e require`, `ruby -e require`. Pass-sets that are ALL weak downgrade to `validation_unknown` instead of false-positive `success`.
  - Python minimal-safe fallback sets `PYTHONPYCACHEPREFIX=.open-apex/pycache` so macOS/Xcode Python writes bytecode inside the workspace instead of failing on protected user cache paths.
- **M2 milestone gate** (`bun run gate:m2`): 13 offline checks (`bun test`, `tsc`, `lint`, `format:check`, classifier fixtures, scheduler gate, patch recovery, file-state map, shadow-git hash-verify, new tools registry, sandbox scaffolding, fixtures, recovery prompts) plus 3 user-gated skips (live canaries + TB2 harbor smoke).

---

**Milestone 1 — Thin vertical slice — complete (post-hardening).** M1 gate: all blocking checks green.

### Delivered in M1

- **Live provider adapters**: `OpenAiAdapter` (Responses API, `previous_response_id` threading, `phase` preservation) and `AnthropicAdapter` (Messages API, adapter-owned replay buffer, thinking-block signature round-trip, automatic prompt caching, context-editing + server-compaction beta headers).
- **Strict tool use on both providers**: per-provider schema lifters strip unsupported JSON Schema keywords and auto-downgrade per-tool when needed. Anthropic one-shot fallback on 400 "Schema is too complex for compilation".
- **SSE idle watchdog** on both adapters (120 s default): aborts silent streams with transient-503 for retry.
- **Retry layer** (§1.2): `DefaultRetryPolicy` with decorrelated jitter, full retryable/non-retryable classification, `Retry-After` header respect, OpenAI `No tool output found` known-failure reconstruction. Singleton `RateLimiter` + per-endpoint `CircuitBreaker`.
- **9 tools** with production hardening: `read_file` (256 KB content cap + truncation sentinel), `list_tree`, `search_text` (ripgrep), `run_shell` (argv form, 600 s server-side hard cap + 5 s reap deadline post-SIGKILL), `write_file`, `apply_patch` (unified-diff + reverse-patch + structured errors), `search_replace` (uniqueness + CRLF/BOM/binary edges), `checkpoint_save` (graceful degradation on shadow-git failure), `checkpoint_restore`.
- **Tool scheduler** (§3.4.13): parallel function-kind + serial editor/shell.
- **CATASTROPHIC classifier** (§7.6.1 regex block, 31 verbatim patterns).
- **Turn runner** (§3.4.11 + §3.4.13): full agentic loop, OpenAI `phase` + Anthropic thinking signatures preserved. Benchmark-mode 3-strike hallucinated-tool / prose-only recovery ladder (escalating nudges + forced `tool_choice: "required"` + `runtime_failure` on strike 3).
- **Full validator discovery ladder** (§7.6.2): six rungs with honest-completion downgrade for weak-only pass-sets.
- **System-prompt assembly** (§7.6.11 M1 subset): identity + base-instructions + per-preset provider appendix. `<environment_context>` turn-1 injection.
- **Structured provider-error surface**: `HttpError` literals propagate to `result.error` with `ProviderError` shape.
- **Incremental ATIF + startup-phase watchdog**: per-step trajectory flush, risky-phase `markPending(label)` breadcrumbs, 60 s `startup_stall` event.
- **Telemetry cost estimation**: per-model prices populate `result.usage.total_cost_usd` + `by_provider`.
- **Line-based chat REPL** (full Ink TUI lands in M5).
- **Live canary matrix** (§5.4): 19 canaries across plain/streaming/tool-round-trip/previous_response_id/phase/allowed_tools/effort/signature/cache/context-editing/compaction/multi-tool-result + production-tool-manifest regression guards.

---

**Milestone 0 — Foundation, repo scaffolding, build discipline — complete.** M0 gate: 12/12 checks pass (see [`gates/M0/gate-result-M0.json`](./gates/M0/gate-result-M0.json)).

### Delivered in M0

- **Locked contracts** (§3.4): `ProviderAdapter`, `StreamEvent`, `Orchestrator`/`Runner`, `SubagentResult` union (6 role payloads), storage contracts, ATIF v1.6 (TypeScript mirror of Harbor's Pydantic models, same-step `source_call_id` invariant enforced), `OpenApexResult`, tool contracts, error/exit taxonomy.
- **Preset registry** (§7.6.9): four presets shipped — `tb2-gpt54`, `tb2-sonnet46`, `tb2-opus46`, `tb2-opus47` — with JSON-schema validation + benchmark-safe override registry with forbidden-field checks (§1.2).
- **Telemetry**: secret redaction regex library (§3.5.4) covering OpenAI/Anthropic/AWS/GitHub/Stripe/JWT/Serper/Daytona/URI creds + generic `KEY=VALUE` fallback; incremental-flush `TelemetrySink` that writes pinned `logs/orchestrator.log`, `logs/provider.log`, `logs/tools/` subpaths (§3.4.10); ATIF writer with live Harbor `trajectory_validator` conformance.
- **Mock provider family** (M0 substrate for mock-vs-live test parity): `MockOpenAiAdapter` + `MockAnthropicAdapter` with scripted `StreamEvent` replay, capability-matrix overrides, scripted errors for retry-policy tests. M1 contract tests will reuse this verbatim.
- **CLI**: stable `open-apex [chat|autonomous|verify-gate]` contract (§3.3) with versioned artifact bundle layout (§3.4.10) + exit-status taxonomy (§3.4.9). Stdout emits exactly one machine-readable `OpenApexResult` per autonomous run.
- **Harbor integration** (§3.4.7): Python wrapper skeleton with real `install()` branching on `apk`/`apt-get`/`dnf`/`yum` + prebuilt-binary download from `github.com/alxmol/Open-Apex1`.
- **Sandbox** (§M2 layer 3): Landlock Rust helper skeleton (Linux-only; degrades silently on unsupported kernels).
- **Verification gate** (§0.6): live-probes every required §3.6 capability and beta header, treating both `unavailable` and `untested` as blockers. Latest artifact at [`packages/config/verification-gates/verified-as-of-2026-04-20.json`](./packages/config/verification-gates/) — 12 required capabilities available, both required beta headers HTTP 200.
- **Benchmark manifest structure** (§7.6.5): typed `TB2_TASK_INVENTORY` with all 89 TB2 tasks pinned to commit `69671fba…7a77c`, plus 21 slice manifests under [`packages/evals/slices/`](./packages/evals/slices/) (smoke-6, 16 category slices, long-running, hard-only, search-heavy, full-89). Loader cross-references every `task_id` into the inventory to prevent drift.
- **Fixtures + scenarios** (§7.6.6 / §M0): three seeded fixture repos (`py-failing-tests`, `node-lint-build-test`, `infra-shell-heavy`) with `reset.sh` + `expected.json`; developer-golden-path scenario running 7 assertions (reset → inspect → edit → validate via real pytest → undo → resume → provider switch) against `py-failing-tests` using mock providers.
- **Build discipline** (§5.2): ESLint 9 flat config + Prettier, both green and gated by the M0 gate; monorepo typecheck clean under `strict` + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`.

## Numbers

- **Local test suite**: `bun test` reports 1088 pass, 2 live-only skips, 0 fail, and 3130 `expect()` calls across 1090 tests in 85 files.
- **TB2 inventory**: 89 pinned tasks and 20 shipped slice manifests.
- **Presets**: 5 checked-in presets (`chat-gpt54`, `tb2-gpt54`, `tb2-sonnet46`, `tb2-opus46`, `tb2-opus47`).
- **Workspace packages**: 3 apps and 10 packages under the Bun workspace.

## Repo layout

```
open-apex/
├── apps/
│   ├── cli/                         open-apex CLI (chat + autonomous + verify-gate)
│   ├── harbor-installed-agent/      Python wrapper for Harbor installation
│   └── landlock-helper/             Rust kernel-sandbox helper
├── packages/
│   ├── core/                        Contracts, prompts, pricing, prediction, retry, storage types
│   ├── config/                      Config loading, presets, project docs, verification gates
│   ├── telemetry/                   ATIF writer, redaction, telemetry sink
│   ├── tools/                       Built-in tools, permission classifier, patch/checkpoint helpers
│   ├── runtime/                     Phase engine, turn runner, session store, validation/recovery
│   ├── provider-openai/             OpenAI Responses adapter, request builder, SSE parser
│   ├── provider-anthropic/          Anthropic Messages adapter, request builder, SSE parser
│   ├── search/                      Search providers, ranking, extraction, contamination filtering
│   ├── indexer/                     Repo map, stack/language detection, symbol index
│   └── evals/
│       ├── fixtures/                Seeded fixture repos with reset.sh + expected.json
│       ├── harbor-configs/          Harbor/TB2 run configs
│       ├── slices/                  TB2 benchmark manifests
│       └── src/
│           ├── canaries/            Live provider/search canaries
│           ├── fixtures/            Fixture registry
│           ├── milestone-gates/     M0-M5 gate runners
│           ├── scenarios/           Golden-path runner + scenario registry
│           ├── slices/              Inventory + loader + generator
│           └── index.ts             Evals package entrypoint
├── package.json
├── tsconfig.json
├── tsconfig.base.json
├── eslint.config.js
├── bunfig.toml
└── README.md
```

## Quick start

Requires Bun `1.3.12`, Python `≥3.11`, Git `≥2.42`, ripgrep `≥14`, Docker (for M6 Harbor runs), and API keys in `.env.local` (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `SERPER_API_KEY` — plus `SERPAPI_KEY` as fallback).

```bash
# Install workspace deps
bun install

# Run the local test suite (live adapter tests skip unless RUN_LIVE=1)
bun test

# Build-discipline checks (required on every PR per §5.2)
bun run lint
bun run format:check
bun x tsc -p tsconfig.json --noEmit

# Run live adapter tests (hits real provider APIs; requires RUN_LIVE=1 + keys)
bun run test:live

# Run the provider canary matrix (9 OpenAI + 10 Anthropic live canaries; ~$0.25 per run)
bun run canaries
bun run canaries:openai
bun run canaries:anthropic

# Run the pre-build verification gate (live probes; ~$0.08 per run)
bun run verify:gate

# Run a milestone gate (emits gates/M<n>/gate-result-M<n>.json)
bun run gate:m0
bun run gate:m1
bun run gate:m2
bun run gate:m3
bun run gate:m4
bun run gate:m5

# Regenerate TB2 slice manifests from TB2_TASK_INVENTORY (after a pinned-commit bump)
bun run packages/evals/scripts/generate-slices.ts

# Autonomous run (M4 phase engine: predict → gather → synthesize → execute
# → validate → recover, with benchmark-mode checkpoint child-process isolation
# auto-on).
bun run apps/cli/src/bin.ts autonomous \
  --workspace /path/to/workspace \
  --preset tb2-gpt54 \
  --output-dir /tmp/oa-out \
  --task-file /path/to/task.txt \
  --benchmark
```

## License

Apache-2.0.
