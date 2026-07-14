import { describe, expect, it } from "vitest";

import { createLogger } from "../../src/logging/logger.js";

describe("createLogger", () => {
  it("redacts secrets, draft payload fields, and serialized Error text", () => {
    const chunks: string[] = [];
    const logger = createLogger(
      { logLevel: "info", nodeEnv: "test" },
      {
        write: (chunk: string) => {
          chunks.push(chunk);
        },
      },
    );

    logger.info(
      {
        req: {
          headers: {
            authorization: "Bearer header-secret-token",
            cookie: "connect.sid=session-secret; substack.sid=session-secret",
          },
        },
        config: {
          sessionToken: "session-secret",
          nested: {
            previewTokenSecret: "preview-secret",
            staticBearerToken: "bearer-secret",
            mcpPathSecret: "private-path",
          },
        },
        input: {
          body_markdown: "Private draft body",
          bodyMarkdown: "Private camel body",
          confirmation_token: "preview-token-secret",
          idempotency_key: "idempotency-secret",
          image_url: "https://example.com/private-source.png",
          image_base64: "data:image/png;base64,aGk=",
        },
        response: {
          draft_body: '{"type":"doc","content":[]}',
          draftBody: '{"type":"doc","content":[{"text":"camel private"}]}',
          request_body: '{"body_markdown":"request private"}',
          rawBody: '{"raw":"private"}',
          uploadedImageUrl: "https://substackcdn.com/private-upload.png",
        },
        error: new Error(
          "Substack failed with SUBSTACK_SESSION_TOKEN=session-secret and bodyMarkdown='Private camel body' image_url=https://example.com/private-source.png",
        ),
      },
      "request failed",
    );

    const output = chunks.join("");
    const parsed = JSON.parse(output) as Record<string, unknown>;

    expect(output).toContain("[REDACTED]");
    for (const unsafe of [
      "header-secret-token",
      "session-secret",
      "preview-secret",
      "bearer-secret",
      "private-path",
      "Private draft body",
      "Private camel body",
      "preview-token-secret",
      "idempotency-secret",
      "https://example.com/private-source.png",
      "data:image/png;base64,aGk=",
      '{"type":"doc","content":[]}',
      "camel private",
      "request private",
      "https://substackcdn.com/private-upload.png",
    ]) {
      expect(output).not.toContain(unsafe);
    }

    expect(parsed.msg).toBe("request failed");
    expect(parsed.req).toEqual({
      headers: {
        authorization: "[REDACTED]",
        cookie: "[REDACTED]",
      },
    });
    expect(parsed.config).toEqual({
      sessionToken: "[REDACTED]",
      nested: {
        previewTokenSecret: "[REDACTED]",
        staticBearerToken: "[REDACTED]",
        mcpPathSecret: "[REDACTED]",
      },
    });
    expect(parsed.input).toEqual({
      body_markdown: "[REDACTED]",
      bodyMarkdown: "[REDACTED]",
      confirmation_token: "[REDACTED]",
      idempotency_key: "[REDACTED]",
      image_url: "[REDACTED]",
      image_base64: "[REDACTED]",
    });
    expect(parsed.response).toEqual({
      draft_body: "[REDACTED]",
      draftBody: "[REDACTED]",
      request_body: "[REDACTED]",
      rawBody: "[REDACTED]",
      uploadedImageUrl: "[REDACTED]",
    });
    expect(parsed.error).toMatchObject({
      type: "Error",
      message:
        "Substack failed with SUBSTACK_SESSION_TOKEN=[REDACTED] and bodyMarkdown='[REDACTED]' image_url=[REDACTED]",
    });
  });

  it("redacts string, nested-cause, and object error fields", () => {
    const chunks: string[] = [];
    const logger = createLogger(
      { logLevel: "info", nodeEnv: "test" },
      {
        write: (chunk: string) => {
          chunks.push(chunk);
        },
      },
    );
    const errorWithCause = new Error("outer failure");
    Object.defineProperty(errorWithCause, "cause", {
      value:
        "bodyMarkdown='Nested private body' idempotencyKey=nested-secret-key",
    });

    logger.info({ error: errorWithCause }, "error cause");
    logger.info(
      { error: "confirmation_token=secret.token.parts" },
      "string error",
    );
    logger.info(
      { error: { draft_body: '{"type":"doc","content":[]}' } },
      "object error",
    );

    expect(chunks).toHaveLength(3);
    const causeLog = parseLogChunk(chunks, 0);
    const stringLog = parseLogChunk(chunks, 1);
    const objectLog = parseLogChunk(chunks, 2);

    expect(causeLog.error).toMatchObject({
      type: "Error",
      message: "outer failure",
      cause: "bodyMarkdown='[REDACTED]' idempotencyKey=[REDACTED]",
    });
    expect(stringLog.error).toBe("confirmation_token=[REDACTED]");
    expect(objectLog.error).toEqual({ draft_body: "[REDACTED]" });
    expect(chunks.join("")).not.toContain("Nested private body");
    expect(chunks.join("")).not.toContain("nested-secret-key");
    expect(chunks.join("")).not.toContain("secret.token.parts");
    expect(chunks.join("")).not.toContain('{"type":"doc","content":[]}');
  });
});

function parseLogChunk(
  chunks: readonly string[],
  index: number,
): Record<string, unknown> {
  const chunk = chunks[index];
  if (chunk === undefined) {
    throw new Error(`Missing log chunk at index ${index}.`);
  }

  return JSON.parse(chunk) as Record<string, unknown>;
}
