import { z } from "zod";

import type { AppConfig } from "../config.js";
import { type AuditLogger, writeAuditEvent } from "../logging/audit.js";
import {
  contentHash,
  verifyConfirmationToken,
} from "../safety/confirmationToken.js";
import {
  createSubstackClient,
  type SubstackClient,
} from "../substack/index.js";
import type { DraftCreatePayload } from "../substack/types.js";
import {
  AudienceSchema,
  type BuildDraftPayloadOutput,
  buildDraftPayload,
  type DraftPayload,
} from "./draftPayload.js";
import { addDraftUrlWarningIfUnsafe, toSafeDraftUrl } from "./draftUrl.js";
import {
  createMemoryIdempotencyStore,
  type IdempotencyStore,
} from "./idempotencyStore.js";
import { summarizeSubstackToolError } from "./substackToolErrors.js";

export const CreateDraftInputSchema = z
  .object({
    title: z.string(),
    subtitle: z.string().optional(),
    audience: AudienceSchema.optional(),
    body_format: z.enum(["markdown_v1", "blocks_v1"]),
    body_markdown: z.string().optional(),
    blocks: z.unknown().optional(),
    confirmation_token: z.string().min(1),
    idempotency_key: z.string().trim().min(1).optional(),
  })
  .strict();

export type CreateDraftInput = z.infer<typeof CreateDraftInputSchema>;

export interface CreateDraftOutput {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly draft_id?: number | undefined;
  readonly draft_title?: string | undefined;
  readonly draft_url?: string | undefined;
  readonly message: string;
  readonly warnings: readonly string[];
}

export type CreateDraftIdempotencyStore = IdempotencyStore<CreateDraftOutput>;

interface CreateDraftOptions {
  readonly client?: Pick<SubstackClient, "createDraft"> | undefined;
  readonly now?: Date | undefined;
  readonly auditLogger?: AuditLogger | undefined;
  readonly idempotencyStore?: CreateDraftIdempotencyStore | undefined;
}

const defaultIdempotencyStore =
  createMemoryIdempotencyStore<CreateDraftOutput>();
const IDEMPOTENCY_MEMORY_WARNING =
  "idempotency_key is remembered in memory for the preview-token TTL only; it is not durable across restarts or deployments.";
const IDEMPOTENCY_REPLAY_WARNING =
  "idempotency_key matched a previous successful create; returning cached draft result without another Substack create call.";

export function createCreateDraftIdempotencyStore(): CreateDraftIdempotencyStore {
  return createMemoryIdempotencyStore<CreateDraftOutput>();
}

export async function createDraft(
  input: CreateDraftInput,
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
  options: CreateDraftOptions = {},
): Promise<CreateDraftOutput> {
  const warnings = new Set<string>();
  const errors: string[] = [];
  const idempotencyKey = normalizedIdempotencyKey(input.idempotency_key);

  if (normalizeText(input.title) === "") {
    errors.push("title is required when creating a draft.");
  }
  if (input.idempotency_key !== undefined) {
    if (!idempotencyKey) {
      errors.push("idempotency_key must not be blank.");
    } else {
      warnings.add(IDEMPOTENCY_MEMORY_WARNING);
    }
  }

  const built = buildDraftPayload({ ...input, action: "create" }, config);
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

  if (config.userId === undefined) {
    errors.push("SUBSTACK_USER_ID is required.");
  }

  const basePayload = built.payload;
  const draftBody = basePayload?.draft_body;

  if (draftBody === undefined) {
    errors.push("draft_body could not be built.");
  }

  if (
    errors.length > 0 ||
    !basePayload ||
    draftBody === undefined ||
    config.userId === undefined
  ) {
    auditCreateDraft(options.auditLogger, input, built, {
      outcome: "failure",
      reason: "validation",
      errorCount: errors.length,
      warningCount: warnings.size,
    });
    return failure(errors, warnings);
  }

  const createPayload = buildSubstackCreatePayload(
    basePayload,
    draftBody,
    input.title,
    config.userId,
  );

  if (idempotencyKey) {
    const idempotencyResult = await createWithIdempotency(
      {
        auditLogger: options.auditLogger,
        built,
        client: options.client,
        createPayload,
        idempotencyKey,
        input,
        now: options.now ?? new Date(),
        store: options.idempotencyStore ?? defaultIdempotencyStore,
        ttlSeconds: config.confirmationTokenTtlSeconds,
        warnings,
      },
      config,
    );
    if (idempotencyResult) {
      return idempotencyResult;
    }
  }

  return executeCreateDraft(
    {
      auditLogger: options.auditLogger,
      built,
      client: options.client,
      createPayload,
      input,
      warnings,
    },
    config,
  );
}

