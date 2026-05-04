/**
 * M5 slash-command registry.
 *
 * The full Ink presentation layer can render these results as cards/views; the
 * command registry is deliberately UI-agnostic so the line-mode fallback and
 * tests exercise the same product behavior.
 */

import {
  estimateCostUsd,
  type HistoryItem,
  type SessionHandle,
  type SessionStore,
  type TokenUsage,
} from "@open-apex/core";
import type { LoadedPreset } from "@open-apex/config";
import { getJobManager } from "@open-apex/tools";

export interface ChatCommandContext {
  runId: string;
  workspace: string;
  session: SessionHandle;
  sessionStore: SessionStore;
  history: HistoryItem[];
  usage: TokenUsage;
  preset: LoadedPreset;
  autonomyLevel: string;
  setAutonomyLevel(level: string): void;
  resetConversation(reason: string): Promise<void> | void;
  checkpointSave?(name?: string): Promise<string>;
  checkpointRestoreLatest?(): Promise<string>;
  compactSession?(): Promise<CommandResult>;
  resumeSession?(
    sessionId: string,
    mode: "auto" | "continue-current" | "restore-checkpoint" | "abort",
  ): Promise<CommandResult>;
  switchPreset?(presetId: string): Promise<CommandResult>;
  setEffort?(effort: string): Promise<CommandResult> | CommandResult;
}

export interface CommandResult {
  text: string;
  json?: unknown;
}

export type CommandHandler = (
  ctx: ChatCommandContext,
  args: string[],
  opts: { json: boolean },
) => Promise<CommandResult> | CommandResult;

export interface CommandDefinition {
  name: string;
  usage: string;
  description: string;
  handler: CommandHandler;
}

export class CommandRegistry {
  private readonly commands = new Map<string, CommandDefinition>();

  register(def: CommandDefinition): void {
    this.commands.set(def.name, def);
  }

