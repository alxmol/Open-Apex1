#!/usr/bin/env bun
/**
 * open-apex bin — invoked as `open-apex ...` on PATH (and via `bun run src/bin.ts`).
 */

import { runCli } from "./index.ts";

const code = await runCli({ argv: process.argv });
process.exit(code);