async function executeCreateDraft(
  options: {
    readonly auditLogger?: AuditLogger | undefined;
    readonly built: BuildDraftPayloadOutput;
    readonly client?: Pick<SubstackClient, "createDraft"> | undefined;
    readonly createPayload: DraftCreatePayload;
    readonly input: CreateDraftInput;
    readonly warnings: ReadonlySet<string>;
  },
  config: Pick<
    AppConfig,
    "publicationUrl" | "sessionToken" | "userAgent" | "userId"
  >,
): Promise<CreateDraftOutput> {
  try {
    const client = options.client ?? createSubstackClient(config);
    const created = await client.createDraft(options.createPayload);
    const resultWarnings = new Set(options.warnings);
    addDraftUrlWarningIfUnsafe(created.url, resultWarnings);

    auditCreateDraft(options.auditLogger, options.input, options.built, {
      outcome: "success",
      draftId: created.id,
      errorCount: 0,
      warningCount: resultWarnings.size,
    });

    return {
      ok: true,
      errors: [],
      draft_id: created.id,
      draft_title: created.title ?? options.createPayload.draft_title,
      draft_url: toSafeDraftUrl(created.url),
      message: `Created Substack draft ${created.id}. Review and publish manually in Substack.`,
      warnings: Array.from(resultWarnings),
    };
  } catch (error) {
    const summary = summarizeSubstackToolError(error);
    auditCreateDraft(options.auditLogger, options.input, options.built, {
      outcome: "failure",
      reason: "substack_client",
      errorCount: 1,
      warningCount: options.warnings.size,
    });
    return failure([summary], options.warnings);
  }
}

export function summarizeCreateDraft(result: CreateDraftOutput): string {
  if (!result.ok) {
    return `Draft creation failed with ${result.errors.length} error(s).`;
  }

  return result.message;
}

