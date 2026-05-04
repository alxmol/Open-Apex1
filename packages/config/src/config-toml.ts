/**
 * .openapex/config.toml loader.
 * Locked per §7.6.10.
 *
 * Precedence (lowest → highest):
 *   built-in defaults
 *   → user config ($OPEN_APEX_HOME/config.toml)
 *   → project config (.openapex/config.toml)
 *   → session overrides
 *   → explicit CLI flags / slash commands
 *
 * Benchmark mode (triggered by `--benchmark` or preset.benchmarkMode=true)
 * ignores user + project configs entirely — only built-in defaults + preset
 * apply. Enforced by code branch per §7.6.10 and verified by §1.2 isolation
 * acceptance test.
 *
 * TOML parsing: Bun ships a built-in TOML parser via `Bun.TOML`? Not yet.
 * We use a tiny hand-rolled subset parser that covers the ~40 keys we ship.
 * If this proves insufficient later we swap in `@iarna/toml` or similar.
 */

import type { AutonomyLevel } from "@open-apex/core";

export interface OpenApexConfig {
  profile: {
    preset: string;
    autonomy: AutonomyLevel;
    default_workspace?: string;
  };
  model: {
    provider?: "openai" | "anthropic";
    model?: string;
    effort?: string;
    verbosity?: "low" | "medium" | "high";
    thinking_display?: "summarized" | "omitted";
    max_turns?: number;
    /** 0 = no ceiling. */
    max_budget_usd?: number;
    timeout_sec_per_shell?: number;
  };
  permissions: {
    network_enabled: boolean;
    allow_unknown_in_high_without_sandbox: boolean;
    banned_allowlist_prefixes_additional: string[];
    session_allowlist: string[];
    allowed_domains: {
      extra: string[];
      removed: string[];
    };
  };
  search: {
    aggressiveness: "off" | "selective" | "proactive" | "aggressive";
    primary_provider: "serper" | "serpapi";
    dev_persistent_cache: boolean;
    dev_cache_ttl_seconds: number;
    contamination_blocklist_enabled: boolean;
    project_doc_max_bytes: number;
    project_root_markers: string[];
    project_doc_fallback_filenames?: string[];
  };
  telemetry: {
    retention_days: number;
    per_run_size_cap_mb: number;
    upload_opt_in: boolean;
    upload_endpoint: string;
    /** Cannot be disabled in benchmark mode (§7.6.10). */
    redaction_enabled: boolean;
    trajectory_schema_version: string;
  };
  cli: {
    file_opener: "vscode" | "cursor" | "windsurf" | "none";
    disable_animations: boolean;
    tui_theme: "auto" | "dark" | "light";
    show_cost_in_status_line: boolean;
    confirm_before_destructive: boolean;
    bracketed_paste: "auto" | "always" | "never";
  };
  /** Unknown keys encountered during parsing — logged as warnings. */
  _unknown_keys: string[];
  /** Developer instructions (Section 7.6.11 position 7.iii). */
  developer_instructions?: string;
}

/** Default config merged under all loaded layers. */
export function defaultConfig(): OpenApexConfig {
  return {
    profile: {
      preset: "chat-gpt54",
      autonomy: "medium",
    },
    model: {},
    permissions: {
      network_enabled: true,
      allow_unknown_in_high_without_sandbox: false,
      banned_allowlist_prefixes_additional: [],
      session_allowlist: [],
      allowed_domains: {
        extra: [],
        removed: [],
      },
    },
    search: {
      aggressiveness: "selective",
      primary_provider: "serper",
      dev_persistent_cache: false,
      dev_cache_ttl_seconds: 3600,
      contamination_blocklist_enabled: true,
      project_doc_max_bytes: 32768,
      project_root_markers: [".git"],
      project_doc_fallback_filenames: ["AGENTS.md"],
    },
    telemetry: {
      retention_days: 90,
      per_run_size_cap_mb: 1024,
      upload_opt_in: false,
      upload_endpoint: "",
      redaction_enabled: true,
      trajectory_schema_version: "ATIF-v1.6",
    },
    cli: {
      file_opener: "none",
      disable_animations: false,
      tui_theme: "auto",
      show_cost_in_status_line: true,
      confirm_before_destructive: true,
      bracketed_paste: "auto",
    },
    _unknown_keys: [],
  };
}

