import type { AppConfig } from "../config.js";
import {
  checkJsonUtf8ByteLimit,
  checkUtf8ByteLimit,
} from "../safety/limits.js";
import {
  type ContentStats,
  computeContentStats,
  type NewsletterBlock,
  PROVISIONAL_LATEX_BLOCK_WARNING,
} from "./newsletterBlocks.js";
import { parseBlocks } from "./parseBlocks.js";
import { parseMarkdown } from "./parseMarkdown.js";

export type NewsletterBodyFormat = "markdown_v1" | "blocks_v1";

export interface NewsletterContentInput {
  readonly body_format: NewsletterBodyFormat;
  readonly body_markdown?: string | undefined;
  readonly blocks?: unknown;
  readonly strict?: boolean | undefined;
}

export interface ParsedNewsletterContent {
  readonly ok: boolean;
  readonly blocks: readonly NewsletterBlock[];
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly unsupportedFeatures: readonly string[];
  readonly stats: ContentStats;
}

const EMPTY_STATS: ContentStats = {
  characters: 0,
  words: 0,
  blocks: 0,
  images: 0,
  code_blocks: 0,
  latex_blocks: 0,
  links: 0,
};

export function parseNewsletterContent(
  input: NewsletterContentInput,
  config: Pick<AppConfig, "maxBodyBytes">,
): ParsedNewsletterContent {
  const errors: string[] = [];
  const warnings: string[] = [];
  const unsupportedFeatures = new Set<string>();
  let blocks: readonly NewsletterBlock[] = [];

  if (input.body_format === "markdown_v1") {
    if (input.blocks !== undefined) {
      errors.push(
        "blocks must not be provided when body_format is markdown_v1.",
      );
    }

    const markdown = input.body_markdown;
    if (markdown === undefined) {
      errors.push("body_markdown is required when body_format is markdown_v1.");
    } else {
      const limit = checkUtf8ByteLimit(markdown, config.maxBodyBytes);
      if (!limit.ok) {
        errors.push(
          `body_markdown is ${limit.bytes} bytes, which exceeds MAX_BODY_BYTES=${limit.maxBytes}.`,
        );
      }

      const parsed = parseMarkdown(markdown);
      blocks = parsed.blocks;
      warnings.push(...parsed.warnings);
      for (const feature of parsed.unsupportedFeatures) {
        unsupportedFeatures.add(feature);
      }
    }
  } else {
    if (input.body_markdown !== undefined) {
      errors.push(
        "body_markdown must not be provided when body_format is blocks_v1.",
      );
    }

    const limit = checkJsonUtf8ByteLimit(input.blocks, config.maxBodyBytes);
    if (limit && !limit.ok) {
      errors.push(
        `blocks is ${limit.bytes} bytes, which exceeds MAX_BODY_BYTES=${limit.maxBytes}.`,
      );
    }

    const parsed = parseBlocks(input.blocks);
    blocks = parsed.blocks;
    errors.push(...parsed.errors);
  }

  if (input.strict && unsupportedFeatures.size > 0) {
    errors.push(
      `Unsupported features in strict mode: ${Array.from(unsupportedFeatures).join(", ")}.`,
    );
  }

  if (unsupportedFeatures.has("raw_html")) {
    errors.push("Raw HTML is not supported in V1.");
  }

  const parsedStats = computeContentStats(blocks);
  if (parsedStats.latex_blocks > 0) {
    warnings.push(PROVISIONAL_LATEX_BLOCK_WARNING);
    if (input.strict) {
      errors.push(
        "LaTeX block mapping is provisional until a live Substack LaTeX fixture is captured; strict mode requires native LaTeX fixture compatibility.",
      );
    }
  }

  const stats =
    errors.length > 0 && blocks.length === 0 ? EMPTY_STATS : parsedStats;

  return {
    ok: errors.length === 0,
    blocks,
    errors,
    warnings,
    unsupportedFeatures: Array.from(unsupportedFeatures),
    stats,
  };
}
