import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  applyNativeDraftImagePatch,
  inspectNativeDraftBody,
  NativeDraftImagePatchSchema,
} from "../../src/tools/nativeDraftImagePatch.js";

const MAX_BODY_BYTES = 100_000;
const ORIGINAL_IMAGE_URL = "https://cdn.example.com/original.jpg";
const SECOND_IMAGE_URL = "https://cdn.example.com/second.PNG?revision=2";
const REPLACEMENT_IMAGE_URL =
  "https://cdn.example.com/replacements/final-image.webp";

describe("nativeDraftImagePatch", () => {
  it("inspects a native body with stable hash, image manifest, stats, and preview text", () => {
    const body = nativeBody();
    const serialized = JSON.stringify(body);

    const result = inspectNativeDraftBody(body, MAX_BODY_BYTES);

    expect(result).toEqual({
      ok: true,
      serialized_body: serialized,
      body_hash: sha256(serialized),
      images: [
        {
          native_index: 1,
          url: ORIGINAL_IMAGE_URL,
          width: 640,
          height: 360,
          format: "jpeg",
          alt_text: "Existing alt text",
          caption: "Existing caption",
          title: "Existing title",
        },
        {
          native_index: 2,
          url: SECOND_IMAGE_URL,
          width: 320,
          height: 200,
          format: "png",
        },
      ],
      stats: {
        blocks: 6,
        words: 13,
        images: 2,
        code_blocks: 1,
        latex_blocks: 1,
      },
      preview_text:
        "Before image Existing caption Unknown survives const value = 1 x + y",
    });
  });

  it("replaces exactly one URL while preserving unknown content and omitted metadata", () => {
    const body = nativeBody();
    const originalSerialized = JSON.stringify(body);
    const expectedBody = nativeBody({ firstImageUrl: REPLACEMENT_IMAGE_URL });
    const expectedSerialized = JSON.stringify(expectedBody);

    const result = applyNativeDraftImagePatch(
      body,
      {
        match_image_url: ORIGINAL_IMAGE_URL,
        replacement_image_url: REPLACEMENT_IMAGE_URL,
      },
      MAX_BODY_BYTES,
    );

    expect(result).toEqual({
      ok: true,
      serialized_body: expectedSerialized,
      images: [
        {
          native_index: 1,
          url: REPLACEMENT_IMAGE_URL,
          width: 640,
          height: 360,
          format: "webp",
          alt_text: "Existing alt text",
          caption: "Existing caption",
          title: "Existing title",
        },
        {
          native_index: 2,
          url: SECOND_IMAGE_URL,
          width: 320,
          height: 200,
          format: "png",
        },
      ],
      stats: {
        blocks: 6,
        words: 13,
        images: 2,
        code_blocks: 1,
        latex_blocks: 1,
      },
      preview_text:
        "Before image Existing caption Unknown survives const value = 1 x + y",
      summary: {
        image_index: 1,
        previous_image_url: ORIGINAL_IMAGE_URL,
        replacement_image_url: REPLACEMENT_IMAGE_URL,
        original_body_sha256: sha256(originalSerialized),
        patched_body_sha256: sha256(expectedSerialized),
        preserved_non_target_content: true,
      },
      warnings: [
        "Targeted native image patch preserves every non-target draft_body JSON field.",
      ],
    });
    expect(body).toEqual(nativeBody());
  });

  it("replaces caption and image attributes explicitly by native index", () => {
    const result = applyNativeDraftImagePatch(
      nativeBody(),
      {
        image_index: 1,
        replacement_image_url: REPLACEMENT_IMAGE_URL,
        alt_text: "Replacement alt",
        caption: "Replacement caption",
        title: "Replacement title",
        width: 1280,
        height: 720,
      },
      MAX_BODY_BYTES,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(JSON.parse(result.serialized_body)).toEqual(
      nativeBody({
        firstImageUrl: REPLACEMENT_IMAGE_URL,
        alt: "Replacement alt",
        caption: "Replacement caption",
        title: "Replacement title",
        width: 1280,
        height: 720,
      }),
    );
    expect(result.images[0]).toEqual({
      native_index: 1,
      url: REPLACEMENT_IMAGE_URL,
      width: 1280,
      height: 720,
      format: "webp",
      alt_text: "Replacement alt",
      caption: "Replacement caption",
      title: "Replacement title",
    });
    expect(result.warnings).toEqual([
      "Targeted native image patch preserves every non-target draft_body JSON field.",
      "Native caption patching remains provisional until a captured Substack image fixture is verified in the editor.",
    ]);
  });

  it("removes caption and nullable image attributes without removing unknown attrs", () => {
    const result = applyNativeDraftImagePatch(
      nativeBody(),
      {
        image_index: 1,
        replacement_image_url: REPLACEMENT_IMAGE_URL,
        alt_text: null,
        caption: null,
        title: null,
        width: null,
        height: null,
      },
      MAX_BODY_BYTES,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(JSON.parse(result.serialized_body)).toEqual(
      nativeBody({
        firstImageUrl: REPLACEMENT_IMAGE_URL,
        alt: null,
        caption: null,
        title: null,
        width: null,
        height: null,
      }),
    );
    expect(result.images[0]).toEqual({
      native_index: 1,
      url: REPLACEMENT_IMAGE_URL,
      format: "webp",
    });
  });

  it("fails caption mutation when the selected image has no captionedImage container", () => {
    const result = applyNativeDraftImagePatch(
      nativeBody(),
      {
        image_index: 2,
        replacement_image_url: REPLACEMENT_IMAGE_URL,
        caption: "No paragraph fallback",
      },
      MAX_BODY_BYTES,
    );

    expect(result).toEqual({
      ok: false,
      errors: [
        "The selected image does not have a native captionedImage container; no paragraph fallback was applied.",
      ],
    });
  });

  it("requires exactly one selector and validates patch fields strictly", () => {
    const missingSelector = applyNativeDraftImagePatch(
      nativeBody(),
      { replacement_image_url: REPLACEMENT_IMAGE_URL },
      MAX_BODY_BYTES,
    );
    const bothSelectors = applyNativeDraftImagePatch(
      nativeBody(),
      {
        image_index: 1,
        match_image_url: ORIGINAL_IMAGE_URL,
        replacement_image_url: REPLACEMENT_IMAGE_URL,
      },
      MAX_BODY_BYTES,
    );

    expect(missingSelector).toEqual({
      ok: false,
      errors: [
        "Provide exactly one image selector: match_image_url or image_index.",
      ],
    });
    expect(bothSelectors).toEqual(missingSelector);

    for (const patch of [
      {
        image_index: 0,
        replacement_image_url: REPLACEMENT_IMAGE_URL,
      },
      {
        image_index: 1,
        replacement_image_url: "not a URL",
      },
      {
        image_index: 1,
        replacement_image_url: REPLACEMENT_IMAGE_URL,
        width: 0,
      },
      {
        image_index: 1,
        replacement_image_url: REPLACEMENT_IMAGE_URL,
        unknown_field: true,
      },
    ]) {
      expect(NativeDraftImagePatchSchema.safeParse(patch).success).toBe(false);
    }
  });

  it("reports missing, out-of-range, and ambiguous image selections", () => {
    expect(
      applyNativeDraftImagePatch(
        nativeBody(),
        {
          image_index: 3,
          replacement_image_url: REPLACEMENT_IMAGE_URL,
        },
        MAX_BODY_BYTES,
      ),
    ).toEqual({
      ok: false,
      errors: ["image_index 3 does not identify an existing native image."],
    });

    expect(
      applyNativeDraftImagePatch(
        nativeBody(),
        {
          match_image_url: "https://cdn.example.com/missing.png",
          replacement_image_url: REPLACEMENT_IMAGE_URL,
        },
        MAX_BODY_BYTES,
      ),
    ).toEqual({
      ok: false,
      errors: ["match_image_url did not identify an existing native image."],
    });

    expect(
      applyNativeDraftImagePatch(
        nativeBody({ secondImageUrl: ORIGINAL_IMAGE_URL }),
        {
          match_image_url: ORIGINAL_IMAGE_URL,
          replacement_image_url: REPLACEMENT_IMAGE_URL,
        },
        MAX_BODY_BYTES,
      ),
    ).toEqual({
      ok: false,
      errors: [
        "match_image_url is ambiguous because it identifies multiple native images; use image_index instead.",
      ],
    });
  });

  it("rejects missing, malformed, non-serializable, and non-native bodies", () => {
    const cases: ReadonlyArray<{
      readonly body: unknown;
      readonly error: string;
    }> = [
      {
        body: undefined,
        error: "The draft does not contain a native body.",
      },
      {
        body: "{",
        error: "Native draft body is not valid JSON.",
      },
      {
        body: () => undefined,
        error: "Native draft body could not be JSON serialized.",
      },
      {
        body: null,
        error:
          "Native draft body must be a ProseMirror-style doc with a content array.",
      },
      {
        body: { type: "doc" },
        error:
          "Native draft body must be a ProseMirror-style doc with a content array.",
      },
    ];

    for (const { body, error } of cases) {
      expect(inspectNativeDraftBody(body, MAX_BODY_BYTES)).toEqual({
        ok: false,
        errors: [error],
      });
    }
  });

  it("enforces UTF-8 input and patched-output byte limits", () => {
    const body = nativeBody({ paragraphText: "Before image 🖼️" });
    const serialized = JSON.stringify(body);
    const inputBytes = Buffer.byteLength(serialized, "utf8");

    expect(inspectNativeDraftBody(serialized, inputBytes - 1)).toEqual({
      ok: false,
      errors: [
        `Native draft body is ${inputBytes} bytes, which exceeds MAX_BODY_BYTES=${inputBytes - 1}.`,
      ],
    });

    const shortBody = {
      type: "doc",
      content: [
        {
          type: "image2",
          attrs: { src: "https://a.co/a" },
        },
      ],
    };
    const shortSerialized = JSON.stringify(shortBody);
    const maxBytes = Buffer.byteLength(shortSerialized, "utf8") + 1;
    const longReplacement = `https://cdn.example.com/${"x".repeat(100)}.png`;
    const patchedSerialized = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "image2",
          attrs: { src: longReplacement },
        },
      ],
    });

    expect(
      applyNativeDraftImagePatch(
        shortBody,
        {
          image_index: 1,
          replacement_image_url: longReplacement,
        },
        maxBytes,
      ),
    ).toEqual({
      ok: false,
      errors: [
        `Patched native draft body is ${Buffer.byteLength(patchedSerialized, "utf8")} bytes, which exceeds MAX_BODY_BYTES=${maxBytes}.`,
      ],
    });
  });

  it("rejects replacement URLs with unsafe protocols, credentials, or private hosts", () => {
    const cases = [
      {
        replacement_image_url: "ftp://cdn.example.com/replacement.png",
        error: "replacement_image_url must use http:// or https://.",
      },
      {
        replacement_image_url:
          "https://user:secret@cdn.example.com/replacement.png",
        error: "replacement_image_url must not include username or password.",
      },
      {
        replacement_image_url: "http://127.0.0.1/replacement.png",
        error:
          "replacement_image_url must not point to localhost or private network addresses.",
      },
    ];

    for (const { replacement_image_url, error } of cases) {
      expect(
        applyNativeDraftImagePatch(
          nativeBody(),
          { image_index: 1, replacement_image_url },
          MAX_BODY_BYTES,
        ),
      ).toEqual({ ok: false, errors: [error] });
    }
  });

  it("emits hash evidence that exposes a stale inspected body", () => {
    const inspectedBody = nativeBody();
    const inspection = inspectNativeDraftBody(inspectedBody, MAX_BODY_BYTES);
    expect(inspection.ok).toBe(true);
    if (!inspection.ok) {
      return;
    }

    const editedBody = nativeBody({ paragraphText: "Edited after inspection" });
    const editedSerialized = JSON.stringify(editedBody);
    const result = applyNativeDraftImagePatch(
      editedBody,
      {
        image_index: 1,
        replacement_image_url: REPLACEMENT_IMAGE_URL,
      },
      MAX_BODY_BYTES,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    expect(result.summary.original_body_sha256).toBe(sha256(editedSerialized));
    expect(result.summary.original_body_sha256).not.toBe(inspection.body_hash);
    expect(result.summary.patched_body_sha256).toBe(
      sha256(result.serialized_body),
    );
    expect(result.summary.patched_body_sha256).not.toBe(
      result.summary.original_body_sha256,
    );
  });

  it("rejects malformed patches, invalid native bodies, and no-op replacements", () => {
    expect(
      applyNativeDraftImagePatch(
        nativeBody(),
        { image_index: 0, replacement_image_url: REPLACEMENT_IMAGE_URL },
        MAX_BODY_BYTES,
      ).ok,
    ).toBe(false);
    expect(
      applyNativeDraftImagePatch(
        { type: "doc" },
        { image_index: 1, replacement_image_url: REPLACEMENT_IMAGE_URL },
        MAX_BODY_BYTES,
      ),
    ).toEqual({
      ok: false,
      errors: [
        "Native draft body must be a ProseMirror-style doc with a content array.",
      ],
    });
    expect(
      applyNativeDraftImagePatch(
        nativeBody(),
        {
          image_index: 1,
          replacement_image_url: ORIGINAL_IMAGE_URL,
        },
        MAX_BODY_BYTES,
      ),
    ).toEqual({
      ok: false,
      errors: ["The native image patch would not change the draft."],
    });
  });

  it("covers object byte limits, empty image metadata, and long previews", () => {
    expect(inspectNativeDraftBody(nativeBody(), 1).ok).toBe(false);

    const sparse = inspectNativeDraftBody(
      {
        type: "doc",
        content: [
          null,
          { type: "image2", attrs: { src: "" } },
          {
            type: "image2",
            attrs: { src: "https://cdn.example.com/download/raw" },
          },
        ],
      },
      MAX_BODY_BYTES,
    );
    expect(sparse.ok).toBe(true);
    if (!sparse.ok) {
      return;
    }
    expect(sparse.images).toEqual([
      { native_index: 1, url: "" },
      {
        native_index: 2,
        url: "https://cdn.example.com/download/raw",
      },
    ]);

    const longPreview = inspectNativeDraftBody(
      nativeBody({ paragraphText: "word ".repeat(150) }),
      MAX_BODY_BYTES,
    );
    expect(longPreview.ok).toBe(true);
    if (longPreview.ok) {
      expect(longPreview.preview_text).toHaveLength(500);
      expect(longPreview.preview_text.endsWith("...")).toBe(true);
    }
  });

  it("handles absent and empty native captions without a paragraph fallback", () => {
    const removeMissing = applyNativeDraftImagePatch(
      nativeBody({ caption: null }),
      {
        image_index: 1,
        replacement_image_url: REPLACEMENT_IMAGE_URL,
        caption: null,
      },
      MAX_BODY_BYTES,
    );
    expect(removeMissing.ok).toBe(true);

    const addEmpty = applyNativeDraftImagePatch(
      nativeBody({ caption: null }),
      {
        image_index: 1,
        replacement_image_url: REPLACEMENT_IMAGE_URL,
        caption: "",
      },
      MAX_BODY_BYTES,
    );
    expect(addEmpty.ok).toBe(true);
    if (addEmpty.ok) {
      expect(addEmpty.images[0]?.caption).toBe("");
    }

    const emptyCaption = inspectNativeDraftBody(
      nativeBody({ caption: "" }),
      MAX_BODY_BYTES,
    );
    expect(emptyCaption.ok).toBe(true);
    if (emptyCaption.ok) {
      expect(emptyCaption.images[0]?.caption).toBe("");
    }
  });

  it("rejects a selected image whose source URL is empty", () => {
    expect(
      applyNativeDraftImagePatch(
        {
          type: "doc",
          content: [{ type: "image2", attrs: { src: "" } }],
        },
        { image_index: 1, replacement_image_url: REPLACEMENT_IMAGE_URL },
        MAX_BODY_BYTES,
      ),
    ).toEqual({
      ok: false,
      errors: ["The selected native image does not contain an attrs.src URL."],
    });
  });
});

