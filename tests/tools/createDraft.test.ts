import { describe, expect, it } from "vitest";

import { SubstackAuthError } from "../../src/substack/errors.js";
import {
  createCreateDraftIdempotencyStore,
  createDraft,
  summarizeCreateDraft,
} from "../../src/tools/createDraft.js";
import { OMITTED_UNSAFE_DRAFT_URL_WARNING } from "../../src/tools/draftUrl.js";
import { previewDraft } from "../../src/tools/previewDraft.js";
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

describe("createDraft", () => {
  it("creates a draft only after a matching preview token", async () => {
    const { auditLogger, events: auditEvents } = captureAuditEvents();
    const input = {
      title: "Created draft",
      subtitle: "Subtitle",
      audience: "everyone" as const,
      body_format: "markdown_v1" as const,
      body_markdown: "Hello **reader**.",
      confirmation_token: previewToken({
        action: "create",
        title: "Created draft",
        subtitle: "Subtitle",
        audience: "everyone",
        body_format: "markdown_v1",
        body_markdown: "Hello **reader**.",
      }),
    };
    let capturedPayload: unknown;

    const result = await createDraft(input, config, {
      now: later,
      auditLogger,
      client: {
        createDraft: async (payload) => {
          capturedPayload = payload;
          return {
            id: 55,
            title: payload.draft_title,
            url: "https://example.substack.com/p/created-draft",
            raw: {},
          };
        },
      },
    });

    expect(result).toMatchObject({
      ok: true,
      errors: [],
      draft_id: 55,
      draft_title: "Created draft",
      draft_url: "https://example.substack.com/p/created-draft",
      warnings: [],
    });
    expect(result.message).toContain("Review and publish manually");
    expect(summarizeCreateDraft(result)).toBe(result.message);
    expect(capturedPayload).toMatchObject({
      draft_title: "Created draft",
      draft_subtitle: "Subtitle",
      audience: "everyone",
      type: "newsletter",
      draft_bylines: [{ id: 123, is_guest: false }],
    });
    expect(
      (capturedPayload as { readonly draft_body: string }).draft_body,
    ).toContain("Hello");
    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0]).toMatchObject({
      event_type: "mcp_audit",
      action: "create_draft",
      outcome: "success",
      draft_id: 55,
      body_format: "markdown_v1",
      audience: "everyone",
      title_present: true,
      subtitle_present: true,
      body_present: true,
      idempotency_key_present: false,
      warning_count: 0,
      error_count: 0,
      stats: {
        blocks: 1,
        words: 2,
        images: 0,
        code_blocks: 0,
        latex_blocks: 0,
      },
    });
    const serializedAudit = JSON.stringify(auditEvents);
    expect(serializedAudit).not.toContain("Created draft");
    expect(serializedAudit).not.toContain("Hello");
    expect(serializedAudit).not.toContain(input.confirmation_token);
  });

  it("does not set an audience unless the caller explicitly provides one", async () => {
    let capturedPayload: unknown;
    const result = await createDraft(
      {
        title: "Created draft",
        body_format: "markdown_v1",
        body_markdown: "Hello.",
        confirmation_token: previewToken({
          action: "create",
          title: "Created draft",
          body_format: "markdown_v1",
          body_markdown: "Hello.",
        }),
      },
      config,
      {
        now: later,
        client: {
          createDraft: async (payload) => {
            capturedPayload = payload;
            return {
              id: 55,
              title: payload.draft_title,
              raw: {},
            };
          },
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(capturedPayload).not.toHaveProperty("audience");
  });

  it("omits unsafe draft URLs returned by Substack and reports a warning", async () => {
    const result = await createDraft(
      {
        title: "Created draft",
        body_format: "markdown_v1",
        body_markdown: "Hello.",
        confirmation_token: previewToken({
          action: "create",
          title: "Created draft",
          body_format: "markdown_v1",
          body_markdown: "Hello.",
        }),
      },
      config,
      {
        now: later,
        client: {
          createDraft: async (payload) => ({
            id: 55,
            title: payload.draft_title,
            url: "http://127.0.0.1/private-draft",
            raw: {},
          }),
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(result.draft_id).toBe(55);
    expect(result.draft_url).toBeUndefined();
    expect(result.warnings).toContain(OMITTED_UNSAFE_DRAFT_URL_WARNING);
  });

  it("rejects audience changes after preview before calling Substack", async () => {
    let calls = 0;
    const result = await createDraft(
      {
        title: "Created draft",
        audience: "only_paid",
        body_format: "markdown_v1",
        body_markdown: "Hello.",
        confirmation_token: previewToken({
          action: "create",
          title: "Created draft",
          audience: "everyone",
          body_format: "markdown_v1",
          body_markdown: "Hello.",
        }),
      },
      config,
      {
        now: later,
        client: {
          createDraft: async () => {
            calls += 1;
            return { id: 55, raw: {} };
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

  it("normalizes title and subtitle before matching preview tokens and sending payloads", async () => {
    let capturedPayload: unknown;
    const result = await createDraft(
      {
        title: "Created draft",
        subtitle: "Clean subtitle",
        body_format: "markdown_v1",
        body_markdown: "Hello.",
        confirmation_token: previewToken({
          action: "create",
          title: "  Created   draft  ",
          subtitle: " Clean   subtitle ",
          body_format: "markdown_v1",
          body_markdown: "Hello.",
        }),
      },
      config,
      {
        now: later,
        client: {
          createDraft: async (payload) => {
            capturedPayload = payload;
            return {
              id: 58,
              title: payload.draft_title,
              raw: {},
            };
          },
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(capturedPayload).toMatchObject({
      draft_title: "Created draft",
      draft_subtitle: "Clean subtitle",
    });
  });

  it("rejects malformed and mismatched confirmation tokens", async () => {
    let calls = 0;
    const client = {
      createDraft: async () => {
        calls += 1;
        return { id: 1, raw: {} };
      },
    };

    const malformed = await createDraft(
      {
        title: "Created draft",
        body_format: "markdown_v1",
        body_markdown: "Hello.",
        confirmation_token: "not-a-token",
      },
      config,
      { now: later, client },
    );
    expect(malformed.ok).toBe(false);
    expect(malformed.errors).toContain("Malformed confirmation token.");

    const expired = await createDraft(
      {
        title: "Created draft",
        body_format: "markdown_v1",
        body_markdown: "Hello.",
        confirmation_token: previewToken(
          {
            action: "create",
            title: "Created draft",
            body_format: "markdown_v1",
            body_markdown: "Hello.",
          },
          new Date("2026-07-08T11:00:00.000Z"),
        ),
      },
      config,
      { now: later, client },
    );
    expect(expired.ok).toBe(false);
    expect(expired.errors).toContain("Confirmation token has expired.");

    const mismatched = await createDraft(
      {
        title: "Changed title",
        body_format: "markdown_v1",
        body_markdown: "Hello.",
        confirmation_token: previewToken({
          action: "create",
          title: "Original title",
          body_format: "markdown_v1",
          body_markdown: "Hello.",
        }),
      },
      config,
      { now: later, client },
    );
    expect(mismatched.ok).toBe(false);
    expect(mismatched.errors).toContain(
      "Confirmation token does not match the current draft input.",
    );
    expect(calls).toBe(0);
  });

  it("rejects mixed body payloads before calling Substack", async () => {
    let calls = 0;
    const result = await createDraft(
      {
        title: "Created draft",
        body_format: "markdown_v1",
        body_markdown: "Markdown body.",
        blocks: [{ type: "paragraph", children: [{ text: "Blocks body." }] }],
        confirmation_token: previewToken({
          action: "create",
          title: "Created draft",
          body_format: "markdown_v1",
          body_markdown: "Markdown body.",
        }),
      },
      config,
      {
        now: later,
        client: {
          createDraft: async () => {
            calls += 1;
            return { id: 1, raw: {} };
          },
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "blocks must not be provided when body_format is markdown_v1.",
    );
    expect(calls).toBe(0);
  });

  it("requires a non-empty title and user id", async () => {
    const result = await createDraft(
      {
        title: "  ",
        body_format: "markdown_v1",
        body_markdown: "Hello.",
        confirmation_token: "not-a-token",
      },
      { ...config, userId: undefined },
      { now: later },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("title is required when creating a draft.");
    expect(result.errors).toContain("SUBSTACK_USER_ID is required.");
  });

  it("returns idempotency and conversion warnings", async () => {
    const idempotencyStore = createCreateDraftIdempotencyStore();
    const result = await createDraft(
      {
        title: "Created draft",
        body_format: "markdown_v1",
        body_markdown: "$$\nE = mc^2\n$$",
        confirmation_token: previewToken({
          action: "create",
          title: "Created draft",
          body_format: "markdown_v1",
          body_markdown: "$$\nE = mc^2\n$$",
        }),
        idempotency_key: "client-key",
      },
      config,
      {
        now: later,
        idempotencyStore,
        client: {
          createDraft: async (payload) => ({
            id: 56,
            title: payload.draft_title,
            raw: {},
          }),
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(result.warnings).toContain(
      "idempotency_key is remembered in memory for the preview-token TTL only; it is not durable across restarts or deployments.",
    );
    expect(result.warnings).toContain(
      "LaTeX block mapping is provisional until a live Substack LaTeX fixture is captured; preview uses a latex code block fallback.",
    );
  });

  it("replays successful creates with the same idempotency key and draft input", async () => {
    const idempotencyStore = createCreateDraftIdempotencyStore();
    const { auditLogger, events: auditEvents } = captureAuditEvents();
    const input = {
      title: "Created draft",
      body_format: "markdown_v1" as const,
      body_markdown: "Hello.",
      confirmation_token: previewToken({
        action: "create",
        title: "Created draft",
        body_format: "markdown_v1",
        body_markdown: "Hello.",
      }),
      idempotency_key: "client-key",
    };
    let calls = 0;
    const client = {
      createDraft: async () => {
        calls += 1;
        return {
          id: 61,
          title: "Created draft",
          url: "https://example.substack.com/p/created-draft",
          raw: {},
        };
      },
    };

    const first = await createDraft(input, config, {
      auditLogger,
      client,
      idempotencyStore,
      now: later,
    });
    const second = await createDraft(input, config, {
      auditLogger,
      client,
      idempotencyStore,
      now: later,
    });

    expect(first.ok).toBe(true);
    expect(second).toMatchObject({
      ok: true,
      draft_id: 61,
      draft_title: "Created draft",
      draft_url: "https://example.substack.com/p/created-draft",
    });
    expect(second.warnings).toContain(
      "idempotency_key matched a previous successful create; returning cached draft result without another Substack create call.",
    );
    expect(calls).toBe(1);
    expect(auditEvents).toHaveLength(2);
    expect(auditEvents[1]).toMatchObject({
      action: "create_draft",
      outcome: "success",
      draft_id: 61,
      idempotency_key_present: true,
      idempotency_replay: true,
    });
    expect(JSON.stringify(auditEvents)).not.toContain("client-key");
  });

  it("rejects an idempotency key reused for different draft input", async () => {
    const idempotencyStore = createCreateDraftIdempotencyStore();
    let calls = 0;
    const client = {
      createDraft: async () => {
        calls += 1;
        return { id: 62, raw: {} };
      },
    };

    const first = await createDraft(
      {
        title: "Created draft",
        body_format: "markdown_v1",
        body_markdown: "Hello.",
        confirmation_token: previewToken({
          action: "create",
          title: "Created draft",
          body_format: "markdown_v1",
          body_markdown: "Hello.",
        }),
        idempotency_key: "client-key",
      },
      config,
      { client, idempotencyStore, now: later },
    );
    const second = await createDraft(
      {
        title: "Created draft",
        body_format: "markdown_v1",
        body_markdown: "Changed body.",
        confirmation_token: previewToken({
          action: "create",
          title: "Created draft",
          body_format: "markdown_v1",
          body_markdown: "Changed body.",
        }),
        idempotency_key: "client-key",
      },
      config,
      { client, idempotencyStore, now: later },
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(false);
    expect(second.errors).toContain(
      "idempotency_key was already used for a different draft input.",
    );
    expect(calls).toBe(1);
  });

  it("does not cache failed idempotent create attempts", async () => {
    const idempotencyStore = createCreateDraftIdempotencyStore();
    const input = {
      title: "Created draft",
      body_format: "markdown_v1" as const,
      body_markdown: "Hello.",
      confirmation_token: previewToken({
        action: "create",
        title: "Created draft",
        body_format: "markdown_v1",
        body_markdown: "Hello.",
      }),
      idempotency_key: "client-key",
    };
    let calls = 0;

    const failed = await createDraft(input, config, {
      idempotencyStore,
      now: later,
      client: {
        createDraft: async () => {
          calls += 1;
          throw new SubstackAuthError("Substack authentication failed.", {
            status: 401,
          });
        },
      },
    });
    const retried = await createDraft(input, config, {
      idempotencyStore,
      now: later,
      client: {
        createDraft: async () => {
          calls += 1;
          return { id: 63, raw: {} };
        },
      },
    });

    expect(failed.ok).toBe(false);
    expect(retried.ok).toBe(true);
    expect(retried.draft_id).toBe(63);
    expect(calls).toBe(2);
  });

  it("expires idempotency results after the preview-token ttl", async () => {
    const idempotencyStore = createCreateDraftIdempotencyStore();
    const input = {
      title: "Created draft",
      body_format: "markdown_v1" as const,
      body_markdown: "Hello.",
      confirmation_token: previewToken({
        action: "create",
        title: "Created draft",
        body_format: "markdown_v1",
        body_markdown: "Hello.",
      }),
      idempotency_key: "client-key",
    };
    const afterTtl = new Date("2026-07-08T12:20:01.000Z");
    const refreshedInput = {
      ...input,
      confirmation_token: previewToken(
        {
          action: "create",
          title: "Created draft",
          body_format: "markdown_v1",
          body_markdown: "Hello.",
        },
        new Date("2026-07-08T12:10:01.000Z"),
      ),
    };
    let calls = 0;
    const client = {
      createDraft: async () => {
        calls += 1;
        return { id: 63 + calls, raw: {} };
      },
    };

    const first = await createDraft(input, config, {
      client,
      idempotencyStore,
      now: later,
    });
    const second = await createDraft(refreshedInput, config, {
      client,
      idempotencyStore,
      now: afterTtl,
    });

    expect(first.draft_id).toBe(64);
    expect(second.draft_id).toBe(65);
    expect(second.warnings).not.toContain(
      "idempotency_key matched a previous successful create; returning cached draft result without another Substack create call.",
    );
    expect(calls).toBe(2);
  });

  it("rejects blank idempotency keys before calling Substack", async () => {
    let calls = 0;
    const result = await createDraft(
      {
        title: "Created draft",
        body_format: "markdown_v1",
        body_markdown: "Hello.",
        confirmation_token: previewToken({
          action: "create",
          title: "Created draft",
          body_format: "markdown_v1",
          body_markdown: "Hello.",
        }),
        idempotency_key: "  ",
      },
      config,
      {
        now: later,
        client: {
          createDraft: async () => {
            calls += 1;
            return { id: 1, raw: {} };
          },
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("idempotency_key must not be blank.");
    expect(calls).toBe(0);
  });

  it("falls back to the input title when Substack omits title and URL", async () => {
    const result = await createDraft(
      {
        title: "Created draft",
        body_format: "markdown_v1",
        body_markdown: "Hello.",
        confirmation_token: previewToken({
          action: "create",
          title: "Created draft",
          body_format: "markdown_v1",
          body_markdown: "Hello.",
        }),
      },
      config,
      {
        now: later,
        client: {
          createDraft: async () => ({
            id: 57,
            raw: {},
          }),
        },
      },
    );

    expect(result.ok).toBe(true);
    expect(result.draft_title).toBe("Created draft");
    expect(result.draft_url).toBeUndefined();
  });

  it("returns config errors from the default client path", async () => {
    const result = await createDraft(
      {
        title: "Created draft",
        body_format: "markdown_v1",
        body_markdown: "Hello.",
        confirmation_token: previewToken({
          action: "create",
          title: "Created draft",
          body_format: "markdown_v1",
          body_markdown: "Hello.",
        }),
      },
      config,
      { now: later },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(["SUBSTACK_PUBLICATION_URL is required."]);
  });

  it("returns redacted Substack API errors", async () => {
    const result = await createDraft(
      {
        title: "Created draft",
        body_format: "markdown_v1",
        body_markdown: "Hello.",
        confirmation_token: previewToken({
          action: "create",
          title: "Created draft",
          body_format: "markdown_v1",
          body_markdown: "Hello.",
        }),
      },
      config,
      {
        now: later,
        client: {
          createDraft: async () => {
            throw new SubstackAuthError("Substack authentication failed.", {
              status: 401,
              responseBody: "connect.sid=secret-session",
            });
          },
        },
      },
    );

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("HTTP 401");
    expect(result.errors[0]).toContain("[REDACTED]");
    expect(result.errors[0]).not.toContain("secret-session");
    expect(summarizeCreateDraft(result)).toBe(
      "Draft creation failed with 1 error(s).",
    );
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
