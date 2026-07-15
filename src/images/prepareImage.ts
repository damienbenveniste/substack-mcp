import { createHash } from "node:crypto";
import { lookup } from "node:dns/promises";
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";

import { DOMParser, type Document } from "@xmldom/xmldom";
import sharp from "sharp";

import { redactLogSensitiveText } from "../safety/redaction.js";
import { parseHttpUrl } from "../safety/urlPolicy.js";
import type { FetchLike } from "../substack/types.js";

const ALLOWED_RASTER_MIME_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const ALLOWED_RASTER_FORMATS = new Set([
  "avif",
  "gif",
  "heif",
  "jpeg",
  "jpg",
  "png",
  "webp",
]);
const EXTENSION_TO_MIME_TYPE: Readonly<Record<string, string>> = {
  avif: "image/avif",
  gif: "image/gif",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};
const FORMAT_TO_MIME_TYPE: Readonly<Record<string, string>> = {
  avif: "image/avif",
  gif: "image/gif",
  heif: "image/avif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};
const SVG_MIME_TYPE = "image/svg+xml";
const DEFAULT_MAX_WIDTH = 1456;
const DEFAULT_MAX_HEIGHT = 2000;
const MAX_SOURCE_DIMENSION = 6000;
const MAX_SOURCE_PIXELS = 25_000_000;
const MAX_SVG_BYTES = 1_000_000;
const IMAGE_PROCESSING_TIMEOUT_SECONDS = 10;
const MIN_SUSPICIOUS_DIMENSION = 32;

const FORBIDDEN_SVG_ELEMENTS = new Set([
  "audio",
  "embed",
  "feimage",
  "foreignobject",
  "iframe",
  "image",
  "object",
  "script",
  "video",
]);
const EXTERNAL_REFERENCE_ATTRIBUTES = new Set([
  "href",
  "src",
  "xlink:href",
  "xml:base",
]);

export type ImageSourceType = "file" | "url" | "base64" | "svg" | "card";
export type ImageProcessingStage =
  | "source"
  | "download"
  | "sanitization"
  | "decode"
  | "normalization"
  | "validation";
export type ImageProcessingErrorCode =
  | "INVALID_SOURCE_TYPE"
  | "MISSING_SOURCE"
  | "EXACTLY_ONE_IMAGE_SOURCE_REQUIRED"
  | "SOURCE_ARTIFACT_UNAVAILABLE"
  | "FILE_READ_FAILED"
  | "INVALID_BASE64"
  | "IMAGE_DECODE_FAILED"
  | "UNSUPPORTED_IMAGE_FORMAT"
  | "IMAGE_TOO_LARGE"
  | "INVALID_DIMENSIONS"
  | "SVG_SANITIZATION_FAILED"
  | "SVG_RENDER_FAILED"
  | "IMAGE_CONVERSION_FAILED"
  | "OUTPUT_VALIDATION_FAILED"
  | "UNEXPECTED_ASPECT_RATIO_CHANGE"
  | "UNEXPECTED_COLOR_MODE_CHANGE"
  | "VISUAL_FIDELITY_CHECK_FAILED"
  | "REMOTE_IMAGE_DOWNLOAD_FAILED"
  | "REMOTE_IMAGE_BLOCKED";

export type ImageProcessingWarningCode =
  | "DECLARED_MIME_MISMATCH"
  | "DIMENSIONS_CHANGED"
  | "ASPECT_RATIO_CHANGED"
  | "MAJOR_SIZE_REDUCTION"
  | "COLOR_MODE_CHANGED"
  | "TRANSPARENCY_REMOVED"
  | "METADATA_STRIPPED"
  | "FORMAT_CONVERTED"
  | "SVG_CONVERTED_TO_PNG"
  | "IMAGE_RESIZED"
  | "UNUSUALLY_SMALL_IMAGE"
  | "UNUSUAL_ASPECT_RATIO"
  | "MOSTLY_TRANSPARENT"
  | "LOW_VISUAL_VARIANCE"
  | "UNUSUALLY_SMALL_FILE";

export interface ImageProcessingWarning {
  readonly code: ImageProcessingWarningCode;
  readonly message: string;
}

export interface ImageFileReference {
  readonly file_id?: string | undefined;
  readonly artifact_id?: string | undefined;
  readonly download_url?: string | undefined;
  readonly path?: string | undefined;
  readonly name?: string | undefined;
  readonly mime_type?: string | undefined;
  readonly size?: number | undefined;
  readonly expected_sha256?: string | undefined;
}

export type ImageFileInput =
  | string
  | ImageFileReference
  | readonly (string | ImageFileReference)[];

export interface ImageCardInput {
  readonly width: number;
  readonly height: number;
  readonly title: string;
  readonly subtitle?: string | undefined;
  readonly footer?: string | undefined;
  readonly background?: string | undefined;
  readonly foreground?: string | undefined;
}

export interface PrepareImageInput {
  readonly source_type?: ImageSourceType | undefined;
  readonly image_file?: ImageFileInput | undefined;
  readonly image_url?: string | undefined;
  readonly image_base64?: string | undefined;
  readonly svg?: string | undefined;
  readonly card?: ImageCardInput | undefined;
  readonly output_format?: "png" | undefined;
  readonly max_width?: number | undefined;
  readonly max_height?: number | undefined;
  readonly filename_hint?: string | undefined;
  readonly preserve_dimensions?: boolean | undefined;
  readonly allow_resize?: boolean | undefined;
  readonly allow_color_mode_change?: boolean | undefined;
  readonly require_visual_fidelity?: boolean | undefined;
}

export interface ImageProcessingIssue {
  readonly code: ImageProcessingErrorCode;
  readonly message: string;
  readonly stage: ImageProcessingStage;
}

export interface PreparedImage {
  readonly dataUri: string;
  readonly filename: string;
  readonly format: "png";
  readonly width: number;
  readonly height: number;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly sourceType: ImageSourceType;
  readonly source: ImageAssetMetadata;
  readonly processed: ImageAssetMetadata;
  readonly warnings: readonly ImageProcessingWarning[];
}

export interface ImageAssetMetadata {
  readonly filename: string;
  readonly format: string;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly colorMode: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly artifactId?: string | undefined;
}

export type PrepareImageResult =
  | { readonly ok: true; readonly image: PreparedImage }
  | { readonly ok: false; readonly error: ImageProcessingIssue };

export interface ImageDnsAddress {
  readonly address: string;
}

export type ImageDnsLookup = (
  hostname: string,
) => Promise<readonly ImageDnsAddress[]>;

export interface PrepareImageOptions {
  readonly fetchFn?: FetchLike | undefined;
  readonly dnsLookup?: ImageDnsLookup | undefined;
}

interface ResolvedImageSource {
  readonly bytes: Buffer;
  readonly sourceType: ImageSourceType;
  readonly kind: "raster" | "svg";
  readonly declaredMimeType?: string | undefined;
  readonly filename?: string | undefined;
  readonly artifactId?: string | undefined;
  readonly expectedSha256?: string | undefined;
}

type SelectedImageSource =
  | { readonly sourceType: "file"; readonly value: ImageFileInput }
  | { readonly sourceType: "url"; readonly value: string }
  | { readonly sourceType: "base64"; readonly value: string }
  | { readonly sourceType: "svg"; readonly value: string }
  | { readonly sourceType: "card"; readonly value: ImageCardInput };

interface PrepareImageConfig {
  readonly maxImageBytes: number;
  readonly substackRequestTimeoutMs: number;
  readonly imageFileRoots?: readonly string[] | undefined;
}

class ImagePreparationError extends Error {
  readonly issue: ImageProcessingIssue;

  constructor(issue: ImageProcessingIssue) {
    super(issue.message);
    this.name = "ImagePreparationError";
    this.issue = issue;
  }
}

export async function prepareImage(
  input: PrepareImageInput,
  config: PrepareImageConfig,
  options: PrepareImageOptions = {},
): Promise<PrepareImageResult> {
  try {
    const source = await resolveImageSource(input, config, options);
    const image = await normalizeImage(source, input, config.maxImageBytes);
    return { ok: true, image };
  } catch (error) {
    if (error instanceof ImagePreparationError) {
      return { ok: false, error: error.issue };
    }

    return {
      ok: false,
      error: issue(
        "IMAGE_CONVERSION_FAILED",
        "Image processing failed before a valid PNG could be produced.",
        "normalization",
      ),
    };
  }
}

export async function defaultImageDnsLookup(
  hostname: string,
): Promise<readonly ImageDnsAddress[]> {
  return lookup(hostname, { all: true, verbatim: true });
}

async function resolveImageSource(
  input: PrepareImageInput,
  config: PrepareImageConfig,
  options: PrepareImageOptions,
): Promise<ResolvedImageSource> {
  const source = selectImageSource(input);

  switch (source.sourceType) {
    case "file":
      return resolveImageFile(
        source.value,
        input.filename_hint,
        config,
        options,
      );
    case "url":
      return downloadImage(source.value, config, options, {
        sourceType: "url",
        filename: filenameFromUrl(source.value),
      });
    case "base64":
      return decodeBase64Image(
        source.value,
        input.filename_hint,
        config.maxImageBytes,
      );
    case "svg":
      return resolveSvg(source.value, "svg");
    case "card":
      return resolveSvg(renderCardSvg(requireCard(source.value)), "card");
  }
}

function selectImageSource(input: PrepareImageInput): SelectedImageSource {
  const suppliedSources = [
    input.image_file !== undefined
      ? ({ sourceType: "file", value: input.image_file } as const)
      : undefined,
    input.image_url !== undefined
      ? ({ sourceType: "url", value: input.image_url } as const)
      : undefined,
    input.image_base64 !== undefined
      ? ({ sourceType: "base64", value: input.image_base64 } as const)
      : undefined,
    input.svg !== undefined
      ? ({ sourceType: "svg", value: input.svg } as const)
      : undefined,
    input.card !== undefined
      ? ({ sourceType: "card", value: input.card } as const)
      : undefined,
  ].filter((value): value is SelectedImageSource => value !== undefined);

  if (input.source_type === undefined) {
    const selected = suppliedSources.find(
      (source) =>
        source.sourceType === "file" ||
        source.sourceType === "url" ||
        source.sourceType === "base64",
    );
    if (selected === undefined || suppliedSources.length !== 1) {
      throw new ImagePreparationError(
        issue(
          "EXACTLY_ONE_IMAGE_SOURCE_REQUIRED",
          "Exactly one image source is required: image_file, image_url, image_base64, svg, or card.",
          "source",
        ),
      );
    }
    return selected;
  }

  if (
    !(["file", "url", "base64", "svg", "card"] as const).includes(
      input.source_type,
    )
  ) {
    throw new ImagePreparationError(
      issue(
        "INVALID_SOURCE_TYPE",
        "source_type must be one of: file, url, base64, svg, card.",
        "source",
      ),
    );
  }

  const selected = suppliedSources.find(
    (source) => source.sourceType === input.source_type,
  );
  if (selected === undefined || suppliedSources.length !== 1) {
    throw new ImagePreparationError(
      issue(
        "EXACTLY_ONE_IMAGE_SOURCE_REQUIRED",
        `source_type=${input.source_type} requires only its matching source field.`,
        "source",
      ),
    );
  }

  return selected;
}

async function resolveImageFile(
  input: ImageFileInput,
  filenameHint: string | undefined,
  config: PrepareImageConfig,
  options: PrepareImageOptions,
): Promise<ResolvedImageSource> {
  const reference = unwrapImageFile(input);
  if (typeof reference === "string") {
    return readLocalImageFile(reference, config);
  }

  const artifactId = reference.file_id ?? reference.artifact_id;
  if (reference.path !== undefined) {
    const local = await readLocalImageFile(reference.path, config);
    return {
      ...local,
      filename: safeSourceFilename(reference.name) ?? local.filename,
      artifactId,
      expectedSha256: normalizedExpectedSha256(reference.expected_sha256),
    };
  }

  if (!reference.download_url) {
    throw sourceArtifactUnavailable(
      "The exact image_file reference has no downloadable URL or allowlisted local path. No substitute was uploaded.",
    );
  }
  if (
    reference.size !== undefined &&
    (!Number.isSafeInteger(reference.size) || reference.size < 0)
  ) {
    throw sourceArtifactUnavailable(
      "image_file.size must be a non-negative integer when provided.",
    );
  }
  if (reference.size !== undefined) {
    assertImageByteLimit(reference.size, config.maxImageBytes);
  }

  return downloadImage(reference.download_url, config, options, {
    sourceType: "file",
    filename:
      safeSourceFilename(reference.name) ??
      safeSourceFilename(filenameHint) ??
      filenameFromUrl(reference.download_url),
    artifactId,
    declaredMimeType: normalizeMimeType(reference.mime_type ?? null),
    expectedSha256: normalizedExpectedSha256(reference.expected_sha256),
  });
}

function unwrapImageFile(input: ImageFileInput): string | ImageFileReference {
  if (typeof input === "string" || !Array.isArray(input)) {
    return input as string | ImageFileReference;
  }
  if (input.length !== 1 || input[0] === undefined) {
    throw sourceArtifactUnavailable(
      "image_file must identify exactly one file artifact. No substitute was uploaded.",
    );
  }
  return input[0];
}

async function readLocalImageFile(
  path: string,
  config: PrepareImageConfig,
): Promise<ResolvedImageSource> {
  const roots = config.imageFileRoots ?? [];
  if (!isAbsolute(path) || roots.length === 0) {
    throw sourceArtifactUnavailable(
      "Local image_file paths must be absolute and contained by an IMAGE_FILE_ROOTS allowlist entry.",
    );
  }

  let filePath: string;
  try {
    filePath = await realpath(path);
  } catch {
    throw sourceArtifactUnavailable(
      "The exact requested image_file path could not be resolved. No substitute was uploaded.",
    );
  }

  let allowed = false;
  for (const configuredRoot of roots) {
    try {
      const root = await realpath(resolve(configuredRoot));
      const child = relative(root, filePath);
      if (child === "" || (!child.startsWith("..") && !isAbsolute(child))) {
        allowed = true;
        break;
      }
    } catch {
      // A missing allowlist root cannot authorize the requested file.
    }
  }
  if (!allowed) {
    throw sourceArtifactUnavailable(
      "The exact requested image_file is outside the configured IMAGE_FILE_ROOTS allowlist.",
    );
  }

  try {
    const metadata = await stat(filePath);
    if (!metadata.isFile()) {
      throw new Error("not a regular file");
    }
    assertImageByteLimit(metadata.size, config.maxImageBytes);
    const bytes = await readFile(filePath);
    assertImageByteLimit(bytes.byteLength, config.maxImageBytes);
    const declaredMimeType = filePath.toLowerCase().endsWith(".svg")
      ? SVG_MIME_TYPE
      : inferMimeType(basename(filePath));
    if (declaredMimeType === SVG_MIME_TYPE) {
      assertSafeSvg(bytes.toString("utf8"));
    }
    return {
      bytes,
      sourceType: "file",
      kind: declaredMimeType === SVG_MIME_TYPE ? "svg" : "raster",
      declaredMimeType,
      filename: basename(filePath),
    };
  } catch (error) {
    if (error instanceof ImagePreparationError) {
      throw error;
    }
    throw new ImagePreparationError(
      issue(
        "FILE_READ_FAILED",
        "The exact requested image_file could not be read as a regular file. No substitute was uploaded.",
        "source",
      ),
    );
  }
}

async function downloadImage(
  imageUrl: string,
  config: PrepareImageConfig,
  options: PrepareImageOptions,
  source: {
    readonly sourceType: "file" | "url";
    readonly filename?: string | undefined;
    readonly artifactId?: string | undefined;
    readonly declaredMimeType?: string | undefined;
    readonly expectedSha256?: string | undefined;
  },
): Promise<ResolvedImageSource> {
  const field =
    source.sourceType === "file" ? "image_file.download_url" : "image_url";
  const parsed = parseHttpUrl(imageUrl, field);
  if (!parsed.ok) {
    throw new ImagePreparationError(
      issue(
        "REMOTE_IMAGE_BLOCKED",
        parsed.errors[0] ?? "Image URL blocked.",
        "download",
      ),
    );
  }

  const dnsLookup =
    options.dnsLookup ??
    (options.fetchFn === undefined ? defaultImageDnsLookup : undefined);
  if (dnsLookup) {
    await assertPublicDnsResolution(parsed.url.hostname, dnsLookup);
  }

  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(),
    config.substackRequestTimeoutMs,
  );
  timeout.unref?.();

  try {
    const response = await (options.fetchFn ?? fetch)(parsed.url, {
      redirect: "manual",
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      throw new ImagePreparationError(
        issue(
          "REMOTE_IMAGE_BLOCKED",
          "Image fetch redirected; provide the final public image URL directly.",
          "download",
        ),
      );
    }
    if (!response.ok) {
      if (source.sourceType === "file") {
        throw sourceArtifactUnavailable(
          `The exact image_file artifact could not be downloaded (HTTP ${response.status}). No substitute was uploaded.`,
          "download",
        );
      }
      throw new ImagePreparationError(
        issue(
          "REMOTE_IMAGE_DOWNLOAD_FAILED",
          `Image fetch failed with HTTP ${response.status}.`,
          "download",
        ),
      );
    }

    const responseMimeType = normalizeMimeType(
      response.headers.get("content-type"),
    );
    const mimeType = source.declaredMimeType ?? responseMimeType;
    if (!isAllowedSourceMimeType(mimeType)) {
      throw new ImagePreparationError(
        issue(
          "UNSUPPORTED_IMAGE_FORMAT",
          `Unsupported image MIME type: ${mimeType ?? "unknown"}.`,
          "download",
        ),
      );
    }

    const declaredBytes = parseContentLength(
      response.headers.get("content-length"),
    );
    if (declaredBytes !== undefined) {
      assertImageByteLimit(declaredBytes, config.maxImageBytes);
    }

    const bytes = await readResponseBytes(response, config.maxImageBytes);
    if (mimeType === SVG_MIME_TYPE) {
      const svg = bytes.toString("utf8");
      assertSafeSvg(svg);
      return {
        bytes: Buffer.from(svg, "utf8"),
        sourceType: source.sourceType,
        kind: "svg",
        declaredMimeType: mimeType,
        filename: source.filename,
        artifactId: source.artifactId,
        expectedSha256: source.expectedSha256,
      };
    }

    return {
      bytes,
      sourceType: source.sourceType,
      kind: "raster",
      declaredMimeType: mimeType,
      filename: source.filename,
      artifactId: source.artifactId,
      expectedSha256: source.expectedSha256,
    };
  } catch (error) {
    if (error instanceof ImagePreparationError) {
      throw error;
    }
    if (controller.signal.aborted || isAbortError(error)) {
      if (source.sourceType === "file") {
        throw sourceArtifactUnavailable(
          `The exact image_file artifact download timed out after ${config.substackRequestTimeoutMs} ms. No substitute was uploaded.`,
          "download",
        );
      }
      throw new ImagePreparationError(
        issue(
          "REMOTE_IMAGE_DOWNLOAD_FAILED",
          `Image fetch timed out after ${config.substackRequestTimeoutMs} ms.`,
          "download",
        ),
      );
    }
    const message =
      error instanceof Error
        ? redactLogSensitiveText(error.message)
        : "Remote image download failed.";
    if (source.sourceType === "file") {
      throw sourceArtifactUnavailable(
        `${message || "The exact image_file artifact could not be downloaded."} No substitute was uploaded.`,
        "download",
      );
    }
    throw new ImagePreparationError(
      issue(
        "REMOTE_IMAGE_DOWNLOAD_FAILED",
        message || "Remote image download failed.",
        "download",
      ),
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function assertPublicDnsResolution(
  hostname: string,
  dnsLookup: ImageDnsLookup,
): Promise<void> {
  let addresses: readonly ImageDnsAddress[];
  try {
    addresses = await dnsLookup(hostname);
  } catch {
    throw new ImagePreparationError(
      issue(
        "REMOTE_IMAGE_DOWNLOAD_FAILED",
        "Image host DNS resolution failed.",
        "download",
      ),
    );
  }

  if (addresses.length === 0) {
    throw new ImagePreparationError(
      issue(
        "REMOTE_IMAGE_DOWNLOAD_FAILED",
        "Image host DNS resolution returned no addresses.",
        "download",
      ),
    );
  }

  for (const { address } of addresses) {
    const host = address.includes(":") ? `[${address}]` : address;
    if (!parseHttpUrl(`http://${host}`, "resolved image_url").ok) {
      throw new ImagePreparationError(
        issue(
          "REMOTE_IMAGE_BLOCKED",
          "image_url resolved to a localhost or private network address.",
          "download",
        ),
      );
    }
  }
}

async function readResponseBytes(
  response: Response,
  maxBytes: number,
): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    assertImageByteLimit(bytes.byteLength, maxBytes);
    return bytes;
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
      if (totalBytes > maxBytes) {
        await reader.cancel();
        assertImageByteLimit(totalBytes, maxBytes);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(
    chunks.map((chunk) => Buffer.from(chunk)),
    totalBytes,
  );
}

function decodeBase64Image(
  imageBase64: string,
  filenameHint: string | undefined,
  maxImageBytes: number,
): ResolvedImageSource {
  assertFilenameHint(filenameHint);
  const dataUri = parseDataUri(imageBase64);
  const inferredMimeType = inferMimeType(filenameHint);
  if (
    !dataUri &&
    filenameHint !== undefined &&
    inferredMimeType === undefined
  ) {
    throw new ImagePreparationError(
      issue(
        "UNSUPPORTED_IMAGE_FORMAT",
        "filename_hint must end with a supported image extension: avif, gif, jpg, jpeg, png, or webp.",
        "source",
      ),
    );
  }

  const mimeType = dataUri?.mimeType ?? inferredMimeType;
  if (!isAllowedRasterMimeType(mimeType)) {
    throw new ImagePreparationError(
      issue(
        "UNSUPPORTED_IMAGE_FORMAT",
        `Unsupported image MIME type: ${mimeType ?? "unknown"}.`,
        "source",
      ),
    );
  }

  const base64 = normalizeBase64(dataUri?.base64 ?? imageBase64);
  if (!base64) {
    throw new ImagePreparationError(
      issue(
        "INVALID_BASE64",
        "image_base64 must be valid base64 data.",
        "source",
      ),
    );
  }

  const bytes = Buffer.from(base64, "base64");
  assertImageByteLimit(bytes.byteLength, maxImageBytes);
  return {
    bytes,
    sourceType: "base64",
    kind: "raster",
    declaredMimeType: mimeType,
    filename: safeSourceFilename(filenameHint),
  };
}

function resolveSvg(
  svg: string,
  sourceType: "svg" | "card",
): ResolvedImageSource {
  assertSafeSvg(svg);
  return {
    bytes: Buffer.from(svg, "utf8"),
    sourceType,
    kind: "svg",
    declaredMimeType: SVG_MIME_TYPE,
    filename: sourceType === "card" ? "generated-card.svg" : "image.svg",
  };
}

async function normalizeImage(
  source: ResolvedImageSource,
  input: PrepareImageInput,
  maxImageBytes: number,
): Promise<PreparedImage> {
  const sourceSha256 = createHash("sha256").update(source.bytes).digest("hex");
  if (
    source.expectedSha256 !== undefined &&
    source.expectedSha256 !== sourceSha256
  ) {
    throw sourceArtifactUnavailable(
      "The exact image_file checksum did not match expected_sha256. No substitute was uploaded.",
    );
  }
  const sourceMetadata = await readSourceMetadata(source);
  const sourceWidth = sourceMetadata.autoOrient?.width ?? sourceMetadata.width;
  const sourceHeight =
    sourceMetadata.autoOrient?.height ?? sourceMetadata.height;
  assertSourceDimensions(sourceWidth, sourceHeight);
  const preserveDimensions = input.preserve_dimensions !== false;
  const maxWidth =
    input.max_width ?? (preserveDimensions ? sourceWidth : DEFAULT_MAX_WIDTH);
  const maxHeight =
    input.max_height ??
    (preserveDimensions ? sourceHeight : DEFAULT_MAX_HEIGHT);
  assertResizeBounds(maxWidth, maxHeight);
  if ((sourceMetadata.pages ?? 1) > 1) {
    throw new ImagePreparationError(
      issue(
        "UNSUPPORTED_IMAGE_FORMAT",
        "Animated and multi-page images are not supported; provide a single-frame image.",
        "decode",
      ),
    );
  }
  if (
    input.allow_resize === false &&
    ((sourceWidth ?? 0) > maxWidth || (sourceHeight ?? 0) > maxHeight)
  ) {
    throw new ImagePreparationError(
      issue(
        "VISUAL_FIDELITY_CHECK_FAILED",
        `The source image is ${sourceWidth}x${sourceHeight}px and would need resizing to fit ${maxWidth}x${maxHeight}px, but allow_resize is false.`,
        "validation",
      ),
    );
  }

  const warnings: ImageProcessingWarning[] = [];
  const decodedMimeType = FORMAT_TO_MIME_TYPE[sourceMetadata.format ?? ""];
  if (
    source.kind === "raster" &&
    source.declaredMimeType &&
    decodedMimeType &&
    source.declaredMimeType !== decodedMimeType
  ) {
    warnings.push(
      warning(
        "DECLARED_MIME_MISMATCH",
        `Declared image MIME type ${source.declaredMimeType} did not match decoded type ${decodedMimeType}; the decoded image was normalized safely.`,
      ),
    );
  }

  let output: Buffer;
  try {
    output = await createSharp(source.bytes)
      .autoOrient()
      .resize({
        width: maxWidth,
        height: maxHeight,
        fit: "inside",
        withoutEnlargement: true,
      })
      .toColourspace("srgb")
      .png({ compressionLevel: 9, adaptiveFiltering: true })
      .toBuffer();
  } catch {
    throw new ImagePreparationError(
      issue(
        source.kind === "svg" ? "SVG_RENDER_FAILED" : "IMAGE_DECODE_FAILED",
        source.kind === "svg"
          ? "SVG rendering failed before a valid PNG could be produced."
          : "The provided image could not be fully decoded.",
        source.kind === "svg" ? "normalization" : "decode",
      ),
    );
  }

  assertImageByteLimit(output.byteLength, maxImageBytes);
  const validation = await validateOutputPng(output);
  const sha256 = createHash("sha256").update(output).digest("hex");
  const sourceAsset = buildSourceMetadata(source, sourceMetadata, sourceSha256);
  const filename = normalizedPngFilename(
    outputFilenameHint(input.filename_hint, source.filename),
    sha256,
  );
  const processedAsset: ImageAssetMetadata = {
    filename,
    format: "png",
    mimeType: "image/png",
    width: validation.width,
    height: validation.height,
    colorMode: colorModeFromMetadata(validation.metadata),
    sizeBytes: output.byteLength,
    sha256,
  };
  warnings.push(
    ...compareImageTransformationMetadata(sourceAsset, processedAsset),
    ...(hasEmbeddedMetadata(sourceMetadata)
      ? [
          warning(
            "METADATA_STRIPPED",
            "Embedded source metadata was not copied to the normalized upload image.",
          ),
        ]
      : []),
    ...visualWarnings(validation, output.byteLength),
  );
  assertImageVisualFidelity(input, sourceAsset, processedAsset);

  return {
    dataUri: `data:image/png;base64,${output.toString("base64")}`,
    filename,
    format: "png",
    width: validation.width,
    height: validation.height,
    sizeBytes: output.byteLength,
    sha256,
    sourceType: source.sourceType,
    source: sourceAsset,
    processed: processedAsset,
    warnings,
  };
}

function createSharp(bytes: Buffer) {
  return sharp(bytes, {
    failOn: "warning",
    limitInputPixels: MAX_SOURCE_PIXELS,
    limitInputChannels: 5,
    sequentialRead: true,
    unlimited: false,
  }).timeout({ seconds: IMAGE_PROCESSING_TIMEOUT_SECONDS });
}

async function readSourceMetadata(source: ResolvedImageSource) {
  try {
    const metadata = await createSharp(source.bytes).metadata();
    if (
      source.kind === "raster" &&
      !ALLOWED_RASTER_FORMATS.has(metadata.format ?? "")
    ) {
      throw new ImagePreparationError(
        issue(
          "UNSUPPORTED_IMAGE_FORMAT",
          `Unsupported decoded image format: ${metadata.format ?? "unknown"}.`,
          "decode",
        ),
      );
    }
    if (source.kind === "svg" && metadata.format !== "svg") {
      throw new ImagePreparationError(
        issue(
          "SVG_RENDER_FAILED",
          "SVG source did not decode as SVG.",
          "decode",
        ),
      );
    }
    return metadata;
  } catch (error) {
    if (error instanceof ImagePreparationError) {
      throw error;
    }
    throw new ImagePreparationError(
      issue(
        source.kind === "svg" ? "SVG_RENDER_FAILED" : "IMAGE_DECODE_FAILED",
        source.kind === "svg"
          ? "SVG source could not be decoded for rendering."
          : "The provided image could not be fully decoded.",
        "decode",
      ),
    );
  }
}

type SharpMetadata = Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;

function buildSourceMetadata(
  source: ResolvedImageSource,
  metadata: SharpMetadata,
  sha256: string,
): ImageAssetMetadata {
  const width = metadata.autoOrient?.width ?? metadata.width;
  const height = metadata.autoOrient?.height ?? metadata.height;
  assertSourceDimensions(width, height);

  const decodedFormat =
    metadata.format ?? (source.kind === "svg" ? "svg" : "unknown");
  const normalizedFormat = decodedFormat;
  const fallbackExtension =
    normalizedFormat === "jpeg" ? "jpg" : normalizedFormat;
  const filename =
    safeSourceFilename(source.filename) ??
    `source-${sha256.slice(0, 12)}.${fallbackExtension}`;
  const mimeType =
    source.declaredMimeType ??
    (source.kind === "svg"
      ? SVG_MIME_TYPE
      : (FORMAT_TO_MIME_TYPE[normalizedFormat] ?? "application/octet-stream"));
  const artifactId =
    source.artifactId ??
    (source.sourceType === "file" ? `sha256:${sha256}` : undefined);

  return {
    filename,
    format: normalizedFormat,
    mimeType,
    width: width as number,
    height: height as number,
    colorMode: colorModeFromMetadata(metadata),
    sizeBytes: source.bytes.byteLength,
    sha256,
    ...(artifactId !== undefined ? { artifactId } : {}),
  };
}

export function compareImageTransformationMetadata(
  source: ImageAssetMetadata,
  processed: ImageAssetMetadata,
): readonly ImageProcessingWarning[] {
  const warnings: ImageProcessingWarning[] = [];
  if (source.format !== processed.format) {
    warnings.push(
      warning(
        "FORMAT_CONVERTED",
        `Image format changed from ${source.format} to ${processed.format} during normalization.`,
      ),
    );
    if (source.format === "svg") {
      warnings.push(
        warning(
          "SVG_CONVERTED_TO_PNG",
          "The SVG source was rendered to PNG for Substack upload.",
        ),
      );
    }
  }

  if (source.width !== processed.width || source.height !== processed.height) {
    warnings.push(
      warning(
        "DIMENSIONS_CHANGED",
        `Image dimensions changed from ${source.width}x${source.height}px to ${processed.width}x${processed.height}px.`,
      ),
      warning(
        "IMAGE_RESIZED",
        "The source image was resized to fit the configured upload bounds.",
      ),
    );
  }

  if (aspectRatioDelta(source, processed) > 0.02) {
    warnings.push(
      warning(
        "ASPECT_RATIO_CHANGED",
        `Image aspect ratio changed from ${formatRatio(source)} to ${formatRatio(processed)}.`,
      ),
    );
  }

  if (source.sizeBytes > 0 && processed.sizeBytes / source.sizeBytes < 0.2) {
    warnings.push(
      warning(
        "MAJOR_SIZE_REDUCTION",
        `Image size changed from ${source.sizeBytes} byte(s) to ${processed.sizeBytes} byte(s), a reduction greater than 80%.`,
      ),
    );
  }

  if (source.colorMode !== processed.colorMode) {
    warnings.push(
      warning(
        "COLOR_MODE_CHANGED",
        `Image color mode changed from ${source.colorMode} to ${processed.colorMode}.`,
      ),
    );
  }

  if (hasAlphaMode(source.colorMode) && !hasAlphaMode(processed.colorMode)) {
    warnings.push(
      warning(
        "TRANSPARENCY_REMOVED",
        "The source had an alpha channel but the processed PNG does not.",
      ),
    );
  }

  return warnings;
}

export function assertImageVisualFidelity(
  input: PrepareImageInput,
  source: ImageAssetMetadata,
  processed: ImageAssetMetadata,
): void {
  if (
    input.require_visual_fidelity !== false &&
    aspectRatioDelta(source, processed) > 0.02
  ) {
    throw new ImagePreparationError(
      issue(
        "UNEXPECTED_ASPECT_RATIO_CHANGE",
        `Image processing unexpectedly changed the aspect ratio from ${formatRatio(source)} to ${formatRatio(processed)}. No upload was attempted.`,
        "validation",
      ),
    );
  }

  if (
    input.allow_color_mode_change !== true &&
    isColourMode(source.colorMode) &&
    !isColourMode(processed.colorMode)
  ) {
    throw new ImagePreparationError(
      issue(
        "UNEXPECTED_COLOR_MODE_CHANGE",
        `Image processing unexpectedly changed the color mode from ${source.colorMode} to ${processed.colorMode}. No upload was attempted.`,
        "validation",
      ),
    );
  }
}

function colorModeFromMetadata(metadata: SharpMetadata): string {
  if (metadata.space === "cmyk") {
    return metadata.hasAlpha ? "CMYKA" : "CMYK";
  }
  if (metadata.space === "b-w" || (metadata.channels ?? 0) <= 2) {
    return metadata.hasAlpha || metadata.channels === 2
      ? "GRAYSCALE_ALPHA"
      : "GRAYSCALE";
  }
  return metadata.hasAlpha || metadata.channels === 4 ? "RGBA" : "RGB";
}

function hasAlphaMode(colorMode: string): boolean {
  return colorMode.endsWith("A") || colorMode.endsWith("_ALPHA");
}

function hasEmbeddedMetadata(metadata: SharpMetadata): boolean {
  return Boolean(
    metadata.exif || metadata.icc || metadata.iptc || metadata.xmp,
  );
}

function isColourMode(colorMode: string): boolean {
  return (
    colorMode === "RGB" || colorMode === "RGBA" || colorMode.startsWith("CMYK")
  );
}

function aspectRatioDelta(
  source: Pick<ImageAssetMetadata, "width" | "height">,
  processed: Pick<ImageAssetMetadata, "width" | "height">,
): number {
  const sourceRatio = source.width / source.height;
  const processedRatio = processed.width / processed.height;
  return Math.abs(processedRatio - sourceRatio) / sourceRatio;
}

function formatRatio(
  asset: Pick<ImageAssetMetadata, "width" | "height">,
): string {
  return (asset.width / asset.height).toFixed(4);
}

async function validateOutputPng(output: Buffer): Promise<{
  readonly width: number;
  readonly height: number;
  readonly metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  readonly stats: Awaited<ReturnType<ReturnType<typeof sharp>["stats"]>>;
}> {
  try {
    const reopened = createSharp(output);
    const metadata = await reopened.metadata();
    if (
      metadata.format !== "png" ||
      !metadata.width ||
      !metadata.height ||
      metadata.width <= 0 ||
      metadata.height <= 0
    ) {
      throw new Error("Invalid PNG output metadata.");
    }
    const stats = await createSharp(output).stats();
    return {
      width: metadata.width,
      height: metadata.height,
      metadata,
      stats,
    };
  } catch {
    throw new ImagePreparationError(
      issue(
        "OUTPUT_VALIDATION_FAILED",
        "The normalized PNG could not be reopened and fully decoded.",
        "validation",
      ),
    );
  }
}

function visualWarnings(
  output: {
    readonly width: number;
    readonly height: number;
    readonly stats: Awaited<ReturnType<ReturnType<typeof sharp>["stats"]>>;
  },
  sizeBytes: number,
): readonly ImageProcessingWarning[] {
  const warnings: ImageProcessingWarning[] = [];
  if (
    output.width < MIN_SUSPICIOUS_DIMENSION ||
    output.height < MIN_SUSPICIOUS_DIMENSION
  ) {
    warnings.push(
      warning(
        "UNUSUALLY_SMALL_IMAGE",
        `Normalized image is unusually small at ${output.width}x${output.height}px; review it before inserting it into a draft.`,
      ),
    );
  }

  const aspectRatio = output.width / output.height;
  if (aspectRatio > 8 || aspectRatio < 1 / 8) {
    warnings.push(
      warning(
        "UNUSUAL_ASPECT_RATIO",
        `Normalized image has an unusual ${output.width}:${output.height} aspect ratio; review it before inserting it into a draft.`,
      ),
    );
  }

  const alpha = output.stats.channels[3];
  if (alpha && alpha.mean < 2.55) {
    warnings.push(
      warning(
        "MOSTLY_TRANSPARENT",
        "Normalized image is almost entirely transparent; review it before inserting it into a draft.",
      ),
    );
  }

  const colourChannels = output.stats.channels.slice(0, 3);
  if (
    colourChannels.length > 0 &&
    colourChannels.every((channel) => channel.stdev < 0.5)
  ) {
    warnings.push(
      warning(
        "LOW_VISUAL_VARIANCE",
        "Normalized image is almost entirely one color; review it before inserting it into a draft.",
      ),
    );
  }

  if (sizeBytes < 100) {
    warnings.push(
      warning(
        "UNUSUALLY_SMALL_FILE",
        "Normalized PNG file size is unusually small; review it before inserting it into a draft.",
      ),
    );
  }

  return warnings;
}

function assertSafeSvg(svg: string): void {
  const bytes = Buffer.byteLength(svg, "utf8");
  if (bytes === 0) {
    throw unsafeSvg("SVG source must not be empty.");
  }
  if (bytes > MAX_SVG_BYTES) {
    throw new ImagePreparationError(
      issue(
        "IMAGE_TOO_LARGE",
        `SVG source is ${bytes} byte(s), which exceeds the 1000000-byte SVG limit.`,
        "sanitization",
      ),
    );
  }
  if (/<!\s*(?:doctype|entity)\b/iu.test(svg)) {
    throw unsafeSvg(
      "SVG document types and entity declarations are not allowed.",
    );
  }
  const withoutDeclaration = svg.replace(/^\s*<\?xml\s[^?]*\?>/iu, "");
  if (/<\?/u.test(withoutDeclaration)) {
    throw unsafeSvg("SVG processing instructions are not allowed.");
  }

  let document: Document;
  try {
    document = new DOMParser({
      onError: () => {
        throw new Error("Invalid SVG XML.");
      },
    }).parseFromString(svg, "image/svg+xml");
  } catch {
    throw unsafeSvg("SVG source must be well-formed XML.");
  }

  const rootElement = document.documentElement;
  if (
    !rootElement ||
    (rootElement.localName ?? rootElement.nodeName).toLowerCase() !== "svg"
  ) {
    throw unsafeSvg("SVG source must have an svg root element.");
  }

  const elements = Array.from(document.getElementsByTagName("*"));
  for (const element of elements) {
    const elementName = (element.localName ?? element.nodeName).toLowerCase();
    if (FORBIDDEN_SVG_ELEMENTS.has(elementName)) {
      throw unsafeSvg(`SVG element <${elementName}> is not allowed.`);
    }
    if (elementName === "style") {
      assertSafeCss(element.textContent ?? "");
    }

    for (const attribute of Array.from(element.attributes)) {
      const attributeName = attribute.name.toLowerCase();
      const value = attribute.value.trim();
      if (attributeName.startsWith("on")) {
        throw unsafeSvg(`SVG event attribute ${attributeName} is not allowed.`);
      }
      if (EXTERNAL_REFERENCE_ATTRIBUTES.has(attributeName)) {
        if (attributeName === "xml:base" || !value.startsWith("#")) {
          throw unsafeSvg(
            `SVG external reference attribute ${attributeName} is not allowed.`,
          );
        }
      }
      assertSafeCss(value);
    }
  }
}

function assertSafeCss(value: string): void {
  if (/@import|@font-face|expression\s*\(|javascript\s*:/iu.test(value)) {
    throw unsafeSvg(
      "SVG external styles, fonts, and executable CSS are not allowed.",
    );
  }

  for (const match of value.matchAll(/url\s*\(\s*(['"]?)(.*?)\1\s*\)/giu)) {
    const reference = match[2]?.trim();
    if (!reference?.startsWith("#")) {
      throw unsafeSvg("SVG CSS may only reference local fragment identifiers.");
    }
  }
}

function unsafeSvg(message: string): ImagePreparationError {
  return new ImagePreparationError(
    issue("SVG_SANITIZATION_FAILED", message, "sanitization"),
  );
}

function requireCard(card: ImageCardInput): ImageCardInput {
  if (
    !Number.isInteger(card.width) ||
    !Number.isInteger(card.height) ||
    card.width <= 0 ||
    card.height <= 0 ||
    card.width > MAX_SOURCE_DIMENSION ||
    card.height > MAX_SOURCE_DIMENSION ||
    card.width * card.height > MAX_SOURCE_PIXELS
  ) {
    throw new ImagePreparationError(
      issue(
        "INVALID_DIMENSIONS",
        "Card dimensions must be positive integers within 6000px and 25 million pixels.",
        "source",
      ),
    );
  }
  if (!card.title.trim()) {
    throw new ImagePreparationError(
      issue("MISSING_SOURCE", "card.title must not be blank.", "source"),
    );
  }
  assertCardColour(card.background ?? "#ffffff", "card.background");
  assertCardColour(card.foreground ?? "#111111", "card.foreground");
  return card;
}

function renderCardSvg(card: ImageCardInput): string {
  const background = card.background ?? "#ffffff";
  const foreground = card.foreground ?? "#111111";
  const titleSize = Math.max(36, Math.min(78, Math.round(card.height * 0.115)));
  const subtitleSize = Math.max(
    24,
    Math.min(44, Math.round(card.height * 0.065)),
  );
  const footerSize = Math.max(
    16,
    Math.min(28, Math.round(card.height * 0.038)),
  );
  const titleLines = wrapCardText(
    card.title,
    Math.max(18, Math.floor(card.width / (titleSize * 0.58))),
  );
  const subtitleLines = card.subtitle
    ? wrapCardText(
        card.subtitle,
        Math.max(24, Math.floor(card.width / (subtitleSize * 0.56))),
      )
    : [];
  const titleStart = card.height * (subtitleLines.length > 0 ? 0.36 : 0.43);
  const titleMarkup = textLinesMarkup(
    titleLines,
    card.width / 2,
    titleStart,
    titleSize,
    titleSize * 1.18,
    700,
    foreground,
  );
  const subtitleMarkup = textLinesMarkup(
    subtitleLines,
    card.width / 2,
    titleStart + titleLines.length * titleSize * 1.3 + subtitleSize * 0.25,
    subtitleSize,
    subtitleSize * 1.3,
    400,
    foreground,
  );
  const footerMarkup = card.footer
    ? `<text x="${card.width / 2}" y="${card.height - footerSize * 1.9}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${footerSize}" font-weight="400" fill="${foreground}" opacity="0.72">${escapeXml(card.footer)}</text>`
    : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${card.width}" height="${card.height}" viewBox="0 0 ${card.width} ${card.height}"><rect width="${card.width}" height="${card.height}" fill="${background}"/><rect x="${card.width * 0.08}" y="${card.height * 0.12}" width="${card.width * 0.1}" height="${Math.max(6, card.height * 0.012)}" fill="${foreground}"/>${titleMarkup}${subtitleMarkup}${footerMarkup}</svg>`;
}

function wrapCardText(value: string, maxCharacters: number): readonly string[] {
  const words = value.trim().split(/\s+/u);
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxCharacters || current.length === 0) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = word;
  }
  lines.push(current);
  return lines.slice(0, 4);
}

function textLinesMarkup(
  lines: readonly string[],
  x: number,
  startY: number,
  fontSize: number,
  lineHeight: number,
  fontWeight: number,
  fill: string,
): string {
  return lines
    .map(
      (line, index) =>
        `<text x="${x}" y="${startY + index * lineHeight}" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="${fontWeight}" fill="${fill}">${escapeXml(line)}</text>`,
    )
    .join("");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function assertCardColour(value: string, field: string): void {
  if (!/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/iu.test(value)) {
    throw new ImagePreparationError(
      issue(
        "MISSING_SOURCE",
        `${field} must be a 3- or 6-digit hexadecimal color.`,
        "source",
      ),
    );
  }
}

function parseDataUri(
  value: string,
): { readonly mimeType: string; readonly base64: string } | undefined {
  const match = /^data:([^;,]+);base64,(.+)$/isu.exec(value.trim());
  if (!match?.[1] || !match[2]) {
    return undefined;
  }
  return {
    mimeType: normalizeMimeType(match[1]) ?? match[1],
    base64: match[2],
  };
}

function normalizeBase64(value: string): string | undefined {
  const compact = value.replace(/\s+/gu, "");
  if (
    !compact ||
    compact.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(compact)
  ) {
    return undefined;
  }
  const normalized = compact.padEnd(
    compact.length + ((4 - (compact.length % 4)) % 4),
    "=",
  );
  const bytes = Buffer.from(normalized, "base64");
  return bytes.byteLength > 0 && bytes.toString("base64") === normalized
    ? normalized
    : undefined;
}

function assertFilenameHint(value: string | undefined): void {
  if (value === undefined) {
    return;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ImagePreparationError(
      issue(
        "MISSING_SOURCE",
        "filename_hint must not be blank when provided.",
        "source",
      ),
    );
  }
  if (
    trimmed.includes("\0") ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    /^[A-Za-z]:/u.test(trimmed)
  ) {
    throw new ImagePreparationError(
      issue(
        "MISSING_SOURCE",
        "filename_hint must be a simple filename, not a path.",
        "source",
      ),
    );
  }
  if (trimmed.length > 255) {
    throw new ImagePreparationError(
      issue(
        "MISSING_SOURCE",
        "filename_hint must be 255 characters or fewer.",
        "source",
      ),
    );
  }
  if (!/^[A-Za-z0-9._ -]+$/u.test(trimmed)) {
    throw new ImagePreparationError(
      issue(
        "MISSING_SOURCE",
        "filename_hint must contain only letters, numbers, spaces, dots, dashes, and underscores.",
        "source",
      ),
    );
  }
}

function inferMimeType(filenameHint: string | undefined): string | undefined {
  const extension = filenameHint?.trim().toLowerCase().split(".").pop();
  return extension ? EXTENSION_TO_MIME_TYPE[extension] : undefined;
}

function filenameFromUrl(value: string): string | undefined {
  try {
    const candidate = decodeURIComponent(basename(new URL(value).pathname));
    return safeSourceFilename(candidate);
  } catch {
    return undefined;
  }
}

function safeSourceFilename(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const sanitized = Array.from(value)
    .filter((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint > 31 && codePoint !== 127;
    })
    .join("");
  const candidate = basename(sanitized).trim();
  return candidate && candidate !== "." && candidate !== ".."
    ? candidate.slice(0, 255)
    : undefined;
}

function outputFilenameHint(
  explicit: string | undefined,
  sourceFilename: string | undefined,
): string | undefined {
  if (explicit !== undefined) {
    return explicit;
  }
  const candidate = safeSourceFilename(sourceFilename);
  return candidate && /^[A-Za-z0-9._ -]+$/u.test(candidate)
    ? candidate
    : undefined;
}

function normalizedExpectedSha256(
  value: string | undefined,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(normalized)) {
    throw sourceArtifactUnavailable(
      "image_file.expected_sha256 must contain exactly 64 hexadecimal characters.",
    );
  }
  return normalized;
}

function normalizedPngFilename(
  filenameHint: string | undefined,
  sha256: string,
): string {
  assertFilenameHint(filenameHint);
  const trimmed = filenameHint?.trim();
  if (!trimmed) {
    return `substack-image-${sha256.slice(0, 12)}.png`;
  }
  const withoutExtension = trimmed.replace(/\.[^.]*$/u, "").trim();
  return `${withoutExtension || "substack-image"}.png`;
}

function assertResizeBounds(maxWidth: number, maxHeight: number): void {
  if (
    !Number.isInteger(maxWidth) ||
    !Number.isInteger(maxHeight) ||
    maxWidth <= 0 ||
    maxHeight <= 0 ||
    maxWidth > MAX_SOURCE_DIMENSION ||
    maxHeight > MAX_SOURCE_DIMENSION
  ) {
    throw new ImagePreparationError(
      issue(
        "INVALID_DIMENSIONS",
        "max_width and max_height must be positive integers no greater than 6000.",
        "source",
      ),
    );
  }
}

function assertSourceDimensions(
  width: number | undefined,
  height: number | undefined,
): void {
  if (!width || !height || width <= 0 || height <= 0) {
    throw new ImagePreparationError(
      issue(
        "INVALID_DIMENSIONS",
        "Decoded image dimensions must be positive.",
        "validation",
      ),
    );
  }
  if (
    width > MAX_SOURCE_DIMENSION ||
    height > MAX_SOURCE_DIMENSION ||
    width * height > MAX_SOURCE_PIXELS
  ) {
    throw new ImagePreparationError(
      issue(
        "INVALID_DIMENSIONS",
        "Decoded image exceeds the 6000px dimension or 25-million-pixel limit.",
        "validation",
      ),
    );
  }
}

function assertImageByteLimit(bytes: number, maxBytes: number): void {
  if (bytes > maxBytes) {
    throw new ImagePreparationError(
      issue(
        "IMAGE_TOO_LARGE",
        `Image is ${bytes} byte(s), which exceeds MAX_IMAGE_BYTES=${maxBytes}.`,
        "validation",
      ),
    );
  }
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

function isAllowedSourceMimeType(value: string | undefined): value is string {
  return value === SVG_MIME_TYPE || isAllowedRasterMimeType(value);
}

function isAllowedRasterMimeType(value: string | undefined): value is string {
  return value !== undefined && ALLOWED_RASTER_MIME_TYPES.has(value);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function issue(
  code: ImageProcessingErrorCode,
  message: string,
  stage: ImageProcessingStage,
): ImageProcessingIssue {
  return { code, message, stage };
}

function warning(
  code: ImageProcessingWarningCode,
  message: string,
): ImageProcessingWarning {
  return { code, message };
}

function sourceArtifactUnavailable(
  message: string,
  stage: ImageProcessingStage = "source",
): ImagePreparationError {
  return new ImagePreparationError(
    issue("SOURCE_ARTIFACT_UNAVAILABLE", message, stage),
  );
}
