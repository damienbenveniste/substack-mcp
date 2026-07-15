import { z } from "zod";

import type { AppConfig } from "../config.js";
import { type AuditLogger, writeAuditEvent } from "../logging/audit.js";
import {
  verifyConfirmationToken,
  verifyConfirmationTokenIntegrity,
} from "../safety/confirmationToken.js";
import {
  createSubstackClient,
  type SubstackClient,
} from "../substack/index.js";
import type { DraftUpdatePayload } from "../substack/types.js";
import { selectDraftBody } from "./draftBody.js";
import {
  AudienceSchema,
  type BuildDraftPayloadOutput,
  buildDraftPayload,
  type DraftPayload,
} from "./draftPayload.js";
import { isEditableUnpublishedDraft } from "./draftStatus.js";
import { addDraftUrlWarningIfUnsafe, toSafeDraftUrl } from "./draftUrl.js";
import {
  applyNativeDraftImagePatch,
  NativeDraftImagePatchSchema,
  type NativeDraftImagePatchSummary,
} from "./nativeDraftImagePatch.js";
import { summarizeSubstackToolError } from "./substackToolErrors.js";

export const UpdateDraftInputSchema = z
  .object({
    draft_id: z.number().int().positive(),
    title: z.string().optional(),
    subtitle: z.string().optional(),
    audience: AudienceSchema.optional(),
    body_format: z.enum(["markdown_v1", "blocks_v1"]).optional(),
    body_markdown: z.string().optional(),
    blocks: z.unknown().optional(),
    image_patch: NativeDraftImagePatchSchema.optional().describe(
      "The exact native image replacement previously authorized by preview_draft.",
    ),
    confirmation_token: z.string().min(1),
  })
  .strict();

export type UpdateDraftInput = z.infer<typeof UpdateDraftInputSchema>;
export type StandardUpdateDraftInput = UpdateDraftInput;
export type UpdateDraftImagePatchInput = UpdateDraftInput;

export interface UpdateDraftOutput {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly draft_id?: number | undefined;
  readonly draft_title?: string | undefined;
  readonly draft_url?: string | undefined;
  readonly message: string;
  readonly warnings: readonly string[];
  readonly image_patch?: NativeDraftImagePatchSummary | undefined;
}

interface UpdateDraftOptions {
  readonly client?:
    | Pick<SubstackClient, "getDraft" | "updateDraft">
    | undefined;
  readonly now?: Date | undefined;
  readonly auditLogger?: AuditLogger | undefined;
}

export async function updateDraft(
  input: UpdateDraftInput,
  config: Pick<
    AppConfig,
    | "maxBodyBytes"
    | "previewTokenSecret"
    | "publicationUrl"
    | "sessionToken"
    | "substackRequestTimeoutMs"
    | "userAgent"
    | "userId"
  >,
  options: UpdateDraftOptions = {},
): Promise<UpdateDraftOutput> {
  if (input.image_patch !== undefined) {
    return updateDraftImagePatch(input, config, options);
  }

  const warnings = new Set<string>();
  const errors: string[] = [];

  const built = buildDraftPayload({ ...input, action: "update" }, config);
  errors.push(...built.errors);
  for (const warning of built.warnings) {
    warnings.add(warning);
  }

  if (built.payload) {
    const tokenError = verifyDraftToken(
      input,
      built.payload,
      built.audience,
      config,
      options.now,
    );
    if (tokenError) {
      errors.push(tokenError);
    }
  }

  if (errors.length > 0 || !built.payload) {
    auditUpdateDraft(options.auditLogger, input, built, {
      outcome: "failure",
      reason: "validation",
      errorCount: errors.length,
      warningCount: warnings.size,
    });
    return failure(errors, warnings, input.draft_id);
  }

  try {
    const client = options.client ?? createSubstackClient(config);
    const existing = await client.getDraft(input.draft_id);
    if (!isEditableUnpublishedDraft(existing)) {
      auditUpdateDraft(options.auditLogger, input, built, {
        outcome: "blocked",
        reason: "not_unpublished_draft",
        errorCount: 1,
        warningCount: warnings.size,
      });
      return failure(
        [
          "Refusing to update a draft that Substack does not report as an unpublished draft.",
        ],
        warnings,
        input.draft_id,
      );
    }

    const payload: DraftUpdatePayload = built.payload;
    const updated = await client.updateDraft(input.draft_id, payload);
    const candidateDraftUrl = updated.url ?? existing.url;
    addDraftUrlWarningIfUnsafe(candidateDraftUrl, warnings);
    const draftUrl =
      updated.url === undefined
        ? toSafeDraftUrl(existing.url)
        : toSafeDraftUrl(updated.url);

    auditUpdateDraft(options.auditLogger, input, built, {
      outcome: "success",
      draftId: updated.id,
      errorCount: 0,
      warningCount: warnings.size,
    });

    return {
      ok: true,
      errors: [],
      draft_id: updated.id,
      draft_title: updated.title ?? built.payload.draft_title ?? existing.title,
      draft_url: draftUrl,
      message: `Updated Substack draft ${updated.id}. Review and publish manually in Substack.`,
      warnings: Array.from(warnings),
    };
  } catch (error) {
    const summary = summarizeSubstackToolError(error);
    auditUpdateDraft(options.auditLogger, input, built, {
      outcome: "failure",
      reason: "substack_client",
      errorCount: 1,
      warningCount: warnings.size,
    });
    return failure([summary], warnings, input.draft_id);
  }
}

