/**
 * ATIF v1.6 writer.
 * Locked per §3.4.6 + §5.5 + §3.5.5.
 *
 * Invariants enforced at write time:
 *   - step_id sequential from 1 (must equal array index + 1).
 *   - every `observation.results[i].source_call_id` resolves to a preceding
 *     tool_call_id in the same step (the writer CANNOT check previous-step
 *     references — Harbor's validator does that).
 *   - agent-only fields absent on non-agent steps.
 *   - ContentPart type/source exclusivity.
 *   - redaction applied at write time; never post-hoc.
 *
 * Incremental flush: the writer buffers the current trajectory in memory and
 * writes on every `appendStep()`. This lets Harbor's external kill still find
 * a mostly-complete trajectory.json on disk.
 */

import {
  AGENT_ONLY_STEP_FIELDS,
  ATIF_SCHEMA_VERSION,
  type AtifAgent,
  type AtifFinalMetrics,
  type AtifStep,
  type AtifTrajectory,
} from "@open-apex/core";

import { redactJson } from "./redaction.ts";

export interface AtifWriterOptions {
  sessionId: string;
  agent: AtifAgent;
  outputPath: string;
  /** If false, skip redaction (tests only). Defaults to true. */
  redactOnWrite?: boolean;
  /** Optional overall `notes`. */
  notes?: string;
  /** Optional extra metadata. */
  extra?: Record<string, unknown>;
}

export class AtifWriter {
  private steps: AtifStep[] = [];
  private finalMetrics: AtifFinalMetrics | undefined;
  private readonly opts: AtifWriterOptions;
  /**
   * Transient breadcrumb describing work in flight but not yet represented by
   * an appended step. Lives in `extra.pending_step` on the partial-write
   * trajectory and is cleared on the next `appendStep` or explicit
   * `clearPending()`. Lets SIGSEGV / silent-hang post-mortems see "turn N
   * awaiting model response" even when zero real steps have landed.
   */
  private pendingLabel: string | undefined;
  private pendingSince: string | undefined;

  constructor(opts: AtifWriterOptions) {
    this.opts = opts;
  }

  /**
   * Record a transient "work in progress" marker. Triggers a partial flush
   * so the marker is visible on disk immediately. Called on turn_started,
   * tool dispatch, etc. — anywhere a hang could otherwise leave an empty
   * trajectory file.
   */
  markPending(label: string): void {
    this.pendingLabel = label;
    this.pendingSince = new Date().toISOString();
    void this.flushPartial();
  }

  /**
   * Clear the transient marker. Called just before an `appendStep` for a
   * step that represents the same work, or at end-of-turn when the turn
   * completed normally.
   */
  clearPending(): void {
    this.pendingLabel = undefined;
    this.pendingSince = undefined;
  }

  appendStep(step: Omit<AtifStep, "step_id"> & { step_id?: number }): AtifStep {
    const assignedId = this.steps.length + 1;
    const finalStep: AtifStep = {
      ...step,
      step_id: step.step_id ?? assignedId,
    };
    if (finalStep.step_id !== assignedId) {
      throw new Error(`ATIF step_id invariant: expected ${assignedId}, got ${finalStep.step_id}`);
    }
    if (finalStep.source !== "agent") {
      for (const k of AGENT_ONLY_STEP_FIELDS) {
        if (finalStep[k] !== undefined) {
          throw new Error(`ATIF invariant: non-agent step must not set agent-only field '${k}'`);
        }
      }
    }
    if (finalStep.observation?.results) {
      // Harbor v1.6 invariant (harbor.models.trajectories.trajectory
      // .validate_tool_call_references): `source_call_id` MUST reference a
      // `tool_call_id` in the same step's tool_calls. If the step has no
      // tool_calls, any non-null source_call_id is invalid.
      const callIdsInThisStep = new Set((finalStep.tool_calls ?? []).map((c) => c.tool_call_id));
      for (const r of finalStep.observation.results) {
        if (r.source_call_id && !callIdsInThisStep.has(r.source_call_id)) {
          throw new Error(
            `ATIF invariant: observation.source_call_id '${r.source_call_id}' does not reference any tool_call_id in step ${finalStep.step_id}'s tool_calls (Harbor rejects cross-step references)`,
          );
        }
      }
    }
    this.steps.push(finalStep);
    // A real step landing supersedes any transient pending marker.
    this.pendingLabel = undefined;
    this.pendingSince = undefined;
    // §5.5 incremental flush: write the in-progress trajectory to disk NOW
    // so a SIGSEGV / Harbor kill leaves a forensically-useful file behind.
    // Best-effort: we don't await and swallow errors, because append must
    // never throw on disk pressure and callers expect a synchronous-ish API.
    void this.flushPartial();
    return finalStep;
  }

