/**
 * §7.6.2 minimal-safe fallback validator.
 *
 * Selects a per-language safe compile/typecheck command based on the
 * workspace's detected language files. Used at M1 as the ONLY discoverable
 * validator beyond explicit task instructions — the full §7.6.2 ladder
 * (repo manifest → framework convention → repo search → Harbor convention)
 * is built in M3/M4.
 */

import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

import type { ValidatorCandidate } from "@open-apex/core";

export interface FallbackCandidate {
  language: string;
  candidate: ValidatorCandidate;
}

export async function discoverMinimalSafeFallback(
  workspace: string,
  opts: { commandExists?: (command: string) => boolean } = {},
): Promise<FallbackCandidate[]> {
  const results: FallbackCandidate[] = [];
  const hasCommand = opts.commandExists ?? commandExists;

  // TypeScript / JavaScript.
  if (existsSync(path.join(workspace, "tsconfig.json")) && hasCommand("npx")) {
    results.push({
      language: "typescript",
      candidate: {
        command: "npx tsc --noEmit",
        confidence: "low",
        source: "minimal_safe_fallback",
        justification: "tsconfig.json detected; tsc --noEmit is the cheapest safety check",
      },
    });
  } else {
    const jsFiles = await hasFilesWithExt(workspace, [".js", ".mjs", ".cjs"]);
    if (jsFiles.length > 0 && hasCommand("node")) {
      results.push({
        language: "javascript",
        candidate: {
          command: `node --check ${jsFiles.slice(0, 5).join(" ")}`,
          confidence: "low",
          source: "minimal_safe_fallback",
          justification: ".js files detected; node --check verifies syntax",
        },
      });
    }
  }

  // Python.
  const pyFiles = await hasFilesWithExt(workspace, [".py"]);
  if (pyFiles.length > 0 && hasCommand("python3")) {
    results.push({
      language: "python",
      candidate: {
        command:
          "PYTHONPYCACHEPREFIX=.open-apex/pycache python3 -m py_compile " +
          pyFiles.slice(0, 10).join(" "),
        confidence: "low",
        source: "minimal_safe_fallback",
        justification: ".py files detected; py_compile verifies syntax cheaply",
      },
    });
    if (
      (existsSync(path.join(workspace, "mypy.ini")) ||
        existsSync(path.join(workspace, "pyproject.toml"))) &&
      hasCommand("mypy")
    ) {
      results.push({
        language: "python-mypy",
        candidate: {
          command: "mypy .",
          confidence: "low",
          source: "minimal_safe_fallback",
          justification: "mypy config detected",
        },
      });
    }
  }

  // Rust.
  if (existsSync(path.join(workspace, "Cargo.toml")) && hasCommand("cargo")) {
    results.push({
      language: "rust",
      candidate: {
        command: "cargo check --all-targets",
        confidence: "low",
        source: "minimal_safe_fallback",
        justification: "Cargo.toml detected",
      },
    });
  }

  // Go.
  if (existsSync(path.join(workspace, "go.mod")) && hasCommand("go")) {
    results.push({
      language: "go",
      candidate: {
        command: "go vet ./...",
        confidence: "low",
        source: "minimal_safe_fallback",
        justification: "go.mod detected",
      },
    });
    results.push({
      language: "go-build",
      candidate: {
        command: "go build ./...",
        confidence: "low",
        source: "minimal_safe_fallback",
        justification: "go.mod detected; ensure package builds",
      },
    });
  }

  // Ruby.
  const rbFiles = await hasFilesWithExt(workspace, [".rb"]);
  if (rbFiles.length > 0 && hasCommand("ruby")) {
    results.push({
      language: "ruby",
      candidate: {
        command: `ruby -c ${rbFiles.slice(0, 5).join(" ")}`,
        confidence: "low",
        source: "minimal_safe_fallback",
        justification: ".rb files detected; ruby -c verifies syntax",
      },
    });
  }

  // C/C++ (Makefile dry-run).
  if (existsSync(path.join(workspace, "Makefile")) && hasCommand("make")) {
    results.push({
      language: "make",
      candidate: {
        command: "make -n",
        confidence: "low",
        source: "minimal_safe_fallback",
        justification: "Makefile detected; dry-run verifies nothing blows up",
      },
    });
  }

  return results;
}

function commandExists(command: string): boolean {
  const r = spawnSync("which", [command], { stdio: "ignore" });
  return r.status === 0;
}

async function hasFilesWithExt(root: string, exts: string[]): Promise<string[]> {
  const matches: string[] = [];
  // Shallow: walk 2 levels. Full search is expensive and not needed for the
  // minimal-safe fallback (we just need to confirm the language exists).
  const walk = async (dir: string, depth: number) => {
    if (depth > 2) return;
    let items: string[];
    try {
      items = await readdir(dir);
    } catch {
      return;
    }
    for (const name of items) {
      if (name.startsWith(".")) continue;
      if (
        ["node_modules", "dist", "build", "target", ".venv", "__pycache__", "coverage"].includes(
          name,
        )
      ) {
        continue;
      }
      const full = path.join(dir, name);
      let st;
      try {
        st = await stat(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        await walk(full, depth + 1);
      } else {
        for (const e of exts) {
          if (name.endsWith(e)) {
            matches.push(path.relative(root, full));
            break;
          }
        }
      }
      if (matches.length >= 20) return;
    }
  };
  await walk(root, 0);
  return matches;
}
