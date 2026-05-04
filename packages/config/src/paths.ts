/**
 * Open-Apex filesystem paths.
 * Locked per §3.5.5 + §7.6.7 + §7.6.10.
 *
 * $OPEN_APEX_HOME resolves via the chain:
 *   $OPEN_APEX_HOME (if explicitly set)
 *   $XDG_DATA_HOME/open-apex
 *   $HOME/.local/share/open-apex
 *   /var/open-apex           (only if $HOME is read-only)
 *   /tmp/open-apex-$(id -u)  (last-resort)
 */

import { accessSync, constants } from "node:fs";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

function canWriteTo(dir: string): boolean {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export interface OpenApexPaths {
  home: string;
  /** Resolution trace for telemetry / debug. */
  resolutionChain: string[];
  sessionsDir: string;
  runsDir: string;
  checkpointsDir: string;
  sqliteHome: string;
  crashesDir: string;
  sentinelPath: string;
  canaryBudgetPath: string;
  userConfigPath: string;
  userProjectDocPath: string;
}

export function resolveOpenApexHome(env = process.env): {
  home: string;
  chain: string[];
} {
  const chain: string[] = [];
  // 1. Explicit.
  if (env.OPEN_APEX_HOME) {
    const d = env.OPEN_APEX_HOME;
    chain.push(`OPEN_APEX_HOME=${d}`);
    if (canWriteTo(d)) return { home: d, chain };
    chain.push(`  rejected (not writable)`);
  }
  // 2. $XDG_DATA_HOME/open-apex
  if (env.XDG_DATA_HOME) {
    const d = path.join(env.XDG_DATA_HOME, "open-apex");
    chain.push(`XDG_DATA_HOME/open-apex=${d}`);
    if (canWriteTo(d)) return { home: d, chain };
    chain.push(`  rejected (not writable)`);
  }
  // 3. $HOME/.local/share/open-apex
  const h = env.HOME ?? homedir();
  if (h) {
    const d = path.join(h, ".local", "share", "open-apex");
    chain.push(`HOME/.local/share/open-apex=${d}`);
    if (canWriteTo(d)) return { home: d, chain };
    chain.push(`  rejected (not writable)`);
  }
  // 4. /var/open-apex
  {
    const d = "/var/open-apex";
    chain.push(`/var/open-apex`);
    if (canWriteTo(d)) return { home: d, chain };
    chain.push(`  rejected (not writable)`);
  }
  // 5. /tmp/open-apex-$(id -u)
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const d = `/tmp/open-apex-${uid}`;
  chain.push(`/tmp/open-apex-${uid}=${d}`);
  if (canWriteTo(d)) return { home: d, chain };
  chain.push(`  rejected (not writable)`);
  // Fallback: we're out of options — return the last attempt so the caller
  // can raise a config_error.
  return { home: d, chain };
}

export function openApexPaths(env = process.env): OpenApexPaths {
  const { home, chain } = resolveOpenApexHome(env);
  const sqliteHome = env.OPEN_APEX_SQLITE_HOME ?? home;
  return {
    home,
    resolutionChain: chain,
    sessionsDir: path.join(home, "sessions"),
    runsDir: path.join(home, "runs"),
    checkpointsDir: path.join(home, "checkpoints"),
    sqliteHome,
    crashesDir: path.join(home, "crashes"),
    sentinelPath: path.join(home, "sentinel.json"),
    canaryBudgetPath: path.join(home, "canary-budget.jsonl"),
    userConfigPath: path.join(home, "config.toml"),
    userProjectDocPath: path.join(home, "OPEN_APEX.md"),
  };
}
