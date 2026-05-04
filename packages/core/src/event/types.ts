/**
 * Structured chat-mode TUI events and replay-log entries.
 * Locked per §3.4.5 StructuredEvent + §5.5 observability requirements.
 *
 * This file defines the user-facing (chat TUI + replay.md) event schema.
 * The normalized RunEvent (§3.4.11) is distinct and lives in runtime/types.ts
 * — it is the orchestrator observer surface. This file is the persistence /
 * rendering surface.
 */

import type { OpenApexEvent } from "../storage/telemetry.ts";
import type { RunEvent } from "../runtime/types.ts";

/** One line of the events.jsonl file. */
export type EventLogEntry = OpenApexEvent;

/**
 * Re-export the runtime RunEvent so consumers have a single import.
 * Kept as a named re-export so consumers that want the full observer union
 * can still use `import type { RunEvent }`.
 */
export type { RunEvent };
