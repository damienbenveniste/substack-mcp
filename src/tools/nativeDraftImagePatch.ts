import { createHash } from "node:crypto";

import { z } from "zod";

import { checkUtf8ByteLimit } from "../safety/limits.js";
import { parseHttpUrl } from "../safety/urlPolicy.js";
import type { DraftPayloadStats, DraftPreviewImage } from "./draftPayload.js";

export const NativeDraftImagePatchSchema = z
  .object({
    match_image_url: z
      .string()
      .url()
      .optional()
      .describe("Exact current image URL to replace."),
    image_index: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "One-based native image index from get_draft or preview_draft.",
      ),
    replacement_image_url: z
      .string()
      .url()
      .describe("Exact image_url returned by upload_image."),
    alt_text: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Accessibility text. Omit to preserve it, provide null to remove it, or provide a string to replace it.",
      ),
    caption: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Visible native caption. Omit to preserve it, provide null to remove it, or provide a string to replace it.",
      ),
    title: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Image title metadata. Omit to preserve it, provide null to remove it, or provide a string to replace it.",
      ),
    width: z.number().int().positive().nullable().optional(),
    height: z.number().int().positive().nullable().optional(),
  })
  .strict();

export type NativeDraftImagePatch = z.infer<typeof NativeDraftImagePatchSchema>;

export interface NativeDraftImage extends DraftPreviewImage {
  readonly native_index: number;
}

export interface NativeDraftInspection {
  readonly ok: true;
  readonly serialized_body: string;
  readonly body_hash: string;
  readonly images: readonly NativeDraftImage[];
  readonly stats: DraftPayloadStats;
  readonly preview_text: string;
}

export interface NativeDraftImagePatchSummary {
  readonly image_index: number;
  readonly previous_image_url: string;
  readonly replacement_image_url: string;
  readonly original_body_sha256: string;
  readonly patched_body_sha256: string;
  readonly preserved_non_target_content: true;
}

export type NativeDraftImagePatchResult =
  | {
      readonly ok: true;
      readonly serialized_body: string;
      readonly images: readonly NativeDraftImage[];
      readonly stats: DraftPayloadStats;
      readonly preview_text: string;
      readonly summary: NativeDraftImagePatchSummary;
      readonly warnings: readonly string[];
    }
  | {
      readonly ok: false;
      readonly errors: readonly string[];
    };

type MutableRecord = Record<string, unknown>;

interface LocatedImage {
  readonly nativeIndex: number;
  readonly node: MutableRecord;
  readonly captionedImage?: MutableRecord | undefined;
}

export function inspectNativeDraftBody(
  body: unknown,
  maxBodyBytes: number,
):
  | NativeDraftInspection
  | { readonly ok: false; readonly errors: readonly string[] } {
  const parsed = parseNativeDraftBody(body, maxBodyBytes);
  if (!parsed.ok) {
    return parsed;
  }

  const images = collectNativeImages(parsed.doc);
  return {
    ok: true,
    serialized_body: parsed.serialized,
    body_hash: sha256(parsed.serialized),
    images,
    stats: computeNativeStats(parsed.doc, images.length),
    preview_text: nativePreviewText(parsed.doc),
  };
}

