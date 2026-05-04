import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import { JsonlSqliteSessionStore } from "../src/session-store.ts";

function tempRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "open-apex-session-store-"));
}

describe("JsonlSqliteSessionStore", () => {
  test("writes canonical JSONL rollout and rebuilds snapshots", async () => {
    const root = tempRoot();
    const store = new JsonlSqliteSessionStore({
      sessionsDir: path.join(root, "sessions"),
      sqliteHome: path.join(root, "sqlite"),
      presetRevision: "r-test",
    });
    const session = await store.openSession({
      workspace: root,
      presetId: "tb2-gpt54",
      agentName: "test-agent",
      sessionId: "s_test",
    });
    await store.appendRolloutItem(session.sessionId, {
      type: "response_item",
      payload: {
        id: "u1",
        createdAt: "2026-04-27T00:00:00.000Z",
        role: "user",
        content: "hello",
      },
    });
    await store.appendRolloutItem(session.sessionId, {
      type: "turn_context",
      payload: {
        turn: 1,
        cwd: root,
        timestamp: "2026-04-27T00:00:01.000Z",
        providerHandle: {
          kind: "openai_response",
          responseId: "resp_1",
          reasoningItemsIncluded: true,
        },
      },
    });

    const snapshot = await store.snapshot(session.sessionId);
    expect(snapshot.meta.session_id).toBe("s_test");
    expect(snapshot.meta.preset_revision).toBe("r-test");
    expect(snapshot.history).toHaveLength(1);
    expect(snapshot.usage.inputTokens).toBe(0);
    expect(snapshot.timeline.turns).toBe(1);
    expect(snapshot.lastProviderHandle?.kind).toBe("openai_response");

    const listed = await store.listSessions({ workspace: root });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.lastTurn).toBe(1);
    store.close();
  });

  test("recovers sessions by scanning canonical JSONL when SQLite is missing", async () => {
    const root = tempRoot();
    const sessionsDir = path.join(root, "sessions");
    const sqliteHome = path.join(root, "sqlite");
    let store = new JsonlSqliteSessionStore({ sessionsDir, sqliteHome });
    const session = await store.openSession({
      workspace: root,
      presetId: "tb2-gpt54",
      agentName: "test-agent",
      sessionId: "s_recover",
    });
    await store.appendRolloutItem(session.sessionId, {
      type: "response_item",
      payload: {
        id: "a1",
        createdAt: "2026-04-27T00:00:00.000Z",
        role: "assistant",
        content: "ok",
        tokenUsage: { inputTokens: 7, outputTokens: 3, cachedInputTokens: 2 },
      },
    });
    store.close();
    rmSync(sqliteHome, { recursive: true, force: true });

    store = new JsonlSqliteSessionStore({ sessionsDir, sqliteHome });
    const listed = await store.listSessions({ workspace: root, presetId: "tb2-gpt54" });
    expect(listed.map((s) => s.sessionId)).toContain("s_recover");
    const loaded = await store.loadSession("s_recover");
    expect(loaded.rolloutPath).toBe(session.rolloutPath);
    const snapshot = await store.snapshot("s_recover");
    expect(snapshot.usage).toEqual({ inputTokens: 7, outputTokens: 3, cachedInputTokens: 2 });
    store.close();
  });

  test("recovers sessions by scanning canonical JSONL when SQLite is corrupt", async () => {
    const root = tempRoot();
    const sessionsDir = path.join(root, "sessions");
    const sqliteHome = path.join(root, "sqlite");
    let store = new JsonlSqliteSessionStore({ sessionsDir, sqliteHome });
    await store.openSession({
      workspace: root,
      presetId: "tb2-gpt54",
      agentName: "test-agent",
      sessionId: "s_corrupt_db",
    });
    store.close();
    rmSync(sqliteHome, { recursive: true, force: true });
    mkdirSync(sqliteHome, { recursive: true });
    writeFileSync(path.join(sqliteHome, "threads.db"), "not a sqlite database\n", "utf8");

    store = new JsonlSqliteSessionStore({ sessionsDir, sqliteHome });
    const listed = await store.listSessions({ workspace: root });
    expect(listed.map((s) => s.sessionId)).toContain("s_corrupt_db");
    store.close();
  });

  test("manual compact marker restores durable compacted provider handle", async () => {
    const root = tempRoot();
    const store = new JsonlSqliteSessionStore({
      sessionsDir: path.join(root, "sessions"),
      sqliteHome: path.join(root, "sqlite"),
    });
    const session = await store.openSession({
      workspace: root,
      presetId: "chat-gpt54",
      agentName: "test-agent",
      sessionId: "s_compacted",
    });
    await store.appendRolloutItem(session.sessionId, {
      type: "compacted",
      payload: {
        trigger: "manual",
        preTokens: 100,
        postTokens: 30,
        providerHandle: {
          kind: "openai_compacted",
          input: [{ type: "message", role: "assistant", content: [] }],
          reasoningItemsIncluded: true,
          conversationId: "conv_compact",
        },
      },
    });

    const snapshot = await store.snapshot(session.sessionId);
    expect(snapshot.lastCompactionMarker?.providerHandle?.kind).toBe("openai_compacted");
    expect(snapshot.lastProviderHandle).toEqual(snapshot.lastCompactionMarker?.providerHandle);
    expect(snapshot.timeline.providerHandles).toBe(1);
    store.close();
  });

  test("older compact markers without provider handles remain replay-compatible", async () => {
    const root = tempRoot();
    const store = new JsonlSqliteSessionStore({
      sessionsDir: path.join(root, "sessions"),
      sqliteHome: path.join(root, "sqlite"),
    });
    const session = await store.openSession({
      workspace: root,
      presetId: "chat-gpt54",
      agentName: "test-agent",
      sessionId: "s_old_compact",
    });
    await store.appendRolloutItem(session.sessionId, {
      type: "compacted",
      payload: { trigger: "manual", preTokens: 100, postTokens: 75 },
    });

    const snapshot = await store.snapshot(session.sessionId);
    expect(snapshot.lastCompactionMarker?.trigger).toBe("manual");
    expect(snapshot.lastProviderHandle).toBeUndefined();
    store.close();
  });

  test("provider_handle events restore OpenAI conversation handles", async () => {
    const root = tempRoot();
    const store = new JsonlSqliteSessionStore({
      sessionsDir: path.join(root, "sessions"),
      sqliteHome: path.join(root, "sqlite"),
    });
    const session = await store.openSession({
      workspace: root,
      presetId: "chat-gpt54",
      agentName: "test-agent",
      sessionId: "s_conversation",
    });
    await store.appendRolloutItem(session.sessionId, {
      type: "event_msg",
      payload: {
        type: "provider_handle",
        ts: "2026-04-27T00:00:00.000Z",
        providerHandleKind: "openai_conversation",
        providerHandle: {
          kind: "openai_conversation",
          conversationId: "conv_replay",
        },
      },
    });

    const snapshot = await store.snapshot(session.sessionId);
    expect(snapshot.lastProviderHandle).toEqual({
      kind: "openai_conversation",
      conversationId: "conv_replay",
    });
    expect(snapshot.timeline.providerHandles).toBe(1);
    store.close();
  });

  test("rebuilds usage from legacy stream usage events when assistant items lack tokenUsage", async () => {
    const root = tempRoot();
    const store = new JsonlSqliteSessionStore({
      sessionsDir: path.join(root, "sessions"),
      sqliteHome: path.join(root, "sqlite"),
    });
    const session = await store.openSession({
      workspace: root,
      presetId: "tb2-gpt54",
      agentName: "test-agent",
      sessionId: "s_usage_event",
    });
    await store.appendRolloutItem(session.sessionId, {
      type: "event_msg",
      payload: {
        type: "stream_event",
        ts: "2026-04-27T00:00:00.000Z",
        event: {
          type: "usage_update",
          usage: { inputTokens: 11, outputTokens: 4 },
          cacheHit: false,
        },
      },
    });
    await store.appendRolloutItem(session.sessionId, {
      type: "response_item",
      payload: {
        id: "a1",
        createdAt: "2026-04-27T00:00:01.000Z",
        role: "assistant",
        content: "ok",
      },
    });
    const snapshot = await store.snapshot(session.sessionId);
    expect(snapshot.usage).toEqual({ inputTokens: 11, outputTokens: 4 });
    store.close();
  });

  test("purging one session does not delete sibling session rollouts", async () => {
    const root = tempRoot();
    const store = new JsonlSqliteSessionStore({
      sessionsDir: path.join(root, "sessions"),
      sqliteHome: path.join(root, "sqlite"),
    });
    const a = await store.openSession({
      workspace: root,
      presetId: "tb2-gpt54",
      agentName: "test-agent",
      sessionId: "s_a",
    });
    const b = await store.openSession({
      workspace: root,
      presetId: "tb2-gpt54",
      agentName: "test-agent",
      sessionId: "s_ab",
    });
    await store.deleteSession(a.sessionId, { purgeArtifacts: true });
    expect(existsSync(a.rolloutPath)).toBe(false);
    expect(existsSync(b.rolloutPath)).toBe(true);
    const snapshot = await store.snapshot(b.sessionId);
    expect(snapshot.meta.session_id).toBe("s_ab");
    store.close();
  });

  test("stale lock is removed while loading a recovered session", async () => {
    const root = tempRoot();
    const sessionsDir = path.join(root, "sessions");
    const sqliteHome = path.join(root, "sqlite");
    let store = new JsonlSqliteSessionStore({ sessionsDir, sqliteHome });
    const session = await store.openSession({
      workspace: root,
      presetId: "tb2-gpt54",
      agentName: "test-agent",
      sessionId: "s_stale",
    });
    store.close();
    rmSync(sqliteHome, { recursive: true, force: true });
    writeFileSync(
      path.join(path.dirname(session.rolloutPath), ".s_stale.lock"),
      JSON.stringify({ pid: 99999999, createdAt: "2026-04-27T00:00:00.000Z" }) + "\n",
    );

    store = new JsonlSqliteSessionStore({ sessionsDir, sqliteHome });
    const loaded = await store.loadSession("s_stale");
    expect(loaded.sessionId).toBe("s_stale");
    store.close();
  });

  test("corrupt JSONL rollouts are skipped during index recovery", async () => {
    const root = tempRoot();
    const sessionsDir = path.join(root, "sessions");
    const sqliteHome = path.join(root, "sqlite");
    const dayDir = path.join(sessionsDir, "2026", "04", "27");
    mkdirSync(dayDir, { recursive: true });
    writeFileSync(path.join(dayDir, "rollout-1777248000000-s_bad.jsonl"), "{not json}\n");
    const store = new JsonlSqliteSessionStore({ sessionsDir, sqliteHome });
    const good = await store.openSession({
      workspace: root,
      presetId: "tb2-gpt54",
      agentName: "test-agent",
      sessionId: "s_good",
    });
    store.release(good.sessionId);
    const listed = await store.listSessions();
    expect(listed.map((s) => s.sessionId)).toEqual(["s_good"]);
    store.close();
  });

  test("prevents two active handles for the same session", async () => {
    const root = tempRoot();
    const store = new JsonlSqliteSessionStore({
      sessionsDir: path.join(root, "sessions"),
      sqliteHome: path.join(root, "sqlite"),
    });
    await store.openSession({
      workspace: root,
      presetId: "tb2-gpt54",
      agentName: "test-agent",
      sessionId: "s_lock",
    });
    await expect(store.loadSession("s_lock")).rejects.toThrow(/session_locked|unreadable lock/);
    store.close();
  });
});
