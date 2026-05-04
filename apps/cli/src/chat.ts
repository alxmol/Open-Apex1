/**
 * Chat-mode entrypoint (M1: line-based REPL).
 *
 * Full Ink TUI (slash commands, destructive-op cards, @file picker, status
 * bar, streaming render) lands in M5. At M1 the chat REPL reads user input
 * from stdin one line at a time, runs a single agentic turn, and prints the
 * assistant text.
 */

import { createInterface } from "node:readline/promises";
import * as path from "node:path";

import { loadPreset, openApexPaths, type LoadedPreset } from "@open-apex/config";
import {
  addUsage,
  assembleSystemPrompt,
  resolvePromptPaths,
  type AutonomyLevel,
  type EffortLevel,
  type HistoryItem,
  type Message,
  type ProviderContinuationHandle,
} from "@open-apex/core";
import {
  FileStateMap,
  JsonlSqliteSessionStore,
  loadSessionFileState,
  runAgenticTurns,
  writeSessionFileState,
} from "@open-apex/runtime";
import {
  registerBuiltinTools,
  cleanupJobManager,
  setSearchProviderFactory,
  ShadowGitCheckpointStore,
  ToolRegistryImpl,
} from "@open-apex/tools";
import { SerperProvider, SerpApiProvider } from "@open-apex/search";

import { makeAdapter, presetToRequestOptions } from "./adapter-factory.ts";
import type { ChatArgs } from "./args.ts";
import { createDefaultCommandRegistry } from "./commands.ts";

export interface RunChatDeps {
  paths?: ReturnType<typeof openApexPaths>;
  loadPreset?: typeof loadPreset;
  makeAdapter?: typeof makeAdapter;
}

