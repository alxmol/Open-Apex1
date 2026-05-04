import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { describe, expect, test } from "bun:test";

import { openApexPaths, resolveOpenApexHome } from "../src/index.ts";

describe("resolveOpenApexHome (§3.5.5 resolution chain)", () => {
  test("honors OPEN_APEX_HOME when set and writable", () => {
    const d = mkdtempSync(path.join(tmpdir(), "openapex-home-"));
    const { home, chain } = resolveOpenApexHome({ OPEN_APEX_HOME: d, HOME: "/tmp" });
    expect(home).toBe(d);
    expect(chain[0]).toContain("OPEN_APEX_HOME=");
  });

  test("falls back to XDG_DATA_HOME/open-apex when OPEN_APEX_HOME is unset", () => {
    const xdg = mkdtempSync(path.join(tmpdir(), "openapex-xdg-"));
    const { home } = resolveOpenApexHome({
      XDG_DATA_HOME: xdg,
      HOME: "/tmp",
    });
    expect(home).toBe(path.join(xdg, "open-apex"));
  });

  test("falls back to HOME/.local/share/open-apex when XDG unset", () => {
    const fakeHome = mkdtempSync(path.join(tmpdir(), "openapex-fakehome-"));
    const { home } = resolveOpenApexHome({ HOME: fakeHome });
    expect(home).toBe(path.join(fakeHome, ".local", "share", "open-apex"));
  });
});

describe("openApexPaths", () => {
  test("emits every expected subpath under home", () => {
    const xdg = mkdtempSync(path.join(tmpdir(), "openapex-xdg-"));
    const paths = openApexPaths({ XDG_DATA_HOME: xdg, HOME: "/tmp" });
    expect(paths.sessionsDir).toContain("sessions");
    expect(paths.runsDir).toContain("runs");
    expect(paths.checkpointsDir).toContain("checkpoints");
    expect(paths.sentinelPath.endsWith("sentinel.json")).toBe(true);
    expect(paths.canaryBudgetPath.endsWith("canary-budget.jsonl")).toBe(true);
    expect(paths.userConfigPath.endsWith("config.toml")).toBe(true);
    expect(paths.userProjectDocPath.endsWith("OPEN_APEX.md")).toBe(true);
    expect(paths.sqliteHome).toBe(paths.home);
  });
});
