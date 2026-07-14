import { describe, expect, it } from "vitest";

import {
  DEFAULT_NGROK_API_URL,
  DEFAULT_NGROK_COMMAND,
  DEFAULT_NGROK_HTTP_ARGS,
  DEFAULT_NGROK_HTTP_COMMAND,
  DEFAULT_NGROK_MCP_PATH,
  DEFAULT_NGROK_PORT,
  localBaseUrl,
  ngrokArgsForPort,
  ngrokNoAuthUsage,
  parseNgrokNoAuthArgs,
  remoteMcpUrl,
  selectNgrokPublicUrl,
} from "../../scripts/smokeNgrokNoAuthHttpCore.js";

describe("parseNgrokNoAuthArgs", () => {
  it("uses safe local noauth defaults for the built HTTP server and ngrok", () => {
    const options = parseNgrokNoAuthArgs([], {}, "/repo/substack-mcp");

    expect(options).toMatchObject({
      help: false,
      command: DEFAULT_NGROK_HTTP_COMMAND,
      args: [...DEFAULT_NGROK_HTTP_ARGS],
      cwd: "/repo/substack-mcp",
      artifactRoot: "/repo/substack-mcp",
      host: "127.0.0.1",
      port: DEFAULT_NGROK_PORT,
      mcpPath: DEFAULT_NGROK_MCP_PATH,
      ngrokCommand: DEFAULT_NGROK_COMMAND,
      ngrokArgs: [],
      tunnelTimeoutMs: 15_000,
      holdOpenSeconds: 0,
      useLocalCredentials: false,
    });
    if (options.help) {
      throw new Error("Expected runnable ngrok noauth smoke options.");
    }
    expect(options.ngrokApiUrl.href).toBe(DEFAULT_NGROK_API_URL);
    expect(options.evidenceArtifact).toBeUndefined();
    expect(options.env).toMatchObject({
      AUTH_MODE: "noauth",
      MCP_TRANSPORT: "http",
      NODE_ENV: "test",
      PORT: "8787",
      SUBSTACK_PUBLICATION_URL: "https://example.substack.com",
      SUBSTACK_SESSION_TOKEN: "ngrok-smoke-session-token",
      SUBSTACK_USER_ID: "1",
    });
    expect(options.env.PREVIEW_TOKEN_SECRET).toContain(
      "ngrok-smoke-preview-token-secret",
    );
  });

  it("supports custom commands, tunnel options, evidence artifact, and env overrides", () => {
    const options = parseNgrokNoAuthArgs(
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
        "--evidence-artifact",
        ".data/v1/gate-11-chatgpt-ngrok.md",
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
        "--use-local-credentials",
        "--env",
        "MAX_BODY_BYTES=1234",
      ],
      {
        AUTH_MODE: "static_bearer",
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
      evidenceArtifact: ".data/v1/gate-11-chatgpt-ngrok.md",
      host: "localhost",
      port: 9000,
      mcpPath: "/mcp/private",
      ngrokCommand: "custom-ngrok",
      ngrokArgs: ["--domain=example.ngrok.app"],
      tunnelTimeoutMs: 2000,
      holdOpenSeconds: 900,
      useLocalCredentials: true,
    });
    if (options.help) {
      throw new Error("Expected runnable ngrok noauth smoke options.");
    }
    expect(options.ngrokApiUrl.href).toBe("http://127.0.0.1:4041/api/tunnels");
    expect(options.env.AUTH_MODE).toBe("noauth");
    expect(options.env.PORT).toBe("9000");
    expect(options.env.MAX_BODY_BYTES).toBe("1234");
  });

  it("uses PORT from the environment while preserving safe noauth app settings", () => {
    const options = parseNgrokNoAuthArgs(
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
      throw new Error("Expected runnable ngrok noauth smoke options.");
    }
    expect(options.env).toMatchObject({
      AUTH_MODE: "noauth",
      LOG_LEVEL: "debug",
      PORT: "9999",
      SUBSTACK_PUBLICATION_URL: "https://custom.substack.com",
      SUBSTACK_USER_AGENT: "SubstackMcpTest/1.0",
    });
  });

  it("allows help without local server configuration", () => {
    expect(parseNgrokNoAuthArgs(["--help"], {})).toEqual({ help: true });
    expect(parseNgrokNoAuthArgs(["-h"], {})).toEqual({ help: true });
  });

  it("rejects invalid or unsafe options", () => {
    expect(() => parseNgrokNoAuthArgs(["--command"], {})).toThrow(
      "--command requires a value.",
    );
    expect(() => parseNgrokNoAuthArgs(["--port", "0"], {})).toThrow(
      "--port must be an integer from 1 to 65535.",
    );
    expect(() => parseNgrokNoAuthArgs(["--port", "65536"], {})).toThrow(
      "--port must be an integer from 1 to 65535.",
    );
    expect(() => parseNgrokNoAuthArgs(["--mcp-path", "/not-mcp"], {})).toThrow(
      "--mcp-path must be /mcp or /mcp/<secret>.",
    );
    expect(() =>
      parseNgrokNoAuthArgs(["--mcp-path", "/mcp/private/nested"], {}),
    ).toThrow("<secret> must be one URL-safe path segment");
    expect(() =>
      parseNgrokNoAuthArgs(["--evidence-artifact", "../outside.md"], {}),
    ).toThrow(
      "ngrok noauth evidence artifact must stay inside the project directory.",
    );
    expect(() =>
      parseNgrokNoAuthArgs(["--ngrok-api-url", "https://example.com"], {}),
    ).toThrow("--ngrok-api-url must use http.");
    expect(() =>
      parseNgrokNoAuthArgs(["--tunnel-timeout-ms", "999"], {}),
    ).toThrow("--tunnel-timeout-ms must be an integer from 1000 to 120000.");
    expect(() =>
      parseNgrokNoAuthArgs(["--hold-open-seconds", "3601"], {}),
    ).toThrow("--hold-open-seconds must be an integer from 0 to 3600.");
    expect(() => parseNgrokNoAuthArgs(["--use-local-credentials"], {})).toThrow(
      "--use-local-credentials requires a non-zero --hold-open-seconds window for explicit manual acceptance.",
    );
    expect(() => parseNgrokNoAuthArgs(["--env", "1BAD=value"], {})).toThrow(
      "Invalid environment variable name: 1BAD",
    );
    expect(() => parseNgrokNoAuthArgs(["--env", "NO_EQUALS"], {})).toThrow(
      "--env requires NAME=value.",
    );
    expect(() => parseNgrokNoAuthArgs(["--bogus"], {})).toThrow(
      "Unknown option: --bogus",
    );
  });
});

