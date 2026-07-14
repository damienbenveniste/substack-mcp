import { describe, expect, it } from "vitest";
import {
  DEFAULT_OAUTH_HTTP_ARGS,
  DEFAULT_OAUTH_HTTP_COMMAND,
  DEFAULT_OAUTH_ISSUER,
  DEFAULT_OAUTH_JWKS_HOST,
  DEFAULT_OAUTH_JWKS_PATH,
  DEFAULT_OAUTH_SUBJECT,
} from "../../scripts/smokeLocalOAuthHttpCore.js";
import {
  DEFAULT_NGROK_API_URL,
  DEFAULT_NGROK_COMMAND,
  DEFAULT_NGROK_HOST,
  DEFAULT_NGROK_MCP_PATH,
  DEFAULT_NGROK_PORT,
} from "../../scripts/smokeNgrokNoAuthHttpCore.js";
import {
  ngrokOAuthChildEnv,
  ngrokOAuthJwksUrl,
  ngrokOAuthUsage,
  parseNgrokOAuthArgs,
  withNgrokOAuthJwksPort,
} from "../../scripts/smokeNgrokOAuthHttpCore.js";
import { authScopes } from "../../src/auth/scopes.js";

describe("parseNgrokOAuthArgs", () => {
  it("uses safe OAuth and ngrok defaults", () => {
    const options = parseNgrokOAuthArgs([], {}, "/repo/substack-mcp");

    expect(options).toMatchObject({
      help: false,
      command: DEFAULT_OAUTH_HTTP_COMMAND,
      args: [...DEFAULT_OAUTH_HTTP_ARGS],
      cwd: "/repo/substack-mcp",
      artifactRoot: "/repo/substack-mcp",
      host: DEFAULT_NGROK_HOST,
      port: DEFAULT_NGROK_PORT,
      mcpPath: DEFAULT_NGROK_MCP_PATH,
      jwksHost: DEFAULT_OAUTH_JWKS_HOST,
      jwksPort: 0,
      jwksPath: DEFAULT_OAUTH_JWKS_PATH,
      issuerUrl: DEFAULT_OAUTH_ISSUER,
      subject: DEFAULT_OAUTH_SUBJECT,
      scopes: [...authScopes],
      ngrokCommand: DEFAULT_NGROK_COMMAND,
      ngrokArgs: [],
      tunnelTimeoutMs: 15_000,
    });
    if (options.help) {
      throw new Error("Expected runnable ngrok OAuth smoke options.");
    }
    expect(options.ngrokApiUrl.href).toBe(DEFAULT_NGROK_API_URL);
    expect(options.evidenceArtifact).toBeUndefined();
    expect(options.env).toMatchObject({
      AUTH_MODE: "oauth",
      MCP_TRANSPORT: "http",
      NODE_ENV: "test",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      OAUTH_JWT_ALGORITHMS: "RS256",
      SUBSTACK_PUBLICATION_URL: "https://example.substack.com",
      SUBSTACK_SESSION_TOKEN: "ngrok-oauth-smoke-session-token",
      SUBSTACK_USER_ID: "1",
    });
    expect(options.env.PREVIEW_TOKEN_SECRET).toContain(
      "ngrok-oauth-smoke-preview-token-secret",
    );
    expect(options.env).not.toHaveProperty("MCP_PUBLIC_BASE_URL");
    expect(options.env).not.toHaveProperty("OAUTH_JWKS_URL");
  });

  it("supports custom commands, OAuth claims, tunnel options, artifact, and env overrides", () => {
    const options = parseNgrokOAuthArgs(
      [
        "--command",
        "tsx",
        "--arg",
        "src/http.ts",
        "--cwd",
        "/custom",
        "--host",
        "localhost",
        "--port",
        "9000",
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
        "--evidence-artifact",
        ".data/v1/remote-oauth.md",
        "--ngrok-command",
        "custom-ngrok",
        "--ngrok-arg",
        "--domain=example.ngrok.app",
        "--ngrok-api-url",
        "http://127.0.0.1:4041/api/tunnels",
        "--tunnel-timeout-ms",
        "2000",
        "--env",
        "MAX_BODY_BYTES=1234",
      ],
      {
        AUTH_MODE: "noauth",
        PORT: "1234",
      },
      "/repo",
    );

    expect(options).toMatchObject({
      help: false,
      command: "tsx",
      args: ["src/http.ts"],
      cwd: "/custom",
      artifactRoot: "/repo",
      evidenceArtifact: ".data/v1/remote-oauth.md",
      host: "localhost",
      port: 9000,
      mcpPath: "/mcp/private",
      jwksHost: "localhost",
      jwksPort: 9443,
      jwksPath: "/keys",
      issuerUrl: "https://issuer.example.test",
      subject: "subject-123",
      scopes: ["drafts:read", "images:write"],
      ngrokCommand: "custom-ngrok",
      ngrokArgs: ["--domain=example.ngrok.app"],
      tunnelTimeoutMs: 2000,
    });
    if (options.help) {
      throw new Error("Expected runnable ngrok OAuth smoke options.");
    }
    expect(options.ngrokApiUrl.href).toBe("http://127.0.0.1:4041/api/tunnels");
    expect(options.env.AUTH_MODE).toBe("oauth");
    expect(options.env.MAX_BODY_BYTES).toBe("1234");
  });

  it("uses PORT and OAUTH_JWKS_PORT from the environment", () => {
    const options = parseNgrokOAuthArgs(
      [],
      {
        LOG_LEVEL: "debug",
        OAUTH_JWKS_PORT: "9443",
        PORT: "9999",
        SUBSTACK_PUBLICATION_URL: "https://custom.substack.com",
      },
      "/repo",
    );

    expect(options).toMatchObject({
      help: false,
      port: 9999,
      jwksPort: 9443,
    });
    if (options.help) {
      throw new Error("Expected runnable ngrok OAuth smoke options.");
    }
    expect(options.env).toMatchObject({
      AUTH_MODE: "oauth",
      LOG_LEVEL: "debug",
      SUBSTACK_PUBLICATION_URL: "https://custom.substack.com",
    });
  });

  it("allows help without local server configuration", () => {
    expect(parseNgrokOAuthArgs(["--help"], {})).toEqual({ help: true });
    expect(parseNgrokOAuthArgs(["-h"], {})).toEqual({ help: true });
  });

  it("rejects invalid, unsafe, or ambiguous options", () => {
    expect(() => parseNgrokOAuthArgs(["--command"], {})).toThrow(
      "--command requires a value.",
    );
    expect(() => parseNgrokOAuthArgs(["--port", "0"], {})).toThrow(
      "--port must be an integer from 1 to 65535.",
    );
    expect(() => parseNgrokOAuthArgs(["--jwks-port", "9443abc"], {})).toThrow(
      "--jwks-port must be an integer from 1 to 65535.",
    );
    expect(() => parseNgrokOAuthArgs(["--jwks-port", "0"], {})).toThrow(
      "--jwks-port must be an integer from 1 to 65535.",
    );
    expect(() => parseNgrokOAuthArgs(["--mcp-path", "/not-mcp"], {})).toThrow(
      "--mcp-path must be /mcp or /mcp/<secret>.",
    );
    expect(() =>
      parseNgrokOAuthArgs(["--mcp-path", "/mcp/private/nested"], {}),
    ).toThrow("<secret> must be one URL-safe path segment");
    expect(() => parseNgrokOAuthArgs(["--jwks-path", "keys"], {})).toThrow(
      "--jwks-path must start with /.",
    );
    expect(() =>
      parseNgrokOAuthArgs(["--issuer", "http://issuer.example.test"], {}),
    ).toThrow("--issuer must be an absolute https URL.");
    expect(() => parseNgrokOAuthArgs(["--scope", "profile"], {})).toThrow(
      "--scope must be one of:",
    );
    expect(() =>
      parseNgrokOAuthArgs(["--evidence-artifact", "../outside.md"], {}),
    ).toThrow(
      "ngrok OAuth evidence artifact must stay inside the project directory.",
    );
    expect(() =>
      parseNgrokOAuthArgs(["--ngrok-api-url", "https://example.com"], {}),
    ).toThrow("--ngrok-api-url must use http.");
    expect(() =>
      parseNgrokOAuthArgs(["--tunnel-timeout-ms", "999"], {}),
    ).toThrow("--tunnel-timeout-ms must be an integer from 1000 to 120000.");
    expect(() =>
      parseNgrokOAuthArgs(["--env", "MCP_PUBLIC_BASE_URL=https://x.test"], {}),
    ).toThrow(
      "MCP_PUBLIC_BASE_URL is computed by smoke:ngrok-oauth; use the dedicated CLI option instead.",
    );
    expect(() => parseNgrokOAuthArgs(["--env", "1BAD=value"], {})).toThrow(
      "Invalid environment variable name: 1BAD",
    );
    expect(() => parseNgrokOAuthArgs(["--env", "NO_EQUALS"], {})).toThrow(
      "--env requires NAME=value.",
    );
    expect(() => parseNgrokOAuthArgs(["--bogus"], {})).toThrow(
      "Unknown option: --bogus",
    );
  });
});

