import pino, { type DestinationStream } from "pino";

import type { AppConfig } from "../config.js";
import { redactLogSensitiveText } from "../safety/redaction.js";

const REDACT_FIELD_NAMES = [
  "authorization",
  "authorizationHeader",
  "bodyJson",
  "bodyMarkdown",
  "body_json",
  "cookie",
  "draftBody",
  "draftJson",
  "draft_body",
  "draft_json",
  "idempotencyKey",
  "idempotency_key",
  "imageUrl",
  "image_base64",
  "image_url",
  "mcpPathSecret",
  "rawBody",
  "raw_body",
  "requestBody",
  "request_body",
  "sessionToken",
  "previewTokenSecret",
  "staticBearerToken",
  "uploadedImageUrl",
  "uploaded_image_url",
  "SUBSTACK_SESSION_TOKEN",
  "PREVIEW_TOKEN_SECRET",
  "MCP_BEARER_TOKEN",
  "MCP_PATH_SECRET",
  "body_markdown",
  "confirmation_token",
] as const;

const REDACT_PATHS = [
  "req.headers.cookie",
  "req.headers.authorization",
  "req.headers.Authorization",
  "headers.cookie",
  "headers.authorization",
  "headers.Authorization",
  ...REDACT_FIELD_NAMES.flatMap((field) => [
    field,
    `*.${field}`,
    `*.*.${field}`,
    `*.*.*.${field}`,
  ]),
];

export function createLogger(
  config: Pick<AppConfig, "logLevel" | "nodeEnv">,
  destination?: DestinationStream | undefined,
) {
  const options = {
    level: config.logLevel,
    base: {
      service: "substack-draft-mcp",
      env: config.nodeEnv,
    },
    redact: {
      paths: REDACT_PATHS,
      censor: "[REDACTED]",
    },
    serializers: {
      err: serializeError,
      error: serializeError,
    },
  };

  return destination ? pino(options, destination) : pino(options);
}

function serializeError(error: unknown): unknown {
  if (error instanceof Error) {
    const serialized: Record<string, unknown> = {
      type: error.name,
      message: redactLogSensitiveText(error.message),
    };
    if (error.stack) {
      serialized.stack = redactLogSensitiveText(error.stack);
    }
    if (error.cause !== undefined) {
      serialized.cause = serializeError(error.cause);
    }
    return serialized;
  }

  if (typeof error === "string") {
    return redactLogSensitiveText(error);
  }

  return error;
}
