/**
 * CLI entrypoint logic (library form — `bin.ts` calls this with argv).
 */

import { ExitCodes, type ExitCode } from "@open-apex/core";

import { parseArgs, ArgError, type ParsedArgs } from "./args.ts";
import { runAutonomous } from "./autonomous.ts";
import { runChat } from "./chat.ts";
import { helpForTopic, HELP_TEXT } from "./help.ts";

const CLI_VERSION = "0.0.1";

export interface RunCliOptions {
  argv: string[];
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  /** Test-only injection hooks (adapter, skipValidation). */
  deps?: import("./autonomous.ts").AutonomousDependencies;
}

export async function runCli(opts: RunCliOptions): Promise<ExitCode> {
  const stdout = opts.stdout ?? process.stdout;
  const stderr = opts.stderr ?? process.stderr;
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(opts.argv);
  } catch (err) {
    if (err instanceof ArgError) {
      stderr.write(`error: ${err.message}\n\n`);
      stderr.write(HELP_TEXT + "\n");
      return ExitCodes.config_error;
    }
    throw err;
  }

  switch (parsed.kind) {
    case "version":
      stdout.write(`open-apex ${CLI_VERSION}\n`);
      return ExitCodes.success;
    case "help":
      stdout.write(helpForTopic(parsed.topic) + "\n");
      return ExitCodes.success;
    case "chat": {
      const code = await runChat(parsed, stdout, stderr);
      return code === 0 ? ExitCodes.success : ExitCodes.runtime_failure;
    }
    case "verify-gate": {
      // Dynamically import the gate runner so we don't pay the import cost
      // for every CLI invocation.
      const { runVerificationGate } = await import("@open-apex/config");
      const artifact = await runVerificationGate(CLI_VERSION);
      stdout.write(JSON.stringify(artifact, null, 2) + "\n");
      return artifact.blockers.length === 0 ? ExitCodes.success : ExitCodes.config_error;
    }
    case "autonomous": {
      const outcome = await runAutonomous(parsed, stderr, opts.deps ?? {});
      // Contract: stdout emits exactly one final OpenApexResult JSON line.
      stdout.write(JSON.stringify(outcome.result) + "\n");
      return outcome.exitCode;
    }
  }
}

export { parseArgs, ArgError } from "./args.ts";
export { runAutonomous } from "./autonomous.ts";
export { runChat } from "./chat.ts";
export { CLI_VERSION };
