/**
 * Secret redaction library.
 * Locked per §3.5.4 + §7.6.8.
 *
 * Applied at three sinks: ATIF trajectory writer, log writer, replay-log writer.
 * In benchmark mode redaction cannot be disabled (§7.6.10).
 *
 * Strategy:
 *   1. Specific patterns first (provider keys, cloud keys, JWT, etc.) — precise.
 *   2. URI-credential preserving regex — keeps URL structure readable.
 *   3. Generic fallback — catches assignments of KEY/SECRET/TOKEN/PASSWORD
 *      patterns that the specific list missed. Runs AFTER specific patterns so
 *      it doesn't over-redact structured keys.
 *
 * Every pattern has fixture tests in packages/telemetry/test/redaction.fixtures.test.ts.
 */

export interface RedactionPattern {
  source: string;
  pattern: RegExp;
}

export const SECRET_PATTERNS: RedactionPattern[] = [
  // Anthropic MUST come before OpenAI because both start with `sk-`.
  {
    source: "anthropic",
    pattern: /sk-ant-api\d{0,2}-[A-Za-z0-9_\-]{80,120}/g,
  },
  {
    source: "openai",
    // Negative lookahead excludes `sk-ant-` so Anthropic keys above are not
    // swallowed by the more permissive OpenAI pattern.
    pattern: /sk-(?!ant-)(?:proj-)?[A-Za-z0-9_\-]{20,}/g,
  },
  {
    source: "aws-access-key",
    pattern: /\b(?:AKIA|A3T|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{12,}\b/g,
  },
  { source: "github-pat", pattern: /\bghp_[A-Za-z0-9_]{36}\b/g },
  { source: "github-server-to-server", pattern: /\bghs_[A-Za-z0-9_]{36}\b/g },
  {
    source: "stripe",
    pattern: /\b(?:rk|sk)_(?:test|live)_[0-9a-zA-Z]{24}\b/g,
  },
  { source: "google-api", pattern: /\bAIza[0-9A-Za-z\-_]{35}\b/g },
  {
    source: "jwt",
    pattern: /\beyJ[A-Za-z0-9_\-=]{10,}\.eyJ[A-Za-z0-9_\-=]{10,}\.[A-Za-z0-9_\-=]{10,}\b/g,
  },
  // Serper keys are 40 hex chars; narrower context required to avoid
  // false-positives on SHA1 hashes that appear in tool output.
  {
    source: "serper",
    pattern:
      /(?:SERPER[_-]?API[_-]?KEY|X-API-KEY|serper(?:_api)?_key)\s*[:=]\s*\b([0-9a-f]{40})\b/gi,
  },
  // Daytona (observed in .env.local shape: dtn_<42 alphanumeric>).
  {
    source: "daytona",
    pattern: /\bdtn_[A-Za-z0-9]{40,80}\b/g,
  },
];

/** URI credentials — preserve structure. postgres://user:pw@host -> postgres://<REDACTED>@host */
export const URI_CREDS = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^:@/\s]+:[^@/\s]+(@)/g;

/**
 * Generic KEY=VALUE fallback. Runs AFTER specific patterns. Matches a line
 * of the form:
 *   UPPER_SNAKE_KEY(?:...KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH|PWD|PASS) = "..."
 */
export const GENERIC_FALLBACK =
  /^([A-Z][A-Z0-9_]*(?:KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL|AUTH|PWD|PASS)[A-Z0-9_]*)\s*=\s*("|'|)(?!<REDACTED)([^"'\n]{8,})\2$/gm;

export interface RedactOptions {
  /** If set, inline allowlist lines matching this tag skip redaction. */
  allowlistTag?: string; // default `# pragma: allowlist secret`
}

/** Replace all secrets in `text` with `<REDACTED:<source>>` markers. */
export function redact(text: string, opts: RedactOptions = {}): string {
  if (!text) return text;
  const tag = opts.allowlistTag ?? "# pragma: allowlist secret";
  // Split into lines so we can honor allowlist.
  const lines = text.split("\n");
  const out: string[] = [];
  for (const line of lines) {
    if (line.includes(tag)) {
      out.push(line);
      continue;
    }
    let ln = line;
    // Specific patterns.
    for (const { source, pattern } of SECRET_PATTERNS) {
      // Re-create the pattern so the global state is fresh per-line.
      const re = new RegExp(pattern.source, pattern.flags);
      ln = ln.replace(re, (match, cap1) => {
        // For Serper the captured group is the actual key we want to redact.
        if (source === "serper" && typeof cap1 === "string") {
          return match.replace(cap1, `<REDACTED:${source}>`);
        }
        return `<REDACTED:${source}>`;
      });
    }
    // URI credentials.
    ln = ln.replace(URI_CREDS, "$1<REDACTED:uri-creds>$2");
    // Generic fallback. Line-level (GENERIC_FALLBACK uses ^...$ with /m).
    // Apply to a single-line slice.
    const gf = new RegExp(GENERIC_FALLBACK.source, "g");
    ln = ln.replace(gf, (_m, key, quote, _val) => {
      return `${key}=${quote}<REDACTED:generic>${quote}`;
    });
    out.push(ln);
  }
  return out.join("\n");
}

/** Redact every string value inside a JSON object, recursively. */
export function redactJson<T>(value: T, opts?: RedactOptions): T {
  if (value == null) return value;
  if (typeof value === "string") {
    return redact(value, opts) as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactJson(v, opts)) as T;
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactJson(v, opts);
    }
    return out as T;
  }
  return value;
}
