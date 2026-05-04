/**
 * FileSystemTelemetrySink — implementation of the §3.4.5 TelemetrySink.
 *
 * Writes incrementally per §5.5: events.jsonl flushed after every emit(),
 * so Harbor's external kill still produces a usable partial trajectory.
 *
 * All writes pass through the §3.5.4 redaction library.
 */

import { mkdir } from "node:fs/promises";
import * as path from "node:path";

import type { AtifTrajectory, OpenApexEvent, SummaryJson, TelemetrySink } from "@open-apex/core";

import { redact, redactJson } from "./redaction.ts";

export interface FileSinkOptions {
  /** Output directory — the run bundle root (§3.4.10). */
  outputDir: string;
  /** If false, bypass redaction (tests only). Defaults to true. */
  redactOnWrite?: boolean;
}

export class FileSystemTelemetrySink implements TelemetrySink {
  private eventSeq = 0;
  private readonly outputDir: string;
  private readonly eventsPath: string;
  private readonly logsDir: string;
  private readonly redact: boolean;
  private writer: Bun.FileSink | null = null;
  private initialized = false;

  constructor(opts: FileSinkOptions) {
    this.outputDir = opts.outputDir;
    this.eventsPath = path.join(this.outputDir, "events.jsonl");
    this.logsDir = path.join(this.outputDir, "logs");
    this.redact = opts.redactOnWrite !== false;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.outputDir, { recursive: true });
    await mkdir(this.logsDir, { recursive: true });
    // §3.4.10 pins the per-run bundle layout. Create every declared path
    // up-front so downstream consumers can open the files without probing
    // for existence.
    await mkdir(path.join(this.logsDir, "tools"), { recursive: true });
    await Bun.write(path.join(this.logsDir, "orchestrator.log"), "");
    await Bun.write(path.join(this.logsDir, "provider.log"), "");
    await mkdir(path.join(this.outputDir, "checkpoints", "manifest"), {
      recursive: true,
    });
    await mkdir(path.join(this.outputDir, "subagents"), { recursive: true });
    this.writer = Bun.file(this.eventsPath).writer();
    this.initialized = true;
  }

  /** Append a line to logs/orchestrator.log (no redaction at call site; caller responsibility). */
  async appendOrchestratorLog(line: string): Promise<void> {
    await this.ensureInitialized();
    const redacted = this.redact ? redact(line) : line;
    const existing = await Bun.file(path.join(this.logsDir, "orchestrator.log")).text();
    await Bun.write(
      path.join(this.logsDir, "orchestrator.log"),
      existing + redacted + (redacted.endsWith("\n") ? "" : "\n"),
    );
  }

  /** Append a line to logs/provider.log. */
  async appendProviderLog(line: string): Promise<void> {
    await this.ensureInitialized();
    const redacted = this.redact ? redact(line) : line;
    const existing = await Bun.file(path.join(this.logsDir, "provider.log")).text();
    await Bun.write(
      path.join(this.logsDir, "provider.log"),
      existing + redacted + (redacted.endsWith("\n") ? "" : "\n"),
    );
  }

  async emit(event: OpenApexEvent): Promise<void> {
    await this.ensureInitialized();
    // Sink owns seq: always re-assign a monotonic value. Caller's seq (if any)
    // is ignored so there's one authoritative ordering per run.
    const enriched: OpenApexEvent = {
      ...event,
      seq: ++this.eventSeq,
    };
    const finalEv = this.redact ? redactJson(enriched) : enriched;
    const line = JSON.stringify(finalEv) + "\n";
    this.writer!.write(line);
    // Flush synchronously so partial artifacts always exist on disk.
    this.writer!.flush();
  }

  async flush(_opts?: { partial: boolean }): Promise<void> {
    if (this.writer) {
      this.writer.flush();
    }
  }

  async writeAtif(trajectory: AtifTrajectory): Promise<string> {
    await this.ensureInitialized();
    const finalObj = this.redact ? redactJson(trajectory) : trajectory;
    const p = path.join(this.outputDir, "trajectory.json");
    await Bun.write(p, JSON.stringify(finalObj, null, 2) + "\n");
    return p;
  }

  async writeReplayLog(markdown: string): Promise<string> {
    await this.ensureInitialized();
    const content = this.redact ? redact(markdown) : markdown;
    const p = path.join(this.outputDir, "replay.md");
    await Bun.write(p, content);
    return p;
  }

  async writeSummary(summary: SummaryJson): Promise<string> {
    await this.ensureInitialized();
    const finalObj = this.redact ? redactJson(summary) : summary;
    const p = path.join(this.outputDir, "summary.json");
    await Bun.write(p, JSON.stringify(finalObj, null, 2) + "\n");
    return p;
  }

  async close(): Promise<void> {
    if (this.writer) {
      this.writer.flush();
      await this.writer.end();
      this.writer = null;
    }
  }
}
