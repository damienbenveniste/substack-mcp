import { describe, expect, it } from "vitest";

import {
  assertPreviewDraftTool,
  assertValidateNewsletterContentTool,
  type ToolCaller,
} from "../../scripts/smokeValidateTool.js";

const tableWarning = "Markdown tables are not supported in V1.";

describe("assertValidateNewsletterContentTool", () => {
  it("calls validate_newsletter_content with the rich Markdown fixture and returns summary stats", async () => {
    let receivedArguments: unknown;
    const client = {
      async callTool(request) {
        expect(request.name).toBe("validate_newsletter_content");
        receivedArguments = request.arguments;
        return {
          isError: false,
          structuredContent: {
            ok: true,
            errors: [],
            warnings: [tableWarning],
            stats: {
              blocks: 16,
              words: 42,
              images: 1,
              code_blocks: 1,
              latex_blocks: 1,
              links: 1,
            },
            unsupported_features: ["table"],
          },
        };
      },
    } satisfies ToolCaller;

    const result = await assertValidateNewsletterContentTool(client);

    expect(receivedArguments).toMatchObject({
      body_format: "markdown_v1",
    });
    expect(
      String((receivedArguments as { body_markdown?: unknown }).body_markdown),
    ).toContain("# The Week in Agentic Tools");
    expect(result).toEqual({
      ok: true,
      fixture: "fixtures/markdown/full-rich-draft.md",
      blocks: 16,
      words: 42,
      images: 1,
      code_blocks: 1,
      latex_blocks: 1,
      links: 1,
      warning_count: 1,
      unsupported_features: ["table"],
    });
  });

  it("calls preview_draft with the rich Markdown fixture and returns a token summary", async () => {
    let receivedArguments: unknown;
    const client = {
      async callTool(request) {
        expect(request.name).toBe("preview_draft");
        receivedArguments = request.arguments;
        return {
          isError: false,
          structuredContent: {
            ok: true,
            action: "create",
            title: "[MCP SMOKE] Rich Draft Preview",
            preview_text: "Preview text.",
            warnings: [tableWarning],
            stats: {
              blocks: 16,
              words: 42,
              images: 1,
              code_blocks: 1,
              latex_blocks: 1,
            },
            confirmation_token: "payload.signature",
            confirmation_expires_at: "2026-07-08T12:15:00.000Z",
            payload_debug: {
              draft_body_doc_type: "doc",
              top_level_nodes: 16,
            },
          },
        };
      },
    } satisfies ToolCaller;

    const result = await assertPreviewDraftTool(client);

    expect(receivedArguments).toMatchObject({
      action: "create",
      title: "[MCP SMOKE] Rich Draft Preview",
      body_format: "markdown_v1",
      include_payload_debug: true,
    });
    expect(
      String((receivedArguments as { body_markdown?: unknown }).body_markdown),
    ).toContain("# The Week in Agentic Tools");
    expect(result).toEqual({
      ok: true,
      fixture: "fixtures/markdown/full-rich-draft.md",
      action: "create",
      title: "[MCP SMOKE] Rich Draft Preview",
      blocks: 16,
      words: 42,
      images: 1,
      code_blocks: 1,
      latex_blocks: 1,
      warning_count: 1,
      confirmation_token_parts: 2,
      confirmation_expires_at: "2026-07-08T12:15:00.000Z",
      preview_text_chars: 13,
      payload_debug_doc_type: "doc",
      payload_debug_top_level_nodes: 16,
    });
  });

  it("rejects MCP tool errors", async () => {
    const client = {
      async callTool() {
        return {
          isError: true,
          structuredContent: {
            ok: false,
          },
        };
      },
    } satisfies ToolCaller;

    await expect(assertValidateNewsletterContentTool(client)).rejects.toThrow(
      "validate_newsletter_content returned an MCP error.",
    );
  });

  it("rejects malformed preview confirmation tokens", async () => {
    const structured = validPreviewStructured();
    structured.confirmation_token = "not-a-jws";

    await expect(
      assertPreviewDraftTool(previewClient(structured)),
    ).rejects.toThrow("preview_draft returned a malformed confirmation token.");
  });

  it("rejects malformed preview status and identity fields", async () => {
    await expect(
      assertPreviewDraftTool(previewClient("not an object")),
    ).rejects.toThrow("preview_draft returned malformed structured content.");

    await expect(
      assertPreviewDraftTool(previewClient({ ok: false }, true)),
    ).rejects.toThrow("preview_draft returned an MCP error.");

    await expect(
      assertPreviewDraftTool(
        previewClient({ ...validPreviewStructured(), ok: false }),
      ),
    ).rejects.toThrow("preview_draft did not return ok=true.");

    await expect(
      assertPreviewDraftTool(
        previewClient({ ...validPreviewStructured(), action: "update" }),
      ),
    ).rejects.toThrow("preview_draft returned an unexpected action.");

    await expect(
      assertPreviewDraftTool(
        previewClient({
          ...validPreviewStructured(),
          title: "Different title",
        }),
      ),
    ).rejects.toThrow("preview_draft returned an unexpected title.");
  });

  it("rejects malformed preview warnings, expiry, and payload debug", async () => {
    await expect(
      assertPreviewDraftTool(
        previewClient({ ...validPreviewStructured(), warnings: "bad" }),
      ),
    ).rejects.toThrow("preview_draft returned malformed warnings.");

    await expect(
      assertPreviewDraftTool(
        previewClient({ ...validPreviewStructured(), warnings: [] }),
      ),
    ).rejects.toThrow(
      "preview_draft did not return the table fixture warning.",
    );

    await expect(
      assertPreviewDraftTool(
        previewClient({
          ...validPreviewStructured(),
          confirmation_expires_at: "not-a-date",
        }),
      ),
    ).rejects.toThrow(
      "preview_draft returned a malformed confirmation expiry.",
    );

    await expect(
      assertPreviewDraftTool(
        previewClient({
          ...validPreviewStructured(),
          payload_debug: {
            draft_body_doc_type: "paragraph",
            top_level_nodes: 16,
          },
        }),
      ),
    ).rejects.toThrow("payload_debug.draft_body_doc_type=paragraph");
  });

  it("rejects malformed preview primitive fields", async () => {
    await expect(
      assertPreviewDraftTool(
        previewClient({ ...validPreviewStructured(), preview_text: "" }),
      ),
    ).rejects.toThrow("preview_draft returned malformed preview_text.");

    await expect(
      assertPreviewDraftTool(
        previewClient({
          ...validPreviewStructured(),
          confirmation_token: 123,
        }),
      ),
    ).rejects.toThrow("preview_draft returned malformed confirmation_token.");

    const badStats = validPreviewStructured();
    badStats.stats = {
      blocks: 16,
      words: "42",
      images: 1,
      code_blocks: 1,
      latex_blocks: 1,
    };
    await expect(
      assertPreviewDraftTool(previewClient(badStats)),
    ).rejects.toThrow("preview_draft returned malformed stats.words.");

    const badPayloadDebug = validPreviewStructured();
    badPayloadDebug.payload_debug = {
      draft_body_doc_type: "doc",
      top_level_nodes: "16",
    };
    await expect(
      assertPreviewDraftTool(previewClient(badPayloadDebug)),
    ).rejects.toThrow(
      "preview_draft returned malformed payload_debug.top_level_nodes.",
    );
  });

  it("rejects unexpected fixture stats", async () => {
    const client = {
      async callTool() {
        return {
          isError: false,
          structuredContent: {
            ok: true,
            warnings: [tableWarning],
            stats: {
              blocks: 15,
              words: 42,
              images: 1,
              code_blocks: 1,
              latex_blocks: 1,
              links: 1,
            },
            unsupported_features: ["table"],
          },
        };
      },
    } satisfies ToolCaller;

    await expect(assertValidateNewsletterContentTool(client)).rejects.toThrow(
      "stats.blocks=15, expected 16",
    );
  });
});

function validPreviewStructured(): Record<string, unknown> {
  return {
    ok: true,
    action: "create",
    title: "[MCP SMOKE] Rich Draft Preview",
    preview_text: "Preview text.",
    warnings: [tableWarning],
    stats: {
      blocks: 16,
      words: 42,
      images: 1,
      code_blocks: 1,
      latex_blocks: 1,
    },
    confirmation_token: "payload.signature",
    confirmation_expires_at: "2026-07-08T12:15:00.000Z",
    payload_debug: {
      draft_body_doc_type: "doc",
      top_level_nodes: 16,
    },
  };
}

function previewClient(
  structuredContent: unknown,
  isError = false,
): ToolCaller {
  return {
    async callTool() {
      return {
        isError,
        structuredContent,
      };
    },
  };
}
