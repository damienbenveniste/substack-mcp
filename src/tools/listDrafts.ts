import { z } from "zod";

import type { AppConfig } from "../config.js";
import {
  createSubstackClient,
  type SubstackClient,
} from "../substack/index.js";
import type { SubstackDraftSummary } from "../substack/types.js";
import { toSafeDraftUrl } from "./draftUrl.js";
import { summarizeSubstackToolError } from "./substackToolErrors.js";

export const ListDraftsInputSchema = z
  .object({
    offset: z.number().int().nonnegative().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  })
  .strict();

export type ListDraftsInput = z.infer<typeof ListDraftsInputSchema>;

export interface ListDraftsOutput {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly drafts: readonly SubstackDraftSummary[];
  readonly offset: number;
  readonly limit: number;
}

interface ListDraftsOptions {
  readonly client?: Pick<SubstackClient, "listDrafts"> | undefined;
}

export async function listDrafts(
  input: ListDraftsInput,
  config: Pick<
    AppConfig,
    | "publicationUrl"
    | "sessionToken"
    | "substackRequestTimeoutMs"
    | "userAgent"
    | "userId"
  >,
  options: ListDraftsOptions = {},
): Promise<ListDraftsOutput> {
  const offset = input.offset ?? 0;
  const limit = input.limit ?? 10;

  try {
    const client = options.client ?? createSubstackClient(config);
    const drafts = await client.listDrafts(offset, limit);

    return {
      ok: true,
      errors: [],
      drafts: drafts.map(toDraftToolSummary),
      offset,
      limit,
    };
  } catch (error) {
    return {
      ok: false,
      errors: [summarizeSubstackToolError(error)],
      drafts: [],
      offset,
      limit,
    };
  }
}

export function summarizeDraftList(result: ListDraftsOutput): string {
  if (!result.ok) {
    return `Draft listing failed with ${result.errors.length} error(s).`;
  }

  if (result.drafts.length === 0) {
    return "No Substack drafts found.";
  }

  return `Found ${result.drafts.length} Substack draft(s).`;
}

function toDraftToolSummary(draft: SubstackDraftSummary): SubstackDraftSummary {
  const summary = {
    id: draft.id,
    title: draft.title,
    subtitle: draft.subtitle,
    audience: draft.audience,
    word_count: draft.word_count,
    created_at: draft.created_at,
    updated_at: draft.updated_at,
    url: toSafeDraftUrl(draft.url),
  };

  return Object.fromEntries(
    Object.entries(summary).filter(([, value]) => value !== undefined),
  ) as unknown as SubstackDraftSummary;
}
