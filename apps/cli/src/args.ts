/**
 * CLI argument parser.
 *
 * Locked contract per §3.3:
 *   open-apex [chat]                        — interactive (default subcommand)
 *   open-apex autonomous
 *        --workspace <path>
 *        (--task-file <path> | --task-stdin)
 *        --preset <id>
 *        --output-dir <path>
 *        [--benchmark]
 *        [--trajectory-schema-version ATIF-v1.4|v1.5|v1.6]
 *        [--max-turns N]
 *   open-apex verify-gate                   — run §0.6 verification gate
 *   open-apex --version
 *   open-apex --help
 *
 * Autonomous mode stdout is reserved for a single final OpenApexResult JSON
 * line. Stderr is progress and human-readable logging.
 */

export type Subcommand = "chat" | "autonomous" | "verify-gate" | "version" | "help";

export interface AutonomousArgs {
  kind: "autonomous";
  workspace: string;
  taskFile?: string;
  taskStdin?: boolean;
  preset: string;
  outputDir: string;
  benchmark: boolean;
  maxTurns?: number;
  trajectorySchemaVersion?: "ATIF-v1.4" | "ATIF-v1.5" | "ATIF-v1.6";
}

export interface ChatArgs {
  kind: "chat";
  workspace?: string;
  preset?: string;
}

export interface VerifyGateArgs {
  kind: "verify-gate";
}

export interface VersionArgs {
  kind: "version";
}

export interface HelpArgs {
  kind: "help";
  topic?: string;
}

export type ParsedArgs = AutonomousArgs | ChatArgs | VerifyGateArgs | VersionArgs | HelpArgs;

export class ArgError extends Error {
  constructor(
    public readonly code: "missing_arg" | "bad_value" | "unknown_flag",
    message: string,
  ) {
    super(message);
    this.name = "ArgError";
  }
}

export function parseArgs(argv: string[]): ParsedArgs {
  // Strip the first two: `bun` and the script path.
  const args = argv.slice(2);

  if (args.length === 0) {
    return { kind: "chat" };
  }

  const first = args[0]!;
  if (first === "--version" || first === "-v") {
    return { kind: "version" };
  }
  if (first === "--help" || first === "-h") {
    const topic = args[1];
    const out: HelpArgs = { kind: "help" };
    if (topic !== undefined) out.topic = topic;
    return out;
  }

  switch (first) {
    case "chat":
      return parseChat(args.slice(1));
    case "autonomous":
      return parseAutonomous(args.slice(1));
    case "verify-gate":
      return { kind: "verify-gate" };
    default:
      // If not a known subcommand, treat as chat with flags.
      return parseChat(args);
  }
}

function parseChat(rest: string[]): ChatArgs {
  const out: ChatArgs = { kind: "chat" };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    switch (a) {
      case "--workspace":
        out.workspace = requireValue(rest, ++i, "--workspace");
        break;
      case "--preset":
        out.preset = requireValue(rest, ++i, "--preset");
        break;
      case "--help":
      case "-h":
        return out;
      default:
        throw new ArgError("unknown_flag", `unknown chat flag: ${a}`);
    }
  }
  return out;
}

function parseAutonomous(rest: string[]): AutonomousArgs {
  let workspace: string | undefined;
  let taskFile: string | undefined;
  let taskStdin = false;
  let preset: string | undefined;
  let outputDir: string | undefined;
  let benchmark = false;
  let maxTurns: number | undefined;
  let trajectorySchemaVersion: AutonomousArgs["trajectorySchemaVersion"];

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    switch (a) {
      case "--workspace":
        workspace = requireValue(rest, ++i, "--workspace");
        break;
      case "--task-file":
        taskFile = requireValue(rest, ++i, "--task-file");
        break;
      case "--task-stdin":
        taskStdin = true;
        break;
      case "--preset":
        preset = requireValue(rest, ++i, "--preset");
        break;
      case "--output-dir":
        outputDir = requireValue(rest, ++i, "--output-dir");
        break;
      case "--benchmark":
        benchmark = true;
        break;
      case "--max-turns": {
        const v = requireValue(rest, ++i, "--max-turns");
        maxTurns = Number.parseInt(v, 10);
        if (!Number.isFinite(maxTurns) || maxTurns < 1) {
          throw new ArgError("bad_value", `--max-turns must be a positive integer, got '${v}'`);
        }
        break;
      }
      case "--trajectory-schema-version": {
        const v = requireValue(rest, ++i, "--trajectory-schema-version");
        if (v !== "ATIF-v1.4" && v !== "ATIF-v1.5" && v !== "ATIF-v1.6") {
          throw new ArgError(
            "bad_value",
            `--trajectory-schema-version must be ATIF-v1.4|v1.5|v1.6, got '${v}'`,
          );
        }
        trajectorySchemaVersion = v;
        break;
      }
      case "--help":
      case "-h":
        return {
          kind: "autonomous",
          workspace: "?",
          preset: "?",
          outputDir: "?",
          benchmark: false,
        };
      default:
        throw new ArgError("unknown_flag", `unknown autonomous flag: ${a}`);
    }
  }

  if (!workspace) {
    throw new ArgError("missing_arg", "autonomous requires --workspace");
  }
  if (!preset) {
    throw new ArgError("missing_arg", "autonomous requires --preset");
  }
  if (!outputDir) {
    throw new ArgError("missing_arg", "autonomous requires --output-dir");
  }
  if (!taskFile && !taskStdin) {
    throw new ArgError(
      "missing_arg",
      "autonomous requires one of --task-file <path> or --task-stdin",
    );
  }
  if (taskFile && taskStdin) {
    throw new ArgError(
      "bad_value",
      "autonomous: --task-file and --task-stdin are mutually exclusive",
    );
  }

  const out: AutonomousArgs = {
    kind: "autonomous",
    workspace,
    preset,
    outputDir,
    benchmark,
  };
  if (taskFile !== undefined) out.taskFile = taskFile;
  if (taskStdin) out.taskStdin = true;
  if (maxTurns !== undefined) out.maxTurns = maxTurns;
  if (trajectorySchemaVersion !== undefined) out.trajectorySchemaVersion = trajectorySchemaVersion;
  return out;
}

function requireValue(rest: string[], idx: number, flag: string): string {
  if (idx >= rest.length || !rest[idx] || rest[idx]!.startsWith("--")) {
    throw new ArgError("missing_arg", `flag ${flag} requires a value`);
  }
  return rest[idx]!;
}