  /**
   * Best-effort partial write of the trajectory-so-far. Always marks
   * `extra.partial = true` so consumers know it may grow; the final
   * `flush()` rewrites without the partial marker.
   */
  private async flushPartial(): Promise<void> {
    // Flush when we have either real steps OR a pending marker. A
    // pending-only flush is the turn-start breadcrumb case — trajectory.json
    // lands on disk before the model's first response arrives so a hang
    // leaves a non-empty file.
    if (this.steps.length === 0 && this.pendingLabel === undefined) return;
    try {
      let traj: AtifTrajectory;
      if (this.steps.length === 0 && this.pendingLabel !== undefined) {
        // No steps yet — synthesize a sentinel trajectory with a placeholder
        // system step so Harbor's validator can still parse it.
        traj = {
          schema_version: ATIF_SCHEMA_VERSION,
          session_id: this.opts.sessionId,
          agent: this.opts.agent,
          steps: [
            {
              step_id: 1,
              source: "system",
              message: `(awaiting first model response — ${this.pendingLabel})`,
            },
          ],
        };
        if (this.opts.notes !== undefined) traj.notes = this.opts.notes;
        if (this.opts.extra) traj.extra = { ...this.opts.extra };
      } else {
        traj = this.buildTrajectory();
      }
      traj.extra = { ...(traj.extra ?? {}), partial: true };
      if (this.pendingLabel) {
        traj.extra.pending_step = {
          label: this.pendingLabel,
          since: this.pendingSince ?? new Date().toISOString(),
        };
      }
      const redact = this.opts.redactOnWrite !== false;
      const obj = redact ? redactJson(traj) : traj;
      await Bun.write(this.opts.outputPath, JSON.stringify(obj, null, 2) + "\n");
    } catch {
      // swallow — incremental flush is observability, not correctness
    }
  }

  setFinalMetrics(m: AtifFinalMetrics): void {
    this.finalMetrics = m;
  }

  buildTrajectory(): AtifTrajectory {
    if (this.steps.length === 0) {
      throw new Error("ATIF requires at least one step");
    }
    const out: AtifTrajectory = {
      schema_version: ATIF_SCHEMA_VERSION,
      session_id: this.opts.sessionId,
      agent: this.opts.agent,
      steps: this.steps,
    };
    if (this.opts.notes !== undefined) out.notes = this.opts.notes;
    if (this.finalMetrics) out.final_metrics = this.finalMetrics;
    if (this.opts.extra) out.extra = this.opts.extra;
    return out;
  }

  async flush(opts: { partial?: boolean } = {}): Promise<string> {
    if (this.steps.length === 0 && !opts.partial) {
      throw new Error("ATIF requires at least one step before flush");
    }
    if (this.steps.length === 0 && opts.partial) {
      // Emit a minimal trajectory with a sentinel step so Harbor's validator
      // has something to parse; marks it with extra.partial=true.
      this.steps.push({
        step_id: 1,
        source: "system",
        message: "(no steps produced before finalize)",
      });
    }
    const trajectory = this.buildTrajectory();
    if (opts.partial) {
      trajectory.extra = { ...(trajectory.extra ?? {}), partial: true };
    }
    const redact = this.opts.redactOnWrite !== false;
    const finalObj = redact ? redactJson(trajectory) : trajectory;
    await Bun.write(this.opts.outputPath, JSON.stringify(finalObj, null, 2) + "\n");
    return this.opts.outputPath;
  }
}

/**
 * Validate an AtifTrajectory against the Harbor v1.6 Pydantic shape.
 * This is a TypeScript-level pre-flight check; the authoritative validator
 * is `python -m harbor.utils.trajectory_validator`, which CI invokes on
 * every emitted trajectory.
 */
export interface AtifValidationError {
  path: string;
  message: string;
}

export function validateAtifTrajectory(t: AtifTrajectory): AtifValidationError[] {
  const errs: AtifValidationError[] = [];
  if (t.schema_version !== ATIF_SCHEMA_VERSION) {
    errs.push({
      path: "schema_version",
      message: `expected ${ATIF_SCHEMA_VERSION}, got ${t.schema_version}`,
    });
  }
  if (!t.session_id) errs.push({ path: "session_id", message: "required" });
  if (!t.agent || !t.agent.name || !t.agent.version) {
    errs.push({ path: "agent", message: "agent.name and agent.version required" });
  }
  if (!Array.isArray(t.steps) || t.steps.length === 0) {
    errs.push({ path: "steps", message: "min length 1" });
  }
  t.steps?.forEach((s, i) => {
    if (s.step_id !== i + 1) {
      errs.push({
        path: `steps[${i}].step_id`,
        message: `must equal index+1 (${i + 1})`,
      });
    }
    if (!["system", "user", "agent"].includes(s.source)) {
      errs.push({
        path: `steps[${i}].source`,
        message: "must be system | user | agent",
      });
    }
    if (s.source !== "agent") {
      for (const k of AGENT_ONLY_STEP_FIELDS) {
        if (s[k] !== undefined) {
          errs.push({
            path: `steps[${i}].${k}`,
            message: "agent-only field present on non-agent step",
          });
        }
      }
    }
    if (s.tool_calls) {
      for (const c of s.tool_calls) {
        if (!c.tool_call_id) {
          errs.push({
            path: `steps[${i}].tool_calls.tool_call_id`,
            message: "required",
          });
        }
        if (!c.function_name) {
          errs.push({
            path: `steps[${i}].tool_calls.function_name`,
            message: "required",
          });
        }
      }
    }
    // Harbor strict source_call_id invariant (same-step only).
    if (s.observation?.results) {
      const ids = new Set((s.tool_calls ?? []).map((c) => c.tool_call_id));
      s.observation.results.forEach((r, j) => {
        if (r.source_call_id && !ids.has(r.source_call_id)) {
          errs.push({
            path: `steps[${i}].observation.results[${j}].source_call_id`,
            message: `'${r.source_call_id}' not in step ${s.step_id}'s tool_calls (Harbor rejects cross-step refs)`,
          });
        }
      });
    }
  });
  return errs;
}
