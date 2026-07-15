import { describe, expect, it } from "vitest";

import {
  previewDraft,
  previewDraftImagePatch,
  summarizePreview,
} from "../../src/tools/previewDraft.js";

const config = {
  maxBodyBytes: 750_000,
  previewTokenSecret: "test-preview-secret-with-enough-entropy",
  confirmationTokenTtlSeconds: 900,
};

const now = new Date("2026-07-08T12:00:00.000Z");
const nativePatchConfig = {
  ...config,
  publicationUrl: undefined,
  sessionToken: undefined,
  substackRequestTimeoutMs: 30_000,
  userAgent: "test-agent",
  userId: 123,
};

describe("previewDraft", () => {
  it("previews one targeted native image replacement without reconstructing the body", async () => {
    const nativeBody = JSON.stringify({
      type: "doc",
      attrs: { unknownDocumentMetadata: "preserve-me" },
      content: [
        { type: "latex_block", attrs: { persistentExpression: "x^2" } },
        {
          type: "captionedImage",
          attrs: { alignment: "center" },
          content: [
            {
              type: "image2",
              attrs: {
                src: "https://cdn.example.com/old.png",
                alt: "Existing alt",
                title: "Existing title",
                customImageState: { keep: true },
              },
            },
            {
              type: "caption",
              content: [{ type: "text", text: "Existing caption" }],
            },
          ],
        },
      ],
    });

    const result = await previewDraftImagePatch(
      {
        action: "update",
        draft_id: 77,
        image_patch: {
          match_image_url: "https://cdn.example.com/old.png",
          replacement_image_url: "https://cdn.example.com/new.png",
        },
        include_payload_debug: true,
      },
      nativePatchConfig,
      {
        now,
        client: {
          getDraft: async (draftId) => ({
            id: draftId,
            title: "Native draft",
            draft_body: nativeBody,
            status: "draft",
            raw: {},
          }),
        },
      },
    );

    expect(result).toMatchObject({
      ok: true,
      action: "update",
      draft_id: 77,
      title: "Native draft",
      stats: { images: 1, latex_blocks: 1 },
      images: [
        {
          native_index: 1,
          url: "https://cdn.example.com/new.png",
          alt_text: "Existing alt",
          title: "Existing title",
          caption: "Existing caption",
        },
      ],
      image_patch: {
        image_index: 1,
        previous_image_url: "https://cdn.example.com/old.png",
        replacement_image_url: "https://cdn.example.com/new.png",
        preserved_non_target_content: true,
      },
      payload_debug: {
        draft_body_doc_type: "doc",
        top_level_nodes: 2,
      },
    });
    expect(result.confirmation_token).toContain(".");
    expect(result.warnings).toContain(
      "Targeted native image patch preserves every non-target draft_body JSON field.",
    );
  });

  it("validates targeted image preview requirements and conflicting fields", async () => {
    const missing = await previewDraftImagePatch(
      { action: "create" },
      nativePatchConfig,
    );
    expect(missing).toMatchObject({
      ok: false,
      draft_id: 0,
      errors: [
        "A targeted image patch requires action=update, draft_id, and image_patch.",
      ],
    });

    const conflicting = await previewDraftImagePatch(
      {
        action: "update",
        draft_id: 77,
        title: "Do not combine",
        image_patch: {
          image_index: 1,
          replacement_image_url: "https://cdn.example.com/new.png",
        },
      },
      nativePatchConfig,
    );
    expect(conflicting.errors).toContain(
      "title must not be provided with image_patch.",
    );
  });

  it("rejects non-drafts and native patch validation failures", async () => {
    const input = {
      action: "update" as const,
      draft_id: 77,
      image_patch: {
        image_index: 1,
        replacement_image_url: "https://cdn.example.com/new.png",
      },
    };
    const published = await previewDraftImagePatch(input, nativePatchConfig, {
      client: {
        getDraft: async (draftId) => ({
          id: draftId,
          is_published: true,
          raw: {},
        }),
      },
    });
    expect(published.errors).toContain(
      "Refusing to preview an image patch for a draft that Substack does not report as unpublished.",
    );

    const missingImage = await previewDraftImagePatch(
      input,
      nativePatchConfig,
      {
        client: {
          getDraft: async (draftId) => ({
            id: draftId,
            status: "draft",
            draft_body: JSON.stringify({ type: "doc", content: [] }),
            raw: {},
          }),
        },
      },
    );
    expect(missingImage.errors).toContain(
      "image_index 1 does not identify an existing native image.",
    );
  });

  it("summarizes targeted preview client failures", async () => {
    const result = await previewDraftImagePatch(
      {
        action: "update",
        draft_id: 77,
        image_patch: {
          image_index: 1,
          replacement_image_url: "https://cdn.example.com/new.png",
        },
      },
      nativePatchConfig,
      {
        client: {
          getDraft: async () => {
            throw new Error("request failed");
          },
        },
      },
    );
    expect(result.ok).toBe(false);
    expect(result.errors).toHaveLength(1);
  });

  it("omits payload debug from targeted previews unless requested", async () => {
    const result = await previewDraftImagePatch(
      {
        action: "update",
        draft_id: 77,
        image_patch: {
          image_index: 1,
          replacement_image_url: "https://cdn.example.com/new.png",
        },
      },
      nativePatchConfig,
      {
        client: {
          getDraft: async (draftId) => ({
            id: draftId,
            status: "draft",
            draft_body: JSON.stringify({
              type: "doc",
              content: [
                {
                  type: "image2",
                  attrs: { src: "https://cdn.example.com/old.png" },
                },
              ],
            }),
            raw: {},
          }),
        },
      },
    );
    expect(result.ok).toBe(true);
    expect(result.payload_debug).toBeUndefined();
  });

  it("returns a confirmation token and minimized payload debug for valid content", () => {
    const result = previewDraft(
      {
        action: "create",
        title: "Draft title",
        subtitle: "Draft subtitle",
        audience: "everyone",
        body_format: "markdown_v1",
        body_markdown: "# Heading\n\nHello **reader**.\n\n$$\nE = mc^2\n$$",
        include_payload_debug: true,
      },
      config,
      now,
    );

    expect(result.ok).toBe(true);
    expect(result.confirmation_token).toContain(".");
    expect(result.confirmation_expires_at).toBe("2026-07-08T12:15:00.000Z");
    expect(result.payload_debug).toEqual({
      payload_type: "newsletter",
      audience: "everyone",
      has_title: true,
      has_subtitle: true,
      draft_body_bytes: expect.any(Number),
      draft_body_doc_type: "doc",
      has_audience: true,
      top_level_nodes: 3,
    });
    expect(result.payload_debug).not.toHaveProperty("draft_body");
    expect(result.images).toEqual([]);
    expect(result.warnings).toEqual([]);
    expect(summarizePreview(result)).toContain(
      "Draft preview ready for create",
    );
  });

  it("returns validation errors without a token", () => {
    const result = previewDraft(
      {
        action: "update",
        body_format: "markdown_v1",
      },
      config,
      now,
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      "draft_id is required when action is update.",
      "body_markdown is required when body_format is markdown_v1.",
    ]);
    expect(result.confirmation_token).toBeUndefined();
    expect(summarizePreview(result)).toBe(
      "Draft preview failed with 2 error(s).",
    );
  });

  it("returns a confirmation token for metadata-only updates", () => {
    const result = previewDraft(
      {
        action: "update",
        draft_id: 10,
        title: "Retitled draft",
        subtitle: "",
        audience: "only_paid",
        include_payload_debug: true,
      },
      config,
      now,
    );

    expect(result.ok).toBe(true);
    expect(result.confirmation_token).toContain(".");
    expect(result.preview_text).toBe(
      "Metadata-only update: title, subtitle, audience.",
    );
    expect(result.stats).toEqual({
      blocks: 0,
      words: 0,
      images: 0,
      code_blocks: 0,
      latex_blocks: 0,
    });
    expect(result.images).toEqual([]);
    expect(result.payload_debug).toEqual({
      payload_type: "omitted",
      audience: "only_paid",
      has_title: true,
      has_subtitle: true,
      draft_body_bytes: 0,
      draft_body_doc_type: "none",
      has_audience: true,
      top_level_nodes: 0,
    });
  });

  it("returns a recursive manifest of exact preview images and metadata", () => {
    const result = previewDraft(
      {
        action: "create",
        title: "Nested images",
        body_format: "blocks_v1",
        blocks: [
          {
            type: "blockquote",
            children: [
              {
                type: "image",
                src: "https://cdn.example.com/art/diagram.PNG?version=2",
                width: 1672,
                height: 941,
                alt: "Architecture diagram",
                caption: "Reference architecture.",
                title: "Platform architecture",
              },
            ],
          },
          {
            type: "ordered_list",
            items: [
              {
                children: [
                  {
                    type: "image",
                    src: "https://cdn.example.com/photo.jpg",
                  },
                ],
              },
            ],
          },
        ],
      },
      config,
      now,
    );

    expect(result.ok).toBe(true);
    expect(result.images).toEqual([
      {
        url: "https://cdn.example.com/art/diagram.PNG?version=2",
        width: 1672,
        height: 941,
        format: "png",
        alt_text: "Architecture diagram",
        caption: "Reference architecture.",
        title: "Platform architecture",
      },
      {
        url: "https://cdn.example.com/photo.jpg",
        format: "jpeg",
      },
    ]);
  });

  it("requires body content for create previews and rejects no-op update previews", () => {
    expect(
      previewDraft(
        {
          action: "create",
          title: "Missing body",
        },
        config,
        now,
      ),
    ).toMatchObject({
      ok: false,
      errors: ["body_format is required when action is create."],
    });

    expect(
      previewDraft(
        {
          action: "update",
          draft_id: 10,
        },
        config,
        now,
      ),
    ).toMatchObject({
      ok: false,
      errors: [
        "At least one of title, subtitle, audience, or body content is required for update.",
      ],
    });
  });

  it("warns when a create preview omits title", () => {
    const result = previewDraft(
      {
        action: "create",
        body_format: "blocks_v1",
        blocks: [{ type: "paragraph", children: [{ text: "Body only." }] }],
      },
      config,
      now,
    );

    expect(result.ok).toBe(true);
    expect(result.warnings).toContain(
      "create_draft will require a non-empty title.",
    );
  });

  it("includes parser warnings in preview output", () => {
    const result = previewDraft(
      {
        action: "create",
        title: "Table warning",
        body_format: "markdown_v1",
        body_markdown: "| A | B |\n| - | - |\n| 1 | 2 |",
      },
      config,
      now,
    );

    expect(result.ok).toBe(true);
    expect(result.warnings).toContain(
      "Markdown tables are not supported in V1.",
    );
  });

  it("does not issue confirmation tokens for raw HTML", () => {
    const result = previewDraft(
      {
        action: "create",
        title: "Raw HTML",
        body_format: "markdown_v1",
        body_markdown: "Before\n\n<script>alert('no')</script>",
      },
      config,
      now,
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Raw HTML is not supported in V1.");
    expect(result.warnings).toContain("Raw HTML is not supported in V1.");
    expect(result.confirmation_token).toBeUndefined();
  });

  it("does not issue confirmation tokens for over-limit blocks_v1 bodies", () => {
    const result = previewDraft(
      {
        action: "create",
        title: "Oversized blocks",
        body_format: "blocks_v1",
        blocks: [
          {
            type: "paragraph",
            children: [{ text: "123456" }],
          },
        ],
      },
      { ...config, maxBodyBytes: 5 },
      now,
    );

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("blocks is ");
    expect(result.errors[0]).toContain("exceeds MAX_BODY_BYTES=5");
    expect(result.confirmation_token).toBeUndefined();
  });

  it("does not issue confirmation tokens for mixed body payloads", () => {
    const result = previewDraft(
      {
        action: "create",
        title: "Mixed body",
        body_format: "blocks_v1",
        body_markdown: "Markdown body.",
        blocks: [{ type: "paragraph", children: [{ text: "Blocks body." }] }],
      },
      config,
      now,
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "body_markdown must not be provided when body_format is blocks_v1.",
    );
    expect(result.confirmation_token).toBeUndefined();
  });

  it("does not default update previews to an audience change", () => {
    const result = previewDraft(
      {
        action: "update",
        draft_id: 10,
        title: "Keep audience",
        body_format: "markdown_v1",
        body_markdown: "Updated body.",
        include_payload_debug: true,
      },
      config,
      now,
    );

    expect(result.ok).toBe(true);
    expect(result.audience).toBeUndefined();
    expect(result.payload_debug?.has_audience).toBe(false);
    expect(result.payload_debug?.payload_type).toBe("omitted");
  });

  it("does not default create previews to an audience value", () => {
    const result = previewDraft(
      {
        action: "create",
        title: "Keep publication default",
        body_format: "markdown_v1",
        body_markdown: "Draft body.",
        include_payload_debug: true,
      },
      config,
      now,
    );

    expect(result.ok).toBe(true);
    expect(result.audience).toBeUndefined();
    expect(result.payload_debug?.has_audience).toBe(false);
  });
});
