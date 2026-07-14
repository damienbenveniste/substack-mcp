import { z } from "zod";

import { parseHttpUrl } from "../safety/urlPolicy.js";
import {
  type NewsletterBlock,
  normalizeCodeLanguage,
} from "./newsletterBlocks.js";

export interface BlocksParseResult {
  readonly blocks: readonly NewsletterBlock[];
  readonly errors: readonly string[];
}

const InlineSpanSchema = z
  .object({
    text: z.string(),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    code: z.boolean().optional(),
    href: PublicHttpUrlSchema("href").optional(),
  })
  .strict();

const OptionalCodeLanguageSchema: z.ZodType<
  string | undefined,
  z.ZodTypeDef,
  unknown
> = z.preprocess(
  (value) => (typeof value === "string" ? normalizeCodeLanguage(value) : value),
  z.string().optional(),
);

function PublicHttpUrlSchema(fieldName: string): z.ZodType<string> {
  return z.string().superRefine((value, context) => {
    const parsed = parseHttpUrl(value, fieldName);
    if (!parsed.ok) {
      for (const error of parsed.errors) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: error,
        });
      }
    }
  });
}

type LazyNewsletterBlockSchema = z.ZodType<
  NewsletterBlock,
  z.ZodTypeDef,
  unknown
>;

const NewsletterBlockSchema: LazyNewsletterBlockSchema = z.lazy(() =>
  z.discriminatedUnion("type", [
    z
      .object({
        type: z.literal("paragraph"),
        children: z.array(InlineSpanSchema),
      })
      .strict(),
    z
      .object({
        type: z.literal("heading"),
        level: z.union([
          z.literal(1),
          z.literal(2),
          z.literal(3),
          z.literal(4),
          z.literal(5),
          z.literal(6),
        ]),
        children: z.array(InlineSpanSchema),
      })
      .strict(),
    z
      .object({
        type: z.literal("blockquote"),
        children: z.array(NewsletterBlockSchema),
      })
      .strict(),
    z
      .object({
        type: z.literal("bulleted_list"),
        items: z.array(
          z
            .object({
              children: z.array(NewsletterBlockSchema),
            })
            .strict(),
        ),
      })
      .strict(),
    z
      .object({
        type: z.literal("ordered_list"),
        start: z.number().int().positive().optional(),
        items: z.array(
          z
            .object({
              children: z.array(NewsletterBlockSchema),
            })
            .strict(),
        ),
      })
      .strict(),
    z
      .object({
        type: z.literal("horizontal_rule"),
      })
      .strict(),
    z
      .object({
        type: z.literal("image"),
        src: PublicHttpUrlSchema("src"),
        alt: z.string().optional(),
        caption: z.string().optional(),
        title: z.string().optional(),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("code_block"),
        language: OptionalCodeLanguageSchema,
        code: z.string(),
      })
      .strict(),
    z
      .object({
        type: z.literal("latex_block"),
        latex: z.string(),
      })
      .strict(),
    z
      .object({
        type: z.literal("embed_url"),
        url: PublicHttpUrlSchema("url"),
      })
      .strict(),
  ]),
);

export const NewsletterBlocksSchema = z.array(NewsletterBlockSchema);

export function parseBlocks(input: unknown): BlocksParseResult {
  const result = NewsletterBlocksSchema.safeParse(input);

  if (result.success) {
    return {
      blocks: result.data,
      errors: [],
    };
  }

  return {
    blocks: [],
    errors: result.error.issues.map(
      (issue) => `${issue.path.join(".") || "blocks"}: ${issue.message}`,
    ),
  };
}
