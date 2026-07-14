import { DEFAULT_SUBSTACK_REQUEST_TIMEOUT_MS } from "../config.js";
import { normalizeSubstackSessionToken } from "../safety/substackSessionToken.js";
import { normalizeSubstackUserId } from "../safety/substackUserId.js";
import { buildSubstackHeaders, normalizePublicationUrl } from "./auth.js";
import { publicationEndpoint } from "./endpoints.js";
import {
  createSubstackError,
  SubstackApiError,
  SubstackTimeoutError,
} from "./errors.js";
import type { FetchLike } from "./types.js";

export interface ValidateSubstackSessionInput {
  readonly publicationUrl: string;
  readonly sessionToken: string;
  readonly userId: number;
  readonly userAgent: string;
  readonly requestTimeoutMs?: number | undefined;
}

export interface ValidatedSubstackSession {
  readonly publicationUrl: string;
  readonly userId: number;
}

export interface ValidateSubstackSessionOptions {
  readonly fetchFn?: FetchLike | undefined;
}

/** Validates a writer session against the publication administration API. */
export async function validateSubstackSession(
  input: ValidateSubstackSessionInput,
  options: ValidateSubstackSessionOptions = {},
): Promise<ValidatedSubstackSession> {
  const publicationUrl = normalizePublicationUrl(input.publicationUrl);
  const sessionToken = normalizeSubstackSessionToken(input.sessionToken);
  if (!sessionToken) {
    throw new Error("SUBSTACK_SESSION_TOKEN is required.");
  }
  const userId = normalizeSubstackUserId(input.userId);
  if (userId === undefined) {
    throw new Error("SUBSTACK_USER_ID is required.");
  }

  const requestTimeoutMs = normalizeRequestTimeoutMs(input.requestTimeoutMs);
  const endpoint = publicationEndpoint();
  const url = new URL(endpoint, `${publicationUrl}/`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  timeout.unref?.();

  let response: Response;
  let text: string;
  try {
    response = await (options.fetchFn ?? fetch)(url, {
      method: "GET",
      headers: buildSubstackHeaders(
        {
          publicationUrl,
          sessionToken,
          userAgent: input.userAgent,
        },
        false,
      ),
      redirect: "error",
      signal: controller.signal,
    });
    text = await response.text();
  } catch (error) {
    if (controller.signal.aborted || isAbortError(error)) {
      throw new SubstackTimeoutError(
        `Substack authentication timed out after ${requestTimeoutMs} ms`,
        {
          endpoint,
          hint: "Retry and check the publication URL and network connection.",
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

  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new SubstackApiError(
      "Substack authentication response was not valid JSON.",
      {
        status: response.status,
        endpoint,
      },
    );
  }

  if (readPositiveInteger(asRecord(raw), "id") === undefined) {
    throw new SubstackApiError(
      "Substack authentication response did not include a positive numeric publication id.",
      {
        status: response.status,
        endpoint,
      },
    );
  }

  return { publicationUrl, userId };
}

function normalizeRequestTimeoutMs(value: number | undefined): number {
  const normalized = value ?? DEFAULT_SUBSTACK_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(normalized) || normalized <= 0) {
    throw new Error("SUBSTACK_REQUEST_TIMEOUT_MS must be a positive integer.");
  }
  return normalized;
}

function readPositiveInteger(
  record: Readonly<Record<string, unknown>>,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : {};
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}
