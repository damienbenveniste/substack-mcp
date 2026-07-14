import { describe, expect, it } from "vitest";

import {
  DEFAULT_DOCKER_BUILD_CONTEXT,
  DEFAULT_DOCKER_COMMAND,
  DEFAULT_DOCKER_CONTAINER_PORT,
  DEFAULT_DOCKER_HOST,
  DEFAULT_DOCKER_IMAGE,
  DEFAULT_DOCKER_MCP_PATH,
  dockerBuildArgs,
  dockerHttpUsage,
  dockerRunArgs,
  parseDockerHttpArgs,
  withDockerPort,
} from "../../scripts/smokeDockerHttpCore.js";

describe("parseDockerHttpArgs", () => {
  it("uses the Dockerfile image path and safe container env by default", () => {
    const options = parseDockerHttpArgs([], {}, "/repo");

    expect(options).toMatchObject({
      help: false,
      dockerCommand: DEFAULT_DOCKER_COMMAND,
      image: DEFAULT_DOCKER_IMAGE,
      buildContext: DEFAULT_DOCKER_BUILD_CONTEXT,
      build: true,
      cwd: "/repo",
      host: DEFAULT_DOCKER_HOST,
      port: 0,
      containerPort: DEFAULT_DOCKER_CONTAINER_PORT,
      mcpPath: DEFAULT_DOCKER_MCP_PATH,
    });
    if (options.help) {
      throw new Error("Expected runnable Docker HTTP smoke-test options.");
    }
    expect(options.containerEnv).toMatchObject({
      NODE_ENV: "production",
      LOG_LEVEL: "silent",
      MCP_TRANSPORT: "http",
      AUTH_MODE: "noauth",
      PORT: String(DEFAULT_DOCKER_CONTAINER_PORT),
      SUBSTACK_PUBLICATION_URL: "https://example.substack.com",
      SUBSTACK_USER_ID: "1",
      PREVIEW_TOKEN_SECRET:
        "docker-smoke-preview-token-secret-with-enough-entropy",
    });
    expect(options.containerEnv).not.toHaveProperty("SUBSTACK_SESSION_TOKEN");
  });

  it("supports custom Docker command, image, ports, endpoint, and container env", () => {
    const options = parseDockerHttpArgs(
      [
        "--docker-command",
        "podman",
        "--image",
        "substack-mcp:test",
        "--build-context",
        "/repo/context",
        "--no-build",
        "--cwd",
        "/custom",
        "--host",
        "localhost",
        "--port",
        "9876",
        "--container-port",
        "9090",
        "--mcp-path",
        "/mcp/private",
        "--env",
        "LOG_LEVEL=debug",
        "--env",
        "MCP_PATH_SECRET=private",
      ],
      {},
      "/repo",
    );

    expect(options).toMatchObject({
      help: false,
      dockerCommand: "podman",
      image: "substack-mcp:test",
      buildContext: "/repo/context",
      build: false,
      cwd: "/custom",
      host: "localhost",
      port: 9876,
      containerPort: 9090,
      mcpPath: "/mcp/private",
    });
    if (options.help) {
      throw new Error("Expected runnable Docker HTTP smoke-test options.");
    }
    expect(options.containerEnv.LOG_LEVEL).toBe("debug");
    expect(options.containerEnv.MCP_PATH_SECRET).toBe("private");
    expect(options.containerEnv.MCP_TRANSPORT).toBe("http");
    expect(options.containerEnv.PORT).toBe("9090");
  });

  it("honors DOCKER_COMMAND, DOCKER_IMAGE, PORT, and CONTAINER_PORT env defaults", () => {
    const options = parseDockerHttpArgs(
      [],
      {
        DOCKER_COMMAND: "podman",
        DOCKER_IMAGE: "substack-mcp:env",
        PORT: "8788",
        CONTAINER_PORT: "9091",
      },
      "/repo",
    );

    expect(options).toMatchObject({
      help: false,
      dockerCommand: "podman",
      image: "substack-mcp:env",
      port: 8788,
      containerPort: 9091,
    });
  });

  it("replaces the auto-selected host port", () => {
    const options = parseDockerHttpArgs([], {}, "/repo");
    if (options.help) {
      throw new Error("Expected runnable Docker HTTP smoke-test options.");
    }

    expect(withDockerPort(options, 54321)).toMatchObject({
      port: 54321,
      containerEnv: {
        PORT: String(DEFAULT_DOCKER_CONTAINER_PORT),
      },
    });
  });

  it("allows help without runnable configuration", () => {
    expect(parseDockerHttpArgs(["--help"], {}, "/repo")).toEqual({
      help: true,
    });
    expect(parseDockerHttpArgs(["-h"], {}, "/repo")).toEqual({
      help: true,
    });
  });

  it("rejects missing values, invalid ports, invalid endpoints, env errors, and unknown options", () => {
    expect(() =>
      parseDockerHttpArgs(["--docker-command"], {}, "/repo"),
    ).toThrow("--docker-command requires a value.");
    expect(() => parseDockerHttpArgs(["--image"], {}, "/repo")).toThrow(
      "--image requires a value.",
    );
    expect(() => parseDockerHttpArgs(["--build-context"], {}, "/repo")).toThrow(
      "--build-context requires a value.",
    );
    expect(() => parseDockerHttpArgs(["--cwd"], {}, "/repo")).toThrow(
      "--cwd requires a value.",
    );
    expect(() => parseDockerHttpArgs(["--host"], {}, "/repo")).toThrow(
      "--host requires a value.",
    );
    expect(() => parseDockerHttpArgs(["--port", "0"], {}, "/repo")).toThrow(
      "--port must be an integer from 1 to 65535.",
    );
    expect(() =>
      parseDockerHttpArgs(["--container-port", "0"], {}, "/repo"),
    ).toThrow("--container-port must be an integer from 1 to 65535.");
    expect(() =>
      parseDockerHttpArgs(["--container-port", "8080abc"], {}, "/repo"),
    ).toThrow("--container-port must be an integer from 1 to 65535.");
    expect(() =>
      parseDockerHttpArgs(["--mcp-path", "/not-mcp"], {}, "/repo"),
    ).toThrow("--mcp-path must be /mcp or /mcp/<secret>.");
    expect(() =>
      parseDockerHttpArgs(["--mcp-path", "/mcp/private/nested"], {}, "/repo"),
    ).toThrow("<secret> must be one URL-safe path segment");
    expect(() => parseDockerHttpArgs(["--env"], {}, "/repo")).toThrow(
      "--env requires a value.",
    );
    expect(() =>
      parseDockerHttpArgs(["--env", "NOT-VALID=value"], {}, "/repo"),
    ).toThrow("Invalid environment variable name: NOT-VALID");
    expect(() =>
      parseDockerHttpArgs(["--env", "MISSING_VALUE"], {}, "/repo"),
    ).toThrow("--env requires NAME=value.");
    expect(() => parseDockerHttpArgs(["--bogus"], {}, "/repo")).toThrow(
      "Unknown option: --bogus",
    );
  });
});