// ─── Tiny TOML subset parser ─────────────────────────────────────────────────
// Supports: `[section]`, `[section.sub]`, `key = value` where value is one of:
//   string (double/single-quoted, no multiline / triple-quotes yet),
//   integer, float, bool, array (homogenous literals), inline table (simple).
// Comments: `#` line or trailing.
// Escapes: standard "\n", "\t", "\\", '\"'.
// Multi-line strings: """..."""  (rudimentary — no escape sequences inside)
// This covers §7.6.10's ~40 keys. Full TOML support can be swapped in later.

interface ParsedToml {
  [k: string]: unknown;
}

function stripComment(line: string): string {
  let out = "";
  let inStr: '"' | "'" | null = null;
  let esc = false;
  for (const c of line) {
    if (esc) {
      out += c;
      esc = false;
      continue;
    }
    if (c === "\\" && inStr) {
      out += c;
      esc = true;
      continue;
    }
    if ((c === '"' || c === "'") && !inStr) {
      inStr = c;
      out += c;
    } else if (inStr && c === inStr) {
      inStr = null;
      out += c;
    } else if (c === "#" && !inStr) {
      break;
    } else {
      out += c;
    }
  }
  return out.replace(/\s+$/, "");
}

function parseValue(raw: string): unknown {
  const s = raw.trim();
  if (s.length === 0) return null;
  if (s === "true") return true;
  if (s === "false") return false;
  // String (double or single)
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    const inner = s.slice(1, -1);
    if (s.startsWith('"')) {
      return inner
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
    }
    return inner;
  }
  // Number
  if (/^-?\d+$/.test(s)) return Number.parseInt(s, 10);
  if (/^-?\d+\.\d+$/.test(s)) return Number.parseFloat(s);
  // Array
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    if (inner.length === 0) return [];
    // Split on commas not inside quotes.
    const items: string[] = [];
    let buf = "";
    let inStr: '"' | "'" | null = null;
    let depth = 0;
    for (const c of inner) {
      if (inStr) {
        buf += c;
        if (c === inStr) inStr = null;
        continue;
      }
      if (c === '"' || c === "'") {
        buf += c;
        inStr = c;
        continue;
      }
      if (c === "[") {
        depth++;
        buf += c;
        continue;
      }
      if (c === "]") {
        depth--;
        buf += c;
        continue;
      }
      if (c === "," && depth === 0) {
        items.push(buf);
        buf = "";
        continue;
      }
      buf += c;
    }
    if (buf.trim().length > 0) items.push(buf);
    return items.map((i) => parseValue(i));
  }
  // Inline table (very minimal).
  if (s.startsWith("{") && s.endsWith("}")) {
    const inner = s.slice(1, -1).trim();
    const out: Record<string, unknown> = {};
    if (inner.length === 0) return out;
    // Split on commas at depth 0.
    const pairs = splitTopLevel(inner, ",");
    for (const p of pairs) {
      const eq = p.indexOf("=");
      if (eq < 0) continue;
      out[p.slice(0, eq).trim()] = parseValue(p.slice(eq + 1));
    }
    return out;
  }
  // Triple-quoted string
  if (s.startsWith('"""') && s.endsWith('"""')) {
    return s.slice(3, -3).replace(/^\n/, "");
  }
  return s;
}

function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let buf = "";
  let inStr: '"' | "'" | null = null;
  let depth = 0;
  for (const c of s) {
    if (inStr) {
      buf += c;
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") {
      buf += c;
      inStr = c;
      continue;
    }
    if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    if (c === sep && depth === 0) {
      out.push(buf);
      buf = "";
    } else {
      buf += c;
    }
  }
  if (buf.length > 0) out.push(buf);
  return out;
}