export function applyNativeDraftImagePatch(
  body: unknown,
  patch: NativeDraftImagePatch,
  maxBodyBytes: number,
): NativeDraftImagePatchResult {
  const parsedPatch = NativeDraftImagePatchSchema.safeParse(patch);
  if (!parsedPatch.success) {
    return {
      ok: false,
      errors: parsedPatch.error.issues.map((issue) => issue.message),
    };
  }
  const selectorCount = [
    parsedPatch.data.match_image_url,
    parsedPatch.data.image_index,
  ].filter((selector) => selector !== undefined).length;
  if (selectorCount !== 1) {
    return {
      ok: false,
      errors: [
        "Provide exactly one image selector: match_image_url or image_index.",
      ],
    };
  }

  const replacementUrl = parseHttpUrl(
    parsedPatch.data.replacement_image_url,
    "replacement_image_url",
  );
  if (!replacementUrl.ok) {
    return { ok: false, errors: replacementUrl.errors };
  }

  const parsed = parseNativeDraftBody(body, maxBodyBytes);
  if (!parsed.ok) {
    return parsed;
  }

  const originalBodySha256 = sha256(parsed.serialized);
  const located = locateNativeImages(parsed.doc);
  const selected = selectImage(located, parsedPatch.data);
  if (!selected.ok) {
    return selected;
  }

  const currentAttrs = asMutableRecord(selected.image.node.attrs);
  const previousImageUrl = readString(currentAttrs, "src");
  if (!previousImageUrl) {
    return {
      ok: false,
      errors: ["The selected native image does not contain an attrs.src URL."],
    };
  }

  selected.image.node.attrs = applyImageAttributes(currentAttrs, {
    ...parsedPatch.data,
    replacement_image_url: replacementUrl.url.toString(),
  });

  const captionError = applyCaption(selected.image, parsedPatch.data.caption);
  if (captionError) {
    return { ok: false, errors: [captionError] };
  }

  const serialized = JSON.stringify(parsed.doc);
  if (serialized === parsed.serialized) {
    return {
      ok: false,
      errors: ["The native image patch would not change the draft."],
    };
  }
  const outputLimit = checkUtf8ByteLimit(serialized, maxBodyBytes);
  if (!outputLimit.ok) {
    return {
      ok: false,
      errors: [
        `Patched native draft body is ${outputLimit.bytes} bytes, which exceeds MAX_BODY_BYTES=${outputLimit.maxBytes}.`,
      ],
    };
  }

  const images = collectNativeImages(parsed.doc);
  const warnings = [
    "Targeted native image patch preserves every non-target draft_body JSON field.",
  ];
  if (parsedPatch.data.caption !== undefined) {
    warnings.push(
      "Native caption patching remains provisional until a captured Substack image fixture is verified in the editor.",
    );
  }

  return {
    ok: true,
    serialized_body: serialized,
    images,
    stats: computeNativeStats(parsed.doc, images.length),
    preview_text: nativePreviewText(parsed.doc),
    summary: {
      image_index: selected.image.nativeIndex,
      previous_image_url: previousImageUrl,
      replacement_image_url: replacementUrl.url.toString(),
      original_body_sha256: originalBodySha256,
      patched_body_sha256: sha256(serialized),
      preserved_non_target_content: true,
    },
    warnings,
  };
}

function parseNativeDraftBody(
  body: unknown,
  maxBodyBytes: number,
):
  | {
      readonly ok: true;
      readonly doc: MutableRecord;
      readonly serialized: string;
    }
  | { readonly ok: false; readonly errors: readonly string[] } {
  if (body === undefined) {
    return { ok: false, errors: ["The draft does not contain a native body."] };
  }

  let parsed: unknown;
  let serialized: string;
  try {
    if (typeof body === "string") {
      const inputLimit = checkUtf8ByteLimit(body, maxBodyBytes);
      if (!inputLimit.ok) {
        return {
          ok: false,
          errors: [
            `Native draft body is ${inputLimit.bytes} bytes, which exceeds MAX_BODY_BYTES=${inputLimit.maxBytes}.`,
          ],
        };
      }
      parsed = JSON.parse(body);
    } else {
      const json = JSON.stringify(body);
      if (json === undefined) {
        return {
          ok: false,
          errors: ["Native draft body could not be JSON serialized."],
        };
      }
      const inputLimit = checkUtf8ByteLimit(json, maxBodyBytes);
      if (!inputLimit.ok) {
        return {
          ok: false,
          errors: [
            `Native draft body is ${inputLimit.bytes} bytes, which exceeds MAX_BODY_BYTES=${inputLimit.maxBytes}.`,
          ],
        };
      }
      parsed = JSON.parse(json);
    }
    serialized = JSON.stringify(parsed);
  } catch {
    return {
      ok: false,
      errors: ["Native draft body is not valid JSON."],
    };
  }

  const doc = asMutableRecord(parsed);
  if (doc.type !== "doc" || !Array.isArray(doc.content)) {
    return {
      ok: false,
      errors: [
        "Native draft body must be a ProseMirror-style doc with a content array.",
      ],
    };
  }

  return { ok: true, doc, serialized };
}