describe("Docker command builders", () => {
  it("builds quiet tagged Docker build args", () => {
    expect(
      dockerBuildArgs({
        image: "substack-mcp:test",
        buildContext: ".",
      }),
    ).toEqual(["build", "--quiet", "--tag", "substack-mcp:test", "."]);
  });

  it("builds a detached run command with safe env and localhost port binding", () => {
    const options = parseDockerHttpArgs([], {}, "/repo");
    if (options.help) {
      throw new Error("Expected runnable Docker HTTP smoke-test options.");
    }

    const args = dockerRunArgs(
      withDockerPort(options, 54321),
      "test-container",
    );

    expect(args).toContain("--detach");
    expect(args).toContain("--rm");
    expect(args).toContain("test-container");
    expect(args).toContain("127.0.0.1:54321:8080");
    expect(args).toContain("PORT=8080");
    expect(args).toContain("AUTH_MODE=noauth");
    expect(args).toContain(
      "PREVIEW_TOKEN_SECRET=docker-smoke-preview-token-secret-with-enough-entropy",
    );
    expect(args).toContain(DEFAULT_DOCKER_IMAGE);
    expect(args.join(" ")).not.toContain("SUBSTACK_SESSION_TOKEN=");
  });
});

describe("dockerHttpUsage", () => {
  it("describes the Docker HTTP smoke command without embedding secrets", () => {
    expect(dockerHttpUsage()).toContain("npm run smoke:docker-http");
    expect(dockerHttpUsage()).toContain("substack-mcp:smoke");
    expect(dockerHttpUsage()).not.toContain("SUBSTACK_SESSION_TOKEN=");
  });
});
