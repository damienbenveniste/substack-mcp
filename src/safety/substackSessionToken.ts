export function normalizeSubstackSessionToken(
  value: string | undefined,
  fieldName = "SUBSTACK_SESSION_TOKEN",
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  if (
    /^cookie\s*:/iu.test(trimmed) ||
    /\b(?:connect\.sid|substack\.sid)\s*=/iu.test(trimmed)
  ) {
    throw new Error(
      `${fieldName} must be the cookie value only, not a Cookie header or name=value pair.`,
    );
  }

  if (/[\s;]/u.test(trimmed)) {
    throw new Error(
      `${fieldName} must be a single cookie value without whitespace or semicolons.`,
    );
  }

  return trimmed;
}