function verifyDraftToken(
  input: Pick<CreateDraftInput, "confirmation_token" | "subtitle" | "title">,
  payload: DraftPayload,
  audience: DraftPayload["audience"],
  config: Pick<AppConfig, "previewTokenSecret">,
  now: Date | undefined,
): string | undefined {
  const verification = verifyConfirmationToken(
    input.confirmation_token,
    {
      action: "create",
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
): CreateDraftOutput {
  return {
    ok: false,
    errors,
    message: `Draft creation failed with ${errors.length} error(s).`,
    warnings: Array.from(warnings),
  };
}

function buildSubstackCreatePayload(
  basePayload: DraftPayload,
  draftBody: string,
  inputTitle: string,
  userId: number,
): DraftCreatePayload {
  return {
    ...basePayload,
    draft_body: draftBody,
    draft_title: basePayload.draft_title ?? inputTitle,
    draft_bylines: [{ id: userId, is_guest: false }],
    type: "newsletter",
  };
}

async function createWithIdempotency(
  options: {
    readonly auditLogger?: AuditLogger | undefined;
    readonly built: BuildDraftPayloadOutput;
    readonly client?: Pick<SubstackClient, "createDraft"> | undefined;
    readonly createPayload: DraftCreatePayload;
    readonly idempotencyKey: string;
    readonly input: CreateDraftInput;
    readonly now: Date;
    readonly store: CreateDraftIdempotencyStore;
    readonly ttlSeconds: number;
    readonly warnings: ReadonlySet<string>;
  },
  config: Pick<
    AppConfig,
    "publicationUrl" | "sessionToken" | "userAgent" | "userId"
  >,
): Promise<CreateDraftOutput | undefined> {
  const nowMs = options.now.getTime();
  options.store.pruneExpired?.(nowMs);

  const fingerprint = createDraftFingerprint(options.createPayload);
  const existing = options.store.get(options.idempotencyKey);
  if (existing) {
    if (existing.fingerprint !== fingerprint) {
      auditCreateDraft(options.auditLogger, options.input, options.built, {
        outcome: "failure",
        reason: "validation",
        errorCount: 1,
        warningCount: options.warnings.size,
      });
      return failure(
        ["idempotency_key was already used for a different draft input."],
        options.warnings,
      );
    }

    const result = existing.result ?? (await existing.inFlight);
    if (!result?.ok) {
      return result;
    }

    auditCreateDraft(options.auditLogger, options.input, options.built, {
      outcome: "success",
      draftId: result.draft_id,
      errorCount: 0,
      idempotencyReplay: true,
      warningCount: options.warnings.size + 1,
    });
    return replayCreateDraftOutput(result);
  }

  const expiresAtMs = nowMs + options.ttlSeconds * 1_000;
  const inFlight = executeCreateDraft(
    {
      auditLogger: options.auditLogger,
      built: options.built,
      client: options.client,
      createPayload: options.createPayload,
      input: options.input,
      warnings: options.warnings,
    },
    config,
  );

  options.store.set(options.idempotencyKey, {
    expiresAtMs,
    fingerprint,
    inFlight,
  });

  const result = await inFlight;
  if (result.ok) {
    options.store.set(options.idempotencyKey, {
      expiresAtMs,
      fingerprint,
      result: cloneCreateDraftOutput(result),
    });
  } else {
    options.store.delete(options.idempotencyKey);
  }

  return result;
}

function createDraftFingerprint(payload: DraftCreatePayload): string {
  return contentHash(payload);
}

function replayCreateDraftOutput(result: CreateDraftOutput): CreateDraftOutput {
  const warnings = new Set(result.warnings);
  warnings.add(IDEMPOTENCY_REPLAY_WARNING);

  return {
    ...cloneCreateDraftOutput(result),
    warnings: Array.from(warnings),
  };
}

function cloneCreateDraftOutput(result: CreateDraftOutput): CreateDraftOutput {
  return {
    ok: result.ok,
    errors: [...result.errors],
    draft_id: result.draft_id,
    draft_title: result.draft_title,
    draft_url: result.draft_url,
    message: result.message,
    warnings: [...result.warnings],
  };
}

function normalizeText(value: string | undefined): string {
  return value?.trim().replace(/\s+/g, " ") ?? "";
}

function normalizedIdempotencyKey(
  value: string | undefined,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const normalized = value.trim();
  return normalized === "" ? undefined : normalized;
}

function auditCreateDraft(
  auditLogger: AuditLogger | undefined,
  input: CreateDraftInput,
  built: BuildDraftPayloadOutput,
  event: {
    readonly outcome: "success" | "failure";
    readonly reason?: "validation" | "substack_client" | undefined;
    readonly draftId?: number | undefined;
    readonly errorCount: number;
    readonly idempotencyReplay?: boolean | undefined;
    readonly warningCount: number;
  },
): void {
  writeAuditEvent(auditLogger, {
    action: "create_draft",
    outcome: event.outcome,
    ...(event.reason ? { reason: event.reason } : {}),
    ...(event.draftId !== undefined ? { draft_id: event.draftId } : {}),
    body_format: input.body_format,
    ...(built.audience ? { audience: built.audience } : {}),
    title_present: normalizeText(input.title) !== "",
    subtitle_present: input.subtitle !== undefined,
    body_present: true,
    idempotency_key_present: input.idempotency_key !== undefined,
    ...(event.idempotencyReplay !== undefined
      ? { idempotency_replay: event.idempotencyReplay }
      : {}),
    stats: built.stats,
    warning_count: event.warningCount,
    error_count: event.errorCount,
  });
}
