/**
 * §7.6.1 network access policy: HTTP method + domain allowlist classifier.
 *
 * Rules (from build-plan §7.6.1 "Network access policy"):
 *   - GET / HEAD  → allowed_domains → READ_ONLY_NETWORK; non-allow → MUTATING
 *   - POST/PUT/PATCH → allowed_domains → MUTATING; non-allow → DESTRUCTIVE
 *   - DELETE → DESTRUCTIVE
 *   - pipe-to-shell (curl | sh) → CATASTROPHIC (caught by CATASTROPHIC regex earlier)
 *   - output to /etc, /usr, /var → CATASTROPHIC (caught earlier)
 *
 * Supported binaries: curl, wget, httpie (`http`, `xh`), aria2c, fetch.
 */

import type { ClassifierResult, ClassifierTier } from "./types.ts";

const DEFAULT_ALLOWED_DOMAINS: readonly string[] = Object.freeze([
  // Package registries.
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "crates.io",
  "static.crates.io",
  "proxy.golang.org",
  "sum.golang.org",
  "rubygems.org",
  "repo.maven.apache.org",
  "plugins.gradle.org",
  // Version control.
  "github.com",
  "api.github.com",
  "raw.githubusercontent.com",
  "gitlab.com",
  "bitbucket.org",
  "codeberg.org",
  // Container registries.
  "registry-1.docker.io",
  "auth.docker.io",
  "ghcr.io",
  "quay.io",
  "gcr.io",
  "public.ecr.aws",
  // OS package repos.
  "deb.debian.org",
  "archive.ubuntu.com",
  // LLM providers.
  "api.anthropic.com",
  "api.openai.com",
  "generativelanguage.googleapis.com",
  // Docs.
  "docs.python.org",
  "docs.rs",
  "developer.mozilla.org",
]);

const DENIED_DOMAINS: readonly string[] = Object.freeze([
  "pastebin.com",
  "transfer.sh",
  "file.io",
  "0x0.st",
  "anonfiles.com",
  "catbox.moe",
  "*.onion",
  "webhook.site",
  "requestbin.com",
  "*.ngrok.io",
  "*.localtunnel.me",
  "pipedream.net",
]);

type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";

/**
 * Classify a curl/wget/httpie/xh/aria2c/fetch invocation. Returns null when
 * the argv shape doesn't match a recognized pattern (caller falls back to
 * rule-table entry, which is `MUTATING`).
 */
export function classifyNetworkInvocation(
  argv: string[],
  opts: { allowedDomains?: string[]; networkEnabled?: boolean } = {},
): ClassifierResult | null {
  if (argv.length === 0) return null;
  const exec = basename(argv[0]!);
  const parsed = parseHttpInvocation(exec, argv);
  if (!parsed) return null;
  const { method, url } = parsed;

  if (!opts.networkEnabled) {
    // Even GETs are MUTATING when network is disabled (the side effect IS
    // the connection attempt, which might leak data).
    return {
      tier: "MUTATING",
      rule: "network_disabled",
      reason: `${exec} ${method} ${url}: network is disabled in this session`,
    };
  }

  const host = extractHost(url);
  const denied = host ? DENIED_DOMAINS.some((d) => matchesDomain(host, d)) : false;
  if (denied) {
    return {
      tier: "DESTRUCTIVE",
      rule: "network_denied_domain",
      reason: `${exec} ${method} ${host}: domain is on the deny list`,
    };
  }
  const allow = opts.allowedDomains ?? DEFAULT_ALLOWED_DOMAINS;
  const allowed = host ? allow.some((d) => matchesDomain(host, d)) : false;

  let tier: ClassifierTier;
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    tier = allowed ? "READ_ONLY_NETWORK" : "MUTATING";
  } else if (method === "POST" || method === "PUT" || method === "PATCH") {
    tier = allowed ? "MUTATING" : "DESTRUCTIVE";
  } else {
    // DELETE and anything else → DESTRUCTIVE.
    tier = "DESTRUCTIVE";
  }
  return {
    tier,
    rule: `network:${method.toLowerCase()}:${allowed ? "allow" : "other"}`,
    reason: `${exec} ${method} ${host ?? "(no host)"} → ${tier}`,
  };
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i === -1 ? p : p.slice(i + 1);
}

