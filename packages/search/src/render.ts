/**
 * Rendering helpers: SearchBundle → provider-friendly content.
 *
 * Anthropic (via `@open-apex/core` `ContentPart.search_result`) — the adapter
 * already emits native `search_result` blocks with citation metadata.
 *
 * OpenAI — Responses API has no native search-result block, so we render a
 * fenced, provenance-annotated text block that the model can cite by URL.
 */

import type { ContentPart, SearchResultContent } from "@open-apex/core";

import type { SearchBundle, SearchResult } from "./types.ts";

export interface RenderOpts {
  /** Cap on number of results surfaced (default 6). */
  maxResults?: number;
  /** Include AI Overview + answer box + knowledge graph as prefixes. */
  includeAuxiliary?: boolean;
}

/** Convert a bundle to `SearchResultContent` parts — Anthropic-friendly. */
export function bundleToAnthropicBlocks(
  bundle: SearchBundle,
  opts: RenderOpts = {},
): SearchResultContent[] {
  const max = opts.maxResults ?? 6;
  const blocks: SearchResultContent[] = [];
  for (const r of bundle.results.slice(0, max)) {
    blocks.push({
      type: "search_result",
      title: r.title,
      url: r.url,
      snippet: r.snippet,
      ...(r.excerpt ? { content: r.excerpt } : {}),
      metadata: {
        rankScore: r.rankScore,
        sourceTier: r.sourceTier,
        provider: r.provenance.provider,
        fetchedAt: r.provenance.fetchedAt,
      },
    });
  }
  return blocks;
}

/**
 * Plain-text rendering for OpenAI. Each result is wrapped in a fenced
 * `<search_result …>…</search_result>` block that mirrors Anthropic's shape
 * so prompts written for one provider are legible on the other.
 */
export function bundleToOpenAiText(bundle: SearchBundle, opts: RenderOpts = {}): string {
  const max = opts.maxResults ?? 6;
  const lines: string[] = [];
  if (opts.includeAuxiliary !== false) {
    if (bundle.aiOverview) {
      lines.push(`<ai_overview>\n${bundle.aiOverview.trim()}\n</ai_overview>`);
    }
    if (bundle.answerBox) {
      lines.push(
        `<answer_box${
          bundle.answerBox.title ? ` title="${escapeAttr(bundle.answerBox.title)}"` : ""
        }${bundle.answerBox.link ? ` source="${escapeAttr(bundle.answerBox.link)}"` : ""}>\n${
          bundle.answerBox.snippet
        }\n</answer_box>`,
      );
    }
    if (bundle.knowledgeGraph) {
      lines.push(
        `<knowledge_graph${
          bundle.knowledgeGraph.title ? ` title="${escapeAttr(bundle.knowledgeGraph.title)}"` : ""
        }${
          bundle.knowledgeGraph.sourceUrl
            ? ` source="${escapeAttr(bundle.knowledgeGraph.sourceUrl)}"`
            : ""
        }>\n${bundle.knowledgeGraph.description}\n</knowledge_graph>`,
      );
    }
  }
  for (const r of bundle.results.slice(0, max)) {
    lines.push(renderSingle(r));
  }
  return lines.join("\n\n");
}

function renderSingle(r: SearchResult): string {
  const attrs = [
    `source="${escapeAttr(r.url)}"`,
    `title="${escapeAttr(r.title)}"`,
    `tier="${r.sourceTier}"`,
    `provider="${r.provenance.provider}"`,
    `rank="${r.rankScore.toFixed(2)}"`,
  ].join(" ");
  const body = (r.excerpt ?? r.snippet).trim();
  return `<search_result ${attrs}>\n${body}\n</search_result>`;
}

function escapeAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Fold a bundle into the generic `ContentPart[]` shape the orchestrator ships. */
export function bundleToContentParts(bundle: SearchBundle, opts: RenderOpts = {}): ContentPart[] {
  const parts: ContentPart[] = [];
  if (opts.includeAuxiliary !== false) {
    if (bundle.aiOverview) {
      parts.push({ type: "text", text: `AI Overview:\n${bundle.aiOverview.trim()}` });
    }
    if (bundle.answerBox) {
      parts.push({
        type: "text",
        text: `Answer box${bundle.answerBox.title ? ` — ${bundle.answerBox.title}` : ""}:\n${
          bundle.answerBox.snippet
        }${bundle.answerBox.link ? `\n(source: ${bundle.answerBox.link})` : ""}`,
      });
    }
  }
  for (const block of bundleToAnthropicBlocks(bundle, opts)) {
    parts.push(block);
  }
  return parts;
}
