import { isAbsolute, relative, resolve } from "node:path";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

import { type AuthScope, authScopes } from "../src/auth/scopes.js";
import { normalizeMcpEndpointPath } from "../src/safety/mcpPathSecret.js";
import {
  DEFAULT_OAUTH_HTTP_ARGS,
  DEFAULT_OAUTH_HTTP_COMMAND,
  DEFAULT_OAUTH_ISSUER,
  DEFAULT_OAUTH_JWKS_HOST,
  DEFAULT_OAUTH_JWKS_PATH,
  DEFAULT_OAUTH_SUBJECT,
  oauthAuthorizationServerUrl,
} from "./smokeLocalOAuthHttpCore.js";
import {
  DEFAULT_NGROK_API_URL,
  DEFAULT_NGROK_COMMAND,
  DEFAULT_NGROK_HOST,
  DEFAULT_NGROK_MCP_PATH,
  DEFAULT_NGROK_PORT,
} from "./smokeNgrokNoAuthHttpCore.js";
import type { RemoteOAuthSmokeResult } from "./smokeRemoteOAuthHttpCore.js";

const DEFAULT_CHILD_ENV = {
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  MCP_TRANSPORT: "http",
  AUTH_MODE: "oauth",
  OAUTH_JWT_ALGORITHMS: "RS256",
  NODE_TLS_REJECT_UNAUTHORIZED: "0",
  SUBSTACK_PUBLICATION_URL: "https://example.substack.com",
  SUBSTACK_SESSION_TOKEN: "ngrok-oauth-smoke-session-token",
  SUBSTACK_USER_ID: "1",
  PREVIEW_TOKEN_SECRET:
    "ngrok-oauth-smoke-preview-token-secret-with-enough-entropy",
} as const;

const APP_ENV_KEYS = [
  "NODE_ENV",
  "LOG_LEVEL",
  "SUBSTACK_PUBLICATION_URL",
  "SUBSTACK_SESSION_TOKEN",
  "SUBSTACK_USER_ID",
  "SUBSTACK_USER_AGENT",
  "PREVIEW_TOKEN_SECRET",
  "MAX_BODY_BYTES",
  "MAX_IMAGE_BYTES",
  "SUBSTACK_REQUEST_TIMEOUT_MS",
  "CONFIRMATION_TOKEN_TTL_SECONDS",
  "MCP_PATH_SECRET",
] as const;

const COMPUTED_ENV_KEYS = new Set([
  "PORT",
  "MCP_TRANSPORT",
  "AUTH_MODE",
  "MCP_PUBLIC_BASE_URL",
  "OAUTH_AUTHORIZATION_SERVER_URL",
  "OAUTH_JWKS_URL",
  "OAUTH_JWT_ALGORITHMS",
]);

export interface NgrokOAuthSmokeRunOptions {
  readonly help: false;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly artifactRoot: string;
  readonly evidenceArtifact?: string | undefined;
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
  readonly ngrokCommand: string;
  readonly ngrokArgs: readonly string[];
  readonly ngrokApiUrl: URL;
  readonly tunnelTimeoutMs: number;
}

export interface NgrokOAuthSmokeHelpOptions {
  readonly help: true;
}

export type NgrokOAuthSmokeOptions =
  | NgrokOAuthSmokeRunOptions
  | NgrokOAuthSmokeHelpOptions;

export interface NgrokOAuthSmokeResult {
  readonly ok: true;
  readonly local: {
    readonly endpoint: string;
    readonly health: {
      readonly url: string;
      readonly status: number;
    };
    readonly command: string;
    readonly args: readonly string[];
  };
  readonly ngrok: {
    readonly command: string;
    readonly args: readonly string[];
    readonly api_url: string;
    readonly public_url: string;
  };
  readonly jwks_url: string;
  readonly issuer: string;
  readonly subject: string;
  readonly scopes: readonly AuthScope[];
  readonly missing_bearer_status: 401;
  readonly remote: RemoteOAuthSmokeResult;
}

