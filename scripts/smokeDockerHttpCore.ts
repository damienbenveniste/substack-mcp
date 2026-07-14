import { normalizeMcpEndpointPath } from "../src/safety/mcpPathSecret.js";
import type {
  PreviewSmokeResult,
  ValidationSmokeResult,
} from "./smokeValidateTool.js";

export const DEFAULT_DOCKER_COMMAND = "docker";
export const DEFAULT_DOCKER_IMAGE = "substack-mcp:smoke";
export const DEFAULT_DOCKER_BUILD_CONTEXT = ".";
export const DEFAULT_DOCKER_HOST = "127.0.0.1";
export const DEFAULT_DOCKER_CONTAINER_PORT = 8080;
export const DEFAULT_DOCKER_MCP_PATH = "/mcp";

const DEFAULT_CONTAINER_ENV = {
  NODE_ENV: "production",
  LOG_LEVEL: "silent",
  MCP_TRANSPORT: "http",
  AUTH_MODE: "noauth",
  SUBSTACK_PUBLICATION_URL: "https://example.substack.com",
  SUBSTACK_USER_ID: "1",
  PREVIEW_TOKEN_SECRET: "docker-smoke-preview-token-secret-with-enough-entropy",
} as const;

export interface DockerHttpSmokeRunOptions {
  readonly help: false;
  readonly dockerCommand: string;
  readonly image: string;
  readonly buildContext: string;
  readonly build: boolean;
  readonly cwd: string;
  readonly host: string;
  readonly port: number;
  readonly containerPort: number;
  readonly mcpPath: string;
  readonly containerEnv: Record<string, string>;
}

export interface DockerHttpSmokeHelpOptions {
  readonly help: true;
}

export type DockerHttpSmokeOptions =
  | DockerHttpSmokeRunOptions
  | DockerHttpSmokeHelpOptions;

export interface DockerHttpSmokeResult {
  readonly ok: true;
  readonly transport: "docker-http";
  readonly endpoint: string;
  readonly image: string;
  readonly host_port: number;
  readonly container_port: number;
  readonly tool_count: number;
  readonly tools: string[];
  readonly validation: ValidationSmokeResult;
  readonly preview: PreviewSmokeResult;
}

export function parseDockerHttpArgs(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd = process.cwd(),
): DockerHttpSmokeOptions {
  let dockerCommand = env.DOCKER_COMMAND ?? DEFAULT_DOCKER_COMMAND;
  let image = env.DOCKER_IMAGE ?? DEFAULT_DOCKER_IMAGE;
  let buildContext = DEFAULT_DOCKER_BUILD_CONTEXT;
  let build = true;
  let workingDirectory = cwd;
  let host = DEFAULT_DOCKER_HOST;
  let port = parsePort(env.PORT, "PORT", 0, 0);
  let containerPort = parsePort(
    env.CONTAINER_PORT,
    "CONTAINER_PORT",
    DEFAULT_DOCKER_CONTAINER_PORT,
    1,
  );
  let mcpPath = DEFAULT_DOCKER_MCP_PATH;
  const envOverrides: Record<string, string> = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--docker-command":
        dockerCommand = readValue(args, index, "--docker-command");
        index += 1;
        break;
      case "--image":
        image = readValue(args, index, "--image");
        index += 1;
        break;
      case "--build-context":
        buildContext = readValue(args, index, "--build-context");
        index += 1;
        break;
      case "--no-build":
        build = false;
        break;
      case "--cwd":
        workingDirectory = readValue(args, index, "--cwd");
        index += 1;
        break;
      case "--host":
        host = readValue(args, index, "--host");
        index += 1;
        break;
      case "--port":
        port = parsePort(readValue(args, index, "--port"), "--port", 1, 1);
        index += 1;
        break;
      case "--container-port":
        containerPort = parsePort(
          readValue(args, index, "--container-port"),
          "--container-port",
          1,
          1,
        );
        index += 1;
        break;
      case "--mcp-path":
        mcpPath = parseMcpPath(readValue(args, index, "--mcp-path"));
        index += 1;
        break;
      case "--env": {
        const assignment = readValue(args, index, "--env");
        const [name, value] = parseEnvAssignment(assignment);
        envOverrides[name] = value;
        index += 1;
        break;
      }
      case "--help":
      case "-h":
        return { help: true };
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return {
    help: false,
    dockerCommand,
    image,
    buildContext,
    build,
    cwd: workingDirectory,
    host,
    port,
    containerPort,
    mcpPath,
    containerEnv: buildContainerEnv(envOverrides, containerPort),
  };
}

