/**
 * Concrete M5 SessionStore.
 *
 * The JSONL rollout is the canonical transcript that can be replayed into a
 * provider after a crash or CLI restart. SQLite is only an index for fast
 * `/resume` pickers and metadata queries; if it is corrupt, the JSONL files
 * remain sufficient to recover sessions.
 */

import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import * as path from "node:path";

import { Database } from "bun:sqlite";

import type {
  CompactionMarker,
  NewSessionOptions,
  RolloutItem,
  SessionFilter,
  SessionHandle,
  SessionMeta,
  SessionMetadata,
  SessionSnapshot,
  SessionStore,
  TurnContextMarker,
  ProviderContinuationHandle,
} from "@open-apex/core";
import { addUsage, zeroUsage, type HistoryItem, type TokenUsage } from "@open-apex/core";

export interface JsonlSqliteSessionStoreOptions {
  sessionsDir: string;
  sqliteHome: string;
  cliVersion?: string;
  presetRevision?: string;
  now?: () => Date;
}

interface ActiveSession extends SessionHandle {
  lockPath: string;
}

interface SqlSessionRow {
  id: string;
  created_at: string;
  updated_at: string;
  last_agent: string;
  last_turn: number;
  workspace_path: string;
  preset_id: string;
  status: "active" | "completed" | "crashed";
  rollout_path: string;
}

export class JsonlSqliteSessionStore implements SessionStore {
  private readonly sessionsDir: string;
  private readonly sqlitePath: string;
  private readonly cliVersion: string;
  private readonly presetRevision: string;
  private readonly now: () => Date;
  private readonly db: Database;
  private readonly active = new Map<string, ActiveSession>();

  constructor(opts: JsonlSqliteSessionStoreOptions) {
    this.sessionsDir = opts.sessionsDir;
    this.sqlitePath = path.join(opts.sqliteHome, "threads.db");
    this.cliVersion = opts.cliVersion ?? "0.0.1";
    this.presetRevision = opts.presetRevision ?? "unknown";
    this.now = opts.now ?? (() => new Date());
    mkdirSync(this.sessionsDir, { recursive: true });
    mkdirSync(path.dirname(this.sqlitePath), { recursive: true });
    this.db = this.openDatabase();
    try {
      this.initSchema();
    } catch {
      this.db.close();
      this.resetSqliteFiles();
      this.db = this.openDatabase();
      this.initSchema();
    }
  }

  async openSession(opts: NewSessionOptions): Promise<SessionHandle> {
    const createdAt = this.now().toISOString();
    const sessionId = opts.sessionId ?? `s_${randomUUID()}`;
    const dayDir = sessionDayDir(this.sessionsDir, createdAt);
    await mkdir(dayDir, { recursive: true });
    const lockPath = path.join(dayDir, `.${sessionId}.lock`);
    acquireLock(lockPath);
    const rolloutPath = path.join(dayDir, `rollout-${Date.parse(createdAt)}-${sessionId}.jsonl`);
    const handle: ActiveSession = {
      sessionId,
      workspace: path.resolve(opts.workspace),
      presetId: opts.presetId,
      agentName: opts.agentName,
      rolloutPath,
      createdAt,
      lockPath,
    };
    this.active.set(sessionId, handle);
    const meta: SessionMeta = {
      session_id: sessionId,
      workspace: handle.workspace,
      preset_id: opts.presetId,
      preset_revision: this.presetRevision,
      agent_name: opts.agentName,
      cli_version: this.cliVersion,
      schema_version: 1,
      created_at: createdAt,
    };
    await writeFile(rolloutPath, serializeItem({ type: "session_meta", payload: meta }), "utf8");
    this.upsertSession(handle, "active", 0, createdAt);
    return stripLock(handle);
  }

  async appendRolloutItem(sessionId: string, item: RolloutItem): Promise<void> {
    const handle = await this.requireHandle(sessionId);
    await appendFile(handle.rolloutPath, serializeItem(item), "utf8");
    const lastTurn = item.type === "turn_context" ? item.payload.turn : undefined;
    this.upsertSession(handle, "active", lastTurn, this.now().toISOString());
  }

  async snapshot(sessionId: string): Promise<SessionSnapshot> {
    const handle = await this.requireHandle(sessionId);
    return readSnapshot(handle.rolloutPath);
  }

