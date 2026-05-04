/**
 * Session storage contracts.
 * Locked per §3.4.5.
 *
 * Storage format: JSONL rollout + SQLite thread index.
 *   $OPEN_APEX_HOME/sessions/YYYY/MM/DD/rollout-<unix-ms>-<uuid>.jsonl
 *     Line 1: { type: "session_meta", payload: {...} }
 *     Lines 2..N: response_item | turn_context | compacted | event_msg
 *   $OPEN_APEX_SQLITE_HOME/threads.db  (bun:sqlite, WAL mode, busy_timeout=5000ms)
 *
 * The JSONL is canonical; SQLite only indexes metadata for the resume picker.
 */

import type { HistoryItem } from "../provider/message.ts";
import type { ProviderContinuationHandle } from "../provider/adapter.ts";
import type { TokenUsage } from "../provider/stream.ts";

export interface SessionStore {
  openSession(opts: NewSessionOptions): Promise<SessionHandle>;
  appendRolloutItem(sessionId: string, item: RolloutItem): Promise<void>;
  snapshot(sessionId: string): Promise<SessionSnapshot>;
  loadSession(sessionId: string): Promise<SessionHandle>;
  listSessions(filter?: SessionFilter): Promise<SessionMetadata[]>;
  deleteSession(sessionId: string, opts: { purgeArtifacts: boolean }): Promise<void>;
}

export interface NewSessionOptions {
  workspace: string;
  presetId: string;
  agentName: string;
  /** Optional session id (otherwise generated). */
  sessionId?: string;
}

export interface SessionHandle {
  sessionId: string;
  workspace: string;
  presetId: string;
  agentName: string;
  rolloutPath: string;
  createdAt: string;
}

export interface SessionMeta {
  session_id: string;
  workspace: string;
  preset_id: string;
  preset_revision: string;
  agent_name: string;
  cli_version: string;
  schema_version: number;
  created_at: string;
}

export interface TurnContextMarker {
  turn: number;
  cwd: string;
  timestamp: string;
  /** Provider handle carried forward (e.g. `previous_response_id`). */
  providerHandle?: ProviderContinuationHandle;
}

export interface CompactionMarker {
  trigger: "manual" | "auto" | "server";
  preTokens: number;
  postTokens: number;
  /** For server-side compaction: range of replaced items. */
  replacedRange?: [number, number];
  /** Provider continuation produced by compaction, if any. */
  providerHandle?: ProviderContinuationHandle;
}

/** §3.4.5 StructuredEvent; typed tightly elsewhere but JSON-addressable. */
export interface StructuredEvent {
  type: string;
  ts: string;
  [k: string]: unknown;
}

export type RolloutItem =
  | { type: "session_meta"; payload: SessionMeta }
  | { type: "response_item"; payload: HistoryItem }
  | { type: "turn_context"; payload: TurnContextMarker }
  | { type: "compacted"; payload: CompactionMarker }
  | { type: "event_msg"; payload: StructuredEvent };

export interface SessionFilter {
  workspace?: string;
  presetId?: string;
  status?: "active" | "completed" | "crashed";
  /** ISO date cutoff. */
  updatedSince?: string;
  limit?: number;
}

export interface SessionMetadata {
  sessionId: string;
  workspace: string;
  presetId: string;
  agentName: string;
  status: "active" | "completed" | "crashed";
  createdAt: string;
  updatedAt: string;
  lastTurn: number;
  rolloutPath: string;
}

export interface SessionSnapshot {
  meta: SessionMeta;
  history: HistoryItem[];
  usage: TokenUsage;
  timeline: SessionTimelineSummary;
  lastProviderHandle?: ProviderContinuationHandle;
  lastCompactionMarker?: CompactionMarker;
}

export interface SessionTimelineSummary {
  historyItems: number;
  turns: number;
  events: number;
  toolCalls: number;
  toolOutputs: number;
  permissionDecisions: number;
  compactions: number;
  checkpoints: number;
  resumeEvents: number;
  divergenceEvents: number;
  providerHandles: number;
  lastEventAt?: string;
}

/**
 * File-state map — per-path cache of (mtime, size) used by search_replace
 * to detect stale reads (§1.2 "Concurrent shell-side mutation" + §3.4.5
 * "File-state map persistence").
 */
export interface FileStateEntry {
  path: string;
  mtime: number;
  size: number;
  sha256?: string;
}
