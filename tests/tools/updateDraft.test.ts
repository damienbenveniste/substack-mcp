import { describe, expect, it } from "vitest";

import { SubstackRateLimitError } from "../../src/substack/errors.js";
import { OMITTED_UNSAFE_DRAFT_URL_WARNING } from "../../src/tools/draftUrl.js";
import { previewDraft } from "../../src/tools/previewDraft.js";
import {
  summarizeUpdateDraft,
  updateDraft,
} from "../../src/tools/updateDraft.js";
import { captureAuditEvents } from "../helpers/audit.js";

const config = {
  maxBodyBytes: 750_000,
  previewTokenSecret: "test-preview-secret-with-enough-entropy",
  confirmationTokenTtlSeconds: 900,
  publicationUrl: undefined,
  sessionToken: undefined,
  substackRequestTimeoutMs: 30_000,
  userId: 123,
  userAgent: "test-agent",
};

const now = new Date("2026-07-08T12:00:00.000Z");
const later = new Date("2026-07-08T12:05:00.000Z");

describe("updateDraft", () => {
  it("updates an unpublished draft after a matching preview token", async () => {
    const input = {
      draft_id: 77,
      title: "Updated draft",
      body_format: "markdown_v1" as const,
      body_markdown: "Updated **body**.",
      confirmation_token: previewToken({
        action: "update",
        draft_id: 77,
        title: "Updated draft",
        body_format: "markdown_v1",
        body_markdown: "Updated **body**.",
      }),
    };
    const calls: string[] = [];
    let capturedPayload: unknown;

    const result = await updateDraft(input, config, {
      now: later,
      client: {
        getDraft: async (draftId) => {
          calls.push(`get:${draftId}`);
          return {
            id: draftId,
            title: "Existing draft",
            url: "https://example.substack.com/p/existing",
            is_published: false,
            raw: {},
          };
        },
        updateDraft: async (draftId, payload) => {
          calls.push(`update:${draftId}`);
          capturedPayload = payload;
          return {
            id: draftId,
            title: payload.draft_title,
            url: "https://example.substack.com/p/updated",
            raw: {},
          };
        },
      },
    });

    expect(calls).toEqual(["get:77", "update:77"]);
    expect(result).toMatchObject({
      ok: true,
      errors: [],
      draft_id: 77,
      draft_title: "Updated draft",
      draft_url: "https://example.substack.com/p/updated",
      warnings: [],
    });
    expect(result.message).toContain("Review and publish manually");
    expect(summarizeUpdateDraft(result)).toBe(result.message);
    expect(capturedPayload).toMatchObject({
      draft_title: "Updated draft",
    });
    expect(capturedPayload).not.toHaveProperty("audience");
    expect(capturedPayload).not.toHaveProperty("type");
    expect(
      (capturedPayload as { readonly draft_body: string }).draft_body,
    ).toContain("Updated");
  });

  it("updates metadata only without sending draft_body", async () => {
    const { auditLogger, events: auditEvents } = captureAuditEvents();
    const input = {
      draft_id: 77,
      title: "Retitled draft",
      subtitle: "",
      audience: "only_paid" as const,
      confirmation_token: previewToken({
        action: "update",
        draft_id: 77,
        title: "Retitled draft",
        subtitle: "",
        audience: "only_paid",
      }),
    };
    let capturedPayload: unknown;

    const result = await updateDraft(input, config, {
      now: later,
      auditLogger,
      client: {
        getDraft: async (draftId) => ({
          id: draftId,
          title: "Existing draft",
          url: "https://example.substack.com/p/existing",
          is_published: false,
          raw: {},
        }),
        updateDraft: async (draftId, payload) => {
          capturedPayload = payload;
          return {
            id: draftId,
            title: payload.draft_title,
            url: "https://example.substack.com/p/retitled",
            raw: {},
          };
        },
      },
    });

    expect(result).toMatchObject({
      ok: true,
      errors: [],
      draft_id: 77,
      draft_title: "Retitled draft",
      draft_url: "https://example.substack.com/p/retitled",
      warnings: [],
    });
    expect(capturedPayload).toEqual({
      draft_title: "Retitled draft",
      draft_subtitle: "",
      audience: "only_paid",
    });
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      event_type: "mcp_audit",
      action: "update_draft",
      outcome: "success",
      draft_id: 77,
      audience: "only_paid",
      title_present: true,
      subtitle_present: true,
      body_present: false,
      metadata_only: true,
      warning_count: 0,
      error_count: 0,
      stats: {
        blocks: 0,
        words: 0,
        images: 0,
        code_blocks: 0,
        latex_blocks: 0,
      },
    });
    const serializedAudit = JSON.stringify(auditEvents);
    expect(serializedAudit).not.toContain("Retitled draft");
    expect(serializedAudit).not.toContain(input.confirmation_token);
  });

  it("omits unsafe updated draft URLs and reports a warning", async () => {
    const result = await updateDraft(
      {
        draft_id: 77,
        title: "Updated draft",
        confirmation_token: previewToken({
          action: "update",
          draft_id: 77,
          title: "Updated draft",
        }),
      },
      config,
      {
        now: later,
        client: {
          getDraft: async (draftId) => ({
            id: draftId,
            title: "Existing draft",
            url: "https://example.substack.com/p/existing",
            is_published: false,
            raw: {},
          }),
          updateDraft: async (draftId, payload) => ({
            id: draftId,
            title: payload.draft_title,
            url: "https://user:password@example.substack.com/p/private",
            raw: {},
          }),
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(result.draft_id).toBe(77);
    expect(result.draft_url).toBeUndefined();
    expect(result.warnings).toContain(OMITTED_UNSAFE_DRAFT_URL_WARNING);
  });

  it("rejects audience changes after preview before fetching the draft", async () => {
    let calls = 0;
    const result = await updateDraft(
      {
        draft_id: 77,
        audience: "only_paid",
        confirmation_token: previewToken({
          action: "update",
          draft_id: 77,
          audience: "everyone",
        }),
      },
      config,
      {
        now: later,
        client: {
          getDraft: async () => {
            calls += 1;
            return { id: 77, raw: {} };
          },
          updateDraft: async () => {
            calls += 1;
            return { id: 77, raw: {} };
          },
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "Confirmation token does not match the current draft input.",
    );
    expect(calls).toBe(0);
  });

  it("normalizes title and subtitle before matching preview tokens and sending update payloads", async () => {
    const input = {
      draft_id: 77,
      title: "Retitled draft",
      subtitle: "Clean subtitle",
      confirmation_token: previewToken({
        action: "update",
        draft_id: 77,
        title: " Retitled   draft ",
        subtitle: " Clean   subtitle ",
      }),
    };
    let capturedPayload: unknown;

    const result = await updateDraft(input, config, {
      now: later,
      client: {
        getDraft: async (draftId) => ({
          id: draftId,
          title: "Existing draft",
          url: "https://example.substack.com/p/existing",
          is_published: false,
          raw: {},
        }),
        updateDraft: async (draftId, payload) => {
          capturedPayload = payload;
          return {
            id: draftId,
            title: payload.draft_title,
            raw: {},
          };
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(capturedPayload).toEqual({
      draft_title: "Retitled draft",
      draft_subtitle: "Clean subtitle",
    });
  });

  it("rejects malformed and expired confirmation tokens before fetching the draft", async () => {
    let calls = 0;
    const malformed = await updateDraft(
      {
        draft_id: 77,
        body_format: "markdown_v1",
        body_markdown: "Updated body.",
        confirmation_token: "not-a-token",
      },
      config,
      {
        now: later,
        client: {
          getDraft: async () => {
            calls += 1;
            return { id: 77, raw: {} };
          },
          updateDraft: async () => {
            calls += 1;
            return { id: 77, raw: {} };
          },
        },
      },
    );

    expect(malformed.ok).toBe(false);
    expect(malformed.errors).toContain("Malformed confirmation token.");

    const expired = await updateDraft(
      {
        draft_id: 77,
        body_format: "markdown_v1",
        body_markdown: "Updated body.",
        confirmation_token: previewToken(
          {
            action: "update",
            draft_id: 77,
            body_format: "markdown_v1",
            body_markdown: "Updated body.",
          },
          new Date("2026-07-08T11:00:00.000Z"),
        ),
      },
      config,
      {
        now: later,
        client: {
          getDraft: async () => {
            calls += 1;
            return { id: 77, raw: {} };
          },
          updateDraft: async () => {
            calls += 1;
            return { id: 77, raw: {} };
          },
        },
      },
    );

    expect(expired.ok).toBe(false);
    expect(expired.errors).toContain("Confirmation token has expired.");
    expect(calls).toBe(0);
  });

  it("rejects mixed body payloads before fetching the draft", async () => {
    let calls = 0;
    const result = await updateDraft(
      {
        draft_id: 77,
        body_format: "blocks_v1",
        body_markdown: "Markdown body.",
        blocks: [{ type: "paragraph", children: [{ text: "Blocks body." }] }],
        confirmation_token: previewToken({
          action: "update",
          draft_id: 77,
          body_format: "blocks_v1",
          blocks: [{ type: "paragraph", children: [{ text: "Blocks body." }] }],
        }),
      },
      config,
      {
        now: later,
        client: {
          getDraft: async () => {
            calls += 1;
            return { id: 77, raw: {} };
          },
          updateDraft: async () => {
            calls += 1;
            return { id: 77, raw: {} };
          },
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "body_markdown must not be provided when body_format is blocks_v1.",
    );
    expect(calls).toBe(0);
  });

  it("refuses to update a published draft", async () => {
    let updateCalls = 0;
    const result = await updateDraft(
      {
        draft_id: 77,
        body_format: "markdown_v1",
        body_markdown: "Updated body.",
        confirmation_token: previewToken({
          action: "update",
          draft_id: 77,
          body_format: "markdown_v1",
          body_markdown: "Updated body.",
        }),
      },
      config,
      {
        now: later,
        client: {
          getDraft: async (draftId) => ({
            id: draftId,
            is_published: true,
            raw: {},
          }),
          updateDraft: async () => {
            updateCalls += 1;
            return { id: 77, raw: {} };
          },
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      "Refusing to update a draft that Substack does not report as an unpublished draft.",
    ]);
    expect(updateCalls).toBe(0);
  });

  it("refuses to update a draft with a published_at timestamp", async () => {
    let updateCalls = 0;
    const result = await updateDraft(
      {
        draft_id: 77,
        body_format: "markdown_v1",
        body_markdown: "Updated body.",
        confirmation_token: previewToken({
          action: "update",
          draft_id: 77,
          body_format: "markdown_v1",
          body_markdown: "Updated body.",
        }),
      },
      config,
      {
        now: later,
        client: {
          getDraft: async (draftId) => ({
            id: draftId,
            is_published: false,
            published_at: "2026-07-08T03:00:00Z",
            raw: {},
          }),
          updateDraft: async () => {
            updateCalls += 1;
            return { id: 77, raw: {} };
          },
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      "Refusing to update a draft that Substack does not report as an unpublished draft.",
    ]);
    expect(updateCalls).toBe(0);
  });

  it("refuses to update a draft with a post_date timestamp", async () => {
    const { auditLogger, events: auditEvents } = captureAuditEvents();
    let updateCalls = 0;
    const result = await updateDraft(
      {
        draft_id: 77,
        body_format: "markdown_v1",
        body_markdown: "Updated body.",
        confirmation_token: previewToken({
          action: "update",
          draft_id: 77,
          body_format: "markdown_v1",
          body_markdown: "Updated body.",
        }),
      },
      config,
      {
        now: later,
        auditLogger,
        client: {
          getDraft: async (draftId) => ({
            id: draftId,
            is_published: false,
            post_date: "2026-07-09T03:00:00Z",
            published_at: null,
            raw: {},
          }),
          updateDraft: async () => {
            updateCalls += 1;
            return { id: 77, raw: {} };
          },
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      "Refusing to update a draft that Substack does not report as an unpublished draft.",
    ]);
    expect(updateCalls).toBe(0);
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      event_type: "mcp_audit",
      action: "update_draft",
      outcome: "blocked",
      reason: "not_unpublished_draft",
      draft_id: 77,
      warning_count: 0,
      error_count: 1,
    });
  });

  it("refuses to update when Substack marks the object as not a draft", async () => {
    let updateCalls = 0;
    const result = await updateDraft(
      {
        draft_id: 77,
        body_format: "markdown_v1",
        body_markdown: "Updated body.",
        confirmation_token: previewToken({
          action: "update",
          draft_id: 77,
          body_format: "markdown_v1",
          body_markdown: "Updated body.",
        }),
      },
      config,
      {
        now: later,
        client: {
          getDraft: async (draftId) => ({
            id: draftId,
            is_draft: false,
            is_published: false,
            raw: {},
          }),
          updateDraft: async () => {
            updateCalls += 1;
            return { id: 77, raw: {} };
          },
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      "Refusing to update a draft that Substack does not report as an unpublished draft.",
    ]);
    expect(updateCalls).toBe(0);
  });

  it("refuses to update when Substack returns a non-draft status", async () => {
    let updateCalls = 0;
    const result = await updateDraft(
      {
        draft_id: 77,
        body_format: "markdown_v1",
        body_markdown: "Updated body.",
        confirmation_token: previewToken({
          action: "update",
          draft_id: 77,
          body_format: "markdown_v1",
          body_markdown: "Updated body.",
        }),
      },
      config,
      {
        now: later,
        client: {
          getDraft: async (draftId) => ({
            id: draftId,
            is_published: false,
            status: "scheduled",
            raw: {},
          }),
          updateDraft: async () => {
            updateCalls += 1;
            return { id: 77, raw: {} };
          },
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      "Refusing to update a draft that Substack does not report as an unpublished draft.",
    ]);
    expect(updateCalls).toBe(0);
  });

  it("refuses to update when Substack returns no positive draft marker", async () => {
    let updateCalls = 0;
    const result = await updateDraft(
      {
        draft_id: 77,
        body_format: "markdown_v1",
        body_markdown: "Updated body.",
        confirmation_token: previewToken({
          action: "update",
          draft_id: 77,
          body_format: "markdown_v1",
          body_markdown: "Updated body.",
        }),
      },
      config,
      {
        now: later,
        client: {
          getDraft: async (draftId) => ({
            id: draftId,
            title: "Ambiguous item",
            raw: {},
          }),
          updateDraft: async () => {
            updateCalls += 1;
            return { id: 77, raw: {} };
          },
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual([
      "Refusing to update a draft that Substack does not report as an unpublished draft.",
    ]);
    expect(updateCalls).toBe(0);
  });

  it("allows updates when Substack returns a draft status marker", async () => {
    let updateCalls = 0;
    const result = await updateDraft(
      {
        draft_id: 77,
        title: "Retitled draft",
        confirmation_token: previewToken({
          action: "update",
          draft_id: 77,
          title: "Retitled draft",
        }),
      },
      config,
      {
        now: later,
        client: {
          getDraft: async (draftId) => ({
            id: draftId,
            title: "Existing draft",
            status: "draft",
            raw: {},
          }),
          updateDraft: async (draftId, payload) => {
            updateCalls += 1;
            return {
              id: draftId,
              title: payload.draft_title,
              raw: {},
            };
          },
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(result.draft_title).toBe("Retitled draft");
    expect(updateCalls).toBe(1);
  });

  it("returns redacted Substack API errors", async () => {
    const result = await updateDraft(
      {
        draft_id: 77,
        audience: "only_paid",
        body_format: "markdown_v1",
        body_markdown: "Updated body.",
        confirmation_token: previewToken({
          action: "update",
          draft_id: 77,
          audience: "only_paid",
          body_format: "markdown_v1",
          body_markdown: "Updated body.",
        }),
      },
      config,
      {
        now: later,
        client: {
          getDraft: async (draftId) => ({
            id: draftId,
            is_published: false,
            raw: {},
          }),
          updateDraft: async () => {
            throw new SubstackRateLimitError("Substack rate limit exceeded.", {
              status: 429,
              responseBody: "SUBSTACK_SESSION_TOKEN=secret-session",
            });
          },
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("HTTP 429");
    expect(result.errors[0]).toContain("[REDACTED]");
    expect(result.errors[0]).not.toContain("secret-session");
    expect(summarizeUpdateDraft(result)).toBe(
      "Draft update failed with 1 error(s).",
    );
  });

  it("returns conversion warnings from the rebuilt payload", async () => {
    const result = await updateDraft(
      {
        draft_id: 77,
        body_format: "markdown_v1",
        body_markdown: "$$\nE = mc^2\n$$",
        confirmation_token: previewToken({
          action: "update",
          draft_id: 77,
          body_format: "markdown_v1",
          body_markdown: "$$\nE = mc^2\n$$",
        }),
      },
      config,
      {
        now: later,
        client: {
          getDraft: async (draftId) => ({
            id: draftId,
            is_published: false,
            raw: {},
          }),
          updateDraft: async (draftId) => ({
            id: draftId,
            raw: {},
          }),
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(result.warnings).toContain(
      "LaTeX block mapping is provisional until a live Substack LaTeX fixture is captured; preview uses a latex code block fallback.",
    );
  });

  it("falls back to existing draft metadata when update response omits it", async () => {
    const result = await updateDraft(
      {
        draft_id: 77,
        body_format: "markdown_v1",
        body_markdown: "Updated body.",
        confirmation_token: previewToken({
          action: "update",
          draft_id: 77,
          body_format: "markdown_v1",
          body_markdown: "Updated body.",
        }),
      },
      config,
      {
        now: later,
        client: {
          getDraft: async (draftId) => ({
            id: draftId,
            title: "Existing draft",
            url: "https://example.substack.com/p/existing",
            is_published: false,
            raw: {},
          }),
          updateDraft: async (draftId) => ({
            id: draftId,
            raw: {},
          }),
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(result.draft_title).toBe("Existing draft");
    expect(result.draft_url).toBe("https://example.substack.com/p/existing");
  });

  it("warns when the existing fallback draft URL is unsafe", async () => {
    const result = await updateDraft(
      {
        draft_id: 77,
        body_format: "markdown_v1",
        body_markdown: "Updated body.",
        confirmation_token: previewToken({
          action: "update",
          draft_id: 77,
          body_format: "markdown_v1",
          body_markdown: "Updated body.",
        }),
      },
      config,
      {
        now: later,
        client: {
          getDraft: async (draftId) => ({
            id: draftId,
            title: "Existing draft",
            url: "http://127.0.0.1/private-draft",
            is_published: false,
            raw: {},
          }),
          updateDraft: async (draftId) => ({
            id: draftId,
            raw: {},
          }),
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(result.draft_title).toBe("Existing draft");
    expect(result.draft_url).toBeUndefined();
    expect(result.warnings).toContain(OMITTED_UNSAFE_DRAFT_URL_WARNING);
  });

  it("returns config errors from the default client path", async () => {
    const result = await updateDraft(
      {
        draft_id: 77,
        body_format: "markdown_v1",
        body_markdown: "Updated body.",
        confirmation_token: previewToken({
          action: "update",
          draft_id: 77,
          body_format: "markdown_v1",
          body_markdown: "Updated body.",
        }),
      },
      config,
      { now: later },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(["SUBSTACK_PUBLICATION_URL is required."]);
  });
});

function previewToken(
  input: Parameters<typeof previewDraft>[0],
  issuedAt: Date = now,
): string {
  const preview = previewDraft(input, config, issuedAt);
  if (!preview.confirmation_token) {
    throw new Error("Expected preview token.");
  }

  return preview.confirmation_token;
}
