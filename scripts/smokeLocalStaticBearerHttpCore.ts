import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

import { normalizeMcpEndpointPath } from "../src/safety/mcpPathSecret.js";
import { normalizeStaticBearerToken } from "../src/safety/staticBearerToken.js";
import type {
  PreviewSmokeResult,
  ValidationSmokeResult,
} from "./smokeValidateTool.js";

export const DEFAULT_STATIC_BEARER_HTTP_COMMAND = "node";
export const DEFAULT_STATIC_BEARER_HTTP_ARGS = ["dist/http.js"] as const;
export const DEFAULT_STATIC_BEARER_HTTP_HOST = "127.0.0.1";
export const DEFAULT_STATIC_BEARER_HTTP_MCP_PATH = "/mcp";
export const DEFAULT_STATIC_BEARER_TOKEN =
  "static-bearer-smoke-token-with-enough-entropy";
export const DEFAULT_WRONG_STATIC_BEARER_TOKEN = "wrong-static-bearer-token";

const DEFAULT_CHILD_ENV = {
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  MCP_TRANSPORT: "http",
  AUTH_MODE: "static_bearer",
  SUBSTACK_PUBLICATION_URL: "https://example.substack.com",
  SUBSTACK_USER_ID: "1",
} as const;

export interface LocalStaticBearerHttpSmokeRunOptions {
  readonly help: false;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly host: string;
  readonly port: number;
  readonly mcpPath: string;
  readonly bearerToken: string;
  readonly wrongBearerToken: string;
}

export interface LocalStaticBearerHttpSmokeHelpOptions {
  readonly help: true;
}

export type LocalStaticBearerHttpSmokeOptions =
  | LocalStaticBearerHttpSmokeRunOptions
  | LocalStaticBearerHttpSmokeHelpOptions;

export interface LocalStaticBearerHttpSmokeResult {
  readonly ok: true;
  readonly transport: "http";
  readonly auth_mode: "static_bearer";
  readonly endpoint: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly missing_bearer_status: 401;
  readonly wrong_bearer_status: 401;
  readonly tool_count: number;
  readonly tools: string[];
  readonly validation: ValidationSmokeResult;
  readonly preview: PreviewSmokeResult;
}

export function parseLocalStaticBearerHttpArgs(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd = process.cwd(),
): LocalStaticBearerHttpSmokeOptions {
  let command = DEFAULT_STATIC_BEARER_HTTP_COMMAND;
  let commandArgs: string[] | undefined;
  let workingDirectory = cwd;
  let host = DEFAULT_STATIC_BEARER_HTTP_HOST;
  let port = parsePort(env.PORT, "PORT", 0);
  let mcpPath = DEFAULT_STATIC_BEARER_HTTP_MCP_PATH;
  let bearerToken = DEFAULT_STATIC_BEARER_TOKEN;
  let wrongBearerToken = DEFAULT_WRONG_STATIC_BEARER_TOKEN;
  const envOverrides: Record<string, string> = {};

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--command":
        command = readValue(args, index, "--command");
        index += 1;
        break;
      case "--arg":
        commandArgs ??= [];
        commandArgs.push(readValue(args, index, "--arg", true));
        index += 1;
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
        port = parsePort(readValue(args, index, "--port"), "--port", 1);
        index += 1;
        break;
      case "--mcp-path":
        mcpPath = parseMcpPath(readValue(args, index, "--mcp-path"));
        index += 1;
        break;
      case "--bearer-token-env":
        bearerToken = readBearerTokenEnv(
          env,
          readValue(args, index, "--bearer-token-env"),
        );
        index += 1;
        break;
      case "--wrong-bearer-token-env":
        wrongBearerToken = readBearerTokenEnv(
          env,
          readValue(args, index, "--wrong-bearer-token-env"),
        );
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

  if (wrongBearerToken === bearerToken) {
    throw new Error(
      "--wrong-bearer-token-env must resolve to a token different from the valid bearer token.",
    );
  }

  return {
    help: false,
    command,
    args: commandArgs ?? [...DEFAULT_STATIC_BEARER_HTTP_ARGS],
    cwd: workingDirectory,
    env: buildChildEnv(envOverrides, port, bearerToken),
    host,
    port,
    mcpPath,
    bearerToken,
    wrongBearerToken,
  };
}

export function localStaticBearerHttpUsage(): string {
  return [
    "Usage: npm run smoke:http-static-bearer -- [options]",
    "",
    "Launches the built HTTP MCP server in AUTH_MODE=static_bearer, waits for",
    "/healthz, verifies missing and wrong bearer tokens return 401, then lists",
    "tools and calls validate_newsletter_content plus preview_draft over",
    "Streamable HTTP with the correct bearer token. It does not call Substack",
    "and does not run write tools.",
    "",
    "Default command:",
    "  node dist/http.js",
    "",
    "Options:",
    "  --command <command>             Executable to launch. Default: node.",
    "  --arg <arg>                     Argument passed to the command. Repeatable.",
    "  --cwd <path>                    Working directory for the child process.",
    "  --host <host>                   Host used by the smoke client. Default: 127.0.0.1.",
    "  --port <port>                   Local port. Default: choose an available port.",
    "  --mcp-path <path>               MCP endpoint path. Default: /mcp.",
    "  --bearer-token-env <name>       Read valid bearer token from env var.",
    "  --wrong-bearer-token-env <name> Read wrong bearer token from env var.",
    "  --env NAME=value                Override one child environment variable. Repeatable.",
    "  --help                          Show this help.",
    "",
    "Examples:",
    "  npm run build",
    "  npm run smoke:http-static-bearer",
    "  MCP_BEARER_TOKEN=secret npm run smoke:http-static-bearer -- --bearer-token-env MCP_BEARER_TOKEN",
  ].join("\n");
}

export function withStaticBearerHttpPort(
  options: LocalStaticBearerHttpSmokeRunOptions,
  port: number,
): LocalStaticBearerHttpSmokeRunOptions {
  return {
    ...options,
    port,
    env: {
      ...options.env,
      PORT: String(port),
    },
  };
}

function buildChildEnv(
  overrides: Record<string, string>,
  port: number,
  bearerToken: string,
): Record<string, string> {
  return {
    ...getDefaultEnvironment(),
    ...DEFAULT_CHILD_ENV,
    PORT: String(port),
    MCP_TRANSPORT: "http",
    AUTH_MODE: "static_bearer",
    MCP_BEARER_TOKEN: bearerToken,
    ...overrides,
  };
}

function parsePort(
  value: string | undefined,
  name: string,
  minimum: number,
): number {
  const raw = value?.trim();
  if (raw === undefined || raw === "") {
    return 0;
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

function readBearerTokenEnv(env: NodeJS.ProcessEnv, envName: string): string {
  const token = normalizeStaticBearerToken(env[envName], envName);
  if (!token) {
    throw new Error(`${envName} must be set to a non-empty bearer token.`);
  }

  return token;
}

function readValue(
  args: readonly string[],
  index: number,
  flag: string,
  allowLeadingDash = false,
): string {
  const value = args[index + 1];
  if (!value || (!allowLeadingDash && value.startsWith("--"))) {
    throw new Error(`${flag} requires a value.`);
  }

  return value;
}
