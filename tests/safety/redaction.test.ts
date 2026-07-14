import { describe, expect, it } from "vitest";

import {
  redactLogSensitiveText,
  redactResponseBodyText,
  redactSecrets,
} from "../../src/safety/redaction.js";

describe("redactSecrets", () => {
  it("redacts Substack session cookies", () => {
    expect(
      redactSecrets(
        'cookie: connect.sid=connect-secret; substack.sid="substack-secret"; other=value',
      ),
    ).toBe("cookie: [REDACTED]; [REDACTED]; other=value");
  });

  it("redacts bearer tokens without redacting surrounding log text", () => {
    expect(
      redactSecrets("Authorization: Bearer abc.def_ghi-jkl+/= request failed"),
    ).toBe("Authorization: [REDACTED] request failed");
  });

  it("redacts env-style secret assignments", () => {
    expect(
      redactSecrets(
        "SUBSTACK_SESSION_TOKEN=session PREVIEW_TOKEN_SECRET='preview secret' MCP_BEARER_TOKEN=\"bearer secret\" MCP_PATH_SECRET=private-path",
      ),
    ).toBe(
      "SUBSTACK_SESSION_TOKEN=[REDACTED] PREVIEW_TOKEN_SECRET='[REDACTED]' MCP_BEARER_TOKEN=\"[REDACTED]\" MCP_PATH_SECRET=[REDACTED]",
    );
  });

  it("redacts private MCP path URL segments", () => {
    expect(
      redactSecrets(
        "https://example.com/mcp/private-path?x=1 http://localhost:8787/mcp /mcp/<redacted>",
      ),
    ).toBe(
      "https://example.com/mcp/[REDACTED]?x=1 http://localhost:8787/mcp /mcp/<redacted>",
    );
  });

  it("redacts JSON-style secret fields from response bodies", () => {
    expect(
      redactSecrets(
        '{"SUBSTACK_SESSION_TOKEN":"session","PREVIEW_TOKEN_SECRET":"preview","MCP_BEARER_TOKEN":"bearer","safe":"value"}',
      ),
    ).toBe(
      '{"SUBSTACK_SESSION_TOKEN":"[REDACTED]","PREVIEW_TOKEN_SECRET":"[REDACTED]","MCP_BEARER_TOKEN":"[REDACTED]","safe":"value"}',
    );
  });

  it("redacts draft content and payload fields from log text", () => {
    expect(
      redactLogSensitiveText(
        'bodyMarkdown="private draft" draftBody=\'{"type":"doc"}\' request_body="{\\"body\\":\\"private\\"}" rawBody=private idempotency_key=client-secret confirmation_token=token.secret image_url=https://example.com/private.png image_base64=data:image/png;base64,aGk= uploadedImageUrl=https://substackcdn.com/uploaded.png',
      ),
    ).toBe(
      'bodyMarkdown="[REDACTED]" draftBody=\'[REDACTED]\' request_body="[REDACTED]" rawBody=[REDACTED] idempotency_key=[REDACTED] confirmation_token=[REDACTED] image_url=[REDACTED] image_base64=[REDACTED] uploadedImageUrl=[REDACTED]',
    );
  });

  it("redacts draft content fields from JSON response bodies", () => {
    expect(
      redactResponseBodyText(
        JSON.stringify({
          error: "validation failed",
          details: {
            draft_body: { type: "doc", content: [{ text: "private body" }] },
            draftBody: { type: "doc", content: [{ text: "camel body" }] },
            request_body: { body_markdown: "request body" },
            rawBody: "raw private body",
            idempotency_key: "client-secret",
            content: "private content",
            nested: [
              {
                body_markdown: "private markdown",
                imageUrl: "https://example.com/private.png",
              },
            ],
          },
          confirmation_token: "token.secret",
          image: "data:image/png;base64,aGk=",
          uploadedImageUrl: "https://substackcdn.com/private-upload.png",
          safe: "visible",
        }),
      ),
    ).toBe(
      JSON.stringify({
        error: "validation failed",
        details: {
          draft_body: "[REDACTED]",
          draftBody: "[REDACTED]",
          request_body: "[REDACTED]",
          rawBody: "[REDACTED]",
          idempotency_key: "[REDACTED]",
          content: "[REDACTED]",
          nested: [
            {
              body_markdown: "[REDACTED]",
              imageUrl: "[REDACTED]",
            },
          ],
        },
        confirmation_token: "[REDACTED]",
        image: "[REDACTED]",
        uploadedImageUrl: "[REDACTED]",
        safe: "visible",
      }),
    );
  });

  it("redacts draft content fields from text response bodies", () => {
    expect(
      redactResponseBodyText(
        'draft_body="{\\"type\\":\\"doc\\",\\"content\\":[{\\"text\\":\\"private\\"}]}" body=private',
      ),
    ).not.toContain("private");
  });

  it("keeps draft content field names visible for evidence diagnostics", () => {
    expect(redactSecrets('{"draft_body":{"type":"doc"}}')).toBe(
      '{"draft_body":{"type":"doc"}}',
    );
  });

  it("leaves non-secret content unchanged", () => {
    expect(redactSecrets("draft_id=123 status=ok")).toBe(
      "draft_id=123 status=ok",
    );
    expect(redactSecrets("Remote static bearer smoke passed.")).toBe(
      "Remote static bearer smoke passed.",
    );
  });
});