describe("ngrok OAuth helpers", () => {
  it("fills allocated JWKS port and computes public-origin OAuth env", () => {
    const parsed = parseNgrokOAuthArgs([], {}, "/repo");
    if (parsed.help) {
      throw new Error("Expected runnable ngrok OAuth smoke options.");
    }
    const options = withNgrokOAuthJwksPort(parsed, 9443);
    const publicUrl = new URL("https://abc.ngrok.app");

    expect(ngrokOAuthJwksUrl(options)).toBe("https://127.0.0.1:9443/jwks.json");
    expect(options.issuerUrl).toBe("https://127.0.0.1:9443");
    expect(ngrokOAuthChildEnv(options, publicUrl)).toMatchObject({
      PORT: "8787",
      MCP_TRANSPORT: "http",
      AUTH_MODE: "oauth",
      MCP_PUBLIC_BASE_URL: "https://abc.ngrok.app",
      OAUTH_AUTHORIZATION_SERVER_URL: "https://127.0.0.1:9443",
      OAUTH_JWKS_URL: "https://127.0.0.1:9443/jwks.json",
      OAUTH_JWT_ALGORITHMS: "RS256",
    });
  });

  it("describes the helper without printing secrets or token values", () => {
    const usage = ngrokOAuthUsage();

    expect(usage).toContain("npm run smoke:ngrok-oauth");
    expect(usage).toContain("ngrok http 8787");
    expect(usage).toContain("AUTH_MODE=oauth");
    expect(usage).toContain("--evidence-artifact");
    expect(usage).not.toContain("SUBSTACK_SESSION_TOKEN");
    expect(usage).not.toContain("PREVIEW_TOKEN_SECRET");
    expect(usage).not.toContain("Bearer ");
  });
});