async function updateDraftImagePatch(
  input: UpdateDraftImagePatchInput,
  config: Pick<
    AppConfig,
    | "maxBodyBytes"
    | "previewTokenSecret"
    | "publicationUrl"
    | "sessionToken"
    | "substackRequestTimeoutMs"
    | "userAgent"
    | "userId"
  >,
  options: UpdateDraftOptions,
): Promise<UpdateDraftOutput> {
  const warnings = new Set<string>();
  if (input.image_patch === undefined) {
    return failure(
      ["image_patch is required for a targeted native image update."],
      warnings,
      input.draft_id,
    );
  }
  const conflictingFields = imagePatchConflictingFields(input);
  if (conflictingFields.length > 0) {
    return failure(
      conflictingFields.map(
        (field) => `${field} must not be provided with image_patch.`,
      ),
      warnings,
      input.draft_id,
    );
  }
  const integrity = verifyConfirmationTokenIntegrity(input.confirmation_token, {
    secret: config.previewTokenSecret,
    now: options.now,
  });
  if (!integrity.ok) {
    auditNativeImagePatch(options.auditLogger, input.draft_id, {
      outcome: "failure",
      reason: "validation",
      warningCount: 0,
      errorCount: 1,
    });
    return failure([integrity.error], warnings, input.draft_id);
  }

  try {
    const client = options.client ?? createSubstackClient(config);
    const existing = await client.getDraft(input.draft_id);
    if (!isEditableUnpublishedDraft(existing)) {
      auditNativeImagePatch(options.auditLogger, input.draft_id, {
        outcome: "blocked",
        reason: "not_unpublished_draft",
        warningCount: 0,
        errorCount: 1,
      });
      return failure(
        [
          "Refusing to update a draft that Substack does not report as an unpublished draft.",
        ],
        warnings,
        input.draft_id,
      );
    }

    const patched = applyNativeDraftImagePatch(
      selectDraftBody(existing),
      input.image_patch,
      config.maxBodyBytes,
    );
    if (!patched.ok) {
      auditNativeImagePatch(options.auditLogger, input.draft_id, {
        outcome: "failure",
        reason: "validation",
        warningCount: 0,
        errorCount: patched.errors.length,
      });
      return failure(patched.errors, warnings, input.draft_id);
    }
    for (const warning of patched.warnings) {
      warnings.add(warning);
    }

    const payload: DraftUpdatePayload = {
      draft_body: patched.serialized_body,
    };
    const verification = verifyConfirmationToken(
      input.confirmation_token,
      {
        action: "update",
        draft_id: input.draft_id,
        content: payload,
      },
      {
        secret: config.previewTokenSecret,
        now: options.now,
      },
    );
    if (!verification.ok) {
      auditNativeImagePatch(options.auditLogger, input.draft_id, {
        outcome: "failure",
        reason: "validation",
        warningCount: warnings.size,
        errorCount: 1,
      });
      return failure([verification.error], warnings, input.draft_id);
    }

    const updated = await client.updateDraft(input.draft_id, payload);
    const candidateDraftUrl = updated.url ?? existing.url;
    addDraftUrlWarningIfUnsafe(candidateDraftUrl, warnings);
    const draftUrl =
      updated.url === undefined
        ? toSafeDraftUrl(existing.url)
        : toSafeDraftUrl(updated.url);

    auditNativeImagePatch(options.auditLogger, input.draft_id, {
      outcome: "success",
      warningCount: warnings.size,
      errorCount: 0,
      stats: patched.stats,
    });
    return {
      ok: true,
      errors: [],
      draft_id: updated.id,
      draft_title: updated.title ?? existing.title,
      draft_url: draftUrl,
      image_patch: patched.summary,
      message: `Replaced native image ${patched.summary.image_index} in Substack draft ${updated.id}. Review and publish manually in Substack.`,
      warnings: Array.from(warnings),
    };
  } catch (error) {
    auditNativeImagePatch(options.auditLogger, input.draft_id, {
      outcome: "failure",
      reason: "substack_client",
      warningCount: warnings.size,
      errorCount: 1,
    });
    return failure(
      [summarizeSubstackToolError(error)],
      warnings,
      input.draft_id,
    );
  }
}

