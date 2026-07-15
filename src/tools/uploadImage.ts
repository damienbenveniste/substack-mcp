import { z } from "zod";

import type { AppConfig } from "../config.js";
import {
  defaultImageDnsLookup,
  type ImageAssetMetadata,
  type ImageDnsLookup,
  type ImageProcessingErrorCode,
  type ImageProcessingIssue,
  type ImageProcessingStage,
  type ImageProcessingWarning,
  prepareImage,
} from "../images/prepareImage.js";
import { type AuditLogger, writeAuditEvent } from "../logging/audit.js";
import { parseHttpUrl } from "../safety/urlPolicy.js";
import {
  createSubstackClient,
  type SubstackClient,
} from "../substack/index.js";
import type { FetchLike } from "../substack/types.js";
import { summarizeSubstackToolError } from "./substackToolErrors.js";

const ImageCardInputSchema = z
  .object({
    width: z.number().int().positive().max(6000),
    height: z.number().int().positive().max(6000),
    title: z.string().min(1).max(500),
    subtitle: z.string().max(500).optional(),
    footer: z.string().max(500).optional(),
    background: z.string().optional(),
    foreground: z.string().optional(),
  })
  .strict();

const ImageFileReferenceSchema = z
  .object({
    file_id: z.string().min(1).optional(),
    artifact_id: z.string().min(1).optional(),
    download_url: z.string().url().optional(),
    path: z.string().min(1).optional(),
    name: z.string().min(1).optional(),
    mime_type: z.string().min(1).optional(),
    size: z.number().int().nonnegative().optional(),
    expected_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/iu)
      .optional(),
  })
  .strict();

const ImageFileItemSchema = z.union([
  z.string().min(1),
  ImageFileReferenceSchema,
]);

export const UploadImageInputSchema = z
  .object({
    source_type: z
      .enum(["file", "url", "base64", "svg", "card"])
      .optional()
      .describe(
        "The one source field to use. Never infer or substitute another source.",
      ),
    image_file: z
      .union([ImageFileItemSchema, z.array(ImageFileItemSchema).length(1)])
      .optional()
      .describe(
        "The exact generated or uploaded image artifact. File-capable MCP clients may bind this field as a file parameter; complete references require download_url, while local paths must be allowlisted by IMAGE_FILE_ROOTS.",
      ),
    image_url: z
      .string()
      .optional()
      .describe(
        "An exact public remote image URL, used only when no image_file artifact is available.",
      ),
    image_base64: z
      .string()
      .optional()
      .describe(
        "Base64 image bytes, used only when neither image_file nor image_url is available.",
      ),
    svg: z
      .string()
      .optional()
      .describe(
        "Raw SVG source, used only when the user explicitly requested this exact SVG; never generate it as a fallback for an unavailable image artifact.",
      ),
    card: ImageCardInputSchema.optional().describe(
      "Server-rendered card source, used only when the user explicitly requested a card; never substitute it for an unavailable image artifact.",
    ),
    output_format: z.literal("png").optional(),
    max_width: z.number().int().positive().max(6000).optional(),
    max_height: z.number().int().positive().max(6000).optional(),
    alt_text: z
      .string()
      .optional()
      .describe(
        "Accessibility text preserved for later draft insertion; it is not a visible caption.",
      ),
    caption: z
      .string()
      .optional()
      .describe(
        "Visible caption preserved for later draft insertion; upload_image itself does not modify a draft.",
      ),
    filename_hint: z
      .string()
      .optional()
      .describe(
        "Output filename hint only. It never selects or searches for a source file.",
      ),
    preserve_dimensions: z.boolean().optional(),
    allow_resize: z
      .boolean()
      .optional()
      .describe("Set false to fail instead of resizing an oversized source."),
    allow_color_mode_change: z
      .boolean()
      .optional()
      .describe(
        "Set true only when a color-to-monochrome conversion is intentional.",
      ),
    require_visual_fidelity: z
      .boolean()
      .optional()
      .describe(
        "Defaults to true and rejects unexpected aspect-ratio changes.",
      ),
  })
  .strict();

