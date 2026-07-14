import { z } from "zod";

import type { AppConfig } from "../config.js";
import { type AuditLogger, writeAuditEvent } from "../logging/audit.js";
import { parseHttpUrl } from "../safety/urlPolicy.js";
import {
  createSubstackClient,
  type SubstackClient,
} from "../substack/index.js";
import type { FetchLike } from "../substack/types.js";
import { summarizeSubstackToolError } from "./substackToolErrors.js";

const ALLOWED_IMAGE_MIME_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

const EXTENSION_TO_MIME_TYPE: Readonly<Record<string, string>> = {
  avif: "image/avif",
  gif: "image/gif",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export const UploadImageInputSchema = z
  .object({
    image_url: z.string().optional(),
    image_base64: z.string().optional(),
    alt_text: z.string().optional(),
    caption: z.string().optional(),
    filename_hint: z.string().optional(),
  })
  .strict();

export type UploadImageInput = z.infer<typeof UploadImageInputSchema>;

export interface UploadImageOutput {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly image_url?: string | undefined;
  readonly alt_text?: string | undefined;
  readonly caption?: string | undefined;
  readonly message: string;
}

interface UploadImageOptions {
  readonly client?: Pick<SubstackClient, "uploadImage"> | undefined;
  readonly fetchFn?: FetchLike | undefined;
  readonly auditLogger?: AuditLogger | undefined;
}

export async function uploadImage(
  input: UploadImageInput,
  config: Pick<
    AppConfig,
    | "maxImageBytes"
    | "publicationUrl"
    | "sessionToken"
    | "substackRequestTimeoutMs"
    | "userAgent"
    | "userId"
  >,
  options: UploadImageOptions = {},
): Promise<UploadImageOutput> {
  let dataUriResult: Awaited<ReturnType<typeof toDataUri>>;
  try {
    dataUriResult = await toDataUri(input, config, options.fetchFn);
  } catch (error) {
    auditUploadImage(options.auditLogger, input, {
      outcome: "failure",
      reason: "image_prepare",
      errorCount: 1,
    });
    return failure([summarizeSubstackToolError(error)], input);
  }

  if (!dataUriResult.ok) {
    auditUploadImage(options.auditLogger, input, {
      outcome: "failure",
      reason: "validation",
      errorCount: dataUriResult.errors.length,
    });
    return failure(dataUriResult.errors, input);
  }

  try {
    const client = options.client ?? createSubstackClient(config);
    const uploaded = await client.uploadImage(dataUriResult.dataUri);
    const uploadedUrlValidation = parseHttpUrl(
      uploaded.url,
      "uploaded image_url",
    );
    if (!uploadedUrlValidation.ok) {
      auditUploadImage(options.auditLogger, input, {
        outcome: "failure",
        reason: "substack_client",
        errorCount: uploadedUrlValidation.errors.length,
      });
      return failure(uploadedUrlValidation.errors, input);
    }

    auditUploadImage(options.auditLogger, input, {
      outcome: "success",
      errorCount: 0,
    });

    return {
      ok: true,
      errors: [],
      image_url: uploadedUrlValidation.url.toString(),
      alt_text: input.alt_text,
      caption: input.caption,
      message: `Uploaded image to Substack: ${uploadedUrlValidation.url.toString()}`,
    };
  } catch (error) {
    const summary = summarizeSubstackToolError(error);
    auditUploadImage(options.auditLogger, input, {
      outcome: "failure",
      reason: "substack_client",
      errorCount: 1,
    });
    return failure([summary], input);
  }
}

export function summarizeUploadImage(result: UploadImageOutput): string {
  if (!result.ok) {
    return `Image upload failed with ${result.errors.length} error(s).`;
  }

  return result.message;
}

async function toDataUri(
  input: Pick<UploadImageInput, "filename_hint" | "image_base64" | "image_url">,
  config: Pick<AppConfig, "maxImageBytes" | "substackRequestTimeoutMs">,
  fetchFn: FetchLike | undefined,
): Promise<
  | { readonly ok: true; readonly dataUri: string }
  | { readonly ok: false; readonly errors: readonly string[] }
> {
  if (Boolean(input.image_url) === Boolean(input.image_base64)) {
    return {
      ok: false,
      errors: ["Exactly one of image_url or image_base64 is required."],
    };
  }

  if (input.image_url) {
    return fetchImageDataUri(input.image_url, config, fetchFn ?? fetch);
  }

  return base64ImageDataUri(
    input.image_base64 ?? "",
    input.filename_hint,
    config,
  );
}

async function fetchImageDataUri(
  imageUrl: string,
  config: Pick<AppConfig, "maxImageBytes" | "substackRequestTimeoutMs">,
  fetchFn: FetchLike,
): Promise<
  | { readonly ok: true; readonly dataUri: string }
  | { readonly ok: false; readonly errors: readonly string[] }
> {
  const parsed = parseHttpUrl(imageUrl, "image_url");
  if (!parsed.ok) {
    return parsed;
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    config.substackRequestTimeoutMs,
  );
  timeout.unref?.();

  try {
    const response = await fetchFn(parsed.url, {
      redirect: "manual",
      signal: controller.signal,
    });
    if (isRedirectStatus(response.status)) {
      return {
        ok: false,
        errors: [
          "Image fetch redirected; provide the final public image URL directly.",
        ],
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        errors: [`Image fetch failed with HTTP ${response.status}.`],
      };
    }

    const mimeType = normalizeMimeType(response.headers.get("content-type"));
    if (!isAllowedMimeType(mimeType)) {
      return {
        ok: false,
        errors: [`Unsupported image MIME type: ${mimeType ?? "unknown"}.`],
      };
    }

    const declaredBytes = parseContentLength(
      response.headers.get("content-length"),
    );
    if (declaredBytes !== undefined) {
      const sizeError = validateImageBytes(declaredBytes, config.maxImageBytes);
      if (sizeError) {
        return { ok: false, errors: [sizeError] };
      }
    }

    const readResult = await readResponseBytes(response, config.maxImageBytes);
    if (!readResult.ok) {
      return readResult;
    }

    return {
      ok: true,
      dataUri: `data:${mimeType};base64,${readResult.bytes.toString("base64")}`,
    };
  } catch (error) {
    if (controller.signal.aborted || isAbortError(error)) {
      return {
        ok: false,
        errors: [
          `Image fetch timed out after ${config.substackRequestTimeoutMs} ms.`,
        ],
      };
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function readResponseBytes(
  response: Response,
  maxBytes: number,
): Promise<
  | { readonly ok: true; readonly bytes: Buffer }
  | { readonly ok: false; readonly errors: readonly string[] }
> {
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    const sizeError = validateImageBytes(bytes.byteLength, maxBytes);
    return sizeError ? { ok: false, errors: [sizeError] } : { ok: true, bytes };
  }

  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (!value) {
        continue;
      }

      totalBytes += value.byteLength;
      const sizeError = validateImageBytes(totalBytes, maxBytes);
      if (sizeError) {
        await reader.cancel();
        return { ok: false, errors: [sizeError] };
      }

      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return {
    ok: true,
    bytes: Buffer.concat(
      chunks.map((chunk) => Buffer.from(chunk)),
      totalBytes,
    ),
  };
}

function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function base64ImageDataUri(
  imageBase64: string,
  filenameHint: string | undefined,
  config: Pick<AppConfig, "maxImageBytes">,
):
  | { readonly ok: true; readonly dataUri: string }
  | { readonly ok: false; readonly errors: readonly string[] } {
  const filenameHintProblem = validateFilenameHint(filenameHint);
  if (filenameHintProblem) {
    return { ok: false, errors: [filenameHintProblem] };
  }

  const dataUri = parseDataUri(imageBase64);
  const inferredMimeType = inferMimeType(filenameHint);
  if (
    !dataUri &&
    filenameHint !== undefined &&
    inferredMimeType === undefined
  ) {
    return {
      ok: false,
      errors: [
        "filename_hint must end with a supported image extension: avif, gif, jpg, jpeg, png, or webp.",
      ],
    };
  }

  const mimeType = dataUri?.mimeType ?? inferredMimeType;
  if (!isAllowedMimeType(mimeType)) {
    return {
      ok: false,
      errors: [`Unsupported image MIME type: ${mimeType ?? "unknown"}.`],
    };
  }

  const base64 = normalizeBase64(dataUri?.base64 ?? imageBase64);
  if (!base64) {
    return {
      ok: false,
      errors: ["image_base64 must be valid base64 data."],
    };
  }

  const bytes = Buffer.from(base64, "base64");
  const sizeError = validateImageBytes(bytes.byteLength, config.maxImageBytes);
  if (sizeError) {
    return { ok: false, errors: [sizeError] };
  }

  return {
    ok: true,
    dataUri: `data:${mimeType};base64,${base64}`,
  };
}

function parseDataUri(
  value: string,
): { readonly mimeType: string; readonly base64: string } | undefined {
  const match = /^data:([^;,]+);base64,(.+)$/is.exec(value.trim());
  if (!match?.[1] || !match[2]) {
    return undefined;
  }

  return {
    mimeType: normalizeMimeType(match[1]) ?? match[1],
    base64: match[2],
  };
}

function normalizeBase64(value: string): string | undefined {
  const compact = value.replace(/\s+/g, "");
  if (
    !compact ||
    compact.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(compact)
  ) {
    return undefined;
  }

  const normalized = compact.padEnd(
    compact.length + ((4 - (compact.length % 4)) % 4),
    "=",
  );
  const bytes = Buffer.from(normalized, "base64");
  if (bytes.byteLength === 0 || bytes.toString("base64") !== normalized) {
    return undefined;
  }

  return normalized;
}

function validateFilenameHint(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "filename_hint must not be blank when provided.";
  }

  if (
    trimmed.includes("\0") ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    /^[A-Za-z]:/u.test(trimmed)
  ) {
    return "filename_hint must be a simple filename, not a path.";
  }

  if (trimmed.length > 255) {
    return "filename_hint must be 255 characters or fewer.";
  }

  return /^[A-Za-z0-9._ -]+$/u.test(trimmed)
    ? undefined
    : "filename_hint must contain only letters, numbers, spaces, dots, dashes, and underscores.";
}

function inferMimeType(filenameHint: string | undefined): string | undefined {
  const extension = filenameHint?.trim().toLowerCase().split(".").pop();
  return extension ? EXTENSION_TO_MIME_TYPE[extension] : undefined;
}

function normalizeMimeType(value: string | null): string | undefined {
  return value?.split(";")[0]?.trim().toLowerCase() || undefined;
}

function parseContentLength(value: string | null): number | undefined {
  const normalized = value?.trim();
  if (!normalized || !/^\d+$/u.test(normalized)) {
    return undefined;
  }

  const parsed = Number.parseInt(normalized, 10);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function isAllowedMimeType(mimeType: string | undefined): mimeType is string {
  return mimeType !== undefined && ALLOWED_IMAGE_MIME_TYPES.has(mimeType);
}

function validateImageBytes(
  bytes: number,
  maxBytes: number,
): string | undefined {
  return bytes <= maxBytes
    ? undefined
    : `Image is ${bytes} byte(s), which exceeds MAX_IMAGE_BYTES=${maxBytes}.`;
}

function failure(
  errors: readonly string[],
  input: Pick<UploadImageInput, "alt_text" | "caption">,
): UploadImageOutput {
  return {
    ok: false,
    errors,
    alt_text: input.alt_text,
    caption: input.caption,
    message: `Image upload failed with ${errors.length} error(s).`,
  };
}

function auditUploadImage(
  auditLogger: AuditLogger | undefined,
  input: UploadImageInput,
  event: {
    readonly outcome: "success" | "failure";
    readonly reason?: "validation" | "substack_client" | "image_prepare";
    readonly errorCount: number;
  },
): void {
  writeAuditEvent(auditLogger, {
    action: "upload_image",
    outcome: event.outcome,
    ...(event.reason ? { reason: event.reason } : {}),
    image_source: imageSource(input),
    alt_text_present: input.alt_text !== undefined,
    caption_present: input.caption !== undefined,
    warning_count: 0,
    error_count: event.errorCount,
  });
}

function imageSource(
  input: Pick<UploadImageInput, "image_base64" | "image_url">,
): "remote_url" | "base64" | "data_uri" | "none" | "ambiguous" {
  if (input.image_url && input.image_base64) {
    return "ambiguous";
  }
  if (input.image_url) {
    return "remote_url";
  }
  if (input.image_base64) {
    return input.image_base64.trim().startsWith("data:")
      ? "data_uri"
      : "base64";
  }

  return "none";
}
