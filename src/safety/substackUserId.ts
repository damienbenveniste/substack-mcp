export function parseOptionalSubstackUserId(
  value: string | undefined,
  fieldName = "SUBSTACK_USER_ID",
): number | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const parsed = Number(trimmed);
  if (!/^\d+$/u.test(trimmed) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }

  return parsed;
}

export function normalizeSubstackUserId(
  value: number | undefined,
  fieldName = "SUBSTACK_USER_ID",
): number | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive integer.`);
  }

  return value;
}