export type UploadImageInput = z.infer<typeof UploadImageInputSchema>;

export interface UploadImageError {
  readonly code: ImageProcessingErrorCode | "SUBSTACK_UPLOAD_FAILED";
  readonly message: string;
  readonly stage: ImageProcessingStage | "upload";
}

export interface UploadImageOutput {
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly error?: UploadImageError | undefined;
  readonly image_url?: string | undefined;
  readonly filename?: string | undefined;
  readonly format?: "png" | undefined;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
  readonly size_bytes?: number | undefined;
  readonly sha256?: string | undefined;
  readonly source_type?: "file" | "url" | "base64" | "svg" | "card" | undefined;
  readonly source_artifact_id?: string | undefined;
  readonly source?: UploadImageAssetMetadata | undefined;
  readonly processed?: UploadImageAssetMetadata | undefined;
  readonly preview_url?: string | undefined;
  readonly alt_text?: string | undefined;
  readonly caption?: string | undefined;
  readonly warnings: readonly string[];
  readonly warning_details: readonly ImageProcessingWarning[];
  readonly message: string;
}

export interface UploadImageAssetMetadata {
  readonly source_type?: "file" | "url" | "base64" | "svg" | "card" | undefined;
  readonly filename: string;
  readonly format: string;
  readonly mime_type: string;
  readonly width: number;
  readonly height: number;
  readonly color_mode: string;
  readonly size_bytes: number;
  readonly sha256: string;
  readonly artifact_id?: string | undefined;
}

interface UploadImageOptions {
  readonly client?: Pick<SubstackClient, "uploadImage"> | undefined;
  readonly fetchFn?: FetchLike | undefined;
  readonly dnsLookup?: ImageDnsLookup | undefined;
  readonly auditLogger?: AuditLogger | undefined;
}

export async function uploadImage(
  input: UploadImageInput,
  config: Pick<
    AppConfig,
    | "maxImageBytes"
    | "imageFileRoots"
    | "publicationUrl"
    | "sessionToken"
    | "substackRequestTimeoutMs"
    | "userAgent"
    | "userId"
  >,
  options: UploadImageOptions = {},
): Promise<UploadImageOutput> {
  const prepared = await prepareImage(input, config, {
    fetchFn: options.fetchFn,
    dnsLookup:
      options.dnsLookup ??
      (options.fetchFn === undefined ? defaultImageDnsLookup : undefined),
  });
  if (!prepared.ok) {
    auditUploadImage(options.auditLogger, input, {
      outcome: "failure",
      reason:
        prepared.error.stage === "source" ||
        prepared.error.stage === "download" ||
        prepared.error.stage === "validation"
          ? "validation"
          : "image_prepare",
      errorCount: 1,
      warningCount: 0,
    });
    return failure(prepared.error, input);
  }

  try {
    const client = options.client ?? createSubstackClient(config);
    const uploaded = await client.uploadImage(prepared.image.dataUri);
    const uploadedUrlValidation = parseHttpUrl(
      uploaded.url,
      "uploaded image_url",
    );
    if (!uploadedUrlValidation.ok) {
      const error = uploadFailure(
        uploadedUrlValidation.errors[0] ??
          "Substack returned an invalid image URL.",
      );
      auditUploadImage(options.auditLogger, input, {
        outcome: "failure",
        reason: "substack_client",
        errorCount: 1,
        warningCount: prepared.image.warnings.length,
      });
      return failure(error, input, prepared.image.warnings);
    }

    auditUploadImage(options.auditLogger, input, {
      outcome: "success",
      errorCount: 0,
      warningCount: prepared.image.warnings.length,
    });

    return {
      ok: true,
      errors: [],
      image_url: uploadedUrlValidation.url.toString(),
      preview_url: uploadedUrlValidation.url.toString(),
      filename: prepared.image.filename,
      format: prepared.image.format,
      width: prepared.image.width,
      height: prepared.image.height,
      size_bytes: prepared.image.sizeBytes,
      sha256: prepared.image.sha256,
      source_type: prepared.image.sourceType,
      source_artifact_id: prepared.image.source.artifactId,
      source: toOutputAssetMetadata(
        prepared.image.source,
        prepared.image.sourceType,
      ),
      processed: toOutputAssetMetadata(prepared.image.processed),
      alt_text: input.alt_text,
      caption: input.caption,
      warnings: prepared.image.warnings.map(({ message }) => message),
      warning_details: prepared.image.warnings,
      message: `Uploaded image to Substack: ${uploadedUrlValidation.url.toString()}`,
    };
  } catch (error) {
    const uploadError = uploadFailure(summarizeSubstackToolError(error));
    auditUploadImage(options.auditLogger, input, {
      outcome: "failure",
      reason: "substack_client",
      errorCount: 1,
      warningCount: prepared.image.warnings.length,
    });
    return failure(uploadError, input, prepared.image.warnings);
  }
}

