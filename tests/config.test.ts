import { describe, expect, it } from "vitest";

import {
  assertMcpTransportConfig,
  assertRuntimeSecretConfig,
  DEFAULT_PREVIEW_TOKEN_SECRET,
  DEFAULT_SUBSTACK_REQUEST_TIMEOUT_MS,
  DEFAULT_USER_AGENT,
  getMcpPath,
  loadConfig,
  loadLocalEnvFiles,
  loadLocalSubstackAuthFile,
} from "../src/config.js";

describe("loadConfig", () => {
  it("loads env files by default through the configured loader", () => {
    let loadCount = 0;

    loadConfig(
      {},
      {
        loadEnv: () => {
          loadCount += 1;
        },
      },
    );

    expect(loadCount).toBe(1);
  });

  it("loads .env.local, generated auth, then .env without overriding existing values", () => {
    const calls: unknown[] = [];

    loadLocalEnvFiles(
      (options) => {
        calls.push(options ?? {});
      },
      () => calls.push("auth"),
    );

    expect(calls).toEqual([
      { path: ".env.local", override: false },
      "auth",
      { override: false },
    ]);
  });

  it("loads generated Substack auth values without replacing explicit env", () => {
    const env: NodeJS.ProcessEnv = { SUBSTACK_USER_ID: "999" };

    loadLocalSubstackAuthFile(
      env,
      () =>
        JSON.stringify({
          SUBSTACK_PUBLICATION_URL: "https://example.substack.com",
          SUBSTACK_SESSION_TOKEN: "session-token",
          SUBSTACK_USER_ID: "123",
          PREVIEW_TOKEN_SECRET: "preview-secret",
        }),
      ".data/test-auth.json",
    );

    expect(env).toEqual({
      SUBSTACK_PUBLICATION_URL: "https://example.substack.com",
      SUBSTACK_SESSION_TOKEN: "session-token",
      SUBSTACK_USER_ID: "999",
      PREVIEW_TOKEN_SECRET: "preview-secret",
    });
  });

  it("rejects malformed generated Substack auth files", () => {
    expect(() =>
      loadLocalSubstackAuthFile({}, () => "not-json", ".data/test-auth.json"),
    ).toThrow(".data/test-auth.json must contain valid JSON.");

    expect(() =>
      loadLocalSubstackAuthFile(
        {},
        () =>
          JSON.stringify({ SUBSTACK_PUBLICATION_URL: "https://example.com" }),
        ".data/test-auth.json",
      ),
    ).toThrow(
      ".data/test-auth.json must contain a non-empty string for SUBSTACK_SESSION_TOKEN.",
    );
  });

  it("ignores a missing generated auth file and preserves other read failures", () => {
    expect(() =>
      loadLocalSubstackAuthFile({}, () => {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }),
    ).not.toThrow();

    const denied = Object.assign(new Error("denied"), { code: "EACCES" });
    expect(() =>
      loadLocalSubstackAuthFile({}, () => {
        throw denied;
      }),
    ).toThrow(denied);
  });

  it("requires the generated auth file root to be an object", () => {
    expect(() =>
      loadLocalSubstackAuthFile(
        {},
        () => JSON.stringify(["not", "an", "object"]),
        ".data/test-auth.json",
      ),
    ).toThrow(".data/test-auth.json must contain a JSON object.");
  });

  it("loads defaults without reading an env file", () => {
    const config = loadConfig({}, { loadEnvFile: false });

    expect(config).toEqual({
      nodeEnv: "development",
      port: 8787,
      host: "127.0.0.1",
      logLevel: "info",
      mcpTransport: "http",
      mcpPathSecret: undefined,
      publicationUrl: undefined,
      sessionToken: undefined,
      userId: undefined,
      userAgent: DEFAULT_USER_AGENT,
      previewTokenSecret: "development-only-preview-token-secret-change-me",
      maxBodyBytes: 750_000,
      maxImageBytes: 8_000_000,
      imageFileRoots: [],
      substackRequestTimeoutMs: DEFAULT_SUBSTACK_REQUEST_TIMEOUT_MS,
      confirmationTokenTtlSeconds: 900,
      authMode: "noauth",
      staticBearerToken: undefined,
      publicBaseUrl: undefined,
      oauthAuthorizationServerUrl: undefined,
      oauthResourceDocumentationUrl: undefined,
      oauthJwksUrl: undefined,
      oauthJwtAlgorithms: ["RS256", "ES256"],
    });
    expect(getMcpPath(config)).toBe("/mcp");
  });

  it("parses configured values and normalizes optional strings", () => {
    const config = loadConfig(
      {
        NODE_ENV: "production",
        PORT: "8080",
        HOST: "0.0.0.0",
        LOG_LEVEL: "debug",
        MCP_TRANSPORT: "stdio",
        MCP_PATH_SECRET: " secret-path ",
        SUBSTACK_PUBLICATION_URL: "https://example.substack.com///",
        SUBSTACK_SESSION_TOKEN: " session-token ",
        SUBSTACK_USER_ID: "123",
        SUBSTACK_USER_AGENT: "test-agent",
        PREVIEW_TOKEN_SECRET: " preview-secret ",
        MAX_BODY_BYTES: "100",
        MAX_IMAGE_BYTES: "200",
        IMAGE_FILE_ROOTS:
          " /tmp/generated-images, /tmp/uploads, /tmp/generated-images ",
        SUBSTACK_REQUEST_TIMEOUT_MS: "4000",
        CONFIRMATION_TOKEN_TTL_SECONDS: "300",
        AUTH_MODE: "static_bearer",
        MCP_BEARER_TOKEN: " bearer-token ",
        MCP_PUBLIC_BASE_URL: " https://mcp.example.com/// ",
        OAUTH_AUTHORIZATION_SERVER_URL: " https://auth.example.com/// ",
        OAUTH_RESOURCE_DOCUMENTATION_URL: " https://docs.example.com/mcp/// ",
        OAUTH_JWKS_URL: " https://auth.example.com/jwks.json/// ",
        OAUTH_JWT_ALGORITHMS: "RS256, ES256, EdDSA",
      },
      { loadEnvFile: false },
    );

    expect(config).toMatchObject({
      nodeEnv: "production",
      port: 8080,
      host: "0.0.0.0",
      logLevel: "debug",
      mcpTransport: "stdio",
      mcpPathSecret: "secret-path",
      publicationUrl: "https://example.substack.com",
      sessionToken: "session-token",
      userId: 123,
      userAgent: "test-agent",
      previewTokenSecret: "preview-secret",
      maxBodyBytes: 100,
      maxImageBytes: 200,
      imageFileRoots: ["/tmp/generated-images", "/tmp/uploads"],
      substackRequestTimeoutMs: 4000,
      confirmationTokenTtlSeconds: 300,
      authMode: "static_bearer",
      staticBearerToken: "bearer-token",
      publicBaseUrl: "https://mcp.example.com",
      oauthAuthorizationServerUrl: "https://auth.example.com",
      oauthResourceDocumentationUrl: "https://docs.example.com/mcp",
      oauthJwksUrl: "https://auth.example.com/jwks.json",
      oauthJwtAlgorithms: ["RS256", "ES256", "EdDSA"],
    });
    expect(getMcpPath(config)).toBe("/mcp/secret-path");
  });

  it("requires IMAGE_FILE_ROOTS entries to be absolute paths", () => {
    expect(() =>
      loadConfig(
        { IMAGE_FILE_ROOTS: "./generated-images" },
        { loadEnvFile: false },
      ),
    ).toThrow("IMAGE_FILE_ROOTS entries must be absolute paths.");
  });

  it("requires MCP_PATH_SECRET to be a single URL-safe path segment", () => {
    for (const value of ["secret/path", "secret space", "%2F", ".", ".."]) {
      expect(() =>
        loadConfig({ MCP_PATH_SECRET: value }, { loadEnvFile: false }),
      ).toThrow("MCP_PATH_SECRET must be one URL-safe path segment");
    }
  });

  it("requires the Substack publication URL to be public HTTPS", () => {
    expect(
      loadConfig(
        {
          SUBSTACK_PUBLICATION_URL:
            "https://example.substack.com/p/a-draft?utm=agent#editor",
        },
        { loadEnvFile: false },
      ).publicationUrl,
    ).toBe("https://example.substack.com");

    expect(() =>
      loadConfig(
        { SUBSTACK_PUBLICATION_URL: "http://example.substack.com" },
        { loadEnvFile: false },
      ),
    ).toThrow("SUBSTACK_PUBLICATION_URL must use https://.");

    expect(() =>
      loadConfig(
        {
          SUBSTACK_PUBLICATION_URL:
            "https://session:token@example.substack.com",
        },
        { loadEnvFile: false },
      ),
    ).toThrow(
      "SUBSTACK_PUBLICATION_URL must not include username or password.",
    );

    expect(() =>
      loadConfig(
        { SUBSTACK_PUBLICATION_URL: "https://127.0.0.1" },
        { loadEnvFile: false },
      ),
    ).toThrow(
      "SUBSTACK_PUBLICATION_URL must not point to localhost or private network addresses.",
    );
  });

  it("treats whitespace-only optional values as missing", () => {
    const config = loadConfig(
      {
        HOST: " ",
        MCP_PATH_SECRET: " ",
        SUBSTACK_PUBLICATION_URL: " ",
        SUBSTACK_SESSION_TOKEN: " ",
        SUBSTACK_USER_ID: " ",
        PREVIEW_TOKEN_SECRET: " ",
        MCP_BEARER_TOKEN: " ",
        MCP_PUBLIC_BASE_URL: " ",
        OAUTH_AUTHORIZATION_SERVER_URL: " ",
        OAUTH_RESOURCE_DOCUMENTATION_URL: " ",
        OAUTH_JWKS_URL: " ",
      },
      { loadEnvFile: false },
    );

    expect(config.host).toBe("127.0.0.1");
    expect(config.mcpPathSecret).toBeUndefined();
    expect(config.publicationUrl).toBeUndefined();
    expect(config.sessionToken).toBeUndefined();
    expect(config.userId).toBeUndefined();
    expect(config.previewTokenSecret).toBe(
      "development-only-preview-token-secret-change-me",
    );
    expect(config.staticBearerToken).toBeUndefined();
    expect(config.publicBaseUrl).toBeUndefined();
    expect(config.oauthAuthorizationServerUrl).toBeUndefined();
    expect(config.oauthResourceDocumentationUrl).toBeUndefined();
    expect(config.oauthJwksUrl).toBeUndefined();
  });

  it("rejects full Cookie headers for the Substack session token", () => {
    expect(() =>
      loadConfig(
        {
          SUBSTACK_SESSION_TOKEN:
            "connect.sid=secret-session; substack.sid=secret-session",
        },
        { loadEnvFile: false },
      ),
    ).toThrow(
      "SUBSTACK_SESSION_TOKEN must be the cookie value only, not a Cookie header or name=value pair.",
    );

    expect(() =>
      loadConfig(
        {
          SUBSTACK_SESSION_TOKEN: "secret session",
        },
        { loadEnvFile: false },
      ),
    ).toThrow(
      "SUBSTACK_SESSION_TOKEN must be a single cookie value without whitespace or semicolons.",
    );
  });

  it("rejects Authorization headers for the static bearer token", () => {
    expect(() =>
      loadConfig(
        {
          MCP_BEARER_TOKEN: "Bearer mcp-secret",
        },
        { loadEnvFile: false },
      ),
    ).toThrow(
      "MCP_BEARER_TOKEN must be the bearer token value only, not an Authorization header or Bearer-prefixed value.",
    );

    expect(() =>
      loadConfig(
        {
          MCP_BEARER_TOKEN: "mcp secret",
        },
        { loadEnvFile: false },
      ),
    ).toThrow(
      "MCP_BEARER_TOKEN must be a single bearer token value without whitespace.",
    );
  });

  it("defaults production HTTP binding to all interfaces for Cloud Run", () => {
    const config = loadConfig(
      { NODE_ENV: "production" },
      { loadEnvFile: false },
    );

    expect(config.host).toBe("0.0.0.0");
  });

  it("rejects the development preview token secret in production runtime config", () => {
    expect(() =>
      assertRuntimeSecretConfig({
        nodeEnv: "production",
        previewTokenSecret: DEFAULT_PREVIEW_TOKEN_SECRET,
      }),
    ).toThrow("PREVIEW_TOKEN_SECRET is required when NODE_ENV=production.");

    expect(() =>
      assertRuntimeSecretConfig({
        nodeEnv: "development",
        previewTokenSecret: DEFAULT_PREVIEW_TOKEN_SECRET,
      }),
    ).not.toThrow();
    expect(() =>
      assertRuntimeSecretConfig({
        nodeEnv: "production",
        previewTokenSecret: "configured-preview-token-secret",
      }),
    ).not.toThrow();
  });

  it("rejects entrypoint transport mismatches", () => {
    expect(() =>
      assertMcpTransportConfig({ mcpTransport: "stdio" }, "http"),
    ).toThrow("MCP_TRANSPORT=stdio cannot be used with the http entrypoint.");
    expect(() =>
      assertMcpTransportConfig({ mcpTransport: "http" }, "stdio"),
    ).toThrow("MCP_TRANSPORT=http cannot be used with the stdio entrypoint.");
    expect(() =>
      assertMcpTransportConfig({ mcpTransport: "http" }, "http"),
    ).not.toThrow();
  });

  it("rejects invalid integers and enum values", () => {
    expect(() => loadConfig({ PORT: "-1" }, { loadEnvFile: false })).toThrow(
      "PORT must be a non-negative integer",
    );
    expect(() =>
      loadConfig({ PORT: "8787abc" }, { loadEnvFile: false }),
    ).toThrow("PORT must be a non-negative integer");
    expect(() =>
      loadConfig({ SUBSTACK_USER_ID: "abc" }, { loadEnvFile: false }),
    ).toThrow("SUBSTACK_USER_ID must be a positive integer.");
    expect(() =>
      loadConfig({ SUBSTACK_USER_ID: "0" }, { loadEnvFile: false }),
    ).toThrow("SUBSTACK_USER_ID must be a positive integer.");
    expect(() =>
      loadConfig({ MAX_BODY_BYTES: "100kb" }, { loadEnvFile: false }),
    ).toThrow("MAX_BODY_BYTES must be a non-negative integer");
    expect(() =>
      loadConfig(
        { CONFIRMATION_TOKEN_TTL_SECONDS: "0" },
        { loadEnvFile: false },
      ),
    ).toThrow("CONFIRMATION_TOKEN_TTL_SECONDS must be a positive integer");
    expect(() =>
      loadConfig({ SUBSTACK_REQUEST_TIMEOUT_MS: "0" }, { loadEnvFile: false }),
    ).toThrow("SUBSTACK_REQUEST_TIMEOUT_MS must be a positive integer");
    expect(() =>
      loadConfig({ MCP_TRANSPORT: "websocket" }, { loadEnvFile: false }),
    ).toThrow("MCP_TRANSPORT must be one of: http, stdio");
    expect(() =>
      loadConfig({ AUTH_MODE: "apikey" }, { loadEnvFile: false }),
    ).toThrow("AUTH_MODE must be one of: noauth, static_bearer, oauth");
    expect(() =>
      loadConfig({ OAUTH_JWT_ALGORITHMS: ", ," }, { loadEnvFile: false }),
    ).toThrow("OAUTH_JWT_ALGORITHMS must contain at least one value");
  });
});
