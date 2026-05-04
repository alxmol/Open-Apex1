import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import { defaultConfig, loadOpenApexConfig, parseToml } from "../src/index.ts";

function tmpFile(content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "openapex-test-"));
  const p = path.join(dir, "config.toml");
  writeFileSync(p, content, "utf8");
  return p;
}

describe("parseToml (§7.6.10 subset)", () => {
  test("section + scalar keys", () => {
    const r = parseToml(`[profile]\npreset = "chat-opus46"\nautonomy = "medium"\n`);
    expect(r).toEqual({
      profile: { preset: "chat-opus46", autonomy: "medium" },
    });
  });

  test("nested section table", () => {
    const r = parseToml(`
[permissions.allowed_domains]
extra = ["docs.rs", "example.com"]
removed = []
`);
    expect(r).toEqual({
      permissions: {
        allowed_domains: {
          extra: ["docs.rs", "example.com"],
          removed: [],
        },
      },
    });
  });

  test("booleans and numbers", () => {
    const r = parseToml(`
[model]
max_turns = 200
max_budget_usd = 0
timeout_sec_per_shell = 300

[telemetry]
retention_days = 90
upload_opt_in = false
`);
    expect((r.model as any).max_turns).toBe(200);
    expect((r.model as any).max_budget_usd).toBe(0);
    expect((r.telemetry as any).upload_opt_in).toBe(false);
  });

  test("comments are stripped", () => {
    const r = parseToml(`# comment\n[cli]\nfile_opener = "none" # trailing comment`);
    expect(r).toEqual({ cli: { file_opener: "none" } });
  });

  test("string with embedded '#' is preserved", () => {
    const r = parseToml(`[profile]\ndefault_workspace = "/my/proj#ect"\n`);
    expect(r).toEqual({
      profile: { default_workspace: "/my/proj#ect" },
    });
  });
});

describe("loadOpenApexConfig", () => {
  test("returns defaults when no files exist", async () => {
    const cfg = await loadOpenApexConfig({
      userConfigPath: "/does/not/exist.toml",
      projectConfigPath: "/does/not/exist.toml",
    });
    expect(cfg).toEqual(defaultConfig());
  });

  test("benchmark mode IGNORES user + project config (§7.6.10 code branch)", async () => {
    const userCfg = tmpFile(`[profile]\npreset = "attacker-preset"\nautonomy = "full_auto"\n`);
    const projCfg = tmpFile(`[profile]\npreset = "poison"\nautonomy = "full_auto"\n`);
    const cfg = await loadOpenApexConfig({
      userConfigPath: userCfg,
      projectConfigPath: projCfg,
      benchmarkMode: true,
    });
    // Defaults win. Poison is ignored entirely.
    expect(cfg.profile.preset).toBe("chat-gpt54");
    expect(cfg.profile.autonomy).toBe("medium");
  });

  test("project config overrides user config, user config overrides defaults", async () => {
    const userCfg = tmpFile(`
[profile]
preset = "chat-sonnet46"
[search]
aggressiveness = "proactive"
[permissions]
network_enabled = false
`);
    const projCfg = tmpFile(`
[profile]
preset = "chat-opus47"
`);
    const cfg = await loadOpenApexConfig({
      userConfigPath: userCfg,
      projectConfigPath: projCfg,
      benchmarkMode: false,
    });
    // Project wins on preset.
    expect(cfg.profile.preset).toBe("chat-opus47");
    // User wins over defaults on search + permissions.
    expect(cfg.search.aggressiveness).toBe("proactive");
    expect(cfg.permissions.network_enabled).toBe(false);
    // Defaults retained for un-touched keys.
    expect(cfg.cli.tui_theme).toBe("auto");
  });

  test("unknown keys produce warning list (not hard failure)", async () => {
    const projCfg = tmpFile(`[profile]\npreset = "chat-opus46"\n\n[alien_section]\nkey = "val"\n`);
    const cfg = await loadOpenApexConfig({
      projectConfigPath: projCfg,
      benchmarkMode: false,
    });
    expect(cfg._unknown_keys.length).toBe(1);
    expect(cfg._unknown_keys[0]!.includes("alien_section")).toBe(true);
  });
});
