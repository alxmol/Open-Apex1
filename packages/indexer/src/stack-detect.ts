/**
 * Detect test frameworks, build systems, and package managers from the
 * workspace layout. Output feeds §3.4.4 `RepoScoutResult` fields directly
 * and is also consumed by the §7.6.2 validator discoverer.
 */

import { existsSync } from "node:fs";
import * as path from "node:path";

import type { RepoMap } from "@open-apex/core";

export interface StackDetection {
  languages: string[];
  testFrameworks: string[];
  buildSystems: string[];
  packageManagers: string[];
  likelyEntrypoints: string[];
  /** High-signal config files worth reading early (first 4 KB each). */
  keyConfigFiles: string[];
}

const LANG_EXT_HINTS: Record<string, string[]> = {
  python: [".py"],
  typescript: [".ts", ".tsx"],
  javascript: [".js", ".jsx", ".mjs", ".cjs"],
  rust: [".rs"],
  go: [".go"],
  java: [".java"],
  ruby: [".rb"],
  c: [".c", ".h"],
  cpp: [".cpp", ".cc", ".cxx", ".hpp"],
  ocaml: [".ml", ".mli"],
  bash: [".sh", ".bash"],
};

export function detectStack(workspace: string, map?: RepoMap): StackDetection {
  const files = map?.files.map((f) => f.path) ?? [];
  const hasPath = (rel: string): boolean => existsSync(path.join(workspace, rel));
  const has = (rel: string): boolean => files.includes(rel) || hasPath(rel);

  const languages = detectLanguages(files, map);
  const testFrameworks: string[] = [];
  const buildSystems: string[] = [];
  const packageManagers: string[] = [];
  const keyConfigFiles: string[] = [];
  const likelyEntrypoints: string[] = [];

  // Python
  if (has("pyproject.toml")) {
    packageManagers.push("pip");
    keyConfigFiles.push("pyproject.toml");
    if (has("poetry.lock")) packageManagers.push("poetry");
    if (has("uv.lock")) packageManagers.push("uv");
  }
  if (has("requirements.txt")) {
    packageManagers.push("pip");
    keyConfigFiles.push("requirements.txt");
  }
  if (has("Pipfile")) packageManagers.push("pipenv");
  if (has("setup.py") || has("setup.cfg")) packageManagers.push("setuptools");
  if (
    has("pytest.ini") ||
    has("tox.ini") ||
    has("conftest.py") ||
    files.some((f) => /^tests?\//.test(f))
  ) {
    testFrameworks.push("pytest");
  }

  // Node / JS / TS
  if (has("package.json")) {
    packageManagers.push("npm");
    keyConfigFiles.push("package.json");
    if (has("pnpm-lock.yaml")) packageManagers.push("pnpm");
    else if (has("yarn.lock")) packageManagers.push("yarn");
    else if (has("bun.lock") || has("bun.lockb")) packageManagers.push("bun");
  }
  if (has("tsconfig.json")) {
    buildSystems.push("tsc");
    keyConfigFiles.push("tsconfig.json");
  }
  if (
    files.some((f) => /^jest\.config\.[jt]s$/.test(f)) ||
    has("jest.config.js") ||
    has("jest.config.ts")
  ) {
    testFrameworks.push("jest");
  }
  if (files.some((f) => /^vitest\.config\.[jt]s$/.test(f))) testFrameworks.push("vitest");
  if (files.some((f) => /^cypress\.config\.[jt]s$/.test(f))) testFrameworks.push("cypress");

  // Rust
  if (has("Cargo.toml")) {
    packageManagers.push("cargo");
    buildSystems.push("cargo");
    keyConfigFiles.push("Cargo.toml");
    testFrameworks.push("cargo-test");
  }

  // Go
  if (has("go.mod")) {
    packageManagers.push("go-modules");
    buildSystems.push("go");
    keyConfigFiles.push("go.mod");
    testFrameworks.push("go-test");
  }

  // Ruby
  if (has("Gemfile")) packageManagers.push("bundler");
  if (files.some((f) => /^spec\//.test(f))) testFrameworks.push("rspec");

  // C / C++ build
  if (has("Makefile") || has("makefile")) {
    buildSystems.push("make");
    keyConfigFiles.push("Makefile");
  }
  if (has("CMakeLists.txt")) {
    buildSystems.push("cmake");
    keyConfigFiles.push("CMakeLists.txt");
  }
  if (has("meson.build")) buildSystems.push("meson");
  if (has("build.ninja")) buildSystems.push("ninja");

  // Java / Gradle / Maven
  if (has("pom.xml")) {
    buildSystems.push("maven");
    packageManagers.push("maven");
    keyConfigFiles.push("pom.xml");
  }
  if (has("build.gradle") || has("build.gradle.kts")) {
    buildSystems.push("gradle");
    packageManagers.push("gradle");
  }

  // Docker / infra
  if (has("Dockerfile")) keyConfigFiles.push("Dockerfile");
  if (has("docker-compose.yml") || has("docker-compose.yaml")) {
    keyConfigFiles.push("docker-compose.yml");
  }

  // Entrypoints
  for (const cand of [
    "main.py",
    "app.py",
    "server.py",
    "cli.py",
    "src/main.ts",
    "src/index.ts",
    "src/main.rs",
    "main.go",
    "cmd/main.go",
    "Main.java",
    "src/main/java/Main.java",
    "index.js",
    "server.js",
  ]) {
    if (has(cand)) likelyEntrypoints.push(cand);
  }

  return {
    languages,
    testFrameworks: unique(testFrameworks),
    buildSystems: unique(buildSystems),
    packageManagers: unique(packageManagers),
    likelyEntrypoints,
    keyConfigFiles: unique(keyConfigFiles),
  };
}

function detectLanguages(files: string[], map: RepoMap | undefined): string[] {
  if (map && map.files.length > 0) {
    const set = new Set<string>();
    for (const f of map.files) if (f.language) set.add(f.language);
    return [...set].sort();
  }
  const set = new Set<string>();
  for (const [lang, exts] of Object.entries(LANG_EXT_HINTS)) {
    for (const f of files) {
      if (exts.some((e) => f.endsWith(e))) {
        set.add(lang);
        break;
      }
    }
  }
  return [...set].sort();
}

function unique(xs: string[]): string[] {
  return [...new Set(xs)];
}
