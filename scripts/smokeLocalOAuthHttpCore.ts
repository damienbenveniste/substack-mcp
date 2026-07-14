import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

import { type AuthScope, authScopes } from "../src/auth/scopes.js";
import { normalizeMcpEndpointPath } from "../src/safety/mcpPathSecret.js";
import type {
  PreviewSmokeResult,
  ValidationSmokeResult,
} from "./smokeValidateTool.js";

export const DEFAULT_OAUTH_HTTP_COMMAND = "node";
export const DEFAULT_OAUTH_HTTP_ARGS = ["dist/http.js"] as const;
export const DEFAULT_OAUTH_HTTP_HOST = "127.0.0.1";
export const DEFAULT_OAUTH_HTTP_MCP_PATH = "/mcp";
export const DEFAULT_OAUTH_JWKS_HOST = "127.0.0.1";
export const DEFAULT_OAUTH_JWKS_PATH = "/jwks.json";
export const DEFAULT_OAUTH_ISSUER = "https://substack-mcp-smoke-auth.local";
export const DEFAULT_OAUTH_SUBJECT = "local-oauth-smoke-user";

const DEFAULT_CHILD_ENV = {
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  MCP_TRANSPORT: "http",
  AUTH_MODE: "oauth",
  OAUTH_JWT_ALGORITHMS: "RS256",
  NODE_TLS_REJECT_UNAUTHORIZED: "0",
  SUBSTACK_PUBLICATION_URL: "https://example.substack.com",
  SUBSTACK_USER_ID: "1",
} as const;

export interface LocalOAuthHttpSmokeRunOptions {
  readonly help: false;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly host: string;
  readonly port: number;
  readonly mcpPath: string;
  readonly jwksHost: string;
  readonly jwksPort: number;
  readonly jwksPath: string;
  readonly issuerUrl: string;
  readonly subject: string;
  readonly scopes: readonly AuthScope[];
}

export interface LocalOAuthHttpSmokeHelpOptions {
  readonly help: true;
}

export type LocalOAuthHttpSmokeOptions =
  | LocalOAuthHttpSmokeRunOptions
  | LocalOAuthHttpSmokeHelpOptions;

export interface LocalOAuthHttpSmokeResult {
  readonly ok: true;
  readonly transport: "http";
  readonly auth_mode: "oauth";
  readonly endpoint: string;
  readonly protected_resource_metadata_url: string;
  readonly authorization_server_discovery_url: string;
  readonly jwks_url: string;
  readonly issuer: string;
  readonly subject: string;
  readonly scopes: readonly AuthScope[];
  readonly command: string;
  readonly args: readonly string[];
  readonly missing_bearer_status: 401;
  readonly tool_count: number;
  readonly tools: string[];
  readonly validation: ValidationSmokeResult;
  readonly preview: PreviewSmokeResult;
}

export function parseLocalOAuthHttpArgs(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd = process.cwd(),
): LocalOAuthHttpSmokeOptions {
  let command = DEFAULT_OAUTH_HTTP_COMMAND;
  let commandArgs: string[] | undefined;
  let workingDirectory = cwd;
  let host = DEFAULT_OAUTH_HTTP_HOST;
  let port = parsePort(env.PORT, "PORT", 0);
  let mcpPath = DEFAULT_OAUTH_HTTP_MCP_PATH;
  let jwksHost = DEFAULT_OAUTH_JWKS_HOST;
  let jwksPort = parsePort(env.OAUTH_JWKS_PORT, "OAUTH_JWKS_PORT", 0);
  let jwksPath = DEFAULT_OAUTH_JWKS_PATH;
  let issuerUrl = DEFAULT_OAUTH_ISSUER;
  let subject = DEFAULT_OAUTH_SUBJECT;
  let scopes: AuthScope[] | undefined;
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
      case "--jwks-host":
        jwksHost = readValue(args, index, "--jwks-host");
        index += 1;
        break;
      case "--jwks-port":
        jwksPort = parsePort(
          readValue(args, index, "--jwks-port"),
          "--jwks-port",
          1,
        );
        index += 1;
        break;
      case "--jwks-path":
        jwksPath = parseJwksPath(readValue(args, index, "--jwks-path"));
        index += 1;
        break;
      case "--issuer":
        issuerUrl = parseHttpsUrl(readValue(args, index, "--issuer"), arg);
        index += 1;
        break;
      case "--subject":
        subject = readValue(args, index, "--subject");
        index += 1;
        break;
      case "--scope":
        scopes ??= [];
        scopes.push(parseAuthScope(readValue(args, index, "--scope")));
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
    args: commandArgs ?? [...DEFAULT_OAUTH_HTTP_ARGS],
    cwd: workingDirectory,
    env: buildChildEnv({
      overrides: envOverrides,
      host,
      port,
      jwksHost,
      jwksPort,
      jwksPath,
      issuerUrl,
    }),
    host,
    port,
    mcpPath,
    jwksHost,
    jwksPort,
    jwksPath,
    issuerUrl,
    subject,
    scopes: scopes ?? [...authScopes],
  };
}

