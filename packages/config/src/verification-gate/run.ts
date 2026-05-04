/**
 * Verification-gate runner.
 *
 * Produces the §0.6 frozen artifact by probing the environment + live APIs.
 *
 * Usage:
 *   bun run packages/config/src/verification-gate/run.ts
 *   # Writes packages/config/verification-gates/verified-as-of-<YYYY-MM-DD>.json
 *
 * Per user directive:
 *   - Skip the "harbor run -d terminal-bench@2.0 -a oracle -l 1" smoke that
 *     §0.4 describes. User has already run + verified it.
 *   - If a required model is not served by the account, DO NOT fall back to a
 *     different model — just note "models are not set up" in the artifact.
 */

import * as path from "node:path";

import { runLiveProbes } from "./live-probes.ts";
import type {
  CapabilityProbeResult,
  CapabilityState,
  ModelAliasResolution,
  ProbeOutcome,
  VerificationGateArtifact,
} from "./types.ts";

const TB2_DATASET_COMMIT = "69671fbaac6d67a7ef0dfec016cc38a64ef7a77c";

interface ProbeEnv {
  openaiKey?: string;
  anthropicKey?: string;
  serperKey?: string;
  serpApiKey?: string;
  cliVersion: string;
  verifiedOn: string;
}

function envSnapshot(cliVersion: string): ProbeEnv {
  const d = new Date();
  const verifiedOn = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  const out: ProbeEnv = { cliVersion, verifiedOn };
  if (process.env.OPENAI_API_KEY) out.openaiKey = process.env.OPENAI_API_KEY;
  if (process.env.ANTHROPIC_API_KEY) out.anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (process.env.SERPER_API_KEY) out.serperKey = process.env.SERPER_API_KEY;
  const serp = process.env.SERPAPI_KEY ?? process.env.SERP_API_KEY;
  if (serp) out.serpApiKey = serp;
  return out;
}

async function capture(
  command: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const p = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
  });
  await p.exited;
  const stdout = await new Response(p.stdout).text();
  const stderr = await new Response(p.stderr).text();
  return { stdout: stdout.trim(), stderr: stderr.trim(), code: p.exitCode ?? 0 };
}

async function tryVersion(bin: string, arg = "--version"): Promise<string> {
  try {
    const r = await capture([bin, arg]);
    if (r.code !== 0) return "unavailable";
    return r.stdout.split("\n")[0] ?? "unavailable";
  } catch {
    return "unavailable";
  }
}

async function probeOpenAIModels(env: ProbeEnv): Promise<{
  aliases: ModelAliasResolution[];
  capabilities: CapabilityProbeResult[];
}> {
  const aliases: ModelAliasResolution[] = [];
  const capabilities: CapabilityProbeResult[] = [];

  if (!env.openaiKey) {
    aliases.push({
      alias: "gpt-5.4",
      present: false,
      provider: "openai",
      note: "OPENAI_API_KEY not set; models are not set up",
    });
    capabilities.push(probeRow("openai.models", "required", "unavailable", "no key"));
    return { aliases, capabilities };
  }

  let res: Response;
  try {
    res = await fetch("https://api.openai.com/v1/models", {
      headers: { Authorization: `Bearer ${env.openaiKey}` },
    });
  } catch (err) {
    aliases.push({
      alias: "gpt-5.4",
      present: false,
      provider: "openai",
      note: `fetch failed: ${(err as Error).message}`,
    });
    capabilities.push(
      probeRow(
        "openai.models",
        "required",
        "unavailable",
        `fetch error: ${(err as Error).message}`,
      ),
    );
    return { aliases, capabilities };
  }
  if (!res.ok) {
    capabilities.push(
      probeRow("openai.models", "required", "unavailable", `HTTP ${res.status}`, res.status),
    );
    return { aliases, capabilities };
  }
  const body = (await res.json()) as { data: Array<{ id: string }> };
  const presentIds = new Set(body.data.map((m) => m.id));
  for (const alias of ["gpt-5.4"]) {
    const entry: ModelAliasResolution = {
      alias,
      provider: "openai",
      present: presentIds.has(alias),
    };
    if (!presentIds.has(alias)) entry.note = "models are not set up";
    aliases.push(entry);
  }
  capabilities.push(
    probeRow("openai.models", "required", "available", `${body.data.length} models`, res.status),
  );
  return { aliases, capabilities };
}

