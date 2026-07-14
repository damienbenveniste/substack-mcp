const COOKIE_SECRET_PATTERNS: readonly RegExp[] = [
  /connect\.sid=(?:"[^"]*"|'[^']*'|[^;\s"]+)/gi,
  /substack\.sid=(?:"[^"]*"|'[^']*'|[^;\s"]+)/gi,
];

const AUTHORIZATION_BEARER_SECRET_PATTERN =
  /(\bAuthorization\b\s*:\s*)Bearer\s+(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi;

const BEARER_SECRET_PATTERN = /Bearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi;

const ENV_SECRET_PATTERN =
  /(\b(?:SUBSTACK_SESSION_TOKEN|PREVIEW_TOKEN_SECRET|MCP_BEARER_TOKEN|MCP_PATH_SECRET)\b"?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi;

const MCP_PATH_SECRET_URL_PATTERN =
  /(\/mcp\/)(?!<redacted>(?:[/?#"'\\\s,}]|$))[A-Za-z0-9._~-]+/gi;

const DRAFT_CONTENT_FIELD_PATTERN =
  /(\b(?:body|body_html|body_json|body_markdown|bodyJson|bodyMarkdown|confirmation_token|content|draft_body|draft_json|draftBody|draftJson|idempotency_key|idempotencyKey|image|image_base64|image_url|imageBase64|imageUrl|raw_body|rawBody|request_body|requestBody|uploaded_image_url|uploadedImageUrl)\b"?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s}]+)/gi;

const RESPONSE_BODY_FIELD_NAMES = new Set([
  "body",
  "body_html",
  "body_json",
  "body_markdown",
  "bodyjson",
  "bodymarkdown",
  "confirmation_token",
  "content",
  "draft_body",
  "draft_json",
  "draftbody",
  "draftjson",
  "idempotency_key",
  "idempotencykey",
  "image",
  "image_base64",
  "image_url",
  "imagebase64",
  "imageurl",
  "raw_body",
  "rawbody",
  "request_body",
  "requestbody",
  "uploaded_image_url",
  "uploadedimageurl",
]);

export function redactSecrets(value: string): string {
  const withoutCookies = COOKIE_SECRET_PATTERNS.reduce(
    (redacted, pattern) => redacted.replace(pattern, "[REDACTED]"),
    value,
  );
  const withoutAuthorizationBearer = withoutCookies.replace(
    AUTHORIZATION_BEARER_SECRET_PATTERN,
    (_match, prefix: string) => `${prefix}[REDACTED]`,
  );
  const withoutBearer = withoutAuthorizationBearer.replace(
    BEARER_SECRET_PATTERN,
    "[REDACTED]",
  );

  const withoutEnvSecrets = withoutBearer.replace(
    ENV_SECRET_PATTERN,
    redactFieldValue,
  );

  return withoutEnvSecrets.replace(
    MCP_PATH_SECRET_URL_PATTERN,
    (_match, prefix: string) => `${prefix}[REDACTED]`,
  );
}

export function redactLogSensitiveText(value: string): string {
  const withoutSecrets = redactSecrets(value);

  return withoutSecrets.replace(DRAFT_CONTENT_FIELD_PATTERN, redactFieldValue);
}

export function redactResponseBodyText(value: string): string {
  const parsed = parseJson(value);
  if (parsed.parsed) {
    return redactLogSensitiveText(
      JSON.stringify(redactResponseBodyFields(parsed.value)),
    );
  }

  return redactLogSensitiveText(value);
}

function redactFieldValue(match: string, prefix: string): string {
  const value = match.slice(prefix.length);
  const quote = value.startsWith('"') ? '"' : value.startsWith("'") ? "'" : "";

  return `${prefix}${quote}[REDACTED]${quote}`;
}

function redactResponseBodyFields(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactResponseBodyFields(item));
  }

  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        isResponseBodyFieldName(key)
          ? "[REDACTED]"
          : redactResponseBodyFields(entry),
      ]),
    );
  }

  return value;
}

function isResponseBodyFieldName(key: string): boolean {
  return RESPONSE_BODY_FIELD_NAMES.has(key.trim().toLowerCase());
}

function parseJson(
  value: string,
):
  | { readonly parsed: true; readonly value: unknown }
  | { readonly parsed: false } {
  try {
    return { parsed: true, value: JSON.parse(value) as unknown };
  } catch {
    return { parsed: false };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
