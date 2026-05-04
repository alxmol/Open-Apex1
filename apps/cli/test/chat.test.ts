import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Readable, Writable } from "node:stream";

import { describe, expect, test } from "bun:test";

import { openApexPaths } from "@open-apex/config";
import { JsonlSqliteSessionStore } from "@open-apex/runtime";
import { MockOpenAiAdapter } from "@open-apex/provider-openai";

import { runChat } from "../src/chat.ts";

class CaptureStream extends Writable {
  readonly chunks: Buffer[] = [];

  override _write(
    chunk: string | Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    callback();
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

describe("runChat product controller", () => {
  test("/resume switches the active chat session state", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "open-apex-chat-home-"));
    const workspace = mkdtempSync(path.join(tmpdir(), "open-apex-chat-ws-"));
    const previousHome = process.env.OPEN_APEX_HOME;
    process.env.OPEN_APEX_HOME = home;
    try {
      const paths = openApexPaths();
      const store = new JsonlSqliteSessionStore({
        sessionsDir: paths.sessionsDir,
        sqliteHome: paths.sqliteHome,
      });
      const saved = await store.openSession({
        workspace,
        presetId: "chat-gpt54",
        agentName: "open-apex-chat",
        sessionId: "s_saved_chat",
      });
      await store.appendRolloutItem(saved.sessionId, {
        type: "response_item",
        payload: {
          id: "u1",
          createdAt: "2026-04-27T00:00:00.000Z",
          role: "user",
          content: "remember this",
        },
      });
      store.release(saved.sessionId);
      store.close();

      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const stdin = Readable.from(["/resume s_saved_chat\n", "/timeline\n", "exit\n"]);
      const code = await runChat(
        { kind: "chat", preset: "chat-gpt54", workspace },
        stdout,
        stderr,
        stdin,
      );

      expect(code).toBe(0);
      expect(stderr.text()).toBe("");
      expect(stdout.text()).toContain("Resumed session s_saved_chat: 1 history items");
      expect(stdout.text()).toContain("Timeline: 1 history items");
    } finally {
      if (previousHome === undefined) delete process.env.OPEN_APEX_HOME;
      else process.env.OPEN_APEX_HOME = previousHome;
    }
  });

