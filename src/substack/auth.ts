import { normalizeSubstackSessionToken } from "../safety/substackSessionToken.js";
import { parsePublicHttpsUrl } from "../safety/urlPolicy.js";
import type { SubstackClientConfig } from "./types.js";

export function normalizePublicationUrl(publicationUrl: string): string {
  const trimmed = publicationUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error("SUBSTACK_PUBLICATION_URL is required.");
  }

  const parsed = parsePublicHttpsUrl(trimmed, "SUBSTACK_PUBLICATION_URL");
  if (!parsed.ok) {
    throw new Error(parsed.errors.join(" "));
  }

  return parsed.url.origin;
}

export function substackCookie(sessionToken: string): string {
  const normalized = normalizeSubstackSessionToken(sessionToken);
  if (!normalized) {
    throw new Error("SUBSTACK_SESSION_TOKEN is required.");
  }

  return `connect.sid=${normalized}; substack.sid=${normalized};`;
}

export function buildSubstackHeaders(
  config: Pick<
    SubstackClientConfig,
    "publicationUrl" | "sessionToken" | "userAgent"
  >,
  hasJsonBody: boolean,
): Headers {
  const publicationOrigin = normalizePublicationUrl(config.publicationUrl);
  const headers = new Headers({
    Cookie: substackCookie(config.sessionToken),
    "User-Agent": config.userAgent,
    Accept: "application/json, text/plain, */*",
    Referer: `${publicationOrigin}/publish/home`,
  });

  if (hasJsonBody) {
    headers.set("Content-Type", "application/json");
  }

  return headers;
}
