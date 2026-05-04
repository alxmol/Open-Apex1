/**
 * Source-ranking policy per §1.2.
 *
 * Prefer official docs / primary sources for API + framework questions, then
 * source repos / issue trackers / StackOverflow / technical blogs when the
 * task is implementation- or error-driven.
 *
 * Returns a compound `rankScore` on [0, 1] that the orchestrator can rely on
 * for sorting without knowing the provider.
 */

import type { SourceTier } from "./types.ts";

/** Hostname → source tier map. Lookup is suffix-based (wildcard-friendly). */
const OFFICIAL_DOCS_HOSTS: readonly string[] = Object.freeze([
  "docs.python.org",
  "docs.anthropic.com",
  "platform.claude.com",
  "developers.openai.com",
  "platform.openai.com",
  "docs.rs",
  "doc.rust-lang.org",
  "go.dev",
  "pkg.go.dev",
  "docs.aws.amazon.com",
  "cloud.google.com",
  "learn.microsoft.com",
  "developer.mozilla.org",
  "docs.djangoproject.com",
  "flask.palletsprojects.com",
  "fastapi.tiangolo.com",
  "reactjs.org",
  "react.dev",
  "vuejs.org",
  "svelte.dev",
  "angular.dev",
  "nodejs.org",
  "bun.sh",
  "tree-sitter.github.io",
  "kubernetes.io",
  "docs.docker.com",
  "postgresql.org",
  "www.postgresql.org",
  "sqlite.org",
  "www.sqlite.org",
  "redis.io",
  "mongodb.com",
  "www.mongodb.com",
  "nginx.org",
  "harbor.openssf.org",
]);

const SOURCE_REPO_SUFFIXES: readonly string[] = Object.freeze([
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "codeberg.org",
  "sr.ht",
]);

const SO_SUFFIXES: readonly string[] = Object.freeze([
  "stackoverflow.com",
  "stackexchange.com",
  "serverfault.com",
  "superuser.com",
]);

export function classifySourceTier(url: string): SourceTier {
  const host = parseHost(url);
  if (!host) return "other";
  if (OFFICIAL_DOCS_HOSTS.some((h) => hostMatches(host, h))) return "official_docs";
  if (SOURCE_REPO_SUFFIXES.some((h) => hostMatches(host, h))) return "source_repo";
  if (SO_SUFFIXES.some((h) => hostMatches(host, h))) return "so";
  if (isLikelyBlog(host)) return "blog";
  return "other";
}

function hostMatches(host: string, suffix: string): boolean {
  return host === suffix || host.endsWith(`.${suffix}`);
}

function parseHost(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function isLikelyBlog(host: string): boolean {
  const BLOG_HOSTS = [
    "medium.com",
    "substack.com",
    "dev.to",
    "hashnode.dev",
    "wordpress.com",
    "blogspot.com",
    "ghost.io",
  ];
  return BLOG_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/**
 * Compute a [0, 1] rank score from tier + SERP position.
 *   official_docs → 1.0 anchor, penalized by position
 *   source_repo   → 0.80 anchor
 *   so            → 0.65 anchor
 *   blog          → 0.45 anchor
 *   other         → 0.30 anchor
 *
 * Position penalty: linear 0 → -0.15 over positions 1 → 10.
 */
export function computeRankScore(tier: SourceTier, position: number): number {
  const anchor: Record<SourceTier, number> = {
    official_docs: 1.0,
    source_repo: 0.8,
    so: 0.65,
    blog: 0.45,
    other: 0.3,
  };
  const base = anchor[tier];
  const p = Math.max(1, Math.min(10, position));
  const penalty = ((p - 1) / 9) * 0.15;
  return Math.max(0, Math.min(1, base - penalty));
}

export { OFFICIAL_DOCS_HOSTS, SOURCE_REPO_SUFFIXES, SO_SUFFIXES };
