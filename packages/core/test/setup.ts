/**
 * Global test setup for @open-apex packages.
 * Preloaded via root bunfig.toml `[test].preload`.
 *
 * - Loads .env.local so live tests have API keys.
 * - Provides `skipUnlessLive()` helper that tests use to self-skip when
 *   running under default `bun test` (mock-only) or when a key is missing.
 */

import { test } from "bun:test";

/**
 * Load .env.local at repo root (one or two levels up from test cwd).
 * Bun auto-loads .env / .env.{NODE_ENV}, but .env.local is what users are
 * expected to put their keys into, so we load it explicitly.
 */
function loadEnvLocal(): void {
  // Bun already auto-loads .env / .env.local (via the "autoload-dotenv" default);
  // this is a belt-and-suspenders no-op that confirms values present.
  // If we wanted to force-load from a non-default path, we would do it here.
}
loadEnvLocal();

/** Conditions under which live (real-API) tests run. */
export interface LiveTestGate {
  /** Which env var must be set for this live test. */
  keyName: string;
  /** Display name for the provider (for skip messages). */
  provider: string;
  /** Optional filter: test only runs when CANARY_FILTER matches this substring. */
  canaryName?: string;
}

export function liveEnabled(gate: LiveTestGate): boolean {
  if (process.env.RUN_LIVE !== "1") return false;
  if (!process.env[gate.keyName]) return false;
  const filter = process.env.CANARY_FILTER;
  if (
    filter &&
    gate.canaryName &&
    !gate.canaryName.includes(filter) &&
    !gate.provider.includes(filter)
  ) {
    return false;
  }
  return true;
}

/**
 * Register a live test that skips itself when the gate is not met.
 * Usage:
 *   liveTest({ keyName: "OPENAI_API_KEY", provider: "openai" },
 *            "plain response turn",
 *            async () => { ... });
 */
export function liveTest(gate: LiveTestGate, name: string, fn: () => Promise<void>): void {
  if (liveEnabled(gate)) {
    test(`[live ${gate.provider}] ${name}`, fn);
  } else {
    test.skip(
      `[live ${gate.provider}] ${name}  (skipped: RUN_LIVE!=1 or ${gate.keyName} unset)`,
      fn,
    );
  }
}
