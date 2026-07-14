import { createRemoteJWKSet, type JWTPayload, jwtVerify } from "jose";

import type { AppConfig } from "../config.js";
import type { AuthPrincipal } from "./principal.js";
import { type AuthScope, authScopes } from "./scopes.js";

export const oauthProtectedResourcePath =
  "/.well-known/oauth-protected-resource";

export interface OAuthProtectedResourceMetadata {
  readonly resource: string;
  readonly authorization_servers: readonly string[];
  readonly scopes_supported: readonly AuthScope[];
  readonly resource_documentation?: string | undefined;
}

export type OAuthConfig = Pick<
  AppConfig,
  | "publicBaseUrl"
  | "oauthAuthorizationServerUrl"
  | "oauthResourceDocumentationUrl"
  | "oauthJwksUrl"
> & {
  readonly oauthJwtAlgorithms?: readonly string[] | undefined;
};

export interface OAuthBearerAuthInput {
  readonly authorizationHeader?: string | undefined;
}

export type OAuthJwtVerifier = (
  token: string,
  config: OAuthConfig,
) => Promise<JWTPayload>;

const remoteJwksCache = new Map<
  string,
  ReturnType<typeof createRemoteJWKSet>
>();
const SAFE_OAUTH_JWT_ALGORITHMS = [
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
] as const;
const SAFE_OAUTH_JWT_ALGORITHM_SET = new Set<string>(SAFE_OAUTH_JWT_ALGORITHMS);

export function assertOAuthConfig(config: OAuthConfig): void {
  if (!config.publicBaseUrl) {
    throw new Error("MCP_PUBLIC_BASE_URL is required when AUTH_MODE=oauth.");
  }
  if (!config.oauthAuthorizationServerUrl) {
    throw new Error(
      "OAUTH_AUTHORIZATION_SERVER_URL is required when AUTH_MODE=oauth.",
    );
  }
  if (!config.oauthJwksUrl) {
    throw new Error("OAUTH_JWKS_URL is required when AUTH_MODE=oauth.");
  }
  if (!config.oauthJwtAlgorithms || config.oauthJwtAlgorithms.length === 0) {
    throw new Error("OAUTH_JWT_ALGORITHMS must contain at least one value.");
  }
  normalizeOAuthJwtAlgorithms(config.oauthJwtAlgorithms);

  assertHttpsUrl(config.publicBaseUrl, "MCP_PUBLIC_BASE_URL");
  assertHttpsUrl(
    config.oauthAuthorizationServerUrl,
    "OAUTH_AUTHORIZATION_SERVER_URL",
  );
  assertHttpsUrl(config.oauthJwksUrl, "OAUTH_JWKS_URL");
  if (config.oauthResourceDocumentationUrl) {
    assertHttpsUrl(
      config.oauthResourceDocumentationUrl,
      "OAUTH_RESOURCE_DOCUMENTATION_URL",
    );
  }
}

export function buildOAuthProtectedResourceMetadata(
  config: OAuthConfig,
): OAuthProtectedResourceMetadata {
  assertOAuthConfig(config);
  const authorizationServerUrl = requireString(
    config.oauthAuthorizationServerUrl,
    "OAUTH_AUTHORIZATION_SERVER_URL",
  );

  return {
    resource: getOAuthResource(config),
    authorization_servers: [authorizationServerUrl],
    scopes_supported: authScopes,
    resource_documentation: config.oauthResourceDocumentationUrl,
  };
}

export async function authorizeOAuthBearer(
  input: OAuthBearerAuthInput,
  config: OAuthConfig,
  verifyJwt: OAuthJwtVerifier = verifyOAuthAccessToken,
): Promise<AuthPrincipal | undefined> {
  const token = parseBearerToken(input.authorizationHeader);
  if (!token) {
    return undefined;
  }

  const payload = await verifyJwt(token, config).catch(() => undefined);
  if (!payload || typeof payload.sub !== "string") {
    return undefined;
  }

  const scopes = extractRecognizedScopes(payload);
  if (scopes.length === 0) {
    return undefined;
  }

  return {
    userId: payload.sub,
    scopes,
  };
}

