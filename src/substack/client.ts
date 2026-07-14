import {
  type AppConfig,
  DEFAULT_SUBSTACK_REQUEST_TIMEOUT_MS,
} from "../config.js";
import { normalizeSubstackSessionToken } from "../safety/substackSessionToken.js";
import { normalizeSubstackUserId } from "../safety/substackUserId.js";
import { parseHttpUrl } from "../safety/urlPolicy.js";
import { buildSubstackHeaders, normalizePublicationUrl } from "./auth.js";
import {
  draftEndpoint,
  draftsEndpoint,
  draftsManagementEndpoint,
  imageEndpoint,
  publicationEndpoint,
} from "./endpoints.js";
import {
  createSubstackError,
  SubstackApiError,
  SubstackTimeoutError,
} from "./errors.js";
import type {
  DraftCreatePayload,
  DraftUpdatePayload,
  FetchLike,
  SubstackAuthValidation,
  SubstackClientConfig,
  SubstackDraft,
  SubstackDraftSummary,
  UploadedImage,
} from "./types.js";

export interface SubstackClientOptions {
  readonly fetchFn?: FetchLike | undefined;
}

type NormalizedSubstackClientConfig = Omit<
  SubstackClientConfig,
  "requestTimeoutMs"
> & {
  readonly requestTimeoutMs: number;
};

export class SubstackClient {
  private readonly config: NormalizedSubstackClientConfig;
  private readonly fetchFn: FetchLike;

