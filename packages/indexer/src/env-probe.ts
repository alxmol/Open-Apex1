/**
 * Environment intelligence probes. Output feeds §3.4.4 `EnvScoutResult`.
 *
 * Everything runs through subprocess primitives that are `READ_ONLY` under
 * §7.6.1 when invoked from the main tool loop. We don't import the permission
 * classifier here — env-probe is one entrypoint ahead of the classifier, so
 * callers decide whether probe output is exposed to the model or used for
 * internal `<environment_context>` enrichment.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";

export interface EnvProbeResult {
  installedPackages: Array<{ manager: string; packages: string[] }>;
  runningProcesses: string[];
  diskFree: string;
  memoryFree: string;
  runtimeVersions: Record<string, string>;
  containerContext?: string;
  probeErrors: string[];
}

export interface EnvProbeOpts {
  workspace: string;
  /** Cap number of top-level entries harvested from each probe source. */
  maxEntries?: number;
  /** Override `Bun.spawn` for tests. */
  spawn?: typeof Bun.spawn;
  /** Signal to abort the probe (each subprocess gets the linked signal). */
  signal?: AbortSignal;
}

const DEFAULT_MAX_ENTRIES = 50;
const TIMEOUT_MS = 5_000;

export async function probeEnvironment(opts: EnvProbeOpts): Promise<EnvProbeResult> {
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const spawn = opts.spawn ?? Bun.spawn;
  const errors: string[] = [];
  const runtimeVersions: Record<string, string> = {};

  async function runCaptured(argv: string[]): Promise<string | null> {
    try {
      const ac = new AbortController();
      const composite = linkSignals(opts.signal, ac.signal);
      const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
      try {
        const proc = spawn(argv, {
          stdout: "pipe",
          stderr: "pipe",
          env: process.env,
          cwd: opts.workspace,
        });
        const abortHandler = () => proc.kill();
        composite.addEventListener("abort", abortHandler, { once: true });
        const out = await new Response(proc.stdout).text();
        await proc.exited;
        if ((proc.exitCode ?? 0) !== 0) return null;
        return out;
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      errors.push(`${argv[0]}: ${(err as Error).message}`);
      return null;
    }
  }

  // Runtime versions — cheap, one subprocess per runtime, run in parallel.
  const runtimeProbes: Array<[string, string[]]> = [
    ["python", ["python3", "--version"]],
    ["node", ["node", "--version"]],
    ["bun", ["bun", "--version"]],
    ["rust", ["rustc", "--version"]],
    ["go", ["go", "version"]],
    ["java", ["java", "-version"]],
    ["ruby", ["ruby", "--version"]],
    ["git", ["git", "--version"]],
  ];
  const versionResults = await Promise.all(
    runtimeProbes.map(async ([k, argv]) => [k, await runCaptured(argv)] as const),
  );
  for (const [k, raw] of versionResults) {
    if (raw) runtimeVersions[k] = firstNonEmptyLine(raw);
  }

  // Installed packages via whichever manifest is present.
  const installedPackages: EnvProbeResult["installedPackages"] = [];
  if (existsSync(path.join(opts.workspace, "package.json"))) {
    const out = await runCaptured(["npm", "ls", "--json", "--depth=0"]);
    if (out) {
      try {
        const parsed = JSON.parse(out) as { dependencies?: Record<string, unknown> };
        const pkgs = Object.keys(parsed.dependencies ?? {}).slice(0, maxEntries);
        if (pkgs.length > 0) installedPackages.push({ manager: "npm", packages: pkgs });
      } catch (err) {
        errors.push(`npm-json: ${(err as Error).message}`);
      }
    }
  }
  if (
    existsSync(path.join(opts.workspace, "pyproject.toml")) ||
    existsSync(path.join(opts.workspace, "requirements.txt"))
  ) {
    const out = await runCaptured(["pip", "list", "--format=json"]);
    if (out) {
      try {
        const parsed = JSON.parse(out) as Array<{ name: string }>;
        installedPackages.push({
          manager: "pip",
          packages: parsed.slice(0, maxEntries).map((p) => p.name),
        });
      } catch (err) {
        errors.push(`pip-list: ${(err as Error).message}`);
      }
    }
  }
  if (existsSync(path.join(opts.workspace, "Cargo.toml"))) {
    const out = await runCaptured(["cargo", "metadata", "--format-version=1", "--no-deps"]);
    if (out) {
      try {
        const parsed = JSON.parse(out) as {
          packages?: Array<{ name?: string }>;
        };
        const pkgs = (parsed.packages ?? []).map((p) => p.name ?? "").filter(Boolean);
        if (pkgs.length > 0) installedPackages.push({ manager: "cargo", packages: pkgs });
      } catch (err) {
        errors.push(`cargo-metadata: ${(err as Error).message}`);
      }
    }
  }

  // Disk + memory — cross-platform best-effort.
  const diskFreeRaw = (await runCaptured(["df", "-h", opts.workspace])) ?? "";
  const diskFree = summarizeDf(diskFreeRaw);
  const memFreeRaw =
    process.platform === "darwin"
      ? ((await runCaptured(["vm_stat"])) ?? "")
      : ((await runCaptured(["free", "-h"])) ?? "");
  const memoryFree = summarizeMemory(memFreeRaw);

  // Running processes — top 10 by CPU.
  const psOut = (await runCaptured(["ps", "ax", "-o", "pid,comm,%cpu"])) ?? "";
  const runningProcesses = summarizeProcesses(psOut, maxEntries);

  const containerContext = detectContainerContext();

  const result: EnvProbeResult = {
    installedPackages,
    runningProcesses,
    diskFree,
    memoryFree,
    runtimeVersions,
    probeErrors: errors,
  };
  if (containerContext) result.containerContext = containerContext;
  return result;
}

function firstNonEmptyLine(s: string): string {
  return (
    s
      .split(/\r?\n/)
      .find((l) => l.trim().length > 0)
      ?.trim() ?? s.trim()
  );
}

function summarizeDf(raw: string): string {
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) return "(unavailable)";
  const header = lines[0]!.split(/\s+/);
  const data = lines[lines.length - 1]!.split(/\s+/);
  // `df -h` columns: Filesystem Size Used Avail Use% Mounted on
  const availIdx = Math.max(
    0,
    header.findIndex((h) => /avail/i.test(h)),
  );
  const availValue = data[availIdx] ?? data[3] ?? "?";
  return `${availValue} available`;
}