export async function runChat(
  args: ChatArgs,
  stdout: NodeJS.WritableStream = process.stdout,
  stderr: NodeJS.WritableStream = process.stderr,
  stdin: NodeJS.ReadableStream = process.stdin,
  deps: RunChatDeps = {},
): Promise<number> {
  const paths = deps.paths ?? openApexPaths();
  const loadPresetFn = deps.loadPreset ?? loadPreset;
  const makeAdapterFn = deps.makeAdapter ?? makeAdapter;
  stdout.write(
    [
      "",
      "  open-apex chat (M1 line-based REPL)",
      "",
      `  OPEN_APEX_HOME: ${paths.home}`,
      `  Full TUI (Ink + streaming + slash commands + @file + destructive-op`,
      `  cards) lands in Milestone 5. Type Ctrl-D or 'exit' to quit.`,
      "",
    ].join("\n"),
  );

  const presetId = args.preset ?? "chat-gpt54";
  let preset: LoadedPreset;
  try {
    preset = await loadPresetFn(presetId);
  } catch (err) {
    stderr.write(`error: preset '${presetId}' not found (${(err as Error).message})\n`);
    return 5;
  }
  const workspace = args.workspace ? path.resolve(args.workspace) : process.cwd();
  stdout.write(
    `  preset=${preset.presetId} model=${preset.modelId} provider=${preset.provider}\n  workspace=${workspace}\n\n`,
  );

  let adapter = makeAdapterFn(preset);
  let registry = buildChatRegistry(preset);
  let toolMap = new Map(registry.list().map((t) => [t.name, t]));
  const checkpointStore = new ShadowGitCheckpointStore({
    workspace,
    storeRoot: paths.checkpointsDir,
  });
  await checkpointStore.init();
  const sessionStore = new JsonlSqliteSessionStore({
    sessionsDir: paths.sessionsDir,
    sqliteHome: paths.sqliteHome,
    cliVersion: "0.0.1",
    presetRevision: preset.revision,
  });
  let session = await sessionStore.openSession({
    workspace,
    presetId: preset.presetId,
    agentName: "open-apex-chat",
  });

  let assembled = await assembleForPreset(preset, registry);

  const history: HistoryItem[] = [];

  let reqOpts = presetToRequestOptions(preset);
  let autonomyLevel = chatAutonomyForPreset(preset);
  let providerHandle: ProviderContinuationHandle | null = null;
  let deliveredHistoryLength = 0;
  let pendingResumeNotice: string | null = null;
  let fileStateMap = new FileStateMap(workspace);
  let conversationStartAttempted = false;
  const ctx = {
    userContext: {
      workspace,
      openApexHome: paths.home,
      autonomyLevel,
      sessionId: session.sessionId,
      checkpointStore,
      fileStateMap,
    },
    runId: `chat_${Date.now()}`,
    signal: new AbortController().signal,
    usage: { inputTokens: 0, outputTokens: 0 },
  };

  const appendSessionEvent = async (type: string, payload: Record<string, unknown> = {}) => {
    await sessionStore.appendRolloutItem(session.sessionId, {
      type: "event_msg",
      payload: {
        type,
        ts: new Date().toISOString(),
        ...payload,
      },
    });
  };

  const appendHistoryItem = async (item: HistoryItem) => {
    history.push(item);
    await sessionStore.appendRolloutItem(session.sessionId, {
      type: "response_item",
      payload: item,
    });
  };

  const setFileStateMap = (next: FileStateMap) => {
    fileStateMap = next;
    ctx.userContext.fileStateMap = next;
  };

  const loadFileStateForSession = async (target: typeof session): Promise<FileStateMap> => {
    const saved = await loadSessionFileState<SerializedFileState>(target, target.sessionId);
    return isSerializedFileState(saved)
      ? FileStateMap.deserialize(workspace, saved)
      : new FileStateMap(workspace);
  };

  const persistFileState = async () => {
    await writeSessionFileState(session, session.sessionId, fileStateMap.serialize());
  };

  const resetFileState = async () => {
    setFileStateMap(new FileStateMap(workspace));
    await persistFileState();
  };

  const setConversationId = (conversationId: string | null) => {
    if (conversationId) {
      reqOpts = { ...reqOpts, conversationId, store: reqOpts.store ?? true };
      conversationStartAttempted = true;
      return;
    }
    const { conversationId: _conversationId, ...rest } = reqOpts;
    reqOpts = rest;
    conversationStartAttempted = false;
  };

  const syncConversationFromHandle = (handle: ProviderContinuationHandle | null) => {
    const conversationId = handle ? conversationIdFromHandle(handle) : undefined;
    setConversationId(conversationId ?? null);
  };

  const createConversation = async (
    reason: string,
  ): Promise<{ kind: "openai_conversation"; conversationId: string } | null> => {
    const capabilities = adapter.getCapabilities();
    if (capabilities.providerId !== "openai" || !capabilities.supportsConversations) return null;
    conversationStartAttempted = true;
    const result = await adapter.startConversation({
      metadata: {
        session_id: session.sessionId,
        preset_id: preset.presetId,
        agent: session.agentName,
      },
    });
    if (!result.applicable) {
      await appendSessionEvent("provider_conversation_unavailable", {
        reason,
        provider: preset.provider,
        model: preset.modelId,
        detail: result.reason ?? null,
      });
      return null;
    }
    setConversationId(result.providerHandle.conversationId);
    await appendSessionEvent("provider_handle", {
      reason,
      providerHandleKind: result.providerHandle.kind,
      providerHandle: result.providerHandle,
    });
    return result.providerHandle;
  };

  const ensureConversation = async (reason: string) => {
    if (reqOpts.conversationId || conversationStartAttempted) return;
    await createConversation(reason);
  };

  setFileStateMap(await loadFileStateForSession(session));
  await ensureConversation("session_started");

  const commands = createDefaultCommandRegistry();
  const rl = createInterface({
    input: stdin,
    output: stdout,
    prompt: "> ",
  });
  rl.prompt();

  const switchPreset = async (nextPresetId: string) => {
    const previous = preset;
    const next = await loadPresetFn(nextPresetId);
    preset = next;
    adapter = makeAdapterFn(preset);
    registry = buildChatRegistry(preset);
    toolMap = new Map(registry.list().map((t) => [t.name, t]));
    assembled = await assembleForPreset(preset, registry);
    reqOpts = presetToRequestOptions(preset);
    setConversationId(null);
    autonomyLevel = chatAutonomyForPreset(preset);
    ctx.userContext.autonomyLevel = autonomyLevel;
    history.length = 0;
    providerHandle = null;
    deliveredHistoryLength = 0;
    await resetFileState();
    await appendSessionEvent("provider_switch", {
      fromPreset: previous.presetId,
      toPreset: preset.presetId,
      fromProvider: previous.provider,
      toProvider: preset.provider,
      fromModel: previous.modelId,
      toModel: preset.modelId,
    });
    await ensureConversation("provider_switch");
    return {
      text: `Switched to ${preset.presetId} (${preset.provider}/${preset.modelId}); conversation context reset.`,
      json: { presetId: preset.presetId, provider: preset.provider, model: preset.modelId },
    };
  };

  const setEffort = async (effort: string) => {
    const nextEffort = effort as EffortLevel;
    reqOpts = { ...reqOpts, effort: nextEffort };
    preset = { ...preset, effort: nextEffort };
    await appendSessionEvent("effort_changed", { effort });
    return { text: `Effort: ${effort}`, json: { effort } };
  };

  const compactSession = async () => {
    if (!providerHandle) {
      return { text: "No provider continuation handle is available to compact yet." };
    }
    const request = {
      systemPrompt: assembled.text,
      messages: history.map(historyToMessageForChat),
      tools: registry.list().map((t) => ({
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      })),
      toolChoice:
        registry.list().length > 0 ? ({ type: "auto" } as const) : ({ type: "none" } as const),
    };
    const result = await adapter.compact(providerHandle, { request, requestOptions: reqOpts });
    if (!result.applicable) {
      return {
        text: `Compaction unavailable: ${result.reason ?? "provider did not compact"}`,
        json: result,
      };
    }
    let nextProviderHandle = result.providerHandle ?? providerHandle;
    if (nextProviderHandle.kind === "openai_compacted") {
      setConversationId(null);
      const freshConversation = await createConversation("manual_compact_post_compaction");
      const { conversationId: _oldConversationId, ...compactedBase } = nextProviderHandle;
      nextProviderHandle = freshConversation
        ? { ...compactedBase, conversationId: freshConversation.conversationId }
        : compactedBase;
    }
    providerHandle = nextProviderHandle;
    syncConversationFromHandle(providerHandle);
    deliveredHistoryLength = history.length;
    const preTokens = ctx.usage.inputTokens;
    const postTokens =
      result.summaryTokens !== undefined
        ? Math.max(0, preTokens - result.summaryTokens)
        : preTokens;
    const markerProviderHandle =
      providerHandle.kind === "openai_compacted" ? providerHandle : result.providerHandle;
    await sessionStore.appendRolloutItem(session.sessionId, {
      type: "compacted",
      payload: {
        trigger: "manual",
        preTokens,
        postTokens,
        ...(result.replacedRange ? { replacedRange: result.replacedRange } : {}),
        ...(markerProviderHandle ? { providerHandle: markerProviderHandle } : {}),
      },
    });
    await appendSessionEvent("manual_compact", {
      providerHandleKind: providerHandle.kind,
      summaryTokens: result.summaryTokens ?? null,
    });
    const jsonResult = markerProviderHandle
      ? { ...result, providerHandle: markerProviderHandle }
      : result;
    return {
      text: `Compacted context (${providerHandle.kind}); future turns will continue from compacted state.`,
      json: jsonResult,
    };
  };

  const resumeSession = async (
    sessionId: string,
    mode: "auto" | "continue-current" | "restore-checkpoint" | "abort",
  ) => {
    if (mode === "abort") return { text: "Resume aborted; current session unchanged." };
    const sameSession = sessionId === session.sessionId;
    const loaded = sameSession ? session : await sessionStore.loadSession(sessionId);
    const latestCheckpoint = await latestCheckpointForSession(checkpointStore, sessionId);
    const divergence = latestCheckpoint
      ? await checkpointStore.verify(latestCheckpoint.commitSha)
      : null;
    const diverged = divergence ? !divergence.verified : false;
    if (diverged && mode === "auto") {
      if (!sameSession) sessionStore.release(loaded.sessionId);
      return {
        text:
          `Workspace diverged from checkpoint ${latestCheckpoint?.commitSha ?? "unknown"}.\n` +
          `Choose: /resume ${sessionId} --continue-current, /resume ${sessionId} --restore-checkpoint, or /resume ${sessionId} --abort`,
        json: { diverged: true, checkpoint: latestCheckpoint, divergence },
      };
    }
    if (diverged && mode === "restore-checkpoint" && latestCheckpoint) {
      const report = await checkpointStore.restore(latestCheckpoint.commitSha);
      if (!report.verified) {
        if (!sameSession) sessionStore.release(loaded.sessionId);
        return {
          text: `Restore failed verification for ${latestCheckpoint.commitSha}`,
          json: report,
        };
      }
    }
    if (!sameSession) {
      await persistFileState();
      sessionStore.markCompleted(session.sessionId);
      sessionStore.release(session.sessionId);
    }
    session = loaded;
    const snap = await sessionStore.snapshot(session.sessionId);
    history.length = 0;
    history.push(...snap.history);
    ctx.usage = snap.usage;
    providerHandle = snap.lastProviderHandle ?? null;
    setConversationId(conversationIdFromHandle(providerHandle) ?? null);
    deliveredHistoryLength = history.length;
    ctx.userContext.sessionId = session.sessionId;
    if (diverged) {
      await resetFileState();
    } else {
      setFileStateMap(await loadFileStateForSession(session));
    }
    if (diverged && mode === "continue-current") {
      pendingResumeNotice =
        "Open-Apex resumed this session after detecting external workspace changes since the last checkpoint. Continue from the current on-disk workspace state and treat prior file observations as potentially stale.";
      await appendSessionEvent("workspace_diverged", {
        action: "continue-current",
        checkpoint: latestCheckpoint?.commitSha ?? null,
        divergence,
      });
    }
    await ensureConversation("session_resumed");
    await appendSessionEvent("session_resumed", {
      sessionId: session.sessionId,
      historyItems: history.length,
      providerHandleKind: providerHandle?.kind ?? null,
      conversationId: reqOpts.conversationId ?? null,
    });
    return {
      text: `Resumed session ${session.sessionId}: ${history.length} history items, provider=${providerHandle?.kind ?? "local-replay"}`,
      json: { session, snapshot: snap },
    };
  };

  try {
    for await (const line of rl) {
      const text = line.trim();
      if (!text) {
        rl.prompt();
        continue;
      }
      if (text === "exit" || text === "quit") break;
      if (text.startsWith("/")) {
        try {
          const result = await commands.execute(text, {
            runId: ctx.runId,
            workspace,
            session,
            sessionStore,
            history,
            usage: ctx.usage,
            preset,
            autonomyLevel,
            setAutonomyLevel(level: string) {
              autonomyLevel = level as typeof autonomyLevel;
              ctx.userContext.autonomyLevel = autonomyLevel;
            },
            async resetConversation(reason: string) {
              history.length = 0;
              providerHandle = null;
              deliveredHistoryLength = 0;
              setConversationId(null);
              await resetFileState();
              await appendSessionEvent("conversation_reset", { reason });
              await ensureConversation("conversation_reset");
            },
            async checkpointSave(name?: string) {
              const cp = await checkpointStore.save(
                "user_named",
                session.sessionId,
                history.length,
                {
                  ...(name ? { name } : {}),
                },
              );
              await appendSessionEvent("checkpoint_saved", {
                commitSha: cp.commitSha,
                name: name ?? null,
                reason: cp.reason,
              });
              return name ? `${cp.commitSha} (${name})` : cp.commitSha;
            },
            async checkpointRestoreLatest() {
              const [latest] = await checkpointStore.list(session.sessionId);
              if (!latest) return "No checkpoint found for this session.";
              const report = await checkpointStore.restore(latest.commitSha);
              await appendSessionEvent("checkpoint_restored", {
                commitSha: latest.commitSha,
                verified: report.verified,
              });
              return `Restored ${latest.commitSha}; verified=${report.verified}`;
            },
            compactSession,
            resumeSession,
            switchPreset,
            setEffort,
          });
          stdout.write(result.text + "\n");
        } catch (err) {
          stderr.write(`command error: ${(err as Error).message}\n`);
        }
        rl.prompt();
        continue;
      }
      if (pendingResumeNotice) {
        await appendHistoryItem({
          id: `resume_notice_${history.length}`,
          createdAt: new Date().toISOString(),
          role: "developer",
          content: pendingResumeNotice,
        });
        pendingResumeNotice = null;
      }
      const userItem: HistoryItem = {
        id: `user_${history.length}`,
        createdAt: new Date().toISOString(),
        role: "user",
        content: text,
      };
      await appendHistoryItem(userItem);
      try {
        await ensureConversation("turn_start");
        const runStartHistoryLength = history.length;
        const startingHandle = providerHandle;
        const startingDelivered = startingHandle
          ? Math.min(deliveredHistoryLength, runStartHistoryLength)
          : 0;
        const result = await runAgenticTurns({
          adapter,
          systemPrompt: assembled.text,
          initialMessages: history.map(historyToMessageForChat),
          tools: registry.list(),
          toolRegistry: toolMap,
          ctx: ctx as Parameters<typeof runAgenticTurns>[0]["ctx"],
          options: {
            maxTurns: Math.min(10, preset.maxTurns), // chat-mode default cap
            requestOptions: reqOpts,
            startingProviderHandle: startingHandle,
            startingDeliveredHistoryLength: startingDelivered,
            fallbackToLocalReplayOnResumeError: true,
            session: {
              store: sessionStore,
              sessionId: session.sessionId,
              cwd: workspace,
            },
            canUseTool: async ({ classification, gate }) => ({
              kind: "deny",
              reason: `chat approval UI required for ${classification.tier}/${gate.kind}; retry in full_auto or lower-risk form`,
            }),
          },
        });
        // Commit the assistant + tool_result items back into history.
        for (const item of result.history.slice(history.length)) {
          history.push(item);
        }
        providerHandle = result.providerHandle;
        syncConversationFromHandle(providerHandle);
        deliveredHistoryLength = providerHandle ? history.length : 0;
        // Print the model's final text.
        if (result.finalAssistant) {
          const text = extractPlainText(result.finalAssistant.content);
          if (text) stdout.write(text + "\n");
        }
        ctx.usage = addUsage(ctx.usage, result.usage);
        await persistFileState();
      } catch (err) {
        stderr.write(`runtime error: ${(err as Error).message}\n`);
      }
      rl.prompt();
    }
  } finally {
    rl.close();
    try {
      await persistFileState();
    } catch (err) {
      stderr.write(`warning: failed to persist file-state: ${(err as Error).message}\n`);
    }
    await cleanupJobManager(ctx.runId);
    sessionStore.markCompleted(session.sessionId);
    sessionStore.close();
  }
  stdout.write("\n  bye.\n");
  return 0;
}

