import { z } from "zod";

import type { AppConfig } from "../config.js";
import { parseNewsletterContent } from "../content/parseNewsletterContent.js";
import { toPreviewText } from "../content/toPreviewText.js";
import {
  type SubstackPmDoc,
  toSubstackProseMirror,
} from "../content/toSubstackProseMirror.js";
import type { ConfirmationAction } from "../safety/confirmationToken.js";
import { stableStringify } from "../safety/confirmationToken.js";

export const AudienceSchema = z.enum([
  "everyone",
  "only_paid",
  "founding",
  "only_free",
]);

export type DraftAudience = z.infer<typeof AudienceSchema>;

export interface DraftPayloadInput {
  readonly action: ConfirmationAction;
  readonly title?: string | undefined;
  readonly subtitle?: string | undefined;
  readonly audience?: DraftAudience | undefined;
  readonly body_format?: "markdown_v1" | "blocks_v1" | undefined;
  readonly body_markdown?: string | undefined;
  readonly blocks?: unknown;
}

export interface DraftPayload {
  readonly draft_title?: string | undefined;
  readonly draft_subtitle?: string | undefined;
  readonly draft_body?: string | undefined;
  readonly audience?: DraftAudience | undefined;
  readonly type?: "newsletter" | undefined;
}

export interface DraftPayloadStats {
  readonly blocks: number;
  readonly words: number;
  readonly images: number;
  readonly code_blocks: number;
  readonly latex_blocks: number;
}

export interface BuildDraftPayloadOutput {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
  readonly stats: DraftPayloadStats;
  readonly preview_text: string;
  readonly audience?: DraftAudience | undefined;
  readonly payload?: DraftPayload | undefined;
}

const EMPTY_STATS: DraftPayloadStats = {
  blocks: 0,
  words: 0,
  images: 0,
  code_blocks: 0,
  latex_blocks: 0,
};

export function buildDraftPayload(
  input: DraftPayloadInput,
  config: Pick<AppConfig, "maxBodyBytes">,
): BuildDraftPayloadOutput {
  if (input.body_format === undefined) {
    return buildMetadataOnlyPayload(input);
  }

  const warnings = new Set<string>();
  const parsed = parseNewsletterContent(
    {
      body_format: input.body_format,
      body_markdown: input.body_markdown,
      blocks: input.blocks,
    },
    config,
  );

  for (const warning of parsed.warnings) {
    warnings.add(warning);
  }

  const conversion = parsed.ok
    ? toSubstackProseMirror(parsed.blocks)
    : { doc: emptyDoc(), warnings: [] };
  for (const warning of conversion.warnings) {
    warnings.add(warning);
  }

  const stats: DraftPayloadStats = {
    blocks: parsed.stats.blocks,
    words: parsed.stats.words,
    images: parsed.stats.images,
    code_blocks: parsed.stats.code_blocks,
    latex_blocks: parsed.stats.latex_blocks,
  };
  const baseOutput = {
    ok: parsed.ok,
    errors: parsed.errors,
    warnings: Array.from(warnings),
    stats,
    preview_text: toPreviewText(parsed.blocks),
    audience: resolveAudience(input),
  };

  if (!parsed.ok) {
    return baseOutput;
  }

  return {
    ...baseOutput,
    payload: toDraftPayload(input, baseOutput.audience, conversion.doc),
  };
}

function toDraftPayload(
  input: Pick<DraftPayloadInput, "action" | "subtitle" | "title">,
  audience: DraftAudience | undefined,
  doc: SubstackPmDoc | undefined,
): DraftPayload {
  return {
    ...(input.title !== undefined
      ? { draft_title: normalizeMetadataText(input.title) }
      : {}),
    ...(input.subtitle !== undefined
      ? { draft_subtitle: normalizeMetadataText(input.subtitle) }
      : {}),
    ...(doc !== undefined ? { draft_body: stableStringify(doc) } : {}),
    ...(audience !== undefined ? { audience } : {}),
    ...(input.action === "create" ? { type: "newsletter" as const } : {}),
  };
}

function buildMetadataOnlyPayload(
  input: DraftPayloadInput,
): BuildDraftPayloadOutput {
  const errors: string[] = [];
  const audience = resolveAudience(input);

  if (input.action === "create") {
    errors.push("body_format is required when action is create.");
  }

  if (input.body_markdown !== undefined || input.blocks !== undefined) {
    errors.push("body_format is required when body content is provided.");
  }

  if (
    input.action === "update" &&
    input.title === undefined &&
    input.subtitle === undefined &&
    input.audience === undefined
  ) {
    errors.push(
      "At least one of title, subtitle, audience, or body content is required for update.",
    );
  }

  const ok = errors.length === 0;

  return {
    ok,
    errors,
    warnings: [],
    stats: EMPTY_STATS,
    preview_text: metadataPreviewText(input, audience),
    audience,
    payload: ok ? toDraftPayload(input, audience, undefined) : undefined,
  };
}

function metadataPreviewText(
  input: Pick<DraftPayloadInput, "audience" | "subtitle" | "title">,
  audience: DraftAudience | undefined,
): string {
  const changes: string[] = [];
  if (input.title !== undefined) {
    changes.push("title");
  }
  if (input.subtitle !== undefined) {
    changes.push("subtitle");
  }
  if (input.audience !== undefined || audience !== undefined) {
    changes.push("audience");
  }

  return changes.length > 0
    ? `Metadata-only update: ${changes.join(", ")}.`
    : "Metadata-only update.";
}

function resolveAudience(
  input: Pick<DraftPayloadInput, "audience">,
): DraftAudience | undefined {
  return input.audience;
}

function normalizeMetadataText(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function emptyDoc(): SubstackPmDoc {
  return {
    type: "doc",
    content: [],
  };
}
