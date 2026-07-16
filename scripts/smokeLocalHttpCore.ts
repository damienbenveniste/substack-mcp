import { isAbsolute, relative, resolve } from "node:path";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

import { normalizeMcpEndpointPath } from "../src/safety/mcpPathSecret.js";
import type {
  PreviewSmokeResult,
  ValidationSmokeResult,
} from "./smokeValidateTool.js";

export const DEFAULT_HTTP_COMMAND = "node";
export const DEFAULT_HTTP_ARGS = ["dist/http.js"] as const;
export const DEFAULT_HTTP_HOST = "127.0.0.1";
export const DEFAULT_HTTP_MCP_PATH = "/mcp";
export const DEFAULT_INSPECTOR_COMMAND = "npx";
export const DEFAULT_INSPECTOR_ARGS = [
  "--yes",
  "@modelcontextprotocol/inspector@latest",
] as const;

const DEFAULT_CHILD_ENV = {
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  MCP_TRANSPORT: "http",
  AUTH_MODE: "noauth",
  SUBSTACK_PUBLICATION_URL: "https://example.substack.com",
  SUBSTACK_SESSION_TOKEN: "http-smoke-session-token",
  SUBSTACK_USER_ID: "1",
  PREVIEW_TOKEN_SECRET: "http-smoke-preview-token-secret-with-enough-entropy",
} as const;

const APP_ENV_KEYS = [
  "NODE_ENV",
  "LOG_LEVEL",
  "MCP_TRANSPORT",
  "AUTH_MODE",
  "SUBSTACK_PUBLICATION_URL",
  "SUBSTACK_SESSION_TOKEN",
  "SUBSTACK_USER_ID",
  "SUBSTACK_USER_AGENT",
  "PREVIEW_TOKEN_SECRET",
  "MAX_BODY_BYTES",
  "MAX_IMAGE_BYTES",
  "SUBSTACK_REQUEST_TIMEOUT_MS",
  "CONFIRMATION_TOKEN_TTL_SECONDS",
  "MCP_BEARER_TOKEN",
  "MCP_PATH_SECRET",
  "MCP_PUBLIC_BASE_URL",
  "OAUTH_AUTHORIZATION_SERVER_URL",
  "OAUTH_RESOURCE_DOCUMENTATION_URL",
  "OAUTH_JWKS_URL",
  "OAUTH_JWT_ALGORITHMS",
] as const;

export interface LocalHttpSmokeRunOptions {
  readonly help: false;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly artifactRoot: string;
  readonly evidenceArtifact?: string | undefined;
  readonly runInspectorCli: boolean;
  readonly inspectorCommand: string;
  readonly inspectorArgs: readonly string[];
  readonly env: Record<string, string>;
  readonly host: string;
  readonly port: number;
  readonly mcpPath: string;
}

export interface LocalHttpSmokeHelpOptions {
  readonly help: true;
}

export type LocalHttpSmokeOptions =
  | LocalHttpSmokeRunOptions
  | LocalHttpSmokeHelpOptions;

export interface LocalHttpSmokeResult {
  readonly ok: true;
  readonly transport: "http";
  readonly endpoint: string;
  readonly health: LocalHttpHealthResult;
  readonly command: string;
  readonly args: readonly string[];
  readonly tool_count: number;
  readonly tools: string[];
  readonly inspector?: LocalHttpInspectorResult | undefined;
  readonly validation: ValidationSmokeResult;
  readonly preview: PreviewSmokeResult;
}

export interface LocalHttpInspectorResult {
  readonly ok: true;
  readonly command: string;
  readonly args: readonly string[];
  readonly method: "tools/list";
  readonly tool_count: number;
  readonly tools: string[];
}

export interface LocalHttpHealthResult {
  readonly url: string;
  readonly status: number;
}

