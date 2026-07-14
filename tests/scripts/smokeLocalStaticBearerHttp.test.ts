import { describe, expect, it } from "vitest";

import {
  DEFAULT_STATIC_BEARER_HTTP_ARGS,
  DEFAULT_STATIC_BEARER_HTTP_COMMAND,
  DEFAULT_STATIC_BEARER_HTTP_HOST,
  DEFAULT_STATIC_BEARER_HTTP_MCP_PATH,
  DEFAULT_STATIC_BEARER_TOKEN,
  DEFAULT_WRONG_STATIC_BEARER_TOKEN,
  localStaticBearerHttpUsage,
  parseLocalStaticBearerHttpArgs,
  withStaticBearerHttpPort,
} from "../../scripts/smokeLocalStaticBearerHttpCore.js";

describe("parseLocalStaticBearerHttpArgs", () => {
  it("uses the built HTTP entrypoint and safe static-bearer env by default", () => {
    const options = parseLocalStaticBearerHttpArgs([], {}, "/repo");

    expect(options).toMatchObject({
      help: false,
      command: DEFAULT_STATIC_BEARER_HTTP_COMMAND,
      args: [...DEFAULT_STATIC_BEARER_HTTP_ARGS],
      cwd: "/repo",
      host: DEFAULT_STATIC_BEARER_HTTP_HOST,
      port: 0,
      mcpPath: DEFAULT_STATIC_BEARER_HTTP_MCP_PATH,
      bearerToken: DEFAULT_STATIC_BEARER_TOKEN,
      wrongBearerToken: DEFAULT_WRONG_STATIC_BEARER_TOKEN,
    });
    if (options.help) {
      throw new Error(
        "Expected runnable local static-bearer HTTP smoke-test options.",
      );
    }
    expect(options.env).toMatchObject({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      MCP_TRANSPORT: "http",
      AUTH_MODE: "static_bearer",
      MCP_BEARER_TOKEN: DEFAULT_STATIC_BEARER_TOKEN,
      PORT: "0",
      SUBSTACK_PUBLICATION_URL: "https://example.substack.com",
      SUBSTACK_USER_ID: "1",
    });
    expect(options.env).not.toHaveProperty("SUBSTACK_SESSION_TOKEN");
    expect(options.env).not.toHaveProperty("PREVIEW_TOKEN_SECRET");
  });

  it("supports custom command, args, cwd, endpoint, tokens, and child env", () => {
    const options = parseLocalStaticBearerHttpArgs(
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
        "--bearer-token-env",
        "VALID_TOKEN",
        "--wrong-bearer-token-env",
        "WRONG_TOKEN",
        "--env",
        "MCP_PATH_SECRET=private",
      ],
      {
        VALID_TOKEN: "valid-token",
        WRONG_TOKEN: "wrong-token",
      },
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
      bearerToken: "valid-token",
      wrongBearerToken: "wrong-token",
    });
    if (options.help) {
      throw new Error(
        "Expected runnable local static-bearer HTTP smoke-test options.",
      );
    }
    expect(options.env.MCP_BEARER_TOKEN).toBe("valid-token");
    expect(options.env.MCP_PATH_SECRET).toBe("private");
    expect(options.env.AUTH_MODE).toBe("static_bearer");
    expect(options.env.MCP_TRANSPORT).toBe("http");
    expect(options.env.PORT).toBe("9876");
  });

  it("replaces the auto port placeholder consistently", () => {
    const options = parseLocalStaticBearerHttpArgs([], {}, "/repo");
    if (options.help) {
      throw new Error(
        "Expected runnable local static-bearer HTTP smoke-test options.",
      );
    }

    expect(withStaticBearerHttpPort(options, 54321)).toMatchObject({
      port: 54321,
      env: {
        PORT: "54321",
      },
    });
  });

  it("allows help without runnable configuration", () => {
    expect(parseLocalStaticBearerHttpArgs(["--help"], {}, "/repo")).toEqual({
      help: true,
    });
    expect(parseLocalStaticBearerHttpArgs(["-h"], {}, "/repo")).toEqual({
      help: true,
    });
  });

  it("rejects missing values, invalid endpoints, invalid env assignments, and unknown options", () => {
    expect(() =>
      parseLocalStaticBearerHttpArgs(["--command"], {}, "/repo"),
    ).toThrow("--command requires a value.");
    expect(() =>
      parseLocalStaticBearerHttpArgs(["--arg"], {}, "/repo"),
    ).toThrow("--arg requires a value.");
    expect(() =>
      parseLocalStaticBearerHttpArgs(["--cwd"], {}, "/repo"),
    ).toThrow("--cwd requires a value.");
    expect(() =>
      parseLocalStaticBearerHttpArgs(["--host"], {}, "/repo"),
    ).toThrow("--host requires a value.");
    expect(() =>
      parseLocalStaticBearerHttpArgs(["--port", "0"], {}, "/repo"),
    ).toThrow("--port must be an integer from 1 to 65535.");
    expect(() =>
      parseLocalStaticBearerHttpArgs(["--port", "8787abc"], {}, "/repo"),
    ).toThrow("--port must be an integer from 1 to 65535.");
    expect(() =>
      parseLocalStaticBearerHttpArgs(["--mcp-path", "/not-mcp"], {}, "/repo"),
    ).toThrow("--mcp-path must be /mcp or /mcp/<secret>.");
    expect(() =>
      parseLocalStaticBearerHttpArgs(
        ["--mcp-path", "/mcp/private/nested"],
        {},
        "/repo",
      ),
    ).toThrow("<secret> must be one URL-safe path segment");
    expect(() =>
      parseLocalStaticBearerHttpArgs(
        ["--bearer-token-env", "MISSING_TOKEN"],
        {},
        "/repo",
      ),
    ).toThrow("MISSING_TOKEN must be set to a non-empty bearer token.");
    expect(() =>
      parseLocalStaticBearerHttpArgs(
        ["--bearer-token-env", "TOKEN"],
        { TOKEN: "Bearer valid-token" },
        "/repo",
      ),
    ).toThrow(
      "TOKEN must be the bearer token value only, not an Authorization header or Bearer-prefixed value.",
    );
    expect(() =>
      parseLocalStaticBearerHttpArgs(
        ["--bearer-token-env", "TOKEN", "--wrong-bearer-token-env", "TOKEN"],
        { TOKEN: "same-token" },
        "/repo",
      ),
    ).toThrow("--wrong-bearer-token-env must resolve to a token different");
    expect(() =>
      parseLocalStaticBearerHttpArgs(["--env"], {}, "/repo"),
    ).toThrow("--env requires a value.");
    expect(() =>
      parseLocalStaticBearerHttpArgs(["--env", "NOT-VALID=value"], {}, "/repo"),
    ).toThrow("Invalid environment variable name: NOT-VALID");
    expect(() =>
      parseLocalStaticBearerHttpArgs(["--env", "MISSING_VALUE"], {}, "/repo"),
    ).toThrow("--env requires NAME=value.");
    expect(() =>
      parseLocalStaticBearerHttpArgs(["--bogus"], {}, "/repo"),
    ).toThrow("Unknown option: --bogus");
  });
});

describe("localStaticBearerHttpUsage", () => {
  it("describes the command without embedding bearer token values", () => {
    expect(localStaticBearerHttpUsage()).toContain(
      "npm run smoke:http-static-bearer",
    );
    expect(localStaticBearerHttpUsage()).toContain("node dist/http.js");
    expect(localStaticBearerHttpUsage()).toContain("MCP_BEARER_TOKEN");
    expect(localStaticBearerHttpUsage()).not.toContain(
      DEFAULT_STATIC_BEARER_TOKEN,
    );
  });
});