function summarizeMemory(raw: string): string {
  if (!raw) return "(unavailable)";
  if (/Pages free:/.test(raw)) {
    const m = raw.match(/Pages free:\s+(\d+)/);
    if (m) {
      const pages = Number(m[1]);
      const mb = (pages * 4096) / (1024 * 1024);
      return `${mb.toFixed(0)} MiB free (approx)`;
    }
  }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  // Linux `free -h`: line[0] is header, line[1] is Mem:, col 3 is free.
  if (lines.length >= 2 && lines[1]!.trimStart().startsWith("Mem:")) {
    const parts = lines[1]!.trim().split(/\s+/);
    return `${parts[3] ?? "?"} free`;
  }
  return firstNonEmptyLine(raw);
}

function summarizeProcesses(raw: string, cap: number): string[] {
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.length <= 1) return [];
  const header = lines[0]!;
  const entries = lines.slice(1).map((l) => {
    const parts = l.trim().split(/\s+/);
    const pid = parts[0] ?? "?";
    const comm = parts[1] ?? "?";
    const cpu = parts[2] ?? "0";
    return { pid, comm, cpu: Number(cpu) || 0 };
  });
  entries.sort((a, b) => b.cpu - a.cpu);
  return [header, ...entries.slice(0, cap).map((e) => `${e.pid}\t${e.comm}\t${e.cpu}%`)];
}

function detectContainerContext(): string | undefined {
  if (process.env.KUBERNETES_SERVICE_HOST) return "kubernetes";
  try {
    if (statSync("/.dockerenv").isFile()) return "docker";
  } catch {
    /* not docker */
  }
  try {
    const cgroup = readFileSync("/proc/1/cgroup", "utf8");
    if (/docker|kubepods|containerd/.test(cgroup)) return "container";
  } catch {
    /* not linux / not readable */
  }
  return undefined;
}

function linkSignals(a: AbortSignal | undefined, b: AbortSignal): AbortSignal {
  if (!a) return b;
  const ac = new AbortController();
  const abort = () => ac.abort();
  if (a.aborted) ac.abort(a.reason);
  if (b.aborted) ac.abort(b.reason);
  a.addEventListener("abort", abort, { once: true });
  b.addEventListener("abort", abort, { once: true });
  return ac.signal;
}