  list(): CommandDefinition[] {
    return [...this.commands.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async execute(line: string, ctx: ChatCommandContext): Promise<CommandResult> {
    const parsed = parseCommandLine(line);
    const def = this.commands.get(parsed.name);
    if (!def) {
      return {
        text: `Unknown command /${parsed.name}. Type /help for available commands.`,
        json: { error: "unknown_command", command: parsed.name },
      };
    }
    return def.handler(ctx, parsed.args, { json: parsed.json });
  }
}

export function createDefaultCommandRegistry(): CommandRegistry {
  const registry = new CommandRegistry();
  registry.register({
    name: "help",
    usage: "/help [command]",
    description: "List commands or show command-specific help.",
    handler: (_ctx, args) => {
      const all = createHelpRows();
      if (args[0]) {
        const row = all.find((r) => r.name === args[0]!.replace(/^\//, ""));
        return {
          text: row
            ? `/${row.name} — ${row.description}\nUsage: ${row.usage}`
            : `No help for ${args[0]}`,
        };
      }
      return {
        text: all.map((r) => `/${r.name.padEnd(11)} ${r.description}`).join("\n"),
        json: all,
      };
    },
  });
  registry.register({
    name: "new",
    usage: "/new",
    description: "Reset conversation/provider state while preserving session artifacts.",
    handler: async (ctx) => {
      await ctx.resetConversation("/new");
      return { text: "Started a new conversation in the same session." };
    },
  });
  registry.register({
    name: "clear",
    usage: "/clear",
    description: "Clear visible conversation history.",
    handler: (ctx) => {
      ctx.history.length = 0;
      return { text: "Cleared chat history for this session." };
    },
  });
  registry.register({
    name: "cost",
    usage: "/cost [--json]",
    description: "Show session cost estimate.",
    handler: (ctx) => {
      const estimate = estimateCostUsd(ctx.preset.modelId, ctx.usage);
      const json = {
        total_cost_usd: estimate.totalUsd,
        input_usd: estimate.inputUsd,
        cached_input_usd: estimate.cachedInputUsd,
        output_usd: estimate.outputUsd,
        provider: ctx.preset.provider,
        model: ctx.preset.modelId,
      };
      return {
        text: `Estimated cost: $${estimate.totalUsd.toFixed(4)} (${ctx.preset.provider}/${ctx.preset.modelId})`,
        json,
      };
    },
  });
  registry.register({
    name: "tokens",
    usage: "/tokens [--json]",
    description: "Show accumulated token usage.",
    handler: (ctx) => {
      const json = ctx.usage;
      return {
        text: `Tokens: input=${ctx.usage.inputTokens} output=${ctx.usage.outputTokens} cached=${ctx.usage.cachedInputTokens ?? 0}`,
        json,
      };
    },
  });
  registry.register({
    name: "timeline",
    usage: "/timeline [--json]",
    description: "Summarize rollout state for the current session.",
    handler: async (ctx) => {
      const snap = await ctx.sessionStore.snapshot(ctx.session.sessionId);
      const json = {
        session_id: snap.meta.session_id,
        history_items: snap.history.length,
        last_provider_handle: snap.lastProviderHandle?.kind ?? null,
        usage: snap.usage,
        timeline: snap.timeline,
        last_compaction: snap.lastCompactionMarker ?? null,
      };
      return {
        text:
          `Timeline: ${snap.history.length} history items, turns=${snap.timeline.turns}, ` +
          `events=${snap.timeline.events}, compactions=${snap.timeline.compactions}, ` +
          `checkpoints=${snap.timeline.checkpoints}, provider=${json.last_provider_handle ?? "none"}`,
        json,
      };
    },
  });
  registry.register({
    name: "checkpoint",
    usage: "/checkpoint [name]",
    description: "Save a named checkpoint through the shadow-git store.",
    handler: async (ctx, args) => {
      if (!ctx.checkpointSave) return { text: "Checkpoint store is unavailable." };
      const sha = await ctx.checkpointSave(args[0]);
      return { text: `Checkpoint saved: ${sha}`, json: { commitSha: sha } };
    },
  });
  registry.register({
    name: "compact",
    usage: "/compact",
    description: "Compact context using provider compaction when available.",
    handler: async (ctx) => {
      if (ctx.compactSession) return ctx.compactSession();
      await ctx.sessionStore.appendRolloutItem(ctx.session.sessionId, {
        type: "compacted",
        payload: {
          trigger: "manual",
          preTokens: ctx.usage.inputTokens,
          postTokens: ctx.usage.inputTokens,
        },
      });
      return { text: "Recorded manual compaction marker for this session." };
    },
  });
  registry.register({
    name: "diff",
    usage: "/diff",
    description: "Show where diff rendering will attach in the full TUI path.",
    handler: () => ({
      text: "Diff view is available through git/tool inspection in this M5 command surface; full inline diff UI is TUI work.",
    }),
  });
  registry.register({
    name: "undo",
    usage: "/undo",
    description: "Restore the latest checkpoint when available.",
    handler: async (ctx) => {
      if (!ctx.checkpointRestoreLatest) return { text: "Undo is unavailable in this session." };
      const report = await ctx.checkpointRestoreLatest();
      return { text: report };
    },
  });
  registry.register({
    name: "permissions",
    usage: "/permissions [readonly|low|medium|high|full_auto]",
    description: "View or change the session autonomy level.",
    handler: (ctx, args) => {
      const next = args[0] ?? ctx.autonomyLevel;
      if (args[0]) ctx.setAutonomyLevel(next);
      return {
        text: `Permissions: ${next}`,
        json: { autonomyLevel: next },
      };
    },
  });
  for (const name of ["provider", "model", "effort"] as const) {
    registry.register({
      name,
      usage: name === "effort" ? `/${name} [level]` : `/${name} [preset-id]`,
      description:
        name === "effort"
          ? "Show or change current effort level."
          : `Show current ${name} or switch via preset id.`,
      handler: async (ctx, args) => {
        if (name === "effort") {
          if (args[0] && ctx.setEffort) return ctx.setEffort(args[0]);
          return { text: `Effort: ${ctx.preset.effort}` };
        }
        if (args[0] && ctx.switchPreset) return ctx.switchPreset(args[0]);
        return {
          text:
            name === "provider"
              ? `Provider: ${ctx.preset.provider}`
              : `Model: ${ctx.preset.modelId}`,
        };
      },
    });
  }
  registry.register({
    name: "jobs",
    usage: "/jobs [--json]",
    description: "List process-local background jobs.",
    handler: (ctx) => {
      const jobs = getJobManager(ctx.runId).list();
      return {
        text:
          jobs.length === 0
            ? "No jobs running."
            : jobs.map((j) => `${j.id} ${j.name} pid=${j.pid}`).join("\n"),
        json: jobs,
      };
    },
  });
  registry.register({
    name: "agents",
    usage: "/agents",
    description: "Show M4/M5 agent roles available through the phase engine.",
    handler: () => ({
      text: "Agents: repo_scout, environment_scout, web_researcher, strategy_planner, exploratory_executor, verifier",
    }),
  });
  registry.register({
    name: "benchmark",
    usage: "/benchmark",
    description: "Show benchmark-clean status without running Harbor or Terminal-Bench.",
    handler: (ctx) => ({
      text: `Benchmark preset=${ctx.preset.presetId}; Harbor/Terminal-Bench are user-gated and not run by chat.`,
    }),
  });
  registry.register({
    name: "resume",
    usage: "/resume [session-id]",
    description: "Load a session snapshot or list recent sessions.",
    handler: async (ctx, args) => {
      if (!args[0]) {
        const sessions = await ctx.sessionStore.listSessions({
          workspace: ctx.workspace,
          limit: 10,
        });
        return {
          text:
            sessions.length === 0
              ? "No sessions found."
              : sessions.map((s) => `${s.sessionId} ${s.updatedAt} ${s.presetId}`).join("\n"),
          json: sessions,
        };
      }
      const sessionId = args[0];
      if (!sessionId) return { text: "Usage: /resume [session-id]" };
      if (ctx.resumeSession) {
        const mode = args.includes("--continue-current")
          ? "continue-current"
          : args.includes("--restore-checkpoint")
            ? "restore-checkpoint"
            : args.includes("--abort")
              ? "abort"
              : "auto";
        return ctx.resumeSession(sessionId, mode);
      }
      const handle = await ctx.sessionStore.loadSession(sessionId);
      return { text: `Loaded session ${handle.sessionId}`, json: handle };
    },
  });
  return registry;
}

export function parseCommandLine(line: string): { name: string; args: string[]; json: boolean } {
  const trimmed = line.trim();
  const body = trimmed.startsWith("/") ? trimmed.slice(1) : trimmed;
  const parts = body.split(/\s+/).filter(Boolean);
  const name = parts.shift() ?? "";
  const json = parts.includes("--json");
  return { name, args: parts.filter((p) => p !== "--json"), json };
}

function createHelpRows(): Array<Pick<CommandDefinition, "name" | "usage" | "description">> {
  const rows: Array<[string, string, string]> = [
    ["new", "/new", "Reset conversation/provider state."],
    ["clear", "/clear", "Clear visible history."],
    ["compact", "/compact", "Compact context when available."],
    ["checkpoint", "/checkpoint [name]", "Save a checkpoint."],
    ["resume", "/resume [session-id]", "Resume or list sessions."],
    ["provider", "/provider", "Show provider."],
    ["model", "/model", "Show model."],
    ["effort", "/effort", "Show effort."],
    ["permissions", "/permissions [level]", "View/change autonomy."],
    ["diff", "/diff", "Show diff in full TUI path."],
    ["undo", "/undo", "Restore latest checkpoint."],
    ["cost", "/cost", "Show cost."],
    ["tokens", "/tokens", "Show tokens."],
    ["timeline", "/timeline", "Show timeline."],
    ["jobs", "/jobs", "List jobs."],
    ["agents", "/agents", "List agent roles."],
    ["benchmark", "/benchmark", "Show benchmark-clean status."],
    ["help", "/help [command]", "Show help."],
  ];
  return rows.map(([name, usage, description]) => ({ name, usage, description }));
}