async function probeAnthropicModels(env: ProbeEnv): Promise<{
  aliases: ModelAliasResolution[];
  capabilities: CapabilityProbeResult[];
}> {
  const aliases: ModelAliasResolution[] = [];
  const capabilities: CapabilityProbeResult[] = [];
  if (!env.anthropicKey) {
    for (const a of ["claude-sonnet-4-6", "claude-opus-4-6", "claude-opus-4-7"]) {
      aliases.push({
        alias: a,
        provider: "anthropic",
        present: false,
        note: "ANTHROPIC_API_KEY not set; models are not set up",
      });
    }
    capabilities.push(probeRow("anthropic.models", "required", "unavailable", "no key"));
    return { aliases, capabilities };
  }
  let res: Response;
  try {
    res = await fetch("https://api.anthropic.com/v1/models", {
      headers: {
        "x-api-key": env.anthropicKey,
        "anthropic-version": "2023-06-01",
      },
    });
  } catch (err) {
    for (const a of ["claude-sonnet-4-6", "claude-opus-4-6", "claude-opus-4-7"]) {
      aliases.push({
        alias: a,
        provider: "anthropic",
        present: false,
        note: `fetch failed: ${(err as Error).message}`,
      });
    }
    capabilities.push(
      probeRow(
        "anthropic.models",
        "required",
        "unavailable",
        `fetch error: ${(err as Error).message}`,
      ),
    );
    return { aliases, capabilities };
  }
  if (!res.ok) {
    capabilities.push(
      probeRow("anthropic.models", "required", "unavailable", `HTTP ${res.status}`, res.status),
    );
    return { aliases, capabilities };
  }
  const body = (await res.json()) as {
    data: Array<{ id: string; display_name?: string }>;
  };
  const byId = new Map(body.data.map((m) => [m.id, m.display_name]));
  for (const alias of ["claude-sonnet-4-6", "claude-opus-4-6", "claude-opus-4-7"]) {
    const entry: ModelAliasResolution = {
      alias,
      provider: "anthropic",
      present: byId.has(alias),
    };
    const dn = byId.get(alias);
    if (dn !== undefined) entry.displayName = dn;
    if (!byId.has(alias)) entry.note = "models are not set up";
    aliases.push(entry);
  }
  capabilities.push(
    probeRow("anthropic.models", "required", "available", `${body.data.length} models`, res.status),
  );
  return { aliases, capabilities };
}

async function probeExternalServices(
  env: ProbeEnv,
): Promise<VerificationGateArtifact["external_services"]> {
  const results: VerificationGateArtifact["external_services"] = [];
  async function ping(url: string, name: string, init?: RequestInit) {
    try {
      const r = await fetch(url, init);
      results.push({ name, reachable: true, httpStatus: r.status });
    } catch (err) {
      results.push({
        name,
        reachable: false,
        notes: (err as Error).message,
      });
    }
  }
  await ping("https://api.openai.com/v1", "openai.api");
  await ping("https://api.anthropic.com", "anthropic.api");
  if (env.serperKey) {
    await ping("https://google.serper.dev", "serper");
  } else {
    results.push({ name: "serper", reachable: false, notes: "no key" });
  }
  if (env.serpApiKey) {
    await ping("https://serpapi.com", "serpapi");
  } else {
    results.push({ name: "serpapi", reachable: false, notes: "no key" });
  }
  await ping(
    `https://raw.githubusercontent.com/laude-institute/terminal-bench-2/${TB2_DATASET_COMMIT}/README.md`,
    "terminal-bench-2.commit-pinned",
  );
  await ping(
    "https://raw.githubusercontent.com/harbor-framework/harbor/main/README.md",
    "harbor-framework.main",
  );
  await ping("https://registry.npmjs.org/-/ping", "npm.registry");
  return results;
}