export function parseNgrokOAuthArgs(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd = process.cwd(),
): NgrokOAuthSmokeOptions {
  let command = DEFAULT_OAUTH_HTTP_COMMAND;
  let commandArgs: string[] | undefined;
  let workingDirectory = cwd;
  let host = DEFAULT_NGROK_HOST;
  let port = parsePort(env.PORT, "PORT", 1, DEFAULT_NGROK_PORT);
  let mcpPath = DEFAULT_NGROK_MCP_PATH;
  let jwksHost = DEFAULT_OAUTH_JWKS_HOST;
  let jwksPort = parsePort(env.OAUTH_JWKS_PORT, "OAUTH_JWKS_PORT", 0, 0);
  let jwksPath = DEFAULT_OAUTH_JWKS_PATH;
  let issuerUrl = DEFAULT_OAUTH_ISSUER;
  let subject = DEFAULT_OAUTH_SUBJECT;
  let scopes: AuthScope[] | undefined;
  let evidenceArtifact: string | undefined;
  let ngrokCommand = DEFAULT_NGROK_COMMAND;
  const ngrokArgs: string[] = [];
  let ngrokApiUrl = new URL(DEFAULT_NGROK_API_URL);
  let tunnelTimeoutMs = 15_000;
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
        port = parsePort(readValue(args, index, "--port"), "--port", 1, 0);
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
          0,
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
      case "--evidence-artifact":
        evidenceArtifact = resolveProjectArtifact(
          cwd,
          readValue(args, index, "--evidence-artifact"),
        );
        index += 1;
        break;
      case "--ngrok-command":
        ngrokCommand = readValue(args, index, "--ngrok-command");
        index += 1;
        break;
      case "--ngrok-arg":
        ngrokArgs.push(readValue(args, index, "--ngrok-arg", true));
        index += 1;
        break;
      case "--ngrok-api-url":
        ngrokApiUrl = parseNgrokApiUrl(readValue(args, index, arg));
        index += 1;
        break;
      case "--tunnel-timeout-ms":
        tunnelTimeoutMs = parseTimeoutMs(readValue(args, index, arg), arg);
        index += 1;
        break;
      case "--env": {
        const assignment = readValue(args, index, "--env");
        const [name, value] = parseEnvAssignment(assignment);
        if (COMPUTED_ENV_KEYS.has(name)) {
          throw new Error(
            `${name} is computed by smoke:ngrok-oauth; use the dedicated CLI option instead.`,
          );
        }
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
    artifactRoot: resolve(cwd),
    evidenceArtifact,
    env: buildBaseChildEnv(env, envOverrides),
    host,
    port,
    mcpPath,
    jwksHost,
    jwksPort,
    jwksPath,
    issuerUrl,
    subject,
    scopes: scopes ?? [...authScopes],
    ngrokCommand,
    ngrokArgs,
    ngrokApiUrl,
    tunnelTimeoutMs,
  };
}

export function ngrokOAuthUsage(): string {
  return [
    "Usage: npm run smoke:ngrok-oauth -- [options]",
    "",
    "Launches ngrok, serves local HTTPS authorization-server discovery and JWKS",
    "metadata with a throwaway key, starts the built HTTP MCP server in AUTH_MODE=oauth",
    "with the ngrok origin as MCP_PUBLIC_BASE_URL, signs a JWT for that public resource,",
    "then runs the remote OAuth smoke against the public /mcp URL. It does not call",
    "Substack and does not run write tools.",
    "",
    "Default commands:",
    "  node dist/http.js",
    "  ngrok http 8787",
    "",
    "Options:",
    "  --command <command>       Executable to launch for the local HTTP server. Default: node.",
    "  --arg <arg>               Argument passed to the local HTTP command. Repeatable.",
    "  --cwd <path>              Working directory for spawned commands.",
    "  --host <host>             Local host used by health checks. Default: 127.0.0.1.",
    "  --port <port>             Local HTTP/ngrok port. Default: 8787.",
    "  --mcp-path <path>         MCP endpoint path. Default: /mcp.",
    "  --jwks-host <host>        Local HTTPS JWKS host. Default: 127.0.0.1.",
    "  --jwks-port <port>        Local HTTPS JWKS port. Default: choose an available port.",
    "  --jwks-path <path>        Local HTTPS JWKS path. Default: /jwks.json.",
    `  --issuer <url>           HTTPS JWT issuer. Default: ${DEFAULT_OAUTH_ISSUER}`,
    `  --subject <subject>      JWT subject. Default: ${DEFAULT_OAUTH_SUBJECT}`,
    "  --scope <scope>          JWT scope. Repeatable. Default: all V1 scopes.",
    "  --evidence-artifact <path>",
    "                            Write sanitized Markdown evidence for the remote OAuth checklist.",
    "  --ngrok-command <command> ngrok executable. Default: ngrok.",
    "  --ngrok-arg <arg>         Extra argument inserted after `ngrok http`. Repeatable.",
    "  --ngrok-api-url <url>     Local ngrok tunnel API. Default: http://127.0.0.1:4040/api/tunnels.",
    "  --tunnel-timeout-ms <ms>  Time to wait for ngrok public URL. Default: 15000.",
    "  --env NAME=value          Override one non-computed child environment variable. Repeatable.",
    "  --help                    Show this help.",
    "",
    "Examples:",
    "  npm run build",
    "  npm run smoke:ngrok-oauth",
    "  npm run smoke:ngrok-oauth -- --evidence-artifact .data/v1/remote-oauth.md",
  ].join("\n");
}

