import { z } from "zod";

import type { AppConfig } from "../config.js";
import { checkUtf8ByteLimit } from "../safety/limits.js";
import {
  createSubstackClient,
  type SubstackClient,
} from "../substack/index.js";
import type { SubstackDraft } from "../substack/types.js";
import { toSafeDraftUrl } from "./draftUrl.js";
import { summarizeSubstackToolError } from "./substackToolErrors.js";

export const GetDraftInputSchema = z
  .object({
    draft_id: z.number().int().positive(),
    include_body: z.boolean().optional(),
  })
  .strict();

export type GetDraftInput = z.infer<typeof GetDraftInputSchema>;

export interface GetDraftOutput {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly draft?: DraftToolDraft | undefined;
  readonly include_body: boolean;
}

export interface DraftToolDraft {
  readonly id: number;
  readonly title?: string | undefined;
  readonly subtitle?: string | undefined;
  readonly audience?: string | undefined;
  readonly word_count?: number | undefined;
  readonly created_at?: string | undefined;
  readonly updated_at?: string | undefined;
  readonly url?: string | undefined;
  readonly status?: string | undefined;
  readonly draft?: boolean | undefined;
  readonly is_draft?: boolean | undefined;
  readonly post_date?: string | null | undefined;
  readonly published_at?: string | null | undefined;
  readonly is_published?: boolean | undefined;
  readonly body?: unknown;
}

interface GetDraftOptions {
  readonly client?: Pick<SubstackClient, "getDraft"> | undefined;
}

export async function getDraft(
  input: GetDraftInput,
  config: Pick<
    AppConfig,
    | "publicationUrl"
    | "sessionToken"
    | "substackRequestTimeoutMs"
    | "userAgent"
    | "userId"
    | "maxBodyBytes"
  >,
  options: GetDraftOptions = {},
): Promise<GetDraftOutput> {
  const includeBody = input.include_body ?? false;

  try {
    const client = options.client ?? createSubstackClient(config);
    const draft = await client.getDraft(input.draft_id);
    const bodyLimitError = validateIncludedDraftBodyBytes(
      draft,
      includeBody,
      config.maxBodyBytes,
    );

    if (bodyLimitError) {
      return {
        ok: false,
        errors: [bodyLimitError],
        include_body: includeBody,
      };
    }

    return {
      ok: true,
      errors: [],
      draft: toDraftToolDraft(draft, includeBody),
      include_body: includeBody,
    };
  } catch (error) {
    return {
      ok: false,
      errors: [summarizeSubstackToolError(error)],
      include_body: includeBody,
    };
  }
}

export function summarizeDraft(result: GetDraftOutput): string {
  if (!result.ok) {
    return `Draft fetch failed with ${result.errors.length} error(s).`;
  }

  const title = result.draft?.title ? `: ${result.draft.title}` : "";
  const bodyStatus = result.include_body ? " Body included." : " Body omitted.";

  return `Substack draft ${result.draft?.id ?? "unknown"} retrieved${title}.${bodyStatus}`;
}

function toDraftToolDraft(
  draft: SubstackDraft,
  includeBody: boolean,
): DraftToolDraft {
  const body = draft.body ?? draft.draft_body;

  return {
    id: draft.id,
    title: draft.title,
    subtitle: draft.subtitle,
    audience: draft.audience,
    word_count: draft.word_count,
    created_at: draft.created_at,
    updated_at: draft.updated_at,
    url: toSafeDraftUrl(draft.url),
    status: draft.status,
    draft: draft.draft,
    is_draft: draft.is_draft,
    post_date: draft.post_date,
    published_at: draft.published_at,
    is_published: draft.is_published,
    ...(includeBody && body !== undefined ? { body } : {}),
  };
}

function validateIncludedDraftBodyBytes(
  draft: SubstackDraft,
  includeBody: boolean,
  maxBodyBytes: number,
): string | undefined {
  if (!includeBody) {
    return undefined;
  }

  const body = draft.body ?? draft.draft_body;
  if (body === undefined) {
    return undefined;
  }

  if (typeof body === "string") {
    const limit = checkUtf8ByteLimit(body, maxBodyBytes);
    return limit.ok
      ? undefined
      : `draft body is ${limit.bytes} bytes, which exceeds MAX_BODY_BYTES=${limit.maxBytes}.`;
  }

  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(body);
  } catch {
    return "draft body could not be serialized for MAX_BODY_BYTES validation.";
  }

  if (serialized === undefined) {
    return "draft body could not be serialized for MAX_BODY_BYTES validation.";
  }

  const limit = checkUtf8ByteLimit(serialized, maxBodyBytes);
  return limit.ok
    ? undefined
    : `draft body is ${limit.bytes} bytes when JSON serialized, which exceeds MAX_BODY_BYTES=${limit.maxBytes}.`;
}
