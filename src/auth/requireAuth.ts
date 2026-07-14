import type { AppConfig } from "../config.js";
import { normalizeStaticBearerToken } from "../safety/staticBearerToken.js";
import { authorizeNoAuth } from "./noAuth.js";
import {
  assertOAuthConfig,
  authorizeOAuthBearer,
  buildOAuthBearerChallenge,
} from "./oauth.js";
import type { AuthPrincipal } from "./principal.js";
import { authorizeStaticBearer } from "./staticBearerAuth.js";

export interface AuthRequest {
  readonly authorizationHeader?: string | undefined;
}

export interface AuthSuccess {
  readonly ok: true;
  readonly principal: AuthPrincipal;
}

export interface AuthFailure {
  readonly ok: false;
  readonly status: 401;
  readonly body: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export type AuthResult = AuthSuccess | AuthFailure;

type AuthConfig = Pick<
  AppConfig,
  | "authMode"
  | "staticBearerToken"
  | "publicBaseUrl"
  | "oauthAuthorizationServerUrl"
  | "oauthResourceDocumentationUrl"
  | "oauthJwksUrl"
> & {
  readonly oauthJwtAlgorithms?: readonly string[] | undefined;
};

export function assertHttpAuthConfig(config: AuthConfig): void {
  if (config.authMode === "static_bearer") {
    const token = normalizeStaticBearerToken(config.staticBearerToken);
    if (!token) {
      throw new Error(
        "MCP_BEARER_TOKEN is required when AUTH_MODE=static_bearer.",
      );
    }
  }
  if (config.authMode === "oauth") {
    assertOAuthConfig(config);
  }
}

export async function requireAuth(
  request: AuthRequest,
  config: AuthConfig,
): Promise<AuthResult> {
  switch (config.authMode) {
    case "noauth":
      return {
        ok: true,
        principal: authorizeNoAuth(),
      };

    case "static_bearer": {
      const principal = config.staticBearerToken
        ? authorizeStaticBearer({
            authorizationHeader: request.authorizationHeader,
            expectedToken: config.staticBearerToken,
          })
        : undefined;

      if (principal) {
        return {
          ok: true,
          principal,
        };
      }

      return bearerUnauthorized();
    }

    case "oauth":
      return await requireOAuth(request, config);
  }
}

function bearerUnauthorized(): AuthFailure {
  return {
    ok: false,
    status: 401,
    body: "Unauthorized",
    headers: {
      "WWW-Authenticate": 'Bearer realm="substack-draft-mcp"',
    },
  };
}

function oauthUnauthorized(
  config: Pick<AppConfig, "publicBaseUrl">,
): AuthFailure {
  return {
    ok: false,
    status: 401,
    body: "Unauthorized",
    headers: {
      "WWW-Authenticate": buildOAuthBearerChallenge(config),
    },
  };
}

async function requireOAuth(
  request: AuthRequest,
  config: AuthConfig,
): Promise<AuthResult> {
  const principal = await authorizeOAuthBearer(
    { authorizationHeader: request.authorizationHeader },
    config,
  );
  if (principal) {
    return {
      ok: true,
      principal,
    };
  }

  return oauthUnauthorized(config);
}