export function summarizeUploadImage(result: UploadImageOutput): string {
  if (!result.ok) {
    return `Image upload failed with ${result.errors.length} error(s).`;
  }
  return result.message;
}

function failure(
  error: ImageProcessingIssue | UploadImageError,
  input: Pick<UploadImageInput, "alt_text" | "caption">,
  warnings: readonly ImageProcessingWarning[] = [],
): UploadImageOutput {
  return {
    ok: false,
    errors: [error.message],
    error,
    alt_text: input.alt_text,
    caption: input.caption,
    warnings: warnings.map(({ message }) => message),
    warning_details: warnings,
    message: "Image upload failed with 1 error(s).",
  };
}

function toOutputAssetMetadata(
  metadata: ImageAssetMetadata,
  sourceType?: "file" | "url" | "base64" | "svg" | "card",
): UploadImageAssetMetadata {
  return {
    ...(sourceType !== undefined ? { source_type: sourceType } : {}),
    filename: metadata.filename,
    format: metadata.format,
    mime_type: metadata.mimeType,
    width: metadata.width,
    height: metadata.height,
    color_mode: metadata.colorMode,
    size_bytes: metadata.sizeBytes,
    sha256: metadata.sha256,
    ...(metadata.artifactId !== undefined
      ? { artifact_id: metadata.artifactId }
      : {}),
  };
}

function uploadFailure(message: string): UploadImageError {
  return {
    code: "SUBSTACK_UPLOAD_FAILED",
    message,
    stage: "upload",
  };
}

function auditUploadImage(
  auditLogger: AuditLogger | undefined,
  input: UploadImageInput,
  event: {
    readonly outcome: "success" | "failure";
    readonly reason?: "validation" | "substack_client" | "image_prepare";
    readonly errorCount: number;
    readonly warningCount: number;
  },
): void {
  writeAuditEvent(auditLogger, {
    action: "upload_image",
    outcome: event.outcome,
    ...(event.reason ? { reason: event.reason } : {}),
    image_source: imageSource(input),
    alt_text_present: input.alt_text !== undefined,
    caption_present: input.caption !== undefined,
    warning_count: event.warningCount,
    error_count: event.errorCount,
  });
}

function imageSource(
  input: Pick<
    UploadImageInput,
    "card" | "image_base64" | "image_file" | "image_url" | "source_type" | "svg"
  >,
):
  | "remote_url"
  | "file"
  | "base64"
  | "data_uri"
  | "svg"
  | "card"
  | "none"
  | "ambiguous" {
  const suppliedCount = [
    input.image_file,
    input.image_url,
    input.image_base64,
    input.svg,
    input.card,
  ].filter((value) => value !== undefined).length;
  if (suppliedCount > 1) {
    return "ambiguous";
  }
  if (input.source_type === "svg" || input.svg !== undefined) {
    return "svg";
  }
  if (input.source_type === "card" || input.card !== undefined) {
    return "card";
  }
  if (input.source_type === "file" || input.image_file !== undefined) {
    return "file";
  }
  if (input.image_url !== undefined) {
    return "remote_url";
  }
  if (input.image_base64 !== undefined) {
    return input.image_base64.trim().startsWith("data:")
      ? "data_uri"
      : "base64";
  }
  return "none";
}
