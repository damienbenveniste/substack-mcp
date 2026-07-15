import { z } from "zod";

import type { AppConfig } from "../config.js";
import { createConfirmationToken } from "../safety/confirmationToken.js";
import {
  createSubstackClient,
  type SubstackClient,
} from "../substack/index.js";
import { selectDraftBody } from "./draftBody.js";
import {
  AudienceSchema,
  buildDraftPayload,
  type DraftAudience,
  type DraftPayload,
  type DraftPayloadStats,
  type DraftPreviewImage,
} from "./draftPayload.js";
import { isEditableUnpublishedDraft } from "./draftStatus.js";
import {
  applyNativeDraftImagePatch,
  NativeDraftImagePatchSchema,
  type NativeDraftImagePatchSummary,
} from "./nativeDraftImagePatch.js";
import { summarizeSubstackToolError } from "./substackToolErrors.js";

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
    image_patch: NativeDraftImagePatchSchema.optional().describe(
      "Targeted native image replacement. The server fetches and patches the current draft body; do not provide or reconstruct the full body.",
    ),
    include_payload_debug: z.boolean().optional(),
  })
  .strict();

export type PreviewDraftInput = z.infer<typeof PreviewDraftInputSchema>;
export type StandardPreviewDraftInput = PreviewDraftInput;
export type PreviewDraftImagePatchInput = PreviewDraftInput;
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
  readonly images: readonly DraftPreviewImage[];
  readonly confirmation_token?: string | undefined;
  readonly confirmation_expires_at?: string | undefined;
  readonly payload_debug?: PreviewPayloadDebug | undefined;
  readonly image_patch?: NativeDraftImagePatchSummary | undefined;
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
  input: StandardPreviewDraftInput,
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
    images: built.images,
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

interface PreviewDraftImagePatchOptions {
  readonly client?: Pick<SubstackClient, "getDraft"> | undefined;
  readonly now?: Date | undefined;
}

export async function previewDraftImagePatch(
  input: PreviewDraftImagePatchInput,
  config: Pick<
    AppConfig,
    | "confirmationTokenTtlSeconds"
    | "maxBodyBytes"
    | "previewTokenSecret"
    | "publicationUrl"
    | "sessionToken"
    | "substackRequestTimeoutMs"
    | "userAgent"
    | "userId"
  >,
  options: PreviewDraftImagePatchOptions = {},
): Promise<PreviewDraftOutput> {
  if (
    input.action !== "update" ||
    input.draft_id === undefined ||
    input.image_patch === undefined
  ) {
    return imagePatchPreviewFailure(input.draft_id ?? 0, [
      "A targeted image patch requires action=update, draft_id, and image_patch.",
    ]);
  }
  const conflictingFields = imagePatchConflictingFields(input);
  if (conflictingFields.length > 0) {
    return imagePatchPreviewFailure(
      input.draft_id,
      conflictingFields.map(
        (field) => `${field} must not be provided with image_patch.`,
      ),
    );
  }

  try {
    const client = options.client ?? createSubstackClient(config);
    const existing = await client.getDraft(input.draft_id);
    if (!isEditableUnpublishedDraft(existing)) {
      return imagePatchPreviewFailure(input.draft_id, [
        "Refusing to preview an image patch for a draft that Substack does not report as unpublished.",
      ]);
    }

    const patched = applyNativeDraftImagePatch(
      selectDraftBody(existing),
      input.image_patch,
      config.maxBodyBytes,
    );
    if (!patched.ok) {
      return imagePatchPreviewFailure(input.draft_id, patched.errors);
    }

    const payload: DraftPayload = { draft_body: patched.serialized_body };
    const confirmation = createConfirmationToken(
      {
        action: "update",
        draft_id: input.draft_id,
        content: payload,
      },
      {
        secret: config.previewTokenSecret,
        ttlSeconds: config.confirmationTokenTtlSeconds,
        now: options.now,
      },
    );

    return {
      ok: true,
      errors: [],
      action: "update",
      draft_id: input.draft_id,
      title: existing.title,
      preview_text: patched.preview_text,
      warnings: patched.warnings,
      stats: patched.stats,
      images: patched.images,
      image_patch: patched.summary,
      confirmation_token: confirmation.token,
      confirmation_expires_at: confirmation.expiresAt.toISOString(),
      payload_debug: input.include_payload_debug
        ? buildPayloadDebug(payload)
        : undefined,
    };
  } catch (error) {
    return imagePatchPreviewFailure(input.draft_id, [
      summarizeSubstackToolError(error),
    ]);
  }
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

function imagePatchPreviewFailure(
  draftId: number,
  errors: readonly string[],
): PreviewDraftOutput {
  return {
    ok: false,
    errors,
    action: "update",
    draft_id: draftId,
    preview_text: "",
    warnings: [],
    stats: {
      blocks: 0,
      words: 0,
      images: 0,
      code_blocks: 0,
      latex_blocks: 0,
    },
    images: [],
  };
}

function imagePatchConflictingFields(
  input: PreviewDraftInput,
): readonly string[] {
  return [
    "title",
    "subtitle",
    "audience",
    "body_format",
    "body_markdown",
    "blocks",
  ].filter((field) => input[field as keyof PreviewDraftInput] !== undefined);
}
