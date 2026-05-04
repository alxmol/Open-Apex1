/**
 * CLI help text.
 */

export const HELP_TEXT = `
open-apex — terminal-native coding agent

usage:
  open-apex [chat] [--workspace <path>] [--preset <id>]
  open-apex autonomous --workspace <path> (--task-file <path> | --task-stdin)
                       --preset <id> --output-dir <path>
                       [--benchmark] [--max-turns N]
                       [--trajectory-schema-version ATIF-v1.4|v1.5|v1.6]
  open-apex verify-gate
  open-apex --version | --help

subcommands:
  chat           Interactive REPL (M1 vertical slice, full TUI in M5).
  autonomous     Headless one-shot run. Emits a versioned artifact bundle
                 under --output-dir/<run_id>/ and prints one machine-readable
                 OpenApexResult JSON line on stdout.
  verify-gate    Run the §0.6 pre-build verification gate against live
                 provider/search/TB2 endpoints and write the frozen artifact
                 to packages/config/verification-gates/verified-as-of-<date>.json.

presets (shipped in M0):
  tb2-gpt54      OpenAI GPT-5.4 benchmark preset (r1, verified 2026-04-19)
  tb2-sonnet46   Claude Sonnet 4.6 benchmark preset (r1)
  tb2-opus46     Claude Opus 4.6 benchmark preset (r1)
  tb2-opus47     Claude Opus 4.7 benchmark preset (r1, SOTA at 81.8%)

exit codes (§3.4.9):
  0   success
  1   task_failure                    — validator ran, returned failure
  2   validation_unknown              — no confident validator found
  3   permission_refusal_unrecovered
  4   runtime_failure                 — provider/network/tool crash
  5   config_error                    — invalid preset / missing arg
  6   benchmark_contamination_detected
  7   timeout_approaching             — Harbor timeout within 60s; partial artifacts flushed
  130 cancelled_by_user               — SIGINT in chat mode

See open-apex-build-plan.md for the full specification.
`.trim();

export function helpForTopic(topic?: string): string {
  switch (topic) {
    case "autonomous":
      return `
open-apex autonomous — headless one-shot run

required flags:
  --workspace <path>      Project root to operate on.
  --preset <id>           One of: tb2-gpt54 | tb2-sonnet46 | tb2-opus46 | tb2-opus47
  --output-dir <path>     Where to write the <run_id>/ bundle.
  --task-file <path>
    or --task-stdin       Exactly one source for the task instruction.

optional flags:
  --benchmark             Force benchmark-clean mode: IGNORE user + project
                          config + OPEN_APEX.md (§7.6.10, §7.6.13 hard branch).
  --max-turns N           Hard ceiling on model calls (default per preset).
  --trajectory-schema-version ATIF-v1.4|v1.5|v1.6
                          Downgrade the emitted ATIF for older Harbor consumers.

artifact bundle layout (§3.4.10):
  <output-dir>/<run_id>/
    result.json       — OpenApexResult (this same JSON is also printed on stdout)
    summary.json      — human-oriented summary
    events.jsonl      — normalized event log (append-only, incrementally flushed)
    replay.md         — human-readable replay
    trajectory.json   — ATIF-v1.6 trajectory
    checkpoints/manifest/<sha>.json
    logs/orchestrator.log, logs/provider.log, logs/tools/<tool>/<call_id>.log
    subagents/<role>/<session_id>/trajectory.json
`.trim();
    case "chat":
      return `
open-apex chat — interactive REPL

Full TUI (Ink, streaming render, slash commands, destructive-op cards,
@file picker, first-run onboarding) lands in Milestone 5. M0 ships the
entrypoint + preset resolution only.
`.trim();
    case "verify-gate":
      return `
open-apex verify-gate — pre-build verification gate (§0.6)

Probes the environment and writes:
  packages/config/verification-gates/verified-as-of-<YYYY-MM-DD>.json

Probes include:
  - Model alias presence at OpenAI and Anthropic
  - External service reachability (Serper, SerpAPI, GitHub raw, npm, TB2)
  - Tooling versions (bun, node, git, python, ripgrep, harbor)
  - TB2 dataset commit pin

Exits 0 on no blockers, 1 on any blocker. Advisories are logged but
non-blocking.
`.trim();
    default:
      return HELP_TEXT;
  }
}