function probeRow(
  cap: string,
  state: CapabilityState,
  outcome: ProbeOutcome,
  notes?: string,
  httpStatus?: number,
): CapabilityProbeResult {
  const r: CapabilityProbeResult = { capability: cap, state, outcome };
  if (notes !== undefined) r.notes = notes;
  if (httpStatus !== undefined) r.httpStatus = httpStatus;
  return r;
}

export async function runVerificationGate(cliVersion: string): Promise<VerificationGateArtifact> {
  const env = envSnapshot(cliVersion);

  const tooling = {
    bun_version: (await tryVersion("bun")).replace(/^bun\s+/i, ""),
    node_version: await tryVersion("node"),
    git_version: (await tryVersion("git", "--version")).replace(/^git version\s*/i, ""),
    python_version: (await tryVersion("python3")).replace(/^Python\s*/i, ""),
    ripgrep_version: (await tryVersion("rg")).replace(/^ripgrep\s*/i, ""),
    harbor_version: (await tryVersion("harbor", "--version")).replace(/^harbor\s*/i, ""),
  };

  const { aliases: oaAliases, capabilities: oaCaps } = await probeOpenAIModels(env);
  const { aliases: anAliases, capabilities: anCaps } = await probeAnthropicModels(env);
  const externalServices = await probeExternalServices(env);

  // §0.2 / §0.3 / §3.6 — live-probe every required capability and beta header.
  // Per user directive: always live. No 24h cache. Required + !available blocks.
  const probeEnv: import("./live-probes.ts").LiveProbeEnv = {};
  if (env.openaiKey !== undefined) probeEnv.openaiKey = env.openaiKey;
  if (env.anthropicKey !== undefined) probeEnv.anthropicKey = env.anthropicKey;
  const live = await runLiveProbes(probeEnv);

  const capabilities: CapabilityProbeResult[] = [...oaCaps, ...anCaps, ...live.capabilities];

  const blockers: string[] = [];
  const advisories: string[] = [];
  // §0.7 gate failure policy: required feature not proven available → blocker.
  // This covers both "unavailable" (live probe failed) AND "untested" (key
  // absent). M0 cannot certify a capability it has not live-verified.
  for (const c of capabilities) {
    if (c.state === "required" && c.outcome !== "available") {
      blockers.push(
        `required capability not proven available: ${c.capability} [${c.outcome}] ${c.notes ?? ""}`,
      );
    }
  }
  // Beta headers that are referenced by v1 presets: if not available, advisory.
  for (const bh of live.betaHeaders) {
    if (bh.outcome === "unavailable") {
      advisories.push(`beta header failed smoke: ${bh.header} (HTTP ${bh.smokeHttpStatus})`);
    }
  }
  for (const a of [...oaAliases, ...anAliases]) {
    if (!a.present) {
      advisories.push(`model alias missing: ${a.alias} (${a.note ?? ""})`);
    }
  }

  const artifact: VerificationGateArtifact = {
    schema_version: 1,
    verifiedOn: env.verifiedOn,
    cli_version: cliVersion,
    tooling,
    model_aliases: [...oaAliases, ...anAliases],
    beta_headers: live.betaHeaders,
    tb2_dataset_commit_sha: TB2_DATASET_COMMIT,
    external_services: externalServices,
    capabilities,
    blockers,
    advisories,
  };
  return artifact;
}

// Entrypoint when invoked as a script: `bun run verify:gate`.
if (import.meta.main) {
  const cliVersion = process.env.OPEN_APEX_CLI_VERSION ?? "0.0.1";
  const artifact = await runVerificationGate(cliVersion);
  const outDir = path.resolve(new URL("../../verification-gates/", import.meta.url).pathname);
  await Bun.$`mkdir -p ${outDir}`.quiet();
  const outPath = path.join(outDir, `verified-as-of-${artifact.verifiedOn}.json`);
  await Bun.write(outPath, JSON.stringify(artifact, null, 2) + "\n");

  const ok = artifact.blockers.length === 0;
  console.log(`verification gate written: ${outPath}`);
  console.log(`  blockers: ${artifact.blockers.length}`);
  for (const b of artifact.blockers) console.log(`    - ${b}`);
  console.log(`  advisories: ${artifact.advisories.length}`);
  for (const a of artifact.advisories) console.log(`    - ${a}`);
  process.exit(ok ? 0 : 1);
}