function extractPlainText(content: HistoryItem["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

function buildChatRegistry(preset: LoadedPreset): ToolRegistryImpl {
  const registry = new ToolRegistryImpl();
  registerBuiltinTools(registry, {
    webSearch: preset.networkEnabled === true,
    repoMap: true,
    symbolIndex: true,
    readAsset: true,
  });
  if (preset.networkEnabled === true) {
    const hasSerper = Boolean(process.env.SERPER_API_KEY);
    const hasSerpApi = Boolean(process.env.SERP_API_KEY ?? process.env.SERPAPI_KEY);
    if (hasSerper || hasSerpApi) {
      setSearchProviderFactory(() => ({
        provider: hasSerper ? new SerperProvider() : new SerpApiProvider(),
        benchmark: preset.benchmarkMode,
      }));
    }
  }
  return registry;
}

async function latestCheckpointForSession(
  checkpointStore: {
    list(sessionId?: string): Promise<Array<{ commitSha: string }>>;
  },
  sessionId: string,
): Promise<{ commitSha: string } | null> {
  try {
    return (await checkpointStore.list(sessionId))[0] ?? null;
  } catch {
    return null;
  }
}

function chatAutonomyForPreset(preset: LoadedPreset): AutonomyLevel {
  return preset.kind === "chat" ? preset.permissionDefaults : "medium";
}

async function assembleForPreset(preset: LoadedPreset, registry: ToolRegistryImpl) {
  const appendixKey =
    preset.provider === "openai"
      ? "openai-gpt-5.4"
      : preset.modelId.includes("sonnet-4-6")
        ? "anthropic-sonnet-4.6"
        : preset.modelId.includes("opus-4-7")
          ? "anthropic-opus-4.7"
          : "anthropic-opus-4.6";
  const promptPaths = resolvePromptPaths(appendixKey);
  return assembleSystemPrompt({
    identityPath: promptPaths.identityPath,
    baseInstructionsPath: promptPaths.baseInstructionsPath,
    providerAppendixPath: promptPaths.providerAppendixPath,
    tools: registry.list().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
  });
}

function historyToMessageForChat(item: HistoryItem): Message {
  const out: Message = {
    role: item.role,
    content: item.content,
  };
  if (item.phase) out.phase = item.phase;
  if (item.providerMetadata) out.providerMetadata = item.providerMetadata;
  return out;
}

type SerializedFileState = ReturnType<FileStateMap["serialize"]>;

function isSerializedFileState(value: unknown): value is SerializedFileState {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { schema_version?: unknown; entries?: unknown };
  return candidate.schema_version === 1 && Array.isArray(candidate.entries);
}

function conversationIdFromHandle(
  handle: ProviderContinuationHandle | null | undefined,
): string | undefined {
  if (!handle) return undefined;
  if (handle.kind === "openai_conversation") return handle.conversationId;
  if (handle.kind === "openai_response" || handle.kind === "openai_compacted") {
    return handle.conversationId;
  }
  return undefined;
}