interface NativeBodyOptions {
  readonly firstImageUrl?: string;
  readonly secondImageUrl?: string;
  readonly paragraphText?: string;
  readonly alt?: string | null;
  readonly caption?: string | null;
  readonly title?: string | null;
  readonly width?: number | null;
  readonly height?: number | null;
}

function nativeBody(options: NativeBodyOptions = {}) {
  const alt = options.alt === undefined ? "Existing alt text" : options.alt;
  const caption =
    options.caption === undefined ? "Existing caption" : options.caption;
  const title = options.title === undefined ? "Existing title" : options.title;
  const width = options.width === undefined ? 640 : options.width;
  const height = options.height === undefined ? 360 : options.height;
  const imageAttrs: Record<string, unknown> = {
    src: options.firstImageUrl ?? ORIGINAL_IMAGE_URL,
    imageSize: "normal",
    unknown_image_attr: { crop: "preserve" },
  };
  if (alt !== null) {
    imageAttrs.alt = alt;
  }
  if (title !== null) {
    imageAttrs.title = title;
  }
  if (width !== null) {
    imageAttrs.width = width;
  }
  if (height !== null) {
    imageAttrs.height = height;
  }

  const captionedContent: unknown[] = [{ type: "image2", attrs: imageAttrs }];
  if (caption !== null) {
    captionedContent.push(
      options.caption === undefined
        ? {
            type: "caption",
            attrs: { unknown_caption_attr: true },
            content: [
              {
                type: "text",
                text: caption,
                marks: [{ type: "italic", attrs: { preserved: true } }],
              },
            ],
          }
        : {
            type: "caption",
            content:
              caption.length > 0 ? [{ type: "text", text: caption }] : [],
          },
    );
  }
  captionedContent.push({
    type: "unknownInlineAfterImage",
    attrs: { preserve: "yes" },
  });

  return {
    type: "doc",
    attrs: { schemaVersion: 9, unknown_root_attr: "preserve" },
    content: [
      {
        type: "paragraph",
        attrs: { textAlign: "left", unknown_paragraph_attr: 17 },
        content: [
          {
            type: "text",
            text: options.paragraphText ?? "Before image",
            marks: [{ type: "bold", attrs: { unknown_mark_attr: "keep" } }],
          },
        ],
      },
      {
        type: "captionedImage",
        attrs: { unknown_container_attr: ["keep", 1] },
        content: captionedContent,
      },
      {
        type: "unknownBlock",
        attrs: { nested: { preserved: true } },
        content: [{ type: "text", text: "Unknown survives" }],
      },
      {
        type: "highlighted_code_block",
        attrs: { language: "ts", unknown_code_attr: false },
        content: [{ type: "text", text: "const value = 1" }],
      },
      {
        type: "latex_block",
        attrs: { unknown_latex_attr: "keep" },
        content: [{ type: "text", text: "x + y" }],
      },
      {
        type: "image2",
        attrs: {
          src: options.secondImageUrl ?? SECOND_IMAGE_URL,
          width: 320,
          height: 200,
          unknown_second_image_attr: "untouched",
        },
      },
    ],
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
