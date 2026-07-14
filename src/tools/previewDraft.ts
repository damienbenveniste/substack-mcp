import { z } from "zod";

import type { AppConfig } from "../config.js";
import { createConfirmationToken } from "../safety/confirmationToken.js";
import {
  AudienceSchema,
  buildDraftPayload,
  type DraftAudience,
  type DraftPayload,
  type DraftPayloadStats,
} from "./draftPayload.js";

export const PreviewDraftInputSchema = z
  .object({
    action: z.enum(["create", "update"]),
    draft_id: z.number().int().positive().optional(),
    title: z.string().optional(),
    subtitle: z.string().optional(),
    audience: AudienceSchema.optional(),
    body_format: z.enum(["markdown_v1", "blocks_v1"]).optional(),
    body_markdown: z.string().optional(),
    blocks: z.unknown().optional(),
    include_payload_debug: z.boolean().optional(),
  })
  .strict();

export type PreviewDraftInput = z.infer<typeof PreviewDraftInputSchema>;
export type PreviewDraftStats = DraftPayloadStats;

export interface PreviewDraftOutput {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly action: "create" | "update";
  readonly draft_id?: number | undefined;
  readonly title?: string | undefined;
  readonly subtitle?: string | undefined;
  readonly audience?: DraftAudience | undefined;
  readonly preview_text: string;
  readonly warnings: readonly string[];
  readonly stats: PreviewDraftStats;
  readonly confirmation_token?: string | undefined;
  readonly confirmation_expires_at?: string | undefined;
  readonly payload_debug?: PreviewPayloadDebug | undefined;
}

interface PreviewPayloadDebug {
  readonly payload_type: "newsletter" | "omitted";
  readonly audience?: DraftAudience | undefined;
  readonly has_title: boolean;
  readonly has_subtitle: boolean;
  readonly draft_body_bytes: number;
  readonly draft_body_doc_type: string;
  readonly has_audience: boolean;
  readonly top_level_nodes: number;
}

export function previewDraft(
  input: PreviewDraftInput,
  config: Pick<
    AppConfig,
    "confirmationTokenTtlSeconds" | "maxBodyBytes" | "previewTokenSecret"
  >,
  now = new Date(),
): PreviewDraftOutput {
  const errors: string[] = [];
  const warnings = new Set<string>();

  if (input.action === "update" && input.draft_id === undefined) {
    errors.push("draft_id is required when action is update.");
  }

  if (input.action === "create" && normalizeText(input.title) === "") {
    warnings.add("create_draft will require a non-empty title.");
  }

  const built = buildDraftPayload(input, config);
  errors.push(...built.errors);
  for (const warning of built.warnings) {
    warnings.add(warning);
  }

  const baseOutput = {
    ok: errors.length === 0,
    errors,
    action: input.action,
    draft_id: input.draft_id,
    title: input.title,
    subtitle: input.subtitle,
    audience: built.audience,
    preview_text: built.preview_text,
    warnings: Array.from(warnings),
    stats: built.stats,
  };

  if (errors.length > 0) {
    return baseOutput;
  }

  if (!built.payload) {
    return {
      ...baseOutput,
      ok: false,
      errors: ["Draft payload could not be built."],
    };
  }

  const confirmation = createConfirmationToken(
    {
      action: input.action,
      draft_id: input.draft_id,
      title: input.title,
      subtitle: input.subtitle,
      audience: built.audience,
      content: built.payload,
    },
    {
      secret: config.previewTokenSecret,
      ttlSeconds: config.confirmationTokenTtlSeconds,
      now,
    },
  );

  return {
    ...baseOutput,
    confirmation_token: confirmation.token,
    confirmation_expires_at: confirmation.expiresAt.toISOString(),
    payload_debug: input.include_payload_debug
      ? buildPayloadDebug(built.payload)
      : undefined,
  };
}

export function summarizePreview(result: PreviewDraftOutput): string {
  if (!result.ok) {
    return `Draft preview failed with ${result.errors.length} error(s).`;
  }

  const warningText =
    result.warnings.length > 0 ? ` ${result.warnings.length} warning(s).` : "";

  return `Draft preview ready for ${result.action}: ${result.stats.blocks} block(s), ${result.stats.words} word(s). Confirmation token expires at ${result.confirmation_expires_at}.${warningText}`;
}

function buildPayloadDebug(payload: DraftPayload): PreviewPayloadDebug {
  const draftBodyDoc =
    payload.draft_body === undefined
      ? { type: "none", topLevelNodes: 0 }
      : parseDraftBodyDoc(payload.draft_body);

  return {
    payload_type: payload.type ?? "omitted",
    audience: payload.audience,
    has_title: payload.draft_title !== undefined,
    has_subtitle: payload.draft_subtitle !== undefined,
    draft_body_bytes:
      payload.draft_body === undefined
        ? 0
        : Buffer.byteLength(payload.draft_body, "utf8"),
    draft_body_doc_type: draftBodyDoc.type,
    has_audience: payload.audience !== undefined,
    top_level_nodes: draftBodyDoc.topLevelNodes,
  };
}

function normalizeText(value: string | undefined): string {
  return value?.trim().replace(/\s+/g, " ") ?? "";
}

function parseDraftBodyDoc(draftBody: string): {
  readonly type: string;
  readonly topLevelNodes: number;
} {
  try {
    const parsed = JSON.parse(draftBody) as Record<string, unknown>;
    return {
      type: typeof parsed.type === "string" ? parsed.type : "unknown",
      topLevelNodes: Array.isArray(parsed.content) ? parsed.content.length : 0,
    };
  } catch {
    return {
      type: "unknown",
      topLevelNodes: 0,
    };
  }
}