  constructor(
    config: SubstackClientConfig,
    options: SubstackClientOptions = {},
  ) {
    const sessionToken = normalizeSubstackSessionToken(config.sessionToken);
    if (!sessionToken) {
      throw new Error("SUBSTACK_SESSION_TOKEN is required.");
    }
    const userId = normalizeSubstackUserId(config.userId);
    if (userId === undefined) {
      throw new Error("SUBSTACK_USER_ID is required.");
    }

    this.config = {
      ...config,
      publicationUrl: normalizePublicationUrl(config.publicationUrl),
      sessionToken,
      userId,
      requestTimeoutMs: normalizeRequestTimeoutMs(config.requestTimeoutMs),
    };
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async validateAuth(): Promise<SubstackAuthValidation> {
    await this.requestJson<unknown>("GET", publicationEndpoint());
    return { id: this.config.userId, ok: true };
  }

  async listDrafts(
    offset: number,
    limit: number,
  ): Promise<SubstackDraftSummary[]> {
    const raw = await this.requestJson<unknown>(
      "GET",
      draftsManagementEndpoint(offset, limit),
    );
    const candidates = Array.isArray(raw)
      ? raw
      : (readRecordArray(raw, "drafts") ?? readRecordArray(raw, "posts") ?? []);

    return candidates.map((draft) => toDraftSummary(draft));
  }

  async getDraft(draftId: number): Promise<SubstackDraft> {
    const raw = await this.requestJson<unknown>("GET", draftEndpoint(draftId));
    return toDraft(raw);
  }

  async createDraft(payload: DraftCreatePayload): Promise<SubstackDraft> {
    const raw = await this.requestJson<unknown>(
      "POST",
      draftsEndpoint(),
      payload,
    );
    return toDraft(raw);
  }

  async updateDraft(
    draftId: number,
    payload: DraftUpdatePayload,
  ): Promise<SubstackDraft> {
    const raw = await this.requestJson<unknown>(
      "PUT",
      draftEndpoint(draftId),
      payload,
    );
    return toDraft(raw);
  }

  async uploadImage(dataUri: string): Promise<UploadedImage> {
    const raw = await this.requestJson<unknown>("POST", imageEndpoint(), {
      image: dataUri,
    });
    const record = asRecord(raw);
    const url = readString(record, "url") ?? readString(record, "image_url");
    if (!url) {
      throw new SubstackApiError(
        "Substack image response did not include a URL.",
        {
          endpoint: imageEndpoint(),
        },
      );
    }

    const parsed = parseHttpUrl(url, "Substack image response URL");
    if (!parsed.ok) {
      throw new SubstackApiError(parsed.errors.join(" "), {
        endpoint: imageEndpoint(),
      });
    }

    return { url: parsed.url.toString() };
  }

  private async requestJson<T>(
    method: "GET" | "POST" | "PUT",
    endpoint: string,
    body?: unknown,
  ): Promise<T> {
    const url = new URL(endpoint, `${this.config.publicationUrl}/`);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.config.requestTimeoutMs,
    );
    timeout.unref?.();

    let response: Response;
    let text: string;
    try {
      response = await this.fetchFn(url, {
        method,
        headers: buildSubstackHeaders(this.config, body !== undefined),
        signal: controller.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      text = await response.text();
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) {
        throw new SubstackTimeoutError(
          `Substack request timed out after ${this.config.requestTimeoutMs} ms`,
          {
            endpoint,
            hint: "Retry later; if this persists, check Substack availability, publication URL, and network reachability.",
          },
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      throw createSubstackError(response.status, endpoint, text);
    }

    if (!text) {
      return undefined as T;
    }

    try {
      return JSON.parse(text) as T;
    } catch {
      throw new SubstackApiError("Substack response was not valid JSON.", {
        status: response.status,
        endpoint,
        responseBody: text,
      });
    }
  }
}

export function createSubstackClient(
  config: Pick<
    AppConfig,
    "publicationUrl" | "sessionToken" | "userAgent" | "userId"
  > &
    Partial<Pick<AppConfig, "substackRequestTimeoutMs">>,
  options: SubstackClientOptions = {},
): SubstackClient {
  if (!config.publicationUrl) {
    throw new Error("SUBSTACK_PUBLICATION_URL is required.");
  }
  const sessionToken = normalizeSubstackSessionToken(config.sessionToken);
  if (!sessionToken) {
    throw new Error("SUBSTACK_SESSION_TOKEN is required.");
  }
  const userId = normalizeSubstackUserId(config.userId);
  if (userId === undefined) {
    throw new Error("SUBSTACK_USER_ID is required.");
  }

  return new SubstackClient(
    {
      publicationUrl: config.publicationUrl,
      sessionToken,
      userId,
      userAgent: config.userAgent,
      requestTimeoutMs: config.substackRequestTimeoutMs,
    },
    options,
  );
}

function normalizeRequestTimeoutMs(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_SUBSTACK_REQUEST_TIMEOUT_MS;
  }

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("SUBSTACK_REQUEST_TIMEOUT_MS must be a positive integer.");
  }

  return value;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function toDraft(raw: unknown): SubstackDraft {
  const record = asRecord(raw);
  return {
    ...toDraftSummary(raw),
    body: readUnknown(record, "body"),
    draft_body: readUnknown(record, "draft_body"),
    status: readString(record, "status"),
    draft: readBoolean(record, "draft"),
    is_draft: readBoolean(record, "is_draft"),
    post_date: readNullableString(record, "post_date"),
    published_at: readNullableString(record, "published_at"),
    is_published: readBoolean(record, "is_published"),
    raw,
  };
}

function toDraftSummary(raw: unknown): SubstackDraftSummary {
  const record = asRecord(raw);
  return {
    id: readRequiredNumericId(raw),
    title: readString(record, "title") ?? readString(record, "draft_title"),
    subtitle:
      readString(record, "subtitle") ?? readString(record, "draft_subtitle"),
    audience: readString(record, "audience"),
    word_count:
      readNumber(record, "word_count") ??
      readNumber(record, "draft_word_count"),
    created_at:
      readString(record, "created_at") ??
      readString(record, "draft_created_at"),
    updated_at:
      readString(record, "updated_at") ??
      readString(record, "draft_updated_at"),
    url: readString(record, "url") ?? readString(record, "canonical_url"),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readRecordArray(
  value: unknown,
  key: string,
): readonly Record<string, unknown>[] | undefined {
  const candidate = asRecord(value)[key];
  if (!Array.isArray(candidate)) {
    return undefined;
  }

  return candidate.filter(
    (item): item is Record<string, unknown> =>
      typeof item === "object" && item !== null && !Array.isArray(item),
  );
}

function readUnknown(
  record: Record<string, unknown>,
  key: string,
): unknown | undefined {
  return key in record ? record[key] : undefined;
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readNullableString(
  record: Record<string, unknown>,
  key: string,
): string | null | undefined {
  const value = record[key];
  if (value === null) {
    return null;
  }

  return typeof value === "string" ? value : undefined;
}

function readNumber(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function readBoolean(
  record: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = record[key];
  return typeof value === "boolean" ? value : undefined;
}

function readNumericId(value: unknown): number | undefined {
  const record = asRecord(value);
  const id = readNumber(record, "id") ?? readNumber(record, "user_id");
  return id && Number.isInteger(id) ? id : undefined;
}

function readRequiredNumericId(value: unknown): number {
  const id = readNumericId(value);
  if (id === undefined) {
    throw new SubstackApiError(
      "Substack draft response did not include an ID.",
    );
  }

  return id;
}