describe("ngrok noauth helpers", () => {
  it("builds local, ngrok, and remote endpoint URLs", () => {
    expect(localBaseUrl({ host: "localhost", port: 9000 })).toBe(
      "http://localhost:9000",
    );
    expect(
      ngrokArgsForPort({
        ngrokArgs: ["--domain=example.ngrok.app"],
        port: 9000,
      }),
    ).toEqual(["http", "--domain=example.ngrok.app", "9000"]);
    expect(
      remoteMcpUrl(new URL("https://abc.ngrok.app/ignored"), "/mcp/private")
        .href,
    ).toBe("https://abc.ngrok.app/mcp/private");
  });

  it("selects an HTTPS ngrok public URL, preferring the requested local port", () => {
    expect(
      selectNgrokPublicUrl(
        {
          tunnels: [
            {
              public_url: "https://first.ngrok.app",
              config: { addr: "http://127.0.0.1:1111" },
            },
            {
              public_url: "http://ignored.ngrok.app",
              config: { addr: "http://127.0.0.1:8787" },
            },
            {
              public_url: "https://match.ngrok.app",
              config: { addr: "http://127.0.0.1:8787" },
            },
          ],
        },
        8787,
      )?.href,
    ).toBe("https://match.ngrok.app/");

    expect(
      selectNgrokPublicUrl(
        {
          tunnels: [
            {
              public_url: "https://fallback.ngrok.app",
              config: { addr: "http://127.0.0.1:1111" },
            },
          ],
        },
        8787,
      )?.href,
    ).toBe("https://fallback.ngrok.app/");

    expect(selectNgrokPublicUrl({ tunnels: [] }, 8787)).toBeUndefined();
    expect(selectNgrokPublicUrl({ tunnels: "invalid" }, 8787)).toBeUndefined();
    expect(
      selectNgrokPublicUrl(
        {
          tunnels: [
            "invalid",
            {
              public_url: "not a url",
              config: "invalid",
            },
          ],
        },
        8787,
      ),
    ).toBeUndefined();
  });

  it("describes the helper without printing secrets", () => {
    const usage = ngrokNoAuthUsage();

    expect(usage).toContain("npm run smoke:ngrok-noauth");
    expect(usage).toContain("ngrok http 8787");
    expect(usage).toContain("--evidence-artifact");
    expect(usage).toContain("--hold-open-seconds");
    expect(usage).toContain("--use-local-credentials");
    expect(usage).toContain("AUTH_MODE=noauth");
    expect(usage).not.toContain("SUBSTACK_SESSION_TOKEN");
    expect(usage).not.toContain("PREVIEW_TOKEN_SECRET");
  });
});