function setDeep(obj: ParsedToml, segs: string[], value: unknown): void {
  let cur: ParsedToml = obj;
  for (let i = 0; i < segs.length - 1; i++) {
    const k = segs[i]!;
    if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
    cur = cur[k] as ParsedToml;
  }
  cur[segs[segs.length - 1]!] = value;
}

export function parseToml(text: string): ParsedToml {
  const out: ParsedToml = {};
  let section: string[] = [];
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i]!;
    i++;
    const line = stripComment(raw).trim();
    if (line.length === 0) continue;

    if (line.startsWith("[") && line.endsWith("]")) {
      section = line
        .slice(1, -1)
        .split(".")
        .map((s) => s.trim());
      // Ensure section table exists.
      setDeep(
        out,
        section,
        (function ensure(): Record<string, unknown> {
          let cur: ParsedToml = out;
          for (const s of section) {
            if (typeof cur[s] !== "object" || cur[s] === null) cur[s] = {};
            cur = cur[s] as ParsedToml;
          }
          return cur as Record<string, unknown>;
        })(),
      );
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const valPart = line.slice(eq + 1).trim();
    // Multi-line triple-quoted string?
    if (valPart.startsWith('"""') && !valPart.endsWith('"""')) {
      let buf = valPart.slice(3);
      while (i < lines.length && !lines[i]!.trimEnd().endsWith('"""')) {
        buf += "\n" + lines[i]!;
        i++;
      }
      if (i < lines.length) {
        const l = lines[i]!.trimEnd();
        buf += "\n" + l.slice(0, l.length - 3);
        i++;
      }
      setDeep(out, [...section, key], buf);
      continue;
    }
    const value = parseValue(valPart);
    setDeep(out, [...section, key], value);
  }
  return out;
}

// ─── Apply parsed TOML to defaultConfig ──────────────────────────────────────

const KNOWN_TOP_KEYS = new Set([
  "profile",
  "model",
  "permissions",
  "search",
  "telemetry",
  "cli",
  "developer_instructions",
]);

export interface LoadConfigOptions {
  /** Path to user config. */
  userConfigPath?: string;
  /** Path to project config (default: .openapex/config.toml in workspace). */
  projectConfigPath?: string;
  /** Benchmark mode — IGNORE user + project configs entirely (§7.6.10). */
  benchmarkMode?: boolean;
}

export async function loadOpenApexConfig(opts: LoadConfigOptions = {}): Promise<OpenApexConfig> {
  const cfg = defaultConfig();
  if (opts.benchmarkMode) {
    // Hard-coded branch: no user/project config in benchmark mode.
    return cfg;
  }
  const unknowns: string[] = [];
  async function merge(filePath: string, src: "user" | "project"): Promise<void> {
    const f = Bun.file(filePath);
    if (!(await f.exists())) return;
    const text = await f.text();
    const parsed = parseToml(text);
    for (const [k, v] of Object.entries(parsed)) {
      if (!KNOWN_TOP_KEYS.has(k)) {
        unknowns.push(`${src}:${filePath}#${k}`);
        continue;
      }
      mergeInto(cfg as unknown as Record<string, unknown>, k, v);
    }
  }
  if (opts.userConfigPath) await merge(opts.userConfigPath, "user");
  if (opts.projectConfigPath) await merge(opts.projectConfigPath, "project");
  cfg._unknown_keys = unknowns;
  return cfg;
}

function mergeInto(target: Record<string, unknown>, key: string, value: unknown): void {
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    target[key] &&
    typeof target[key] === "object" &&
    !Array.isArray(target[key])
  ) {
    const t = target[key] as Record<string, unknown>;
    for (const [k, v] of Object.entries(value)) {
      mergeInto(t, k, v);
    }
  } else {
    target[key] = value;
  }
}