export function withNgrokOAuthJwksPort(
  options: NgrokOAuthSmokeRunOptions,
  jwksPort: number,
): NgrokOAuthSmokeRunOptions {
  const nextOptions = {
    ...options,
    jwksPort,
  };

  return {
    ...nextOptions,
    issuerUrl:
      options.issuerUrl === DEFAULT_OAUTH_ISSUER
        ? oauthAuthorizationServerUrl(nextOptions)
        : options.issuerUrl,
  };
}

export function ngrokOAuthJwksUrl(
  options: Pick<
    NgrokOAuthSmokeRunOptions,
    "jwksHost" | "jwksPath" | "jwksPort"
  >,
): string {
  return `https://${options.jwksHost}:${options.jwksPort}${options.jwksPath}`;
}

export function ngrokOAuthChildEnv(
  options: Pick<
    NgrokOAuthSmokeRunOptions,
    "env" | "issuerUrl" | "jwksHost" | "jwksPath" | "jwksPort" | "port"
  >,
  publicUrl: URL,
): Record<string, string> {
  return {
    ...options.env,
    PORT: String(options.port),
    MCP_TRANSPORT: "http",
    AUTH_MODE: "oauth",
    MCP_PUBLIC_BASE_URL: publicUrl.origin,
    OAUTH_AUTHORIZATION_SERVER_URL: options.issuerUrl,
    OAUTH_JWKS_URL: ngrokOAuthJwksUrl(options),
    OAUTH_JWT_ALGORITHMS: "RS256",
  };
}

function buildBaseChildEnv(
  env: NodeJS.ProcessEnv,
  overrides: Record<string, string>,
): Record<string, string> {
  return {
    ...getDefaultEnvironment(),
    ...DEFAULT_CHILD_ENV,
    ...pickAppEnv(env),
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
    ...overrides,
  };
}

function pickAppEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const picked: Record<string, string> = {};
  for (const key of APP_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string") {
      picked[key] = value;
    }
  }
  return picked;
}

function resolveProjectArtifact(cwd: string, value: string): string {
  const root = resolve(cwd);
  const artifactPath = resolve(root, value);
  const artifact = relative(root, artifactPath);
  if (artifact === "" || artifact.startsWith("..") || isAbsolute(artifact)) {
    throw new Error(
      "ngrok OAuth evidence artifact must stay inside the project directory.",
    );
  }

  return artifact;
}

function parsePort(
  value: string | undefined,
  label: string,
  minimum: number,
  fallback: number,
): number {
  const raw = value?.trim();
  if (raw === undefined || raw === "") {
    return fallback;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${label} must be an integer from ${minimum} to 65535.`);
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < minimum || port > 65_535) {
    throw new Error(`${label} must be an integer from ${minimum} to 65535.`);
  }
  return port;
}

function parseTimeoutMs(value: string, label: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${label} must be an integer from 1000 to 120000.`);
  }
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout < 1_000 || timeout > 120_000) {
    throw new Error(`${label} must be an integer from 1000 to 120000.`);
  }
  return timeout;
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

function parseNgrokApiUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:") {
    throw new Error("--ngrok-api-url must use http.");
  }
  return url;
}

function parseAuthScope(value: string): AuthScope {
  if ((authScopes as readonly string[]).includes(value)) {
    return value as AuthScope;
  }
  throw new Error(`--scope must be one of: ${authScopes.join(", ")}.`);
}

function parseEnvAssignment(value: string): readonly [string, string] {
  const separator = value.indexOf("=");
  if (separator <= 0) {
    throw new Error("--env requires NAME=value.");
  }
  const name = value.slice(0, separator);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`Invalid environment variable name: ${name}`);
  }
  return [name, value.slice(separator + 1)];
}

function readValue(
  args: readonly string[],
  index: number,
  flag: string,
  allowDashValue = false,
): string {
  const value = args[index + 1];
  if (!value || (!allowDashValue && value.startsWith("--"))) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}
