import { describe, expect, it } from "vitest";

import { SubstackRateLimitError } from "../../src/substack/errors.js";
import { getDraft, summarizeDraft } from "../../src/tools/getDraft.js";

const config = {
  publicationUrl: undefined,
  sessionToken: undefined,
  substackRequestTimeoutMs: 30_000,
  userId: undefined,
  userAgent: "test-agent",
  maxBodyBytes: 750_000,
};

describe("getDraft", () => {
  it("fetches draft metadata without body by default", async () => {
    const calls: number[] = [];
    const result = await getDraft({ draft_id: 123 }, config, {
      client: {
        getDraft: async (draftId) => {
          calls.push(draftId);
          return {
            id: draftId,
            title: "Existing draft",
            subtitle: "Subtitle",
            audience: "everyone",
            draft_body: '{"type":"doc"}',
            status: "draft",
            draft: true,
            is_draft: true,
            raw: { id: draftId },
          };
        },
      },
    });

    expect(calls).toEqual([123]);
    expect(result).toEqual({
      ok: true,
      errors: [],
      include_body: false,
      draft: {
        id: 123,
        title: "Existing draft",
        subtitle: "Subtitle",
        audience: "everyone",
        word_count: undefined,
        created_at: undefined,
        updated_at: undefined,
        url: undefined,
        status: "draft",
        draft: true,
        is_draft: true,
        post_date: undefined,
        published_at: undefined,
        is_published: undefined,
      },
    });
    expect(result.draft).not.toHaveProperty("body");
    expect(summarizeDraft(result)).toBe(
      "Substack draft 123 retrieved: Existing draft. Body omitted.",
    );
  });

  it("includes the draft body only when requested", async () => {
    const result = await getDraft(
      { draft_id: 123, include_body: true },
      config,
      {
        client: {
          getDraft: async (draftId) => ({
            id: draftId,
            title: "Existing draft",
            draft_body: '{"type":"doc","content":[]}',
            raw: { id: draftId, draft_body: "not exposed" },
          }),
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(result.include_body).toBe(true);
    expect(result.draft?.body).toBe('{"type":"doc","content":[]}');
    expect(result.draft).toMatchObject({
      body_format: "substack_native_v1",
      body_sha256: expect.stringMatching(/^[0-9a-f]{64}$/u),
      images: [],
    });
    expect(result.draft).not.toHaveProperty("raw");
    expect(summarizeDraft(result)).toBe(
      "Substack draft 123 retrieved: Existing draft. Body included.",
    );
  });

  it("returns a one-based native image manifest for targeted patching", async () => {
    const result = await getDraft(
      { draft_id: 123, include_body: true },
      config,
      {
        client: {
          getDraft: async (draftId) => ({
            id: draftId,
            draft_body: JSON.stringify({
              type: "doc",
              content: [
                {
                  type: "captionedImage",
                  content: [
                    {
                      type: "image2",
                      attrs: {
                        src: "https://cdn.example.com/image.png",
                        alt: "Accessible diagram",
                        title: "Tooltip metadata",
                      },
                    },
                    {
                      type: "caption",
                      content: [{ type: "text", text: "Visible caption" }],
                    },
                  ],
                },
              ],
            }),
            raw: {},
          }),
        },
      },
    );

    expect(result.draft?.images).toEqual([
      {
        native_index: 1,
        url: "https://cdn.example.com/image.png",
        format: "png",
        alt_text: "Accessible diagram",
        caption: "Visible caption",
        title: "Tooltip metadata",
      },
    ]);
  });

  it("rejects oversized requested string bodies", async () => {
    const result = await getDraft(
      { draft_id: 123, include_body: true },
      { ...config, maxBodyBytes: 5 },
      {
        client: {
          getDraft: async (draftId) => ({
            id: draftId,
            title: "Large draft",
            draft_body: "private draft body",
            raw: { id: draftId },
          }),
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.draft).toBeUndefined();
    expect(result.include_body).toBe(true);
    expect(result.errors).toEqual([
      "draft body is 18 bytes, which exceeds MAX_BODY_BYTES=5.",
    ]);
  });

  it("rejects oversized requested object bodies after JSON serialization", async () => {
    const result = await getDraft(
      { draft_id: 123, include_body: true },
      { ...config, maxBodyBytes: 10 },
      {
        client: {
          getDraft: async (draftId) => ({
            id: draftId,
            title: "Large object draft",
            body: { type: "doc", content: [{ text: "private" }] },
            raw: { id: draftId },
          }),
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.draft).toBeUndefined();
    expect(result.errors[0]).toBe(
      "draft body is 45 bytes when JSON serialized, which exceeds MAX_BODY_BYTES=10.",
    );
  });

  it("rejects requested bodies that cannot be safely serialized for size checks", async () => {
    const body: Record<string, unknown> = { type: "doc" };
    body.self = body;

    const result = await getDraft(
      { draft_id: 123, include_body: true },
      config,
      {
        client: {
          getDraft: async (draftId) => ({
            id: draftId,
            title: "Circular draft",
            body,
            raw: { id: draftId },
          }),
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.draft).toBeUndefined();
    expect(result.errors).toEqual([
      "draft body could not be serialized for MAX_BODY_BYTES validation.",
    ]);
  });

  it("prefers authoritative draft_body over body when both are present", async () => {
    const result = await getDraft(
      { draft_id: 123, include_body: true },
      config,
      {
        client: {
          getDraft: async (draftId) => ({
            id: draftId,
            body: { type: "doc", content: [] },
            draft_body: '{"type":"doc","content":[]}',
            raw: { id: draftId },
          }),
        },
      },
    );

    expect(result.draft?.body).toBe('{"type":"doc","content":[]}');
    expect(result.draft?.body_format).toBe("substack_native_v1");
  });

  it("omits unsafe draft URLs from metadata output", async () => {
    const result = await getDraft({ draft_id: 123 }, config, {
      client: {
        getDraft: async (draftId) => ({
          id: draftId,
          title: "Existing draft",
          url: "https://user:password@example.substack.com/p/private",
          raw: { id: draftId },
        }),
      },
    });

    expect(result.ok).toBe(true);
    expect(result.draft?.url).toBeUndefined();
  });

  it("summarizes drafts without titles", async () => {
    const result = await getDraft({ draft_id: 123 }, config, {
      client: {
        getDraft: async (draftId) => ({
          id: draftId,
          raw: { id: draftId },
        }),
      },
    });

    expect(summarizeDraft(result)).toBe(
      "Substack draft 123 retrieved. Body omitted.",
    );
  });

  it("returns config errors without throwing", async () => {
    const result = await getDraft({ draft_id: 123 }, config);

    expect(result.ok).toBe(false);
    expect(result.draft).toBeUndefined();
    expect(result.include_body).toBe(false);
    expect(result.errors).toEqual(["SUBSTACK_PUBLICATION_URL is required."]);
    expect(summarizeDraft(result)).toBe("Draft fetch failed with 1 error(s).");
  });

  it("returns redacted Substack API errors", async () => {
    const result = await getDraft(
      { draft_id: 123, include_body: true },
      config,
      {
        client: {
          getDraft: async () => {
            throw new SubstackRateLimitError("Substack rate limit exceeded.", {
              status: 429,
              responseBody: "SUBSTACK_SESSION_TOKEN=secret-session",
              hint: "Wait before retrying.",
            });
          },
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.include_body).toBe(true);
    expect(result.errors[0]).toContain("HTTP 429");
    expect(result.errors[0]).toContain("[REDACTED]");
    expect(result.errors[0]).not.toContain("secret-session");
  });
});
