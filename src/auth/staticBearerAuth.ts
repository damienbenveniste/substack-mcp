import { timingSafeEqual } from "node:crypto";

import { type AuthPrincipal, localSingleUserPrincipal } from "./principal.js";

export interface StaticBearerAuthInput {
  readonly authorizationHeader?: string | undefined;
  readonly expectedToken: string;
}

export function authorizeStaticBearer(
  input: StaticBearerAuthInput,
): AuthPrincipal | undefined {
  const token = parseBearerToken(input.authorizationHeader);
  if (!token || !tokensMatch(token, input.expectedToken)) {
    return undefined;
  }

  return localSingleUserPrincipal;
}

function parseBearerToken(value: string | undefined): string | undefined {
  const match = value?.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token ? token : undefined;
}

function tokensMatch(actual: string, expected: string): boolean {
  const actualBuffer = Buffer.from(actual, "utf8");
  const expectedBuffer = Buffer.from(expected, "utf8");
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
}