  test("manual /compact is durable across restart and /resume", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "open-apex-chat-home-"));
    const workspace = mkdtempSync(path.join(tmpdir(), "open-apex-chat-ws-"));
    const previousHome = process.env.OPEN_APEX_HOME;
    process.env.OPEN_APEX_HOME = home;
    try {
      const paths = openApexPaths();
      const first = new MockOpenAiAdapter({
        script: {
          conversationResults: [
            {
              applicable: true,
              providerHandle: { kind: "openai_conversation", conversationId: "conv_product" },
            },
            {
              applicable: true,
              providerHandle: {
                kind: "openai_conversation",
                conversationId: "conv_after_compact",
              },
            },
          ],
          turns: [textTurn("first answer", "resp_first")],
          compactionResult: {
            applicable: true,
            summaryTokens: 10,
            output: [{ type: "message", role: "assistant", content: [] }],
            providerHandle: {
              kind: "openai_compacted",
              input: [{ type: "message", role: "assistant", content: [] }],
              reasoningItemsIncluded: true,
              conversationId: "conv_product",
            },
          },
        },
      });
      const stdout1 = new CaptureStream();
      const stderr1 = new CaptureStream();
      const code1 = await runChat(
        { kind: "chat", preset: "chat-gpt54", workspace },
        stdout1,
        stderr1,
        Readable.from(["hello\n", "/compact\n", "exit\n"]),
        { paths, makeAdapter: () => first },
      );
      expect(code1).toBe(0);
      expect(stderr1.text()).toBe("");

      let store = new JsonlSqliteSessionStore({
        sessionsDir: paths.sessionsDir,
        sqliteHome: paths.sqliteHome,
      });
      const [saved] = await store.listSessions({ workspace, presetId: "chat-gpt54", limit: 1 });
      expect(saved).toBeDefined();
      const compactSnapshot = await store.snapshot(saved!.sessionId);
      expect(compactSnapshot.lastProviderHandle?.kind).toBe("openai_compacted");
      expect(compactSnapshot.lastProviderHandle).toMatchObject({
        conversationId: "conv_after_compact",
      });
      store.close();

      const second = new MockOpenAiAdapter({
        script: {
          conversationResult: {
            applicable: true,
            providerHandle: { kind: "openai_conversation", conversationId: "conv_new_session" },
          },
          turns: [textTurn("after restart", "resp_after_restart")],
        },
      });
      const stdout2 = new CaptureStream();
      const stderr2 = new CaptureStream();
      const code2 = await runChat(
        { kind: "chat", preset: "chat-gpt54", workspace },
        stdout2,
        stderr2,
        Readable.from([`/resume ${saved!.sessionId}\n`, "next question\n", "exit\n"]),
        { paths, makeAdapter: () => second },
      );

      expect(code2).toBe(0);
      expect(stderr2.text()).toBe("");
      const resume = second.recordedCalls.find((c) => c.method === "resume");
      expect(resume).toBeDefined();
      const payload = resume!.payload as {
        handle: { kind: string; conversationId?: string };
        req: { messages: Array<{ content: string }> };
      };
      expect(payload.handle).toMatchObject({
        kind: "openai_compacted",
        conversationId: "conv_after_compact",
      });
      expect(payload.req.messages.map((m) => m.content)).toEqual(["next question"]);

      store = new JsonlSqliteSessionStore({
        sessionsDir: paths.sessionsDir,
        sqliteHome: paths.sqliteHome,
      });
      const resumedSnapshot = await store.snapshot(saved!.sessionId);
      expect(resumedSnapshot.lastProviderHandle?.kind).toBe("openai_response");
      store.close();
    } finally {
      if (previousHome === undefined) delete process.env.OPEN_APEX_HOME;
      else process.env.OPEN_APEX_HOME = previousHome;
    }
  });

  test("resumed conversation-only sessions continue through openai_conversation", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "open-apex-chat-home-"));
    const workspace = mkdtempSync(path.join(tmpdir(), "open-apex-chat-ws-"));
    const previousHome = process.env.OPEN_APEX_HOME;
    process.env.OPEN_APEX_HOME = home;
    try {
      const paths = openApexPaths();
      const store = new JsonlSqliteSessionStore({
        sessionsDir: paths.sessionsDir,
        sqliteHome: paths.sqliteHome,
      });
      const saved = await store.openSession({
        workspace,
        presetId: "chat-gpt54",
        agentName: "open-apex-chat",
        sessionId: "s_conversation_only",
      });
      await store.appendRolloutItem(saved.sessionId, {
        type: "event_msg",
        payload: {
          type: "provider_handle",
          ts: "2026-04-27T00:00:00.000Z",
          providerHandle: { kind: "openai_conversation", conversationId: "conv_only" },
        },
      });
      store.release(saved.sessionId);
      store.close();

      const adapter = new MockOpenAiAdapter({
        script: {
          conversationResult: {
            applicable: true,
            providerHandle: { kind: "openai_conversation", conversationId: "conv_boot" },
          },
          turns: [textTurn("conversation continued", "resp_conv")],
        },
      });
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const code = await runChat(
        { kind: "chat", preset: "chat-gpt54", workspace },
        stdout,
        stderr,
        Readable.from(["/resume s_conversation_only\n", "continue\n", "exit\n"]),
        { paths, makeAdapter: () => adapter },
      );

      expect(code).toBe(0);
      expect(stderr.text()).toBe("");
      const resume = adapter.recordedCalls.find((c) => c.method === "resume");
      expect(
        (resume?.payload as { handle: { kind: string; conversationId?: string } }).handle,
      ).toEqual({
        kind: "openai_conversation",
        conversationId: "conv_only",
      });
    } finally {
      if (previousHome === undefined) delete process.env.OPEN_APEX_HOME;
      else process.env.OPEN_APEX_HOME = previousHome;
    }
  });

  test("chat file-state rehydrates on /resume and detects stale reads", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "open-apex-chat-home-"));
    const workspace = mkdtempSync(path.join(tmpdir(), "open-apex-chat-ws-"));
    writeFileSync(path.join(workspace, "a.txt"), "before\n", "utf8");
    const previousHome = process.env.OPEN_APEX_HOME;
    process.env.OPEN_APEX_HOME = home;
    try {
      const paths = openApexPaths();
      const first = new MockOpenAiAdapter({
        script: {
          conversationResult: {
            applicable: true,
            providerHandle: { kind: "openai_conversation", conversationId: "conv_files" },
          },
          turns: [
            toolTurn("read_file", { path: "a.txt" }, "resp_read"),
            textTurn("read complete", "resp_read_done"),
          ],
        },
      });
      await runChat(
        { kind: "chat", preset: "chat-gpt54", workspace },
        new CaptureStream(),
        new CaptureStream(),
        Readable.from(["inspect a.txt\n", "exit\n"]),
        { paths, makeAdapter: () => first },
      );

      const store = new JsonlSqliteSessionStore({
        sessionsDir: paths.sessionsDir,
        sqliteHome: paths.sqliteHome,
      });
      const [saved] = await store.listSessions({ workspace, presetId: "chat-gpt54", limit: 1 });
      expect(saved).toBeDefined();
      store.close();

      writeFileSync(path.join(workspace, "a.txt"), "changed externally\n", "utf8");
      const second = new MockOpenAiAdapter({
        script: {
          conversationResult: {
            applicable: true,
            providerHandle: { kind: "openai_conversation", conversationId: "conv_fresh" },
          },
          turns: [
            toolTurn(
              "search_replace",
              { path: "a.txt", oldText: "before", newText: "after" },
              "resp_replace",
            ),
            textTurn("stale read surfaced", "resp_replace_done"),
          ],
        },
      });
      await runChat(
        { kind: "chat", preset: "chat-gpt54", workspace },
        new CaptureStream(),
        new CaptureStream(),
        Readable.from([
          `/resume ${saved!.sessionId}\n`,
          "/permissions full_auto\n",
          "edit it\n",
          "exit\n",
        ]),
        { paths, makeAdapter: () => second },
      );

      const verifyStore = new JsonlSqliteSessionStore({
        sessionsDir: paths.sessionsDir,
        sqliteHome: paths.sqliteHome,
      });
      const snap = await verifyStore.snapshot(saved!.sessionId);
      expect(JSON.stringify(snap.history)).toContain("file_stale_read");
      verifyStore.close();
    } finally {
      if (previousHome === undefined) delete process.env.OPEN_APEX_HOME;
      else process.env.OPEN_APEX_HOME = previousHome;
    }
  });

  test("background jobs survive /new and provider switch inside one chat process", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "open-apex-chat-home-"));
    const workspace = mkdtempSync(path.join(tmpdir(), "open-apex-chat-ws-"));
    const previousHome = process.env.OPEN_APEX_HOME;
    process.env.OPEN_APEX_HOME = home;
    try {
      const paths = openApexPaths();
      const first = new MockOpenAiAdapter({
        script: {
          conversationResult: {
            applicable: true,
            providerHandle: { kind: "openai_conversation", conversationId: "conv_jobs" },
          },
          turns: [
            {
              events: [
                ...jobCallEvents("job-a", "resp_jobs_a"),
                ...jobCallEvents("job-b", "resp_jobs_b"),
                ...jobCallEvents("job-c", "resp_jobs_c"),
                {
                  type: "done" as const,
                  stopReason: "tool_use" as const,
                  providerHandle: {
                    kind: "openai_response" as const,
                    responseId: "resp_jobs",
                    reasoningItemsIncluded: false,
                  },
                },
              ],
            },
            textTurn("jobs started", "resp_jobs_done"),
          ],
        },
      });
      const afterSwitch = new MockOpenAiAdapter({
        script: {
          conversationResult: {
            applicable: true,
            providerHandle: { kind: "openai_conversation", conversationId: "conv_after_switch" },
          },
          turns: [],
        },
      });
      const adapters = [first, afterSwitch];
      const stdout = new CaptureStream();
      const stderr = new CaptureStream();
      const code = await runChat(
        { kind: "chat", preset: "chat-gpt54", workspace },
        stdout,
        stderr,
        Readable.from([
          "/permissions full_auto\n",
          "start three background jobs\n",
          "/new\n",
          "/model chat-gpt54\n",
          "/jobs\n",
          "exit\n",
        ]),
        { paths, makeAdapter: () => adapters.shift() ?? afterSwitch },
      );

      expect(code).toBe(0);
      expect(stderr.text()).toBe("");
      expect(stdout.text()).toContain("job-a");
      expect(stdout.text()).toContain("job-b");
      expect(stdout.text()).toContain("job-c");
    } finally {
      if (previousHome === undefined) delete process.env.OPEN_APEX_HOME;
      else process.env.OPEN_APEX_HOME = previousHome;
    }
  });
});

