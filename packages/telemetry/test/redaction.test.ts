import { describe, expect, test } from "bun:test";

import { redact, redactJson, SECRET_PATTERNS } from "../src/index.ts";

describe("secret redaction patterns (§3.5.4 + §7.6.8)", () => {
  // NOTE: the key values below are INVENTED fixtures — they match the regex
  // shape but are not real keys. They are present in-repo because redaction
  // tests need representative inputs; these strings are kept in the test
  // fixture list of the secret-scanner allowlist if the org requires it.

  test("OpenAI project key (sk-proj-...) redacted", () => {
    const key = ["sk", "proj", "abc123DEFghi456JKL789_-mnoPQR0123STUvwxyzABC"].join("-");
    const input = `OPENAI_API_KEY=${key}`;
    // The `# pragma: allowlist secret` tag is only interpreted when present
    // in the TEXT being redacted — the comment above is in the TS source,
    // not in the input. So we verify redaction actually fires on this input.
    const r = redact(input);
    expect(r).toContain("<REDACTED:openai>");
    expect(r).not.toContain(["sk", "proj"].join("-") + "-");
  });

  test("Anthropic key (sk-ant-api03-...) redacted", () => {
    // Match the 80-120-char body expected by the pattern.
    const body = "a".repeat(90);
    const key = ["sk", "ant", `api03-${body}`].join("-");
    const input = `ANTHROPIC_API_KEY=${key}`;
    const r = redact(input);
    expect(r).toContain("<REDACTED:anthropic>");
    expect(r).not.toContain(body);
  });

  test("Daytona key (dtn_<40+ alphanumeric>) redacted", () => {
    const input = "DAYTONA_API_KEY=dtn_" + "A".repeat(60);
    const r = redact(input);
    expect(r).toContain("<REDACTED:daytona>");
  });

  test("Serper key (40 hex chars) redacted only in assignment context", () => {
    const assign = "SERPER_API_KEY=" + "0123456789abcdef0123456789abcdef01234567";
    const r = redact(assign);
    expect(r).toContain("<REDACTED:serper>");
    // A stray 40-hex string without a Serper context should not be falsely
    // redacted (avoiding false positives on SHA1 hashes).
    const sha1 = "abcdef0123456789abcdef0123456789abcdef01";
    const r2 = redact(`file hash: ${sha1}`);
    expect(r2).toBe(`file hash: ${sha1}`);
  });

  test("GitHub PAT (ghp_...) redacted", () => {
    const input = "ghp_" + "A".repeat(36);
    const r = redact(input);
    expect(r).toContain("<REDACTED:github-pat>");
  });

  test("AWS access key redacted", () => {
    const r = redact("AKIA" + "IOSFODNN7EXAMPLE");
    expect(r).toContain("<REDACTED:aws-access-key>");
  });

  test("JWT redacted", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkphbmUgRG9lIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const r = redact(`token=${jwt}`);
    expect(r).toContain("<REDACTED:jwt>");
    expect(r).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
  });

  test("Stripe key redacted", () => {
    const key = ["sk", "test", "01234567890123456789abcd"].join("_");
    const r = redact(key);
    expect(r).toContain("<REDACTED:stripe>");
  });

  test("URI credentials preserved structurally", () => {
    const input = "postgres://user:secret-pw@db.example.com/prod";
    const r = redact(input);
    expect(r).toBe("postgres://<REDACTED:uri-creds>@db.example.com/prod");
  });

  test("Generic KEY=VALUE fallback catches custom env assignments", () => {
    const input = 'CUSTOM_SERVICE_TOKEN="abcdef12345"';
    const r = redact(input);
    expect(r).toContain("<REDACTED:generic>");
  });

  test("Allowlist tag skips redaction", () => {
    const tag = "# pragma: allowlist secret";
    const key = ["sk", "proj", "abcdef1234567890abcdefghijk"].join("-");
    const input = `fakeApiKey=${key} ${tag}`;
    const r = redact(input);
    expect(r).toContain(key);
    expect(r).not.toContain("<REDACTED");
  });

  test("redactJson recurses into arrays and objects", () => {
    const obj = {
      env: {
        OPENAI_API_KEY: ["sk", "proj", "abcdefghijklmnopqrstuvwxyz"].join("-"),
        other: "harmless",
      },
      logs: [
        "POST /chat { token: " + ["sk", "ant", "api03-" + "b".repeat(90)].join("-") + " }",
        "nothing here",
      ],
    };
    const out = redactJson(obj) as typeof obj;
    expect(out.env.OPENAI_API_KEY).toContain("<REDACTED:openai>");
    expect(out.env.other).toBe("harmless");
    expect(out.logs[0]).toContain("<REDACTED:anthropic>");
    expect(out.logs[1]).toBe("nothing here");
  });

  test("every pattern has a non-empty source name", () => {
    for (const p of SECRET_PATTERNS) {
      expect(p.source.length).toBeGreaterThan(0);
      expect(p.pattern).toBeInstanceOf(RegExp);
    }
  });
});
