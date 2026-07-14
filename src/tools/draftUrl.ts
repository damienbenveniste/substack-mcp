import { parseHttpUrl } from "../safety/urlPolicy.js";

export const OMITTED_UNSAFE_DRAFT_URL_WARNING =
  "Substack returned an invalid or unsafe draft URL; omitted draft_url from the result.";

export function toSafeDraftUrl(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const parsed = parseHttpUrl(value, "draft URL");
  return parsed.ok ? parsed.url.toString() : undefined;
}

export function addDraftUrlWarningIfUnsafe(
  value: string | undefined,
  warnings: Set<string>,
): void {
  if (value !== undefined && toSafeDraftUrl(value) === undefined) {
    warnings.add(OMITTED_UNSAFE_DRAFT_URL_WARNING);
  }
}