export function dockerHttpUsage(): string {
  return [
    "Usage: npm run smoke:docker-http -- [options]",
    "",
    "Builds the Docker image, starts the HTTP MCP server in a container, waits",
    "for /healthz, lists tools over Streamable HTTP, and verifies the exact V1",
    "draft-only tool surface, then calls validate_newsletter_content and",
    "preview_draft with the rich Markdown fixture. It uses safe container env",
    "defaults, does not read .env files, does not call Substack, and does not",
    "run write tools.",
    "",
    "Default image:",
    "  substack-mcp:smoke",
    "",
    "Options:",
    "  --docker-command <command>  Docker-compatible executable. Default: docker.",
    "  --image <name:tag>          Image tag to build/run. Default: substack-mcp:smoke.",
    "  --build-context <path>      Docker build context. Default: .",
    "  --no-build                  Run an existing image instead of building first.",
    "  --cwd <path>                Working directory for Docker commands.",
    "  --host <host>               Host bind address. Default: 127.0.0.1.",
    "  --port <port>               Host port. Default: choose an available port.",
    "  --container-port <port>     Container PORT value. Default: 8080.",
    "  --mcp-path <path>           MCP endpoint path. Default: /mcp.",
    "  --env NAME=value            Override one container environment variable. Repeatable.",
    "  --help                      Show this help.",
    "",
    "Examples:",
    "  npm run smoke:docker-http",
    "  npm run smoke:docker-http -- --image substack-mcp:local",
    "  npm run smoke:docker-http -- --no-build --image substack-mcp:local",
  ].join("\n");
}

export function withDockerPort(
  options: DockerHttpSmokeRunOptions,
  port: number,
): DockerHttpSmokeRunOptions {
  return {
    ...options,
    port,
  };
}

export function dockerBuildArgs(
  options: Pick<DockerHttpSmokeRunOptions, "image" | "buildContext">,
): readonly string[] {
  return ["build", "--quiet", "--tag", options.image, options.buildContext];
}

export function dockerRunArgs(
  options: Pick<
    DockerHttpSmokeRunOptions,
    "host" | "port" | "containerPort" | "containerEnv" | "image"
  >,
  containerName: string,
): readonly string[] {
  return [
    "run",
    "--detach",
    "--rm",
    "--name",
    containerName,
    "--publish",
    `${options.host}:${options.port}:${options.containerPort}`,
    ...Object.entries(options.containerEnv).flatMap(([name, value]) => [
      "--env",
      `${name}=${value}`,
    ]),
    options.image,
  ];
}

function buildContainerEnv(
  overrides: Record<string, string>,
  containerPort: number,
): Record<string, string> {
  return {
    ...DEFAULT_CONTAINER_ENV,
    PORT: String(containerPort),
    MCP_TRANSPORT: "http",
    ...overrides,
  };
}

function parsePort(
  value: string | undefined,
  name: string,
  fallback: number,
  minimum: number,
): number {
  const raw = value?.trim();
  if (raw === undefined || raw === "") {
    return fallback;
  }

  const parsed = Number(raw);
  if (
    !/^\d+$/.test(raw) ||
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    parsed > 65_535
  ) {
    throw new Error(`${name} must be an integer from ${minimum} to 65535.`);
  }

  return parsed;
}

function parseMcpPath(value: string): string {
  return normalizeMcpEndpointPath(value);
}

function parseEnvAssignment(assignment: string): readonly [string, string] {
  const equalsIndex = assignment.indexOf("=");
  if (equalsIndex <= 0) {
    throw new Error("--env requires NAME=value.");
  }

  const name = assignment.slice(0, equalsIndex);
  const value = assignment.slice(equalsIndex + 1);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid environment variable name: ${name}`);
  }

  return [name, value];
}

function readValue(
  args: readonly string[],
  index: number,
  flag: string,
): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value.`);
  }

  return value;
}