function locateNativeImages(doc: MutableRecord): readonly LocatedImage[] {
  const located: LocatedImage[] = [];

  const visit = (
    value: unknown,
    captionedImage: MutableRecord | undefined,
  ): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        visit(item, captionedImage);
      }
      return;
    }

    const record = asMutableRecord(value);
    if (Object.keys(record).length === 0) {
      return;
    }

    const container =
      record.type === "captionedImage" ? record : captionedImage;
    if (
      record.type === "image2" &&
      typeof asMutableRecord(record.attrs).src === "string"
    ) {
      located.push({
        nativeIndex: located.length + 1,
        node: record,
        captionedImage: container,
      });
    }

    if (Array.isArray(record.content)) {
      visit(record.content, container);
    }
  };

  visit(doc, undefined);
  return located;
}

function selectImage(
  images: readonly LocatedImage[],
  patch: NativeDraftImagePatch,
):
  | { readonly ok: true; readonly image: LocatedImage }
  | { readonly ok: false; readonly errors: readonly string[] } {
  if (patch.image_index !== undefined) {
    const selected = images[patch.image_index - 1];
    return selected
      ? { ok: true, image: selected }
      : {
          ok: false,
          errors: [
            `image_index ${patch.image_index} does not identify an existing native image.`,
          ],
        };
  }

  const matches = images.filter(
    (image) =>
      readString(asMutableRecord(image.node.attrs), "src") ===
      patch.match_image_url,
  );
  if (matches.length !== 1) {
    return {
      ok: false,
      errors: [
        matches.length === 0
          ? "match_image_url did not identify an existing native image."
          : "match_image_url is ambiguous because it identifies multiple native images; use image_index instead.",
      ],
    };
  }

  const image = matches[0];
  return image
    ? { ok: true, image }
    : { ok: false, errors: ["The selected native image is unavailable."] };
}

function applyImageAttributes(
  attrs: MutableRecord,
  patch: NativeDraftImagePatch,
): MutableRecord {
  const next = { ...attrs, src: patch.replacement_image_url };
  applyNullableAttribute(next, "alt", patch.alt_text);
  applyNullableAttribute(next, "title", patch.title);
  applyNullableAttribute(next, "width", patch.width);
  applyNullableAttribute(next, "height", patch.height);
  return next;
}

function applyNullableAttribute(
  attrs: MutableRecord,
  key: string,
  value: string | number | null | undefined,
): void {
  if (value === undefined) {
    return;
  }
  if (value === null) {
    delete attrs[key];
    return;
  }
  attrs[key] = value;
}

function applyCaption(
  image: LocatedImage,
  caption: string | null | undefined,
): string | undefined {
  if (caption === undefined) {
    return undefined;
  }
  if (!image.captionedImage || !Array.isArray(image.captionedImage.content)) {
    return "The selected image does not have a native captionedImage container; no paragraph fallback was applied.";
  }

  const content = image.captionedImage.content as unknown[];
  const captionIndex = content.findIndex(
    (item) => asMutableRecord(item).type === "caption",
  );
  if (caption === null) {
    if (captionIndex >= 0) {
      content.splice(captionIndex, 1);
    }
    return undefined;
  }

  const captionNode: MutableRecord = {
    type: "caption",
    content: caption.length > 0 ? [{ type: "text", text: caption }] : [],
  };
  if (captionIndex >= 0) {
    content[captionIndex] = captionNode;
  } else {
    const imageIndex = content.indexOf(image.node);
    content.splice(
      imageIndex >= 0 ? imageIndex + 1 : content.length,
      0,
      captionNode,
    );
  }
  return undefined;
}