/**
 * Parse a curl/wget/httpie argv into {method, url}. Returns null when the
 * pattern is unfamiliar (e.g. `curl --help`).
 */
function parseHttpInvocation(
  exec: string,
  argv: string[],
): { method: HttpMethod; url: string } | null {
  let method: HttpMethod = "GET";
  let url: string | null = null;
  // Split short-flag packs (`-sS` → `-s -S`, preserve `-X`/`-d` as value-taking).
  const tokens = expandShortFlagPacks(argv.slice(1));
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (t === "-X" || t === "--request") {
      const next = tokens[i + 1];
      if (next) {
        method = next.toUpperCase() as HttpMethod;
        i++;
      }
      continue;
    }
    if (/^-X[A-Za-z]+$/.test(t)) {
      method = t.slice(2).toUpperCase() as HttpMethod;
      continue;
    }
    if (t.startsWith("--request=")) {
      method = t.slice("--request=".length).toUpperCase() as HttpMethod;
      continue;
    }
    // httpie / xh: `http METHOD URL ...`
    if ((exec === "http" || exec === "xh" || exec === "httpie") && i === 0 && /^[A-Z]+$/.test(t)) {
      method = t.toUpperCase() as HttpMethod;
      continue;
    }
    // -d / --data / -T / --upload-file → POST / PUT inference
    if (
      t === "-d" ||
      t === "--data" ||
      t === "--data-binary" ||
      t === "--data-raw" ||
      t === "--data-urlencode"
    ) {
      if (method === "GET") method = "POST";
      i++; // skip value
      continue;
    }
    if (t === "-T" || t === "--upload-file") {
      if (method === "GET") method = "PUT";
      i++;
      continue;
    }
    if (t === "--head" || t === "-I") {
      method = "HEAD";
      continue;
    }
    if (t === "--get" || t === "-G") {
      method = "GET";
      continue;
    }
    // Ignore other flags with their values.
    if (t.startsWith("-")) {
      if (flagTakesValue(t)) i++; // skip value
      continue;
    }
    // First non-flag positional after wrappers is the URL.
    if (!url && /^(?:https?|ftp|ws|wss):\/\//.test(t)) {
      url = t;
    }
  }
  if (!url) return null;
  return { method, url };
}

function expandShortFlagPacks(tokens: string[]): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    if (/^-X[A-Za-z]+$/.test(t)) {
      out.push(t);
      continue;
    }
    if (t.length > 2 && t.startsWith("-") && !t.startsWith("--") && /^-[A-Za-z]+$/.test(t)) {
      for (const ch of t.slice(1)) out.push(`-${ch}`);
    } else {
      out.push(t);
    }
  }
  return out;
}

function flagTakesValue(flag: string): boolean {
  // Common value-taking curl / wget flags that we haven't already matched.
  return [
    "-H",
    "--header",
    "-o",
    "--output",
    "-u",
    "--user",
    "-A",
    "--user-agent",
    "-e",
    "--referer",
    "--connect-timeout",
    "-m",
    "--max-time",
    "--retry",
    "-b",
    "--cookie",
    "--ciphers",
    "--cacert",
    "--capath",
    "--cert",
    "--key",
    "--limit-rate",
    "--proxy",
    "-x",
    "-F",
    "--form",
  ].includes(flag);
}

function extractHost(url: string): string | null {
  try {
    const u = new URL(url);
    return u.hostname;
  } catch {
    return null;
  }
}

/**
 * Match `host` against an allowlist/denylist entry. Supports wildcard
 * subdomains (`*.npmjs.com` matches `foo.npmjs.com` and `npmjs.com`).
 */
function matchesDomain(host: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  return host === pattern;
}

export { DEFAULT_ALLOWED_DOMAINS, DENIED_DOMAINS };
