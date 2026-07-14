export function normalizeStaticBearerToken(
  value: string | undefined,
  fieldName = "MCP_BEARER_TOKEN",
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  if (/^authorization\s*:/iu.test(trimmed) || /^bearer\s+/iu.test(trimmed)) {
    throw new Error(
      `${fieldName} must be the bearer token value only, not an Authorization header or Bearer-prefixed value.`,
    );
  }

  if (/\s/u.test(trimmed)) {
    throw new Error(
      `${fieldName} must be a single bearer token value without whitespace.`,
    );
  }

  return trimmed;
}