export function localOAuthHttpUsage(): string {
  return [
    "Usage: npm run smoke:http-oauth -- [options]",
    "",
    "Launches the built HTTP MCP server in AUTH_MODE=oauth, serves a local",
    "HTTPS authorization-server discovery document and JWKS with a throwaway key,",
    "verifies protected-resource metadata and missing bearer-token challenges, then lists tools and calls",
    "validate_newsletter_content plus preview_draft with a signed JWT. It does",
    "not call Substack and does not run write tools.",
    "",
    "Default command:",
    "  node dist/http.js",
    "",
    "Options:",
    "  --command <command>    Executable to launch. Default: node.",
    "  --arg <arg>            Argument passed to the command. Repeatable.",
    "  --cwd <path>           Working directory for the child process.",
    "  --host <host>          Host used by the smoke client. Default: 127.0.0.1.",
    "  --port <port>          Local MCP server port. Default: choose an available port.",
    "  --mcp-path <path>      MCP endpoint path. Default: /mcp.",
    "  --jwks-host <host>     Local HTTPS JWKS host. Default: 127.0.0.1.",
    "  --jwks-port <port>     Local HTTPS JWKS port. Default: choose an available port.",
    "  --jwks-path <path>     Local HTTPS JWKS path. Default: /jwks.json.",
    `  --issuer <url>         HTTPS JWT issuer. Default: ${DEFAULT_OAUTH_ISSUER}`,
    `  --subject <subject>    JWT subject. Default: ${DEFAULT_OAUTH_SUBJECT}`,
    "  --scope <scope>        JWT scope. Repeatable. Default: all V1 scopes.",
    "  --env NAME=value       Override one child environment variable. Repeatable.",
    "  --help                 Show this help.",
    "",
    "Examples:",
    "  npm run build",
    "  npm run smoke:http-oauth",
    "  npm run smoke:http-oauth -- --command tsx --arg src/http.ts",
  ].join("\n");
}

export function withOAuthHttpPorts(
  options: LocalOAuthHttpSmokeRunOptions,
  port: number,
  jwksPort: number,
): LocalOAuthHttpSmokeRunOptions {
  const nextOptions = {
    ...options,
    port,
    jwksPort,
  };
  const issuerUrl =
    options.issuerUrl === DEFAULT_OAUTH_ISSUER
      ? oauthAuthorizationServerUrl(nextOptions)
      : options.issuerUrl;

  return {
    ...nextOptions,
    issuerUrl,
    env: {
      ...options.env,
      PORT: String(port),
      MCP_PUBLIC_BASE_URL: oauthPublicBaseUrl(nextOptions),
      OAUTH_AUTHORIZATION_SERVER_URL: issuerUrl,
      OAUTH_JWKS_URL: oauthJwksUrl(nextOptions),
    },
  };
}

export function oauthPublicBaseUrl(
  options: Pick<LocalOAuthHttpSmokeRunOptions, "host" | "port">,
): string {
  return `https://${options.host}:${options.port}`;
}

export function oauthJwksUrl(
  options: Pick<
    LocalOAuthHttpSmokeRunOptions,
    "jwksHost" | "jwksPath" | "jwksPort"
  >,
): string {
  return `https://${options.jwksHost}:${options.jwksPort}${options.jwksPath}`;
}

export function oauthAuthorizationServerUrl(
  options: Pick<LocalOAuthHttpSmokeRunOptions, "jwksHost" | "jwksPort">,
): string {
  return `https://${options.jwksHost}:${options.jwksPort}`;
}

export function oauthResource(
  options: Pick<LocalOAuthHttpSmokeRunOptions, "env">,
): string {
  const publicBaseUrl = options.env.MCP_PUBLIC_BASE_URL;
  if (!publicBaseUrl) {
    throw new Error("MCP_PUBLIC_BASE_URL is required for OAuth smoke tests.");
  }

  return new URL(publicBaseUrl).origin;
}

function buildChildEnv(input: {
  readonly overrides: Record<string, string>;
  readonly host: string;
  readonly port: number;
  readonly jwksHost: string;
  readonly jwksPort: number;
  readonly jwksPath: string;
  readonly issuerUrl: string;
}): Record<string, string> {
  const urlOptions = {
    host: input.host,
    port: input.port,
    jwksHost: input.jwksHost,
    jwksPort: input.jwksPort,
    jwksPath: input.jwksPath,
  };

  return {
    ...getDefaultEnvironment(),
    ...DEFAULT_CHILD_ENV,
    PORT: String(input.port),
    MCP_TRANSPORT: "http",
    AUTH_MODE: "oauth",
    MCP_PUBLIC_BASE_URL: oauthPublicBaseUrl(urlOptions),
    OAUTH_AUTHORIZATION_SERVER_URL: input.issuerUrl,
    OAUTH_JWKS_URL: oauthJwksUrl(urlOptions),
    ...input.overrides,
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

function parseJwksPath(value: string): string {
  if (!value.startsWith("/")) {
    throw new Error("--jwks-path must start with /.");
  }

  return value;
}

function parseHttpsUrl(value: string, flag: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error(`${flag} must be an absolute https URL.`);
  }

  return url.toString().replace(/\/+$/, "");
}

function parseAuthScope(value: string): AuthScope {
  if ((authScopes as readonly string[]).includes(value)) {
    return value as AuthScope;
  }

  throw new Error(`--scope must be one of: ${authScopes.join(", ")}.`);
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