  async loadSession(sessionId: string): Promise<SessionHandle> {
    let row = this.db
      .query<SqlSessionRow, [string]>("SELECT * FROM sessions WHERE id = ?")
      .get(sessionId);
    if (!row) row = this.recoverSessionRow(sessionId);
    if (!row) throw new Error(`session_not_found: ${sessionId}`);
    const lockPath = path.join(path.dirname(row.rollout_path), `.${sessionId}.lock`);
    acquireLock(lockPath);
    const handle: ActiveSession = {
      sessionId,
      workspace: row.workspace_path,
      presetId: row.preset_id,
      agentName: row.last_agent,
      rolloutPath: row.rollout_path,
      createdAt: row.created_at,
      lockPath,
    };
    this.active.set(sessionId, handle);
    return stripLock(handle);
  }

  async listSessions(filter: SessionFilter = {}): Promise<SessionMetadata[]> {
    this.reindexRollouts();
    const clauses: string[] = [];
    const values: Array<string | number> = [];
    if (filter.workspace) {
      clauses.push("workspace_path = ?");
      values.push(path.resolve(filter.workspace));
    }
    if (filter.presetId) {
      clauses.push("preset_id = ?");
      values.push(filter.presetId);
    }
    if (filter.status) {
      clauses.push("status = ?");
      values.push(filter.status);
    }
    if (filter.updatedSince) {
      clauses.push("updated_at >= ?");
      values.push(filter.updatedSince);
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(" AND ")}` : "";
    const limit = filter.limit ?? 50;
    const rows = this.db
      .query<
        SqlSessionRow,
        Array<string | number>
      >(`SELECT * FROM sessions${where} ORDER BY updated_at DESC LIMIT ${limit}`)
      .all(...values);
    return rows.map(rowToMetadata);
  }

  async deleteSession(sessionId: string, opts: { purgeArtifacts: boolean }): Promise<void> {
    let row = this.db
      .query<SqlSessionRow, [string]>("SELECT * FROM sessions WHERE id = ?")
      .get(sessionId);
    if (!row) row = this.recoverSessionRow(sessionId);
    this.release(sessionId);
    this.db.query("DELETE FROM resume_pointers WHERE session_id = ?").run(sessionId);
    this.db.query("DELETE FROM thread_metadata WHERE session_id = ?").run(sessionId);
    this.db.query("DELETE FROM sessions WHERE id = ?").run(sessionId);
    if (opts.purgeArtifacts && row) {
      const dir = path.dirname(row.rollout_path);
      await rm(row.rollout_path, { force: true });
      await rm(path.join(dir, `.${sessionId}.lock`), { force: true });
      for (const entry of safeReadDir(dir)) {
        if (
          entry !== path.basename(row.rollout_path) &&
          entryHasDelimitedSessionId(entry, sessionId)
        ) {
          await rm(path.join(dir, entry), { recursive: true, force: true });
        }
      }
    }
  }

  markCompleted(sessionId: string, status: "completed" | "crashed" = "completed"): void {
    const handle = this.active.get(sessionId);
    if (!handle) return;
    this.upsertSession(handle, status, undefined, this.now().toISOString());
  }

  release(sessionId: string): void {
    const handle = this.active.get(sessionId);
    if (!handle) return;
    rmSync(handle.lockPath, { force: true });
    this.active.delete(sessionId);
  }

  close(): void {
    for (const id of [...this.active.keys()]) this.release(id);
    this.db.close();
  }

  private async requireHandle(sessionId: string): Promise<ActiveSession> {
    const existing = this.active.get(sessionId);
    if (existing) return existing;
    await this.loadSession(sessionId);
    const loaded = this.active.get(sessionId);
    if (!loaded) throw new Error(`session_not_loaded: ${sessionId}`);
    return loaded;
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_agent TEXT NOT NULL,
        last_turn INTEGER NOT NULL DEFAULT 0,
        workspace_path TEXT NOT NULL,
        preset_id TEXT NOT NULL,
        status TEXT NOT NULL,
        rollout_path TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS sessions_updated_at_idx ON sessions(updated_at DESC);
      CREATE INDEX IF NOT EXISTS sessions_workspace_idx ON sessions(workspace_path);
      CREATE INDEX IF NOT EXISTS sessions_preset_idx ON sessions(preset_id);
      CREATE TABLE IF NOT EXISTS thread_metadata (
        session_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (session_id, key)
      );
      CREATE TABLE IF NOT EXISTS resume_pointers (
        session_id TEXT NOT NULL,
        agent_name TEXT NOT NULL,
        turn INTEGER NOT NULL,
        provider_handle_json TEXT,
        last_commit_sha TEXT,
        last_atif_step_id INTEGER,
        PRIMARY KEY (session_id, agent_name)
      );
    `);
  }

  private openDatabase(): Database {
    try {
      return this.configureDatabase(new Database(this.sqlitePath, { create: true }));
    } catch {
      this.resetSqliteFiles();
      return this.configureDatabase(new Database(this.sqlitePath, { create: true }));
    }
  }

  private configureDatabase(db: Database): Database {
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA synchronous = NORMAL;");
    db.exec("PRAGMA busy_timeout = 5000;");
    return db;
  }

  private resetSqliteFiles(): void {
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(this.sqlitePath + suffix, { force: true });
    }
  }

  private upsertSession(
    handle: SessionHandle,
    status: "active" | "completed" | "crashed",
    lastTurn: number | undefined,
    updatedAt: string,
  ): void {
    const prior = this.db
      .query<{ last_turn: number }, [string]>("SELECT last_turn FROM sessions WHERE id = ?")
      .get(handle.sessionId);
    const turn = lastTurn ?? prior?.last_turn ?? 0;
    this.db
      .query(
        `INSERT INTO sessions
          (id, created_at, updated_at, last_agent, last_turn, workspace_path, preset_id, status, rollout_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          updated_at = excluded.updated_at,
          last_agent = excluded.last_agent,
          last_turn = excluded.last_turn,
          workspace_path = excluded.workspace_path,
          preset_id = excluded.preset_id,
          status = excluded.status,
          rollout_path = excluded.rollout_path`,
      )
      .run(
        handle.sessionId,
        handle.createdAt,
        updatedAt,
        handle.agentName,
        turn,
        handle.workspace,
        handle.presetId,
        status,
        handle.rolloutPath,
      );
  }

  private recoverSessionRow(sessionId: string): SqlSessionRow | null {
    const rolloutPath = findRolloutForSession(this.sessionsDir, sessionId);
    if (!rolloutPath) return null;
    const row = rowFromRollout(rolloutPath);
    if (!row) return null;
    this.upsertRecoveredRow(row);
    return row;
  }

  private reindexRollouts(): void {
    for (const rolloutPath of findRollouts(this.sessionsDir)) {
      const row = rowFromRollout(rolloutPath);
      if (!row) continue;
      this.upsertRecoveredRow(row);
    }
  }

  private upsertRecoveredRow(row: SqlSessionRow): void {
    this.db
      .query(
        `INSERT INTO sessions
          (id, created_at, updated_at, last_agent, last_turn, workspace_path, preset_id, status, rollout_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          updated_at = excluded.updated_at,
          last_agent = excluded.last_agent,
          last_turn = excluded.last_turn,
          workspace_path = excluded.workspace_path,
          preset_id = excluded.preset_id,
          status = excluded.status,
          rollout_path = excluded.rollout_path`,
      )
      .run(
        row.id,
        row.created_at,
        row.updated_at,
        row.last_agent,
        row.last_turn,
        row.workspace_path,
        row.preset_id,
        row.status,
        row.rollout_path,
      );
  }
}