function textTurn(text: string, responseId: string) {
  return {
    events: [
      { type: "text_delta" as const, delta: text },
      {
        type: "usage_update" as const,
        usage: { inputTokens: 3, outputTokens: 2 },
        cacheHit: false,
      },
      {
        type: "done" as const,
        stopReason: "end_turn" as const,
        providerHandle: {
          kind: "openai_response" as const,
          responseId,
          reasoningItemsIncluded: false,
        },
      },
    ],
  };
}

function toolTurn(name: string, args: Record<string, unknown>, responseId: string) {
  return {
    events: [
      {
        type: "tool_call_start" as const,
        callId: `${responseId}_call`,
        name,
        argsSchema: "json" as const,
      },
      {
        type: "tool_call_done" as const,
        callId: `${responseId}_call`,
        args,
      },
      {
        type: "usage_update" as const,
        usage: { inputTokens: 5, outputTokens: 1 },
        cacheHit: false,
      },
      {
        type: "done" as const,
        stopReason: "tool_use" as const,
        providerHandle: {
          kind: "openai_response" as const,
          responseId,
          reasoningItemsIncluded: false,
        },
      },
    ],
  };
}

function jobCallEvents(name: string, callId: string) {
  return [
    {
      type: "tool_call_start" as const,
      callId,
      name: "run_job",
      argsSchema: "json" as const,
    },
    {
      type: "tool_call_done" as const,
      callId,
      args: { argv: ["bash", "-lc", "sleep 5"], name },
    },
  ];
}