export function parseLocalHttpArgs(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd = process.cwd(),
): LocalHttpSmokeOptions {
  let command = DEFAULT_HTTP_COMMAND;
  let commandArgs: string[] | undefined;
  let workingDirectory = cwd;
  let host = DEFAULT_HTTP_HOST;
  let port = parsePort(env.PORT, "PORT", 0);
  let mcpPath = DEFAULT_HTTP_MCP_PATH;
  let evidenceArtifact: string | undefined;
  let runInspectorCli = false;
  let inspectorCommand = DEFAULT_INSPECTOR_COMMAND;
  let inspectorArgs: string[] | undefined;
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
      case "--evidence-artifact":
        evidenceArtifact = resolveProjectArtifact(
          cwd,
          readValue(args, index, "--evidence-artifact"),
        );
        index += 1;
        break;
      case "--inspector-cli":
        runInspectorCli = true;
        break;
      case "--inspector-command":
        inspectorCommand = readValue(args, index, "--inspector-command");
        index += 1;
        break;
      case "--inspector-arg":
        inspectorArgs ??= [];
        inspectorArgs.push(readValue(args, index, "--inspector-arg", true));
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
    command,
    args: commandArgs ?? [...DEFAULT_HTTP_ARGS],
    cwd: workingDirectory,
    artifactRoot: resolve(cwd),
    evidenceArtifact,
    runInspectorCli,
    inspectorCommand,
    inspectorArgs: inspectorArgs ?? [...DEFAULT_INSPECTOR_ARGS],
    env: buildChildEnv(env, envOverrides, port),
    host,
    port,
    mcpPath,
  };
}

export function localHttpUsage(): string {
  return [
    "Usage: npm run smoke:http-local -- [options]",
    "",
    "Launches the built HTTP MCP server, waits for /healthz, lists tools over",
    "Streamable HTTP, verifies the V1 draft-workflow tool surface, and calls",
    "validate_newsletter_content and preview_draft with the rich Markdown",
    "fixture. It does not call Substack and does not run write tools.",
    "",
    "Default command:",
    "  node dist/http.js",
    "",
    "Options:",
    "  --command <command>    Executable to launch. Default: node.",
    "  --arg <arg>            Argument passed to the command. Repeatable.",
    "  --cwd <path>           Working directory for the child process.",
    "  --host <host>          Host used by the smoke client. Default: 127.0.0.1.",
    "  --port <port>          Local port. Default: choose an available port.",
    "  --mcp-path <path>      MCP endpoint path. Default: /mcp.",
    "  --evidence-artifact <path>",
    "                         Write sanitized Markdown evidence for gate 3.",
    "  --inspector-cli       Also run MCP Inspector CLI `tools/list` against the endpoint.",
    "  --inspector-command <command>",
    "                         Inspector executable. Default: npx.",
    "  --inspector-arg <arg>  Inspector command argument before --cli. Repeatable.",
    "  --env NAME=value       Override one child environment variable. Repeatable.",
    "  --help                 Show this help.",
    "",
    "Examples:",
    "  npm run build",
    "  npm run smoke:http-local",
    "  npm run smoke:http-local -- --inspector-cli",
    "  npm run smoke:http-local -- --command tsx --arg src/http.ts",
  ].join("\n");
}

export function withPort(
  options: LocalHttpSmokeRunOptions,
  port: number,
): LocalHttpSmokeRunOptions {
  return {
    ...options,
    port,
    env: {
      ...options.env,
      PORT: String(port),
    },
  };
}

function resolveProjectArtifact(cwd: string, value: string): string {
  const root = resolve(cwd);
  const artifactPath = resolve(root, value);
  const artifact = relative(root, artifactPath);
  if (artifact === "" || artifact.startsWith("..") || isAbsolute(artifact)) {
    throw new Error(
      "local HTTP evidence artifact must stay inside the project directory.",
    );
  }

  return artifact;
}

function buildChildEnv(
  env: NodeJS.ProcessEnv,
  overrides: Record<string, string>,
  port: number,
): Record<string, string> {
  return {
    ...getDefaultEnvironment(),
    ...DEFAULT_CHILD_ENV,
    ...pickAppEnv(env),
    PORT: String(port),
    MCP_TRANSPORT: "http",
    ...overrides,
  };
}

function pickAppEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const key of APP_ENV_KEYS) {
    const value = env[key];
    if (value !== undefined) {
      picked[key] = value;
    }
  }
  return picked;
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