function readSnapshot(rolloutPath: string): SessionSnapshot {
  const lines = readFileSync(rolloutPath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  let meta: SessionMeta | null = null;
  const history: HistoryItem[] = [];
  let usage: TokenUsage = zeroUsage();
  let streamUsage: TokenUsage = zeroUsage();
  let assistantUsageSeen = false;
  const timeline: SessionSnapshot["timeline"] = {
    historyItems: 0,
    turns: 0,
    events: 0,
    toolCalls: 0,
    toolOutputs: 0,
    permissionDecisions: 0,
    compactions: 0,
    checkpoints: 0,
    resumeEvents: 0,
    divergenceEvents: 0,
    providerHandles: 0,
  };
  let lastProviderHandle: SessionSnapshot["lastProviderHandle"];
  let lastCompactionMarker: CompactionMarker | undefined;
  for (const line of lines) {
    const item = JSON.parse(line) as RolloutItem;
    if (item.type === "session_meta") meta = item.payload;
    else if (item.type === "response_item") {
      history.push(item.payload);
      timeline.historyItems++;
      if (item.payload.tokenUsage) {
        assistantUsageSeen = true;
        usage = addUsage(usage, {
          inputTokens: item.payload.tokenUsage.inputTokens ?? 0,
          outputTokens: item.payload.tokenUsage.outputTokens ?? 0,
          ...(item.payload.tokenUsage.reasoningTokens !== undefined
            ? { reasoningTokens: item.payload.tokenUsage.reasoningTokens }
            : {}),
          ...(item.payload.tokenUsage.thinkingTokens !== undefined
            ? { thinkingTokens: item.payload.tokenUsage.thinkingTokens }
            : {}),
          ...(item.payload.tokenUsage.cachedInputTokens !== undefined
            ? { cachedInputTokens: item.payload.tokenUsage.cachedInputTokens }
            : {}),
          ...(item.payload.tokenUsage.cacheCreationInputTokens !== undefined
            ? { cacheCreationInputTokens: item.payload.tokenUsage.cacheCreationInputTokens }
            : {}),
        });
      }
    } else if (item.type === "turn_context") {
      const marker: TurnContextMarker = item.payload;
      timeline.turns++;
      if (marker.providerHandle) lastProviderHandle = marker.providerHandle;
      if (marker.providerHandle) timeline.providerHandles++;
    } else if (item.type === "compacted") {
      lastCompactionMarker = item.payload;
      timeline.compactions++;
      if (isProviderContinuationHandle(item.payload.providerHandle)) {
        lastProviderHandle = item.payload.providerHandle;
        timeline.providerHandles++;
      }
    } else if (item.type === "event_msg") {
      timeline.events++;
      timeline.lastEventAt = item.payload.ts;
      if (item.payload.type === "tool_called") timeline.toolCalls++;
      else if (item.payload.type === "tool_output") timeline.toolOutputs++;
      else if (item.payload.type === "permission_decision") timeline.permissionDecisions++;
      else if (item.payload.type === "checkpoint_saved") timeline.checkpoints++;
      else if (item.payload.type === "session_resumed") timeline.resumeEvents++;
      else if (item.payload.type === "workspace_diverged") timeline.divergenceEvents++;
      const event = (item.payload as { event?: unknown }).event;
      if (isUsageUpdateEvent(event)) {
        streamUsage = addUsage(streamUsage, event.usage);
      }
      const providerHandle = (item.payload as { providerHandle?: unknown }).providerHandle;
      if (isProviderContinuationHandle(providerHandle)) {
        lastProviderHandle = providerHandle;
        timeline.providerHandles++;
      }
    }
  }
  if (!meta) throw new Error(`invalid_rollout_missing_meta: ${rolloutPath}`);
  if (!assistantUsageSeen) usage = streamUsage;
  const out: SessionSnapshot = { meta, history, usage, timeline };
  if (lastProviderHandle) out.lastProviderHandle = lastProviderHandle;
  if (lastCompactionMarker) out.lastCompactionMarker = lastCompactionMarker;
  return out;
}

function rowFromRollout(rolloutPath: string): SqlSessionRow | null {
  try {
    const snapshot = readSnapshot(rolloutPath);
    const st = statSync(rolloutPath);
    return {
      id: snapshot.meta.session_id,
      created_at: snapshot.meta.created_at,
      updated_at: snapshot.timeline.lastEventAt ?? st.mtime.toISOString(),
      last_agent: snapshot.meta.agent_name,
      last_turn: snapshot.timeline.turns,
      workspace_path: snapshot.meta.workspace,
      preset_id: snapshot.meta.preset_id,
      status: lockIsActive(path.dirname(rolloutPath), snapshot.meta.session_id)
        ? "active"
        : "completed",
      rollout_path: rolloutPath,
    };
  } catch {
    return null;
  }
}

function findRolloutForSession(root: string, sessionId: string): string | null {
  return findRollouts(root).find((p) => p.endsWith(`-${sessionId}.jsonl`)) ?? null;
}

function findRollouts(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of safeReadDir(dir)) {
      const p = path.join(dir, entry);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (/^rollout-\d+-s_.+\.jsonl$/.test(entry)) out.push(p);
    }
  };
  walk(root);
  return out;
}

function safeReadDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function entryHasDelimitedSessionId(entry: string, sessionId: string): boolean {
  return new RegExp(`(^|[.-])${escapeRegExp(sessionId)}([.-]|$)`).test(entry);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isUsageUpdateEvent(value: unknown): value is {
  type: "usage_update";
  usage: TokenUsage;
} {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { type?: unknown; usage?: unknown };
  if (candidate.type !== "usage_update") return false;
  if (!candidate.usage || typeof candidate.usage !== "object") return false;
  const usage = candidate.usage as Partial<TokenUsage>;
  return typeof usage.inputTokens === "number" && typeof usage.outputTokens === "number";
}

function isProviderContinuationHandle(value: unknown): value is ProviderContinuationHandle {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { kind?: unknown };
  switch (candidate.kind) {
    case "openai_response":
      return typeof (value as { responseId?: unknown }).responseId === "string";
    case "openai_compacted":
      return Array.isArray((value as { input?: unknown }).input);
    case "openai_conversation":
      return typeof (value as { conversationId?: unknown }).conversationId === "string";
    case "anthropic_messages":
      return Array.isArray((value as { messages?: unknown }).messages);
    default:
      return false;
  }
}

function lockIsActive(dir: string, sessionId: string): boolean {
  const lockPath = path.join(dir, `.${sessionId}.lock`);
  if (!existsSync(lockPath)) return false;
  try {
    const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: number };
    return Boolean(parsed.pid && pidAlive(parsed.pid));
  } catch {
    return false;
  }
}

