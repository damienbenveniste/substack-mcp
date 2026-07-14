import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  authorizeOAuthBearer,
  extractRecognizedScopes,
  type OAuthConfig,
  type OAuthJwtVerifier,
  verifyOAuthAccessToken,
} from "../../src/auth/oauth.js";

const oauthConfig: OAuthConfig = {
  publicBaseUrl: "https://mcp.example.test",
  oauthAuthorizationServerUrl: "https://auth.example.test",
  oauthJwksUrl: "https://auth.example.test/jwks.json",
  oauthJwtAlgorithms: ["RS256"],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("extractRecognizedScopes", () => {
  it("accepts scope strings and scp arrays while ignoring unknown scopes", () => {
    expect(
      extractRecognizedScopes({
        scope: "drafts:read profile",
        scp: ["drafts:write", "unknown", "images:write"],
      }),
    ).toEqual(["drafts:read", "drafts:write", "images:write"]);
  });

  it("accepts scp strings", () => {
    expect(
      extractRecognizedScopes({
        scp: "images:write unknown",
      }),
    ).toEqual(["images:write"]);
  });
});

describe("authorizeOAuthBearer", () => {
  it("returns a scoped principal from a verified bearer token", async () => {
    const verifyJwt: OAuthJwtVerifier = async (token, config) => {
      expect(token).toBe("valid-token");
      expect(config).toBe(oauthConfig);
      return {
        sub: "user-123",
        iss: "https://auth.example.test",
        aud: "https://mcp.example.test",
        exp: 4_102_444_800,
        scope: "drafts:read images:write",
      };
    };

    await expect(
      authorizeOAuthBearer(
        { authorizationHeader: "Bearer valid-token" },
        oauthConfig,
        verifyJwt,
      ),
    ).resolves.toEqual({
      userId: "user-123",
      scopes: ["drafts:read", "images:write"],
    });
  });

  it("rejects malformed headers, failed verification, missing subject, and unknown scopes", async () => {
    const rejectingVerifier: OAuthJwtVerifier = async () => {
      throw new Error("invalid token");
    };
    const missingSubjectVerifier: OAuthJwtVerifier = async () => ({
      exp: 4_102_444_800,
      scope: "drafts:read",
    });
    const unknownScopesVerifier: OAuthJwtVerifier = async () => ({
      sub: "user-123",
      exp: 4_102_444_800,
      scope: "profile email",
    });

    await expect(
      authorizeOAuthBearer(
        { authorizationHeader: "Basic abc" },
        oauthConfig,
        rejectingVerifier,
      ),
    ).resolves.toBeUndefined();
    await expect(
      authorizeOAuthBearer(
        { authorizationHeader: "Bearer invalid" },
        oauthConfig,
        rejectingVerifier,
      ),
    ).resolves.toBeUndefined();
    await expect(
      authorizeOAuthBearer(
        { authorizationHeader: "Bearer missing-sub" },
        oauthConfig,
        missingSubjectVerifier,
      ),
    ).resolves.toBeUndefined();
    await expect(
      authorizeOAuthBearer(
        { authorizationHeader: "Bearer unknown-scopes" },
        oauthConfig,
        unknownScopesVerifier,
      ),
    ).resolves.toBeUndefined();
  });
});

describe("verifyOAuthAccessToken", () => {
  it("verifies a signed JWT through remote JWKS with issuer and audience checks", async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = await publicJwk(publicKey, {
      kid: "test-key",
      alg: "RS256",
    });
    const token = await new SignJWT({ scope: "drafts:read" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer("https://auth-rs.example.test")
      .setAudience("https://mcp.example.test")
      .setSubject("user-123")
      .setExpirationTime("1h")
      .sign(privateKey);
    const config = {
      ...oauthConfig,
      oauthAuthorizationServerUrl: "https://auth-rs.example.test",
      oauthJwksUrl: "https://auth-rs.example.test/jwks.json",
    };

    vi.stubGlobal("fetch", async (input: unknown) => {
      expect(String(input)).toBe("https://auth-rs.example.test/jwks.json");
      return new Response(JSON.stringify({ keys: [jwk] }), {
        headers: { "content-type": "application/json" },
      });
    });

    await expect(verifyOAuthAccessToken(token, config)).resolves.toMatchObject({
      iss: "https://auth-rs.example.test",
      aud: "https://mcp.example.test",
      sub: "user-123",
      scope: "drafts:read",
    });
    await expect(verifyOAuthAccessToken(token, config)).resolves.toMatchObject({
      sub: "user-123",
    });
  });
});

async function publicJwk(
  publicKey: Parameters<typeof exportJWK>[0],
  header: Pick<JWK, "alg" | "kid">,
): Promise<JWK> {
  return {
    ...(await exportJWK(publicKey)),
    ...header,
  };
}