export function getOAuthProtectedResourceMetadataUrl(
  config: Pick<AppConfig, "publicBaseUrl">,
): string {
  if (!config.publicBaseUrl) {
    throw new Error("MCP_PUBLIC_BASE_URL is required when AUTH_MODE=oauth.");
  }

  return `${getOAuthResource(config)}${oauthProtectedResourcePath}`;
}

export function buildOAuthBearerChallenge(
  config: Pick<AppConfig, "publicBaseUrl">,
): string {
  return [
    `Bearer resource_metadata="${getOAuthProtectedResourceMetadataUrl(config)}"`,
    `scope="${authScopes.join(" ")}"`,
  ].join(", ");
}

export async function verifyOAuthAccessToken(
  token: string,
  config: OAuthConfig,
): Promise<JWTPayload> {
  assertOAuthConfig(config);
  const jwksUrl = requireString(config.oauthJwksUrl, "OAUTH_JWKS_URL");
  const algorithms = normalizeOAuthJwtAlgorithms(config.oauthJwtAlgorithms);
  const { payload } = await jwtVerify(token, getRemoteJwks(jwksUrl), {
    issuer: requireString(
      config.oauthAuthorizationServerUrl,
      "OAUTH_AUTHORIZATION_SERVER_URL",
    ),
    audience: getOAuthResource(config),
    algorithms,
    requiredClaims: ["sub", "exp"],
  });

  return payload;
}

export function extractRecognizedScopes(payload: JWTPayload): AuthScope[] {
  const granted = new Set<string>();
  addScopeValues(granted, payload.scope);
  addScopeValues(granted, payload.scp);

  return authScopes.filter((scope) => granted.has(scope));
}

function getOAuthResource(config: Pick<AppConfig, "publicBaseUrl">): string {
  if (!config.publicBaseUrl) {
    throw new Error("MCP_PUBLIC_BASE_URL is required when AUTH_MODE=oauth.");
  }

  return new URL(config.publicBaseUrl).origin;
}

function getRemoteJwks(jwksUrl: string): ReturnType<typeof createRemoteJWKSet> {
  const cached = remoteJwksCache.get(jwksUrl);
  if (cached) {
    return cached;
  }

  const jwks = createRemoteJWKSet(new URL(jwksUrl));
  remoteJwksCache.set(jwksUrl, jwks);
  return jwks;
}

function parseBearerToken(value: string | undefined): string | undefined {
  const match = value?.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1]?.trim();
  return token ? token : undefined;
}

function addScopeValues(target: Set<string>, value: unknown): void {
  if (typeof value === "string") {
    for (const scope of value.split(/\s+/).filter(Boolean)) {
      target.add(scope);
    }
    return;
  }

  if (Array.isArray(value)) {
    for (const scope of value) {
      if (typeof scope === "string" && scope.trim()) {
        target.add(scope.trim());
      }
    }
  }
}

function assertHttpsUrl(value: string, name: string): void {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error(`${name} must be an absolute https URL.`);
  }
  if (url.username || url.password) {
    throw new Error(`${name} must not include username or password.`);
  }
}

function requireString(value: string | undefined, name: string): string {
  if (!value) {
    throw new Error(`${name} is required when AUTH_MODE=oauth.`);
  }

  return value;
}

export function normalizeOAuthJwtAlgorithms(
  value: readonly string[] | undefined,
): string[] {
  if (!value || value.length === 0) {
    throw new Error("OAUTH_JWT_ALGORITHMS must contain at least one value.");
  }

  const algorithms = value.map((algorithm) => algorithm.trim()).filter(Boolean);
  if (algorithms.length === 0) {
    throw new Error("OAUTH_JWT_ALGORITHMS must contain at least one value.");
  }

  const unsupported = algorithms.filter(
    (algorithm) => !SAFE_OAUTH_JWT_ALGORITHM_SET.has(algorithm),
  );
  if (unsupported.length > 0) {
    throw new Error(
      `OAUTH_JWT_ALGORITHMS contains unsupported or unsafe algorithm(s): ${unsupported.join(", ")}. Allowed algorithms: ${SAFE_OAUTH_JWT_ALGORITHMS.join(", ")}.`,
    );
  }

  return [...new Set(algorithms)];
}
