import { z } from "zod";

import type { AppConfig } from "../config.js";
import type { ContentStats } from "../content/newsletterBlocks.js";
import { parseNewsletterContent } from "../content/parseNewsletterContent.js";

export const ValidateNewsletterContentInputSchema = z
  .object({
    body_format: z.enum(["markdown_v1", "blocks_v1"]),
    body_markdown: z.string().optional(),
    blocks: z.unknown().optional(),
    strict: z.boolean().optional(),
  })
  .strict();

export type ValidateNewsletterContentInput = z.infer<
  typeof ValidateNewsletterContentInputSchema
>;

export interface ValidateNewsletterContentOutput {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly stats: ContentStats;
  readonly unsupported_features: readonly string[];
}

export function validateNewsletterContent(
  input: ValidateNewsletterContentInput,
  config: Pick<AppConfig, "maxBodyBytes">,
): ValidateNewsletterContentOutput {
  const parsed = parseNewsletterContent(input, config);

  return {
    ok: parsed.ok,
    errors: parsed.errors,
    warnings: parsed.warnings,
    stats: parsed.stats,
    unsupported_features: parsed.unsupportedFeatures,
  };
}

export function summarizeValidation(
  result: ValidateNewsletterContentOutput,
): string {
  if (!result.ok) {
    return `Content validation failed with ${result.errors.length} error(s).`;
  }

  const warningText =
    result.warnings.length > 0 ? ` ${result.warnings.length} warning(s).` : "";

  return `Content validation passed: ${result.stats.blocks} block(s), ${result.stats.words} word(s), ${result.stats.images} image(s), ${result.stats.code_blocks} code block(s), ${result.stats.latex_blocks} LaTeX block(s).${warningText}`;
}