function collectNativeImages(doc: MutableRecord): readonly NativeDraftImage[] {
  return locateNativeImages(doc).map((image) => {
    const attrs = asMutableRecord(image.node.attrs);
    const caption = readNativeCaption(image.captionedImage);
    return {
      native_index: image.nativeIndex,
      url: readString(attrs, "src") ?? "",
      ...(readPositiveInteger(attrs, "width") !== undefined
        ? { width: readPositiveInteger(attrs, "width") }
        : {}),
      ...(readPositiveInteger(attrs, "height") !== undefined
        ? { height: readPositiveInteger(attrs, "height") }
        : {}),
      ...(inferImageFormat(readString(attrs, "src")) !== undefined
        ? { format: inferImageFormat(readString(attrs, "src")) }
        : {}),
      ...(readString(attrs, "alt") !== undefined
        ? { alt_text: readString(attrs, "alt") }
        : {}),
      ...(caption !== undefined ? { caption } : {}),
      ...(readString(attrs, "title") !== undefined
        ? { title: readString(attrs, "title") }
        : {}),
    };
  });
}

function readNativeCaption(
  captionedImage: MutableRecord | undefined,
): string | undefined {
  if (!captionedImage || !Array.isArray(captionedImage.content)) {
    return undefined;
  }
  const caption = captionedImage.content.find(
    (item) => asMutableRecord(item).type === "caption",
  );
  if (!caption) {
    return undefined;
  }
  return collectText(caption).trim() || "";
}

function computeNativeStats(
  doc: MutableRecord,
  imageCount: number,
): DraftPayloadStats {
  let codeBlocks = 0;
  let latexBlocks = 0;
  visitRecords(doc, (record) => {
    if (record.type === "highlighted_code_block") {
      codeBlocks += 1;
    }
    if (record.type === "latex_block") {
      latexBlocks += 1;
    }
  });
  const text = collectText(doc).trim();
  return {
    blocks: Array.isArray(doc.content) ? doc.content.length : 0,
    words: text.length > 0 ? text.split(/\s+/u).length : 0,
    images: imageCount,
    code_blocks: codeBlocks,
    latex_blocks: latexBlocks,
  };
}

function nativePreviewText(doc: MutableRecord): string {
  const text = collectText(doc).trim().replace(/\s+/gu, " ");
  return text.length > 500 ? `${text.slice(0, 497)}...` : text;
}

function collectText(value: unknown): string {
  const parts: string[] = [];
  visitRecords(value, (record) => {
    if (typeof record.text === "string") {
      parts.push(record.text);
    }
  });
  return parts.join(" ");
}

function visitRecords(
  value: unknown,
  visitor: (record: MutableRecord) => void,
): void {
  if (Array.isArray(value)) {
    for (const item of value) {
      visitRecords(item, visitor);
    }
    return;
  }
  const record = asMutableRecord(value);
  if (Object.keys(record).length === 0) {
    return;
  }
  visitor(record);
  for (const child of Object.values(record)) {
    if (typeof child === "object" && child !== null) {
      visitRecords(child, visitor);
    }
  }
}

function inferImageFormat(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  try {
    const extension = new URL(url).pathname.match(/\.([a-z0-9]+)$/iu)?.[1];
    if (!extension) {
      return undefined;
    }
    const normalized = extension.toLowerCase();
    return normalized === "jpg" ? "jpeg" : normalized;
  } catch {
    return undefined;
  }
}

function asMutableRecord(value: unknown): MutableRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as MutableRecord)
    : {};
}

function readString(record: MutableRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readPositiveInteger(
  record: MutableRecord,
  key: string,
): number | undefined {
  const value = record[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
