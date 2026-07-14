import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertHttpAuthConfig,
  requireAuth,
} from "../../src/auth/requireAuth.js";
import type { AuthMode } from "../../src/config.js";

function authConfig(
  authMode: AuthMode,
  staticBearerToken?: string,
): Parameters<typeof requireAuth>[1] {
  return { authMode, staticBearerToken };
}

function oauthConfig(
  overrides: Partial<Parameters<typeof requireAuth>[1]> = {},
): Parameters<typeof requireAuth>[1] {
  return {
    authMode: "oauth",
    publicBaseUrl: "https://mcp.example.test",
    oauthAuthorizationServerUrl: "https://auth.example.test",
    oauthJwksUrl: "https://auth.example.test/jwks.json",
    oauthJwtAlgorithms: ["RS256"],
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("requireAuth", () => {
  it("allows noauth and returns the local single-user principal", async () => {
    const result = await requireAuth({}, authConfig("noauth"));

    expect(result).toEqual({
      ok: true,
      principal: {
        userId: "local-single-user",
        scopes: ["drafts:read", "drafts:write", "images:write"],
      },
    });
  });

  it("requires an exact bearer token in static_bearer mode", async () => {
    expect(
      await requireAuth(
        { authorizationHeader: "Bearer correct-token" },
        authConfig("static_bearer", "correct-token"),
      ),
    ).toMatchObject({ ok: true });

    expect(
      await requireAuth(
        { authorizationHeader: "Bearer wrong-token" },
        authConfig("static_bearer", "correct-token"),
      ),
    ).toEqual({
      ok: false,
      status: 401,
      body: "Unauthorized",
      headers: {
        "WWW-Authenticate": 'Bearer realm="substack-draft-mcp"',
      },
    });
  });

  it("parses static bearer auth case-insensitively but rejects malformed and partial tokens", async () => {
    expect(
      await requireAuth(
        { authorizationHeader: "bearer  correct-token  " },
        authConfig("static_bearer", "correct-token"),
      ),
    ).toMatchObject({ ok: true });

    for (const authorizationHeader of [
      "Basic correct-token",
      "Bearer correct-token-extra",
      "Bearer",
      "Bearer ",
    ]) {
      expect(
        await requireAuth(
          { authorizationHeader },
          authConfig("static_bearer", "correct-token"),
        ),
      ).toMatchObject({ ok: false, status: 401 });
    }
  });

  it("rejects missing bearer auth in static_bearer mode", async () => {
    expect(
      await requireAuth({}, authConfig("static_bearer", "secret")),
    ).toEqual({
      ok: false,
      status: 401,
      body: "Unauthorized",
      headers: {
        "WWW-Authenticate": 'Bearer realm="substack-draft-mcp"',
      },
    });
  });

  it("validates static_bearer startup configuration", () => {
    expect(() => assertHttpAuthConfig(authConfig("static_bearer"))).toThrow(
      "MCP_BEARER_TOKEN is required when AUTH_MODE=static_bearer.",
    );

    expect(() =>
      assertHttpAuthConfig(authConfig("static_bearer", "secret")),
    ).not.toThrow();
    expect(() =>
      assertHttpAuthConfig(authConfig("static_bearer", "Bearer secret")),
    ).toThrow(
      "MCP_BEARER_TOKEN must be the bearer token value only, not an Authorization header or Bearer-prefixed value.",
    );
  });

  it("validates OAuth startup metadata configuration", () => {
    expect(() => assertHttpAuthConfig(authConfig("oauth"))).toThrow(
      "MCP_PUBLIC_BASE_URL is required when AUTH_MODE=oauth.",
    );
    expect(() =>
      assertHttpAuthConfig(
        oauthConfig({ oauthAuthorizationServerUrl: undefined }),
      ),
    ).toThrow(
      "OAUTH_AUTHORIZATION_SERVER_URL is required when AUTH_MODE=oauth.",
    );
    expect(() =>
      assertHttpAuthConfig(oauthConfig({ oauthJwksUrl: undefined })),
    ).toThrow("OAUTH_JWKS_URL is required when AUTH_MODE=oauth.");
    expect(() =>
      assertHttpAuthConfig(oauthConfig({ publicBaseUrl: "http://mcp.test" })),
    ).toThrow("MCP_PUBLIC_BASE_URL must be an absolute https URL.");
    expect(() =>
      assertHttpAuthConfig(
        oauthConfig({ publicBaseUrl: "https://user:pass@mcp.test" }),
      ),
    ).toThrow("MCP_PUBLIC_BASE_URL must not include username or password.");
    expect(() =>
      assertHttpAuthConfig(
        oauthConfig({
          oauthAuthorizationServerUrl: "https://user:pass@auth.test",
        }),
      ),
    ).toThrow(
      "OAUTH_AUTHORIZATION_SERVER_URL must not include username or password.",
    );
    expect(() =>
      assertHttpAuthConfig(
        oauthConfig({ oauthResourceDocumentationUrl: "http://docs.test" }),
      ),
    ).toThrow(
      "OAUTH_RESOURCE_DOCUMENTATION_URL must be an absolute https URL.",
    );
    expect(() =>
      assertHttpAuthConfig(
        oauthConfig({
          oauthResourceDocumentationUrl: "https://user:pass@docs.test",
        }),
      ),
    ).toThrow(
      "OAUTH_RESOURCE_DOCUMENTATION_URL must not include username or password.",
    );
    expect(() =>
      assertHttpAuthConfig(
        oauthConfig({ oauthJwksUrl: "https://user:pass@auth.test/jwks.json" }),
      ),
    ).toThrow("OAUTH_JWKS_URL must not include username or password.");
    expect(() =>
      assertHttpAuthConfig(oauthConfig({ oauthJwtAlgorithms: ["HS256"] })),
    ).toThrow(
      "OAUTH_JWT_ALGORITHMS contains unsupported or unsafe algorithm(s): HS256.",
    );
    expect(() =>
      assertHttpAuthConfig(
        oauthConfig({ oauthJwtAlgorithms: ["RS256", "none"] }),
      ),
    ).toThrow(
      "OAUTH_JWT_ALGORITHMS contains unsupported or unsafe algorithm(s): none.",
    );
    expect(() => assertHttpAuthConfig(oauthConfig())).not.toThrow();
    expect(() =>
      assertHttpAuthConfig(
        oauthConfig({ oauthJwtAlgorithms: [" RS256 ", "ES256", "RS256"] }),
      ),
    ).not.toThrow();
  });

  it("returns an OAuth bearer challenge when no valid token is present", async () => {
    expect(await requireAuth({}, oauthConfig())).toEqual({
      ok: false,
      status: 401,
      body: "Unauthorized",
      headers: {
        "WWW-Authenticate":
          'Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource", scope="drafts:read drafts:write images:write"',
      },
    });
  });

  it("accepts a valid OAuth JWT bearer token and returns scoped principal", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = {
      ...(await exportJWK(publicKey)),
      kid: "require-auth-key",
      alg: "RS256",
    } satisfies JWK;
    const token = await new SignJWT({ scope: "drafts:read" })
      .setProtectedHeader({ alg: "RS256", kid: "require-auth-key" })
      .setIssuer("https://auth-require.example.test")
      .setAudience("https://mcp.example.test")
      .setSubject("oauth-user-123")
      .setExpirationTime("1h")
      .sign(privateKey);

    vi.stubGlobal("fetch", async (input: unknown) => {
      expect(String(input)).toBe("https://auth-require.example.test/jwks.json");
      return new Response(JSON.stringify({ keys: [jwk] }), {
        headers: { "content-type": "application/json" },
      });
    });

    await expect(
      requireAuth(
        { authorizationHeader: `Bearer ${token}` },
        oauthConfig({
          oauthAuthorizationServerUrl: "https://auth-require.example.test",
          oauthJwksUrl: "https://auth-require.example.test/jwks.json",
        }),
      ),
    ).resolves.toEqual({
      ok: true,
      principal: {
        userId: "oauth-user-123",
        scopes: ["drafts:read"],
      },
    });
  });
});
