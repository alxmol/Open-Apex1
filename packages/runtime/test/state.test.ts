import { describe, expect, test } from "bun:test";

import {
  isLegalTransition,
  isTerminal,
  OrchestratorImpl,
  RunnerImpl,
  STATE_TRANSITIONS,
} from "../src/index.ts";

describe("Orchestrator state-transition table (§3.4.11 invariants)", () => {
  test("idle → preparing_turn is legal; idle → executing_tools is not", () => {
    expect(isLegalTransition("idle", "preparing_turn")).toBe(true);
    expect(isLegalTransition("idle", "executing_tools")).toBe(false);
  });

  test("terminal states have no outgoing transitions", () => {
    for (const t of ["done_final", "done_error", "cancelled"] as const) {
      expect(isTerminal(t)).toBe(true);
      expect(STATE_TRANSITIONS[t]).toEqual([]);
    }
  });

  test("switching_agent is transient: only leads to preparing_turn (invariant 4)", () => {
    expect(STATE_TRANSITIONS.switching_agent).toEqual(["preparing_turn"]);
  });

  test("executing_tools can fold back into preparing_turn OR route to done/cancelled", () => {
    const exits = STATE_TRANSITIONS.executing_tools;
    expect(exits).toContain("preparing_turn");
    expect(exits).toContain("done_final");
    expect(exits).toContain("cancelled");
  });
});

describe("OrchestratorImpl M0 contract", () => {
  test("starts in 'idle' state with currentTurn=0 (invariant 1)", () => {
    const o = new OrchestratorImpl();
    expect(o.state).toBe("idle");
    expect(o.currentTurn).toBe(0);
  });

  test("interrupt() transitions to 'cancelled' without throwing", async () => {
    const o = new OrchestratorImpl();
    await o.interrupt();
    expect(o.state).toBe("cancelled");
  });

  test("run() returns an async-iterable whose .result rejects with M1 pointer", async () => {
    const o = new OrchestratorImpl();
    const agent = { name: "test", instructions: "test" } as never;
    const iter = o.run(agent, "hello");
    let threw = false;
    try {
      await iter.result;
    } catch (err) {
      threw = true;
      expect((err as Error).message).toContain("Milestone 1");
    }
    expect(threw).toBe(true);
  });

  test("snapshotState round-trips through JSON", () => {
    const o = new OrchestratorImpl();
    const s = o.snapshotState();
    expect(s.version).toBe(1);
    const j = JSON.parse(JSON.stringify(s));
    expect(j.version).toBe(1);
    expect(j.currentTurn).toBe(0);
  });
});

describe("RunnerImpl M0 contract", () => {
  test("non-streaming run() returns a rejected promise with M1 pointer", async () => {
    const r = new RunnerImpl();
    const agent = { name: "test", instructions: "test" } as never;
    let threw = false;
    try {
      await r.run(agent, "hello");
    } catch (err) {
      threw = true;
      expect((err as Error).message).toContain("Milestone 1");
    }
    expect(threw).toBe(true);
  });

  test("streaming run() returns iterable whose .result rejects", async () => {
    const r = new RunnerImpl();
    const agent = { name: "test", instructions: "test" } as never;
    const iter = r.run(agent, "hello", { stream: true });
    let threw = false;
    try {
      await iter.result;
    } catch (err) {
      threw = true;
      expect((err as Error).message).toContain("Milestone 1");
    }
    expect(threw).toBe(true);
  });

  test("config is frozen (immutable)", () => {
    const r = new RunnerImpl({ maxTurns: 100 });
    expect(r.config.maxTurns).toBe(100);
    expect(() => ((r.config as any).maxTurns = 200)).toThrow();
  });
});
