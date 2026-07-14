import { describe, expect, it } from "vitest";

import {
  DEFAULT_STATIC_BEARER_TOKEN,
  DEFAULT_WRONG_STATIC_BEARER_TOKEN,
} from "../../scripts/smokeLocalStaticBearerHttpCore.js";
import {
  DEFAULT_NGROK_API_URL,
  DEFAULT_NGROK_COMMAND,
  DEFAULT_NGROK_HTTP_ARGS,
  DEFAULT_NGROK_HTTP_COMMAND,
  DEFAULT_NGROK_MCP_PATH,
  DEFAULT_NGROK_PORT,
} from "../../scripts/smokeNgrokNoAuthHttpCore.js";
import {
  ngrokStaticBearerUsage,
  parseNgrokStaticBearerArgs,
} from "../../scripts/smokeNgrokStaticBearerHttpCore.js";

describe("parseNgrokStaticBearerArgs", () => {
  it("uses fake local static-bearer defaults for the built HTTP server and ngrok", () => {
    const options = parseNgrokStaticBearerArgs([], {}, "/repo/substack-mcp");

    expect(options).toMatchObject({
      help: false,
      command: DEFAULT_NGROK_HTTP_COMMAND,
      args: [...DEFAULT_NGROK_HTTP_ARGS],
      cwd: "/repo/substack-mcp",
      artifactRoot: "/repo/substack-mcp",
      host: "127.0.0.1",
      port: DEFAULT_NGROK_PORT,
      mcpPath: DEFAULT_NGROK_MCP_PATH,
      bearerToken: DEFAULT_STATIC_BEARER_TOKEN,
      wrongBearerToken: DEFAULT_WRONG_STATIC_BEARER_TOKEN,
      ngrokCommand: DEFAULT_NGROK_COMMAND,
      ngrokArgs: [],
      tunnelTimeoutMs: 15_000,
      holdOpenSeconds: 0,
    });
    if (options.help) {
      throw new Error("Expected runnable ngrok static-bearer smoke options.");
    }
    expect(options.ngrokApiUrl.href).toBe(DEFAULT_NGROK_API_URL);
    expect(options.evidenceArtifact).toBeUndefined();
    expect(options.env).toMatchObject({
      AUTH_MODE: "static_bearer",
      MCP_TRANSPORT: "http",
      MCP_BEARER_TOKEN: DEFAULT_STATIC_BEARER_TOKEN,
      NODE_ENV: "test",
      PORT: "8787",
      SUBSTACK_PUBLICATION_URL: "https://example.substack.com",
      SUBSTACK_SESSION_TOKEN: "ngrok-static-bearer-smoke-session-token",
      SUBSTACK_USER_ID: "1",
    });
    expect(options.env.PREVIEW_TOKEN_SECRET).toContain(
      "ngrok-static-bearer-smoke-preview-token-secret",
    );
  });

  it("supports custom commands, tunnel options, token env vars, artifact, and env overrides", () => {
    const options = parseNgrokStaticBearerArgs(
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
        "--bearer-token-env",
        "VALID_TOKEN",
        "--wrong-bearer-token-env",
        "WRONG_TOKEN",
        "--evidence-artifact",
        ".data/v1/gate-14-static-bearer-remote.md",
        "--ngrok-command",
        "custom-ngrok",
        "--ngrok-arg",
        "--domain=example.ngrok.app",
        "--ngrok-api-url",
        "http://127.0.0.1:4041/api/tunnels",
        "--tunnel-timeout-ms",
        "2000",
        "--hold-open-seconds",
        "900",
        "--env",
        "MAX_BODY_BYTES=1234",
      ],
      {
        AUTH_MODE: "noauth",
        PORT: "1234",
        VALID_TOKEN: "valid-token",
        WRONG_TOKEN: "wrong-token",
      },
      "/repo",
    );

    expect(options).toMatchObject({
      help: false,
      command: "tsx",
      args: ["src/http.ts"],
      cwd: "/custom",
      artifactRoot: "/repo",
      evidenceArtifact: ".data/v1/gate-14-static-bearer-remote.md",
      host: "localhost",
      port: 9000,
      mcpPath: "/mcp/private",
      bearerToken: "valid-token",
      bearerTokenEnvName: "VALID_TOKEN",
      wrongBearerToken: "wrong-token",
      ngrokCommand: "custom-ngrok",
      ngrokArgs: ["--domain=example.ngrok.app"],
      tunnelTimeoutMs: 2000,
      holdOpenSeconds: 900,
    });
    if (options.help) {
      throw new Error("Expected runnable ngrok static-bearer smoke options.");
    }
    expect(options.ngrokApiUrl.href).toBe("http://127.0.0.1:4041/api/tunnels");
    expect(options.env.AUTH_MODE).toBe("static_bearer");
    expect(options.env.MCP_BEARER_TOKEN).toBe("valid-token");
    expect(options.env.PORT).toBe("9000");
    expect(options.env.MAX_BODY_BYTES).toBe("1234");
  });

  it("uses PORT from the environment while preserving static-bearer app settings", () => {
    const options = parseNgrokStaticBearerArgs(
      [],
      {
        LOG_LEVEL: "debug",
        PORT: "9999",
        SUBSTACK_PUBLICATION_URL: "https://custom.substack.com",
        SUBSTACK_USER_AGENT: "SubstackMcpTest/1.0",
      },
      "/repo",
    );

    expect(options).toMatchObject({
      help: false,
      port: 9999,
    });
    if (options.help) {
      throw new Error("Expected runnable ngrok static-bearer smoke options.");
    }
    expect(options.env).toMatchObject({
      AUTH_MODE: "static_bearer",
      LOG_LEVEL: "debug",
      MCP_BEARER_TOKEN: DEFAULT_STATIC_BEARER_TOKEN,
      PORT: "9999",
      SUBSTACK_PUBLICATION_URL: "https://custom.substack.com",
      SUBSTACK_USER_AGENT: "SubstackMcpTest/1.0",
    });
  });

  it("allows help without local server configuration", () => {
    expect(parseNgrokStaticBearerArgs(["--help"], {})).toEqual({ help: true });
    expect(parseNgrokStaticBearerArgs(["-h"], {})).toEqual({ help: true });
  });

  it("rejects invalid, unsafe, or ambiguous options", () => {
    expect(() => parseNgrokStaticBearerArgs(["--command"], {})).toThrow(
      "--command requires a value.",
    );
    expect(() => parseNgrokStaticBearerArgs(["--port", "0"], {})).toThrow(
      "--port must be an integer from 1 to 65535.",
    );
    expect(() =>
      parseNgrokStaticBearerArgs(["--mcp-path", "/not-mcp"], {}),
    ).toThrow("--mcp-path must be /mcp or /mcp/<secret>.");
    expect(() =>
      parseNgrokStaticBearerArgs(["--mcp-path", "/mcp/private/nested"], {}),
    ).toThrow("<secret> must be one URL-safe path segment");
    expect(() =>
      parseNgrokStaticBearerArgs(["--bearer-token-env", "MISSING"], {}),
    ).toThrow("MISSING must be set to a non-empty bearer token.");
    expect(() =>
      parseNgrokStaticBearerArgs(["--bearer-token-env", "TOKEN"], {
        TOKEN: "Authorization: Bearer valid-token",
      }),
    ).toThrow(
      "TOKEN must be the bearer token value only, not an Authorization header or Bearer-prefixed value.",
    );
    expect(() =>
      parseNgrokStaticBearerArgs(
        ["--bearer-token-env", "TOKEN", "--wrong-bearer-token-env", "TOKEN"],
        { TOKEN: "same-token" },
      ),
    ).toThrow(
      "--wrong-bearer-token-env must resolve to a token different from the valid bearer token.",
    );
    expect(() =>
      parseNgrokStaticBearerArgs(["--evidence-artifact", "../outside.md"], {}),
    ).toThrow(
      "ngrok static-bearer evidence artifact must stay inside the project directory.",
    );
    expect(() =>
      parseNgrokStaticBearerArgs(
        ["--ngrok-api-url", "https://example.com"],
        {},
      ),
    ).toThrow("--ngrok-api-url must use http.");
    expect(() =>
      parseNgrokStaticBearerArgs(["--tunnel-timeout-ms", "999"], {}),
    ).toThrow("--tunnel-timeout-ms must be an integer from 1000 to 120000.");
    expect(() =>
      parseNgrokStaticBearerArgs(["--hold-open-seconds", "3601"], {}),
    ).toThrow("--hold-open-seconds must be an integer from 0 to 3600.");
    expect(() =>
      parseNgrokStaticBearerArgs(["--hold-open-seconds", "60"], {}),
    ).toThrow(
      "--hold-open-seconds requires --bearer-token-env so the manual client can use the same token without printing it.",
    );
    expect(() =>
      parseNgrokStaticBearerArgs(["--env", "MCP_BEARER_TOKEN=secret"], {}),
    ).toThrow(
      "Use --bearer-token-env instead of passing MCP_BEARER_TOKEN through --env.",
    );
    expect(() =>
      parseNgrokStaticBearerArgs(["--env", "1BAD=value"], {}),
    ).toThrow("Invalid environment variable name: 1BAD");
    expect(() =>
      parseNgrokStaticBearerArgs(["--env", "NO_EQUALS"], {}),
    ).toThrow("--env requires NAME=value.");
    expect(() => parseNgrokStaticBearerArgs(["--bogus"], {})).toThrow(
      "Unknown option: --bogus",
    );
  });
});

describe("ngrok static-bearer usage", () => {
  it("describes the helper without printing token values", () => {
    const usage = ngrokStaticBearerUsage();

    expect(usage).toContain("npm run smoke:ngrok-static-bearer");
    expect(usage).toContain("ngrok http 8787");
    expect(usage).toContain("AUTH_MODE=static_bearer");
    expect(usage).toContain("--bearer-token-env");
    expect(usage).toContain("--evidence-artifact");
    expect(usage).toContain("--hold-open-seconds");
    expect(usage).not.toContain(DEFAULT_STATIC_BEARER_TOKEN);
    expect(usage).not.toContain("SUBSTACK_SESSION_TOKEN");
    expect(usage).not.toContain("PREVIEW_TOKEN_SECRET");
  });
});
