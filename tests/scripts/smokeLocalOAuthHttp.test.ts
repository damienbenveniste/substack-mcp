import { describe, expect, it } from "vitest";
import {
  DEFAULT_OAUTH_HTTP_ARGS,
  DEFAULT_OAUTH_HTTP_COMMAND,
  DEFAULT_OAUTH_HTTP_HOST,
  DEFAULT_OAUTH_HTTP_MCP_PATH,
  DEFAULT_OAUTH_ISSUER,
  DEFAULT_OAUTH_JWKS_HOST,
  DEFAULT_OAUTH_JWKS_PATH,
  DEFAULT_OAUTH_SUBJECT,
  localOAuthHttpUsage,
  oauthAuthorizationServerUrl,
  oauthJwksUrl,
  oauthPublicBaseUrl,
  oauthResource,
  parseLocalOAuthHttpArgs,
  withOAuthHttpPorts,
} from "../../scripts/smokeLocalOAuthHttpCore.js";
import { authScopes } from "../../src/auth/scopes.js";

describe("parseLocalOAuthHttpArgs", () => {
  it("uses the built HTTP entrypoint and safe OAuth env by default", () => {
    const options = parseLocalOAuthHttpArgs([], {}, "/repo");

    expect(options).toMatchObject({
      help: false,
      command: DEFAULT_OAUTH_HTTP_COMMAND,
      args: [...DEFAULT_OAUTH_HTTP_ARGS],
      cwd: "/repo",
      host: DEFAULT_OAUTH_HTTP_HOST,
      port: 0,
      mcpPath: DEFAULT_OAUTH_HTTP_MCP_PATH,
      jwksHost: DEFAULT_OAUTH_JWKS_HOST,
      jwksPort: 0,
      jwksPath: DEFAULT_OAUTH_JWKS_PATH,
      issuerUrl: DEFAULT_OAUTH_ISSUER,
      subject: DEFAULT_OAUTH_SUBJECT,
      scopes: [...authScopes],
    });
    if (options.help) {
      throw new Error("Expected runnable local OAuth HTTP smoke-test options.");
    }
    expect(options.env).toMatchObject({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      MCP_TRANSPORT: "http",
      AUTH_MODE: "oauth",
      PORT: "0",
      MCP_PUBLIC_BASE_URL: "https://127.0.0.1:0",
      OAUTH_AUTHORIZATION_SERVER_URL: DEFAULT_OAUTH_ISSUER,
      OAUTH_JWKS_URL: "https://127.0.0.1:0/jwks.json",
      OAUTH_JWT_ALGORITHMS: "RS256",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      SUBSTACK_PUBLICATION_URL: "https://example.substack.com",
      SUBSTACK_USER_ID: "1",
    });
    expect(options.env).not.toHaveProperty("SUBSTACK_SESSION_TOKEN");
    expect(options.env).not.toHaveProperty("PREVIEW_TOKEN_SECRET");
  });

  it("supports custom command, args, endpoints, JWT claims, scopes, and child env", () => {
    const options = parseLocalOAuthHttpArgs(
      [
        "--command",
        "tsx",
        "--arg",
        "src/http.ts",
        "--arg",
        "--debug",
        "--cwd",
        "/custom",
        "--host",
        "localhost",
        "--port",
        "9876",
        "--mcp-path",
        "/mcp/private",
        "--jwks-host",
        "localhost",
        "--jwks-port",
        "9443",
        "--jwks-path",
        "/keys",
        "--issuer",
        "https://issuer.example.test/",
        "--subject",
        "subject-123",
        "--scope",
        "drafts:read",
        "--scope",
        "images:write",
        "--env",
        "MCP_PATH_SECRET=private",
      ],
      {},
      "/repo",
    );

    expect(options).toMatchObject({
      help: false,
      command: "tsx",
      args: ["src/http.ts", "--debug"],
      cwd: "/custom",
      host: "localhost",
      port: 9876,
      mcpPath: "/mcp/private",
      jwksHost: "localhost",
      jwksPort: 9443,
      jwksPath: "/keys",
      issuerUrl: "https://issuer.example.test",
      subject: "subject-123",
      scopes: ["drafts:read", "images:write"],
    });
    if (options.help) {
      throw new Error("Expected runnable local OAuth HTTP smoke-test options.");
    }
    expect(options.env.MCP_PUBLIC_BASE_URL).toBe("https://localhost:9876");
    expect(options.env.OAUTH_JWKS_URL).toBe("https://localhost:9443/keys");
    expect(options.env.OAUTH_AUTHORIZATION_SERVER_URL).toBe(
      "https://issuer.example.test",
    );
    expect(options.env.MCP_PATH_SECRET).toBe("private");
  });

  it("replaces allocated MCP and JWKS ports consistently", () => {
    const options = parseLocalOAuthHttpArgs([], {}, "/repo");
    if (options.help) {
      throw new Error("Expected runnable local OAuth HTTP smoke-test options.");
    }

    expect(withOAuthHttpPorts(options, 54321, 54443)).toMatchObject({
      port: 54321,
      jwksPort: 54443,
      issuerUrl: "https://127.0.0.1:54443",
      env: {
        PORT: "54321",
        MCP_PUBLIC_BASE_URL: "https://127.0.0.1:54321",
        OAUTH_AUTHORIZATION_SERVER_URL: "https://127.0.0.1:54443",
        OAUTH_JWKS_URL: "https://127.0.0.1:54443/jwks.json",
      },
    });
  });

  it("builds public base, JWKS, and resource URLs", () => {
    expect(oauthPublicBaseUrl({ host: "localhost", port: 1234 })).toBe(
      "https://localhost:1234",
    );
    expect(
      oauthJwksUrl({
        jwksHost: "localhost",
        jwksPort: 9443,
        jwksPath: "/keys",
      }),
    ).toBe("https://localhost:9443/keys");
    expect(
      oauthAuthorizationServerUrl({
        jwksHost: "localhost",
        jwksPort: 9443,
      }),
    ).toBe("https://localhost:9443");
    expect(
      oauthResource({
        env: {
          MCP_PUBLIC_BASE_URL: "https://localhost:1234/some/path",
        },
      }),
    ).toBe("https://localhost:1234");
  });

  it("allows help without runnable configuration", () => {
    expect(parseLocalOAuthHttpArgs(["--help"], {}, "/repo")).toEqual({
      help: true,
    });
    expect(parseLocalOAuthHttpArgs(["-h"], {}, "/repo")).toEqual({
      help: true,
    });
  });

  it("rejects missing values, invalid endpoints, invalid env assignments, and unknown options", () => {
    expect(() => parseLocalOAuthHttpArgs(["--command"], {}, "/repo")).toThrow(
      "--command requires a value.",
    );
    expect(() => parseLocalOAuthHttpArgs(["--port", "0"], {}, "/repo")).toThrow(
      "--port must be an integer from 1 to 65535.",
    );
    expect(() =>
      parseLocalOAuthHttpArgs(["--jwks-port", "9443abc"], {}, "/repo"),
    ).toThrow("--jwks-port must be an integer from 1 to 65535.");
    expect(() =>
      parseLocalOAuthHttpArgs(["--mcp-path", "/not-mcp"], {}, "/repo"),
    ).toThrow("--mcp-path must be /mcp or /mcp/<secret>.");
    expect(() =>
      parseLocalOAuthHttpArgs(
        ["--mcp-path", "/mcp/private/nested"],
        {},
        "/repo",
      ),
    ).toThrow("<secret> must be one URL-safe path segment");
    expect(() =>
      parseLocalOAuthHttpArgs(["--jwks-port", "0"], {}, "/repo"),
    ).toThrow("--jwks-port must be an integer from 1 to 65535.");
    expect(() =>
      parseLocalOAuthHttpArgs(["--jwks-path", "keys"], {}, "/repo"),
    ).toThrow("--jwks-path must start with /.");
    expect(() =>
      parseLocalOAuthHttpArgs(
        ["--issuer", "http://issuer.example.test"],
        {},
        "/repo",
      ),
    ).toThrow("--issuer must be an absolute https URL.");
    expect(() =>
      parseLocalOAuthHttpArgs(["--scope", "profile"], {}, "/repo"),
    ).toThrow("--scope must be one of:");
    expect(() =>
      parseLocalOAuthHttpArgs(["--env", "NOT-VALID=value"], {}, "/repo"),
    ).toThrow("Invalid environment variable name: NOT-VALID");
    expect(() =>
      parseLocalOAuthHttpArgs(["--env", "MISSING_VALUE"], {}, "/repo"),
    ).toThrow("--env requires NAME=value.");
    expect(() => parseLocalOAuthHttpArgs(["--bogus"], {}, "/repo")).toThrow(
      "Unknown option: --bogus",
    );
  });
});

describe("localOAuthHttpUsage", () => {
  it("describes the command and local JWKS without embedding token values", () => {
    expect(localOAuthHttpUsage()).toContain("npm run smoke:http-oauth");
    expect(localOAuthHttpUsage()).toContain("node dist/http.js");
    expect(localOAuthHttpUsage()).toContain("AUTH_MODE=oauth");
    expect(localOAuthHttpUsage()).toContain("local");
    expect(localOAuthHttpUsage()).not.toContain("Bearer ");
  });
});