async function readJsonIfExists<T>(p: string): Promise<T | null> {
  if (!existsSync(p)) return null;
  return JSON.parse(await readFile(p, "utf8")) as T;
}

export async function loadSessionFileState<T>(
  session: SessionHandle,
  runId: string,
): Promise<T | null> {
  return readJsonIfExists<T>(
    path.join(path.dirname(session.rolloutPath), `file-state-${runId}.json`),
  );
}

export async function writeSessionFileState(
  session: SessionHandle,
  runId: string,
  data: unknown,
): Promise<void> {
  await writeFile(
    path.join(path.dirname(session.rolloutPath), `file-state-${runId}.json`),
    JSON.stringify(data, null, 2) + "\n",
    "utf8",
  );
}

function serializeItem(item: RolloutItem): string {
  return JSON.stringify(item) + "\n";
}

function sessionDayDir(root: string, iso: string): string {
  const d = new Date(iso);
  const yyyy = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return path.join(root, yyyy, mm, dd);
}

function stripLock(handle: ActiveSession): SessionHandle {
  return {
    sessionId: handle.sessionId,
    workspace: handle.workspace,
    presetId: handle.presetId,
    agentName: handle.agentName,
    rolloutPath: handle.rolloutPath,
    createdAt: handle.createdAt,
  };
}

function acquireLock(lockPath: string): void {
  mkdirSync(path.dirname(lockPath), { recursive: true });
  if (existsSync(lockPath)) {
    const raw = readFileSync(lockPath, "utf8");
    try {
      const parsed = JSON.parse(raw) as { pid?: number; createdAt?: string };
      if (parsed.pid && !pidAlive(parsed.pid)) {
        rmSync(lockPath, { force: true });
      } else {
        throw new Error(
          `session_locked: held by pid=${parsed.pid ?? "unknown"} since=${parsed.createdAt ?? "unknown"}`,
        );
      }
    } catch (err) {
      if ((err as Error).message.startsWith("session_locked")) throw err;
      throw new Error(`session_locked: unreadable lock ${lockPath}`);
    }
  }
  writeFileSync(
    lockPath,
    JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }) + "\n",
    {
      flag: "wx",
    },
  );
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function rowToMetadata(row: SqlSessionRow): SessionMetadata {
  return {
    sessionId: row.id,
    workspace: row.workspace_path,
    presetId: row.preset_id,
    agentName: row.last_agent,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastTurn: row.last_turn,
    rolloutPath: row.rollout_path,
  };
}