export function summarizeUpdateDraft(result: UpdateDraftOutput): string {
  if (!result.ok) {
    return `Draft update failed with ${result.errors.length} error(s).`;
  }

  return result.message;
}

function verifyDraftToken(
  input: Pick<
    StandardUpdateDraftInput,
    "confirmation_token" | "draft_id" | "subtitle" | "title"
  >,
  payload: DraftPayload,
  audience: DraftPayload["audience"],
  config: Pick<AppConfig, "previewTokenSecret">,
  now: Date | undefined,
): string | undefined {
  const verification = verifyConfirmationToken(
    input.confirmation_token,
    {
      action: "update",
      draft_id: input.draft_id,
      title: input.title,
      subtitle: input.subtitle,
      audience,
      content: payload,
    },
    {
      secret: config.previewTokenSecret,
      now,
    },
  );

  return verification.ok ? undefined : verification.error;
}

function failure(
  errors: readonly string[],
  warnings: ReadonlySet<string>,
  draftId: number,
): UpdateDraftOutput {
  return {
    ok: false,
    errors,
    draft_id: draftId,
    message: `Draft update failed with ${errors.length} error(s).`,
    warnings: Array.from(warnings),
  };
}

function auditUpdateDraft(
  auditLogger: AuditLogger | undefined,
  input: StandardUpdateDraftInput,
  built: BuildDraftPayloadOutput,
  event: {
    readonly outcome: "success" | "failure" | "blocked";
    readonly reason?:
      | "validation"
      | "substack_client"
      | "not_unpublished_draft"
      | undefined;
    readonly draftId?: number | undefined;
    readonly errorCount: number;
    readonly warningCount: number;
  },
): void {
  writeAuditEvent(auditLogger, {
    action: "update_draft",
    outcome: event.outcome,
    ...(event.reason ? { reason: event.reason } : {}),
    draft_id: event.draftId ?? input.draft_id,
    ...(input.body_format ? { body_format: input.body_format } : {}),
    ...(built.audience ? { audience: built.audience } : {}),
    title_present: input.title !== undefined,
    subtitle_present: input.subtitle !== undefined,
    body_present: input.body_format !== undefined,
    metadata_only: input.body_format === undefined,
    stats: built.stats,
    warning_count: event.warningCount,
    error_count: event.errorCount,
  });
}

function auditNativeImagePatch(
  auditLogger: AuditLogger | undefined,
  draftId: number,
  event: {
    readonly outcome: "success" | "failure" | "blocked";
    readonly reason?:
      | "validation"
      | "substack_client"
      | "not_unpublished_draft"
      | undefined;
    readonly warningCount: number;
    readonly errorCount: number;
    readonly stats?: BuildDraftPayloadOutput["stats"] | undefined;
  },
): void {
  writeAuditEvent(auditLogger, {
    action: "update_draft",
    outcome: event.outcome,
    ...(event.reason ? { reason: event.reason } : {}),
    draft_id: draftId,
    body_format: "native_image_patch_v1",
    title_present: false,
    subtitle_present: false,
    body_present: true,
    metadata_only: false,
    ...(event.stats ? { stats: event.stats } : {}),
    warning_count: event.warningCount,
    error_count: event.errorCount,
  });
}

function imagePatchConflictingFields(
  input: UpdateDraftInput,
): readonly string[] {
  return [
    "title",
    "subtitle",
    "audience",
    "body_format",
    "body_markdown",
    "blocks",
  ].filter((field) => input[field as keyof UpdateDraftInput] !== undefined);
}
