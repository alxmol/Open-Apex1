/**
 * Scheduler-level classifier gate: verifies that shell-kind tool calls
 * flow through \u00a77.6.1 classifier + autonomy gate before dispatch.
 * Regression for the M2 wiring at packages/runtime/src/tool-loop.ts.
 *
 * Covers:
 *   - CATASTROPHIC argv → `denied` tool result, execute() never called.
 *   - DESTRUCTIVE argv in `full_auto` → allowed, execute() runs.
 *   - `permission_decision` event is emitted with classification + gate.
 *   - Non-shell tools are gated via their permissionClass.
 *   - shell_command argv wrapped via login shell for classification.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import { readAssetTool, runShellTool, writeFileTool } from "@open-apex/tools";
import type {
  AutonomyLevel,
  OpenApexContext,
  OpenApexRunContext,
  ToolCallRequest,
  ToolDefinition,
} from "@open-apex/core";

import { executeToolBatch, type SchedulerEvent } from "../src/tool-loop.ts";

function mkCtx(autonomy: AutonomyLevel = "full_auto"): OpenApexRunContext {
  const ws = mkdtempSync(path.join(tmpdir(), "oa-sched-class-"));
  const userContext: OpenApexContext = {
    workspace: ws,
    openApexHome: path.join(ws, ".open-apex"),
    autonomyLevel: autonomy,
    sessionId: "scheduler-class-test",
  };
  return {
    userContext,
    runId: "r",
    signal: new AbortController().signal,
    usage: { inputTokens: 0, outputTokens: 0 },
  };
}

function mockShellTool(name: string, onExecute?: () => void): ToolDefinition {
  return {
    name,
    description: "mock shell",
    kind: "shell",
    parameters: { type: "object" },
    permissionClass: "CLASSIFIED",
    errorCodes: [] as const,
    async execute() {
      onExecute?.();
      return { content: { ok: true } };
    },
  } as unknown as ToolDefinition;
}

function mockFetchUrlTool(): ToolDefinition {
  return {
    name: "fetch_url",
    description: "mock fetch",
    kind: "function",
    parameters: {
      type: "object",
      required: ["url"],
      additionalProperties: false,
      properties: {
        url: { type: "string", minLength: 4 },
        method: { enum: ["GET", "HEAD"] },
      },
    },
    permissionClass: "READ_ONLY_NETWORK",
    errorCodes: [] as const,
    async execute() {
      return { content: { ok: true } };
    },
  } as unknown as ToolDefinition;
}

describe("tool-loop classifier gate (\u00a77.6.1 + \u00a73.4.13)", () => {
  test("CATASTROPHIC argv is denied; execute() never called; tool_called emitted with real name (plan Fix 5)", async () => {
    const ctx = mkCtx("full_auto");
    let executed = 0;
    const tool = mockShellTool("run_shell", () => {
      executed++;
    });
    const events: SchedulerEvent[] = [];
    const call: ToolCallRequest = {
      id: "c1",
      name: "run_shell",
      arguments: { argv: ["rm", "-rf", "/"] },
    };
    const [r] = await executeToolBatch([call], new Map([["run_shell", tool]]), ctx, {
      onEvent: (ev) => events.push(ev),
    });
    expect(r!.status).toBe("denied");
    expect(r!.errorType).toBe("permission_denied");
    expect(executed).toBe(0);
    const decision = events.find((e) => e.type === "permission_decision");
    expect(decision).toBeDefined();
    if (decision?.type === "permission_decision") {
      expect(decision.classification.tier).toBe("CATASTROPHIC");
      expect(decision.gate.kind).toBe("reject");
      expect(decision.outcome).toBe("deny");
    }
    // tb2-smoke regression: deny-path must still emit `tool_called` so
    // telemetry records the tool name alongside call_id. Assert the
    // ordering explicitly: tool_called → permission_decision → tool_output.
    const myEvents = events.filter(
      (e) =>
        e.type === "tool_called" || e.type === "permission_decision" || e.type === "tool_output",
    );
    expect(myEvents.map((e) => e.type)).toEqual([
      "tool_called",
      "permission_decision",
      "tool_output",
    ]);
    const called = myEvents[0]!;
    if (called.type === "tool_called") {
      expect(called.call.id).toBe("c1");
      expect(called.call.name).toBe("run_shell");
    }
  });

  test("DESTRUCTIVE argv under full_auto is allowed and executes", async () => {
    const ctx = mkCtx("full_auto");
    let executed = 0;
    const tool = mockShellTool("run_shell", () => {
      executed++;
    });
    const events: SchedulerEvent[] = [];
    const call: ToolCallRequest = {
      id: "c2",
      name: "run_shell",
      arguments: { argv: ["rm", "file.txt"] }, // DESTRUCTIVE but not CATASTROPHIC
    };
    const [r] = await executeToolBatch([call], new Map([["run_shell", tool]]), ctx, {
      onEvent: (ev) => events.push(ev),
    });
    expect(r!.status).toBe("ok");
    expect(executed).toBe(1);
    const decision = events.find((e) => e.type === "permission_decision");
    if (decision?.type === "permission_decision") {
      expect(decision.classification.tier).toBe("DESTRUCTIVE");
      expect(decision.gate.kind).toBe("auto");
      expect(decision.outcome).toBe("allow");
    }
  });

  test("DESTRUCTIVE argv under low autonomy + no canUseTool callback → denied; tool_called emitted (plan Fix 5)", async () => {
    const ctx = mkCtx("low");
    let executed = 0;
    const tool = mockShellTool("run_shell", () => {
      executed++;
    });
    const events: SchedulerEvent[] = [];
    const call: ToolCallRequest = {
      id: "c3",
      name: "run_shell",
      arguments: { argv: ["rm", "file.txt"] },
    };
    const [r] = await executeToolBatch([call], new Map([["run_shell", tool]]), ctx, {
      onEvent: (ev) => events.push(ev),
    });
    expect(r!.status).toBe("denied");
    expect(executed).toBe(0);
    // canUseTool-deny path also emits tool_called before the deny pair.
    const sequence = events
      .filter(
        (e) =>
          e.type === "tool_called" || e.type === "permission_decision" || e.type === "tool_output",
      )
      .map((e) => e.type);
    expect(sequence).toEqual(["tool_called", "permission_decision", "tool_output"]);
  });

  test("MUTATING argv under medium + canUseTool allow → runs", async () => {
    const ctx = mkCtx("medium");
    let executed = 0;
    const tool = mockShellTool("run_shell", () => {
      executed++;
    });
    const call: ToolCallRequest = {
      id: "c4",
      name: "run_shell",
      arguments: { argv: ["npm", "install", "-g", "something"] },
    };
    const [r] = await executeToolBatch([call], new Map([["run_shell", tool]]), ctx, {
      canUseTool: async () => ({ kind: "allow" }),
    });
    expect(r!.status).toBe("ok");
    expect(executed).toBe(1);
  });

  test("READ_ONLY non-shell tool auto-runs and emits permission_decision", async () => {
    const ctx = mkCtx("full_auto");
    let executed = 0;
    const fnTool: ToolDefinition = {
      name: "noop",
      description: "noop",
      kind: "function",
      parameters: { type: "object" },
      permissionClass: "READ_ONLY",
      errorCodes: [] as const,
      async execute() {
        executed++;
        return { content: "ok" };
      },
    } as unknown as ToolDefinition;
    const events: SchedulerEvent[] = [];
    const call: ToolCallRequest = { id: "c5", name: "noop", arguments: {} };
    const [r] = await executeToolBatch([call], new Map([["noop", fnTool]]), ctx, {
      onEvent: (ev) => events.push(ev),
    });
    expect(r!.status).toBe("ok");
    expect(executed).toBe(1);
    const decision = events.find((e) => e.type === "permission_decision");
    expect(decision).toBeDefined();
    if (decision?.type === "permission_decision") {
      expect(decision.classification.tier).toBe("READ_ONLY");
      expect(decision.gate.kind).toBe("auto");
      expect(decision.outcome).toBe("allow");
    }
  });

  test("DESTRUCTIVE non-shell tool under readonly is denied and never executes", async () => {
    const ctx = mkCtx("readonly");
    let executed = 0;
    const fnTool: ToolDefinition = {
      name: "danger_fn",
      description: "danger",
      kind: "function",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      permissionClass: "DESTRUCTIVE",
      errorCodes: [] as const,
      async execute() {
        executed++;
        return { content: "should not run" };
      },
    } as unknown as ToolDefinition;
    const events: SchedulerEvent[] = [];
    const call: ToolCallRequest = { id: "danger", name: "danger_fn", arguments: {} };
    const [r] = await executeToolBatch([call], new Map([["danger_fn", fnTool]]), ctx, {
      onEvent: (ev) => events.push(ev),
    });
    expect(r!.status).toBe("denied");
    expect(r!.errorType).toBe("permission_denied");
    expect(executed).toBe(0);
    expect(
      events
        .filter(
          (e) =>
            e.type === "tool_called" ||
            e.type === "permission_decision" ||
            e.type === "tool_output",
        )
        .map((e) => e.type),
    ).toEqual(["tool_called", "permission_decision", "tool_output"]);
  });

  test("REVERSIBLE non-shell tool auto-runs at medium but requires callback at low", async () => {
    const tool: ToolDefinition = {
      name: "edit_fn",
      description: "edit",
      kind: "editor",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      permissionClass: "REVERSIBLE",
      errorCodes: [] as const,
      async execute() {
        return { content: "edited" };
      },
    } as unknown as ToolDefinition;

    const medium = await executeToolBatch(
      [{ id: "medium", name: "edit_fn", arguments: {} }],
      new Map([["edit_fn", tool]]),
      mkCtx("medium"),
    );
    expect(medium[0]!.status).toBe("ok");

    const lowDenied = await executeToolBatch(
      [{ id: "low-deny", name: "edit_fn", arguments: {} }],
      new Map([["edit_fn", tool]]),
      mkCtx("low"),
    );
    expect(lowDenied[0]!.status).toBe("denied");

    const lowAllowed = await executeToolBatch(
      [{ id: "low-allow", name: "edit_fn", arguments: {} }],
      new Map([["edit_fn", tool]]),
      mkCtx("low"),
      { canUseTool: async () => ({ kind: "allow" }) },
    );
    expect(lowAllowed[0]!.status).toBe("ok");
  });

  test("fetch_url is classified by URL/method/domain policy before execution", async () => {
    const ctx = mkCtx("full_auto");
    (ctx.userContext as { networkEnabled?: boolean }).networkEnabled = true;
    (ctx.userContext as { allowedDomains?: string[] }).allowedDomains = ["docs.python.org"];
    const tool = mockFetchUrlTool();
    const events: SchedulerEvent[] = [];
    const calls: ToolCallRequest[] = [
      { id: "allowed-get", name: "fetch_url", arguments: { url: "https://docs.python.org/3/" } },
      {
        id: "allowed-head",
        name: "fetch_url",
        arguments: { url: "https://docs.python.org/3/", method: "HEAD" },
      },
      { id: "other-get", name: "fetch_url", arguments: { url: "https://example.com/" } },
    ];
    const results = await executeToolBatch(calls, new Map([["fetch_url", tool]]), ctx, {
      onEvent: (e) => events.push(e),
    });
    expect(results.every((r) => r.status === "ok")).toBe(true);
    const decisions = events.filter((e) => e.type === "permission_decision");
    expect(decisions).toHaveLength(3);
    const tiers = decisions.map((e) =>
      e.type === "permission_decision" ? e.classification.tier : "",
    );
    expect(tiers).toEqual(["READ_ONLY_NETWORK", "READ_ONLY_NETWORK", "MUTATING"]);
  });

  test("fetch_url becomes MUTATING when network is disabled", async () => {
    const ctx = mkCtx("full_auto");
    (ctx.userContext as { networkEnabled?: boolean }).networkEnabled = false;
    (ctx.userContext as { allowedDomains?: string[] }).allowedDomains = ["docs.python.org"];
    const events: SchedulerEvent[] = [];
    const [r] = await executeToolBatch(
      [{ id: "net-off", name: "fetch_url", arguments: { url: "https://docs.python.org/3/" } }],
      new Map([["fetch_url", mockFetchUrlTool()]]),
      ctx,
      { onEvent: (e) => events.push(e) },
    );
    expect(r!.status).toBe("ok");
    const decision = events.find((e) => e.type === "permission_decision");
    if (decision?.type === "permission_decision") {
      expect(decision.classification.tier).toBe("MUTATING");
      expect(decision.classification.rule).toBe("network_disabled");
    }
  });

  test("shell_command wraps its `command` through login shell for classification", async () => {
    const ctx = mkCtx("full_auto");
    const events: SchedulerEvent[] = [];
    const tool = mockShellTool("shell_command");
    const call: ToolCallRequest = {
      id: "c6",
      name: "shell_command",
      arguments: { command: "rm -rf /" }, // CATASTROPHIC via wrapped argv
    };
    const [r] = await executeToolBatch([call], new Map([["shell_command", tool]]), ctx, {
      onEvent: (ev) => events.push(ev),
    });
    expect(r!.status).toBe("denied");
    const decision = events.find((e) => e.type === "permission_decision");
    if (decision?.type === "permission_decision") {
      expect(decision.classification.tier).toBe("CATASTROPHIC");
    }
  });

  test("UNKNOWN argv under full_auto without sandbox/callback is denied, not auto-run", async () => {
    const ctx = mkCtx("full_auto");
    let executed = 0;
    const tool = mockShellTool("run_shell", () => {
      executed++;
    });
    const call: ToolCallRequest = {
      id: "c7",
      name: "run_shell",
      arguments: { argv: ["totally-unknown-open-apex-test-binary"] },
    };
    const [r] = await executeToolBatch([call], new Map([["run_shell", tool]]), ctx);
    expect(r!.status).toBe("denied");
    expect(r!.errorType).toBe("permission_denied");
    expect(executed).toBe(0);
  });

  test("generated local executable paths under workspace or /tmp are allowed in full_auto", async () => {
    const ctx = mkCtx("full_auto");
    let executed = 0;
    const tool = mockShellTool("run_shell", () => {
      executed++;
    });
    const events: SchedulerEvent[] = [];
    const absWorkspaceTool = path.join(ctx.userContext.workspace, "build", "tool");
    const calls: ToolCallRequest[] = [
      { id: "local-rel", name: "run_shell", arguments: { argv: ["./src/program"] } },
      { id: "local-abs", name: "run_shell", arguments: { argv: [absWorkspaceTool] } },
      { id: "local-tmp", name: "run_shell", arguments: { argv: ["/tmp/bookforum"] } },
      {
        id: "local-shell",
        name: "shell_command",
        arguments: { command: "cd /app && ./src/program 2>&1" },
      },
    ];

    const results = await executeToolBatch(
      calls,
      new Map([
        ["run_shell", tool],
        ["shell_command", tool],
      ]),
      ctx,
      {
        onEvent: (e) => events.push(e),
      },
    );

    expect(results.every((r) => r.status === "ok")).toBe(true);
    expect(executed).toBe(calls.length);
    const decisions = events.filter((e) => e.type === "permission_decision");
    expect(decisions).toHaveLength(calls.length);
    for (const decision of decisions) {
      if (decision.type === "permission_decision") {
        expect(decision.classification.tier).toBe("MUTATING");
        expect(decision.gate.kind).toBe("auto");
        expect(decision.outcome).toBe("allow");
      }
    }
  });

  test("permission-denied tool output keeps denied status for telemetry consumers", async () => {
    const ctx = mkCtx("full_auto");
    const events: SchedulerEvent[] = [];
    const tool = mockShellTool("run_shell", () => {
      throw new Error("should not execute");
    });
    const call: ToolCallRequest = {
      id: "c8",
      name: "run_shell",
      arguments: { argv: ["unknown-tb-tool"] },
    };
    const [r] = await executeToolBatch([call], new Map([["run_shell", tool]]), ctx, {
      onEvent: (e) => events.push(e),
    });
    const out = events.find((e) => e.type === "tool_output");
    expect(r!.status).toBe("denied");
    if (out?.type === "tool_output") {
      expect(out.result.status).toBe("denied");
      expect(out.result.errorType).toBe("permission_denied");
    }
  });

  test("malformed write_file args return bad_args before tool execution", async () => {
    const ctx = mkCtx("full_auto");
    const events: SchedulerEvent[] = [];
    const call: ToolCallRequest = {
      id: "bad-write",
      name: "write_file",
      arguments: {},
    };
    const [r] = await executeToolBatch(
      [call],
      new Map([["write_file", writeFileTool as unknown as ToolDefinition]]),
      ctx,
      { onEvent: (e) => events.push(e) },
    );

    expect(r!.status).toBe("error");
    expect(r!.errorType).toBe("bad_args");
    expect(r!.content).toContain("write_file.path is required string");
    expect(r!.content).toContain("write_file.content is required string");
    expect(events.map((e) => e.type)).toEqual(["tool_called", "tool_output"]);
  });

  test("malformed run_shell args return bad_args before classifier or execution", async () => {
    const ctx = mkCtx("full_auto");
    const events: SchedulerEvent[] = [];
    const call: ToolCallRequest = {
      id: "bad-shell",
      name: "run_shell",
      arguments: {},
    };
    const [r] = await executeToolBatch(
      [call],
      new Map([["run_shell", runShellTool as unknown as ToolDefinition]]),
      ctx,
      { onEvent: (e) => events.push(e) },
    );

    expect(r!.status).toBe("error");
    expect(r!.errorType).toBe("bad_args");
    expect(r!.content).toContain("run_shell.argv is required array");
    expect(events.some((e) => e.type === "permission_decision")).toBe(false);
  });

  test("unknown extra args are rejected instead of reaching tool execution", async () => {
    const ctx = mkCtx("full_auto");
    const call: ToolCallRequest = {
      id: "extra-write",
      name: "write_file",
      arguments: { path: "a.txt", content: "ok\n", __recovery: true },
    };
    const [r] = await executeToolBatch(
      [call],
      new Map([["write_file", writeFileTool as unknown as ToolDefinition]]),
      ctx,
    );

    expect(r!.status).toBe("error");
    expect(r!.errorType).toBe("bad_args");
    expect(r!.content).toContain("write_file.__recovery is not allowed");
  });

  test("read_asset budget denies the 5th same-turn asset", async () => {
    const ctx = mkCtx("full_auto");
    for (let i = 1; i <= 5; i++) {
      writeFileSync(path.join(ctx.userContext.workspace, `img${i}.png`), Buffer.from("png"));
    }
    const calls: ToolCallRequest[] = Array.from({ length: 5 }, (_, idx) => ({
      id: `asset-${idx + 1}`,
      name: "read_asset",
      arguments: { path: `img${idx + 1}.png` },
    }));
    const results = await executeToolBatch(
      calls,
      new Map([["read_asset", readAssetTool as unknown as ToolDefinition]]),
      ctx,
    );
    expect(results.slice(0, 4).every((r) => r.status === "ok")).toBe(true);
    expect(results[4]!.status).toBe("error");
    expect(results[4]!.errorType).toBe("asset_budget_exceeded");
  });

  test("read_asset budget denies over-20MiB aggregate even when each file is under 10MiB", async () => {
    const ctx = mkCtx("full_auto");
    for (let i = 1; i <= 3; i++) {
      writeFileSync(
        path.join(ctx.userContext.workspace, `large${i}.png`),
        Buffer.alloc(7 * 1024 * 1024),
      );
    }
    const calls: ToolCallRequest[] = [1, 2, 3].map((idx) => ({
      id: `large-${idx}`,
      name: "read_asset",
      arguments: { path: `large${idx}.png` },
    }));
    const results = await executeToolBatch(
      calls,
      new Map([["read_asset", readAssetTool as unknown as ToolDefinition]]),
      ctx,
    );
    expect(results[0]!.status).toBe("ok");
    expect(results[1]!.status).toBe("ok");
    expect(results[2]!.status).toBe("error");
    expect(results[2]!.errorType).toBe("asset_budget_exceeded");
  });
});
