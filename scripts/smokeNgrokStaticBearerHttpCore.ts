import { isAbsolute, relative, resolve } from "node:path";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

import { normalizeMcpEndpointPath } from "../src/safety/mcpPathSecret.js";
import { normalizeStaticBearerToken } from "../src/safety/staticBearerToken.js";
import { parseNgrokHoldOpenSeconds } from "./ngrokHoldOpen.js";
import {
  DEFAULT_STATIC_BEARER_TOKEN,
  DEFAULT_WRONG_STATIC_BEARER_TOKEN,
} from "./smokeLocalStaticBearerHttpCore.js";
import {
  DEFAULT_NGROK_API_URL,
  DEFAULT_NGROK_COMMAND,
  DEFAULT_NGROK_HOST,
  DEFAULT_NGROK_HTTP_ARGS,
  DEFAULT_NGROK_HTTP_COMMAND,
  DEFAULT_NGROK_MCP_PATH,
  DEFAULT_NGROK_PORT,
} from "./smokeNgrokNoAuthHttpCore.js";
import type { RemoteSmokeResult } from "./smokeRemoteHttpCore.js";

const DEFAULT_CHILD_ENV = {
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  MCP_TRANSPORT: "http",
  AUTH_MODE: "static_bearer",
  SUBSTACK_PUBLICATION_URL: "https://example.substack.com",
  SUBSTACK_SESSION_TOKEN: "ngrok-static-bearer-smoke-session-token",
  SUBSTACK_USER_ID: "1",
  PREVIEW_TOKEN_SECRET:
    "ngrok-static-bearer-smoke-preview-token-secret-with-enough-entropy",
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
  "MCP_PATH_SECRET",
] as const;

export interface NgrokStaticBearerSmokeRunOptions {
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
  readonly bearerToken: string;
  readonly bearerTokenEnvName?: string | undefined;
  readonly wrongBearerToken: string;
  readonly ngrokCommand: string;
  readonly ngrokArgs: readonly string[];
  readonly ngrokApiUrl: URL;
  readonly tunnelTimeoutMs: number;
  readonly holdOpenSeconds: number;
}

export interface NgrokStaticBearerSmokeHelpOptions {
  readonly help: true;
}

export type NgrokStaticBearerSmokeOptions =
  | NgrokStaticBearerSmokeRunOptions
  | NgrokStaticBearerSmokeHelpOptions;

export interface NgrokStaticBearerSmokeResult {
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
    readonly hold_open_seconds: number;
  };
  readonly missing_bearer_status: 401;
  readonly wrong_bearer_status: 401;
  readonly remote: RemoteSmokeResult;
}

export function parseNgrokStaticBearerArgs(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd = process.cwd(),
): NgrokStaticBearerSmokeOptions {
  let command = DEFAULT_NGROK_HTTP_COMMAND;
  let commandArgs: string[] | undefined;
  let workingDirectory = cwd;
  let host = DEFAULT_NGROK_HOST;
  let port = parsePort(env.PORT, "PORT");
  let mcpPath = DEFAULT_NGROK_MCP_PATH;
  let evidenceArtifact: string | undefined;
  let bearerToken = DEFAULT_STATIC_BEARER_TOKEN;
  let bearerTokenEnvName: string | undefined;
  let wrongBearerToken = DEFAULT_WRONG_STATIC_BEARER_TOKEN;
  let ngrokCommand = DEFAULT_NGROK_COMMAND;
  const ngrokArgs: string[] = [];
  let ngrokApiUrl = new URL(DEFAULT_NGROK_API_URL);
  let tunnelTimeoutMs = 15_000;
  let holdOpenSeconds = 0;
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
        port = parsePort(readValue(args, index, "--port"), "--port");
        index += 1;
        break;
      case "--mcp-path":
        mcpPath = parseMcpPath(readValue(args, index, "--mcp-path"));
        index += 1;
        break;
      case "--bearer-token-env": {
        bearerTokenEnvName = readValue(args, index, "--bearer-token-env");
        bearerToken = readBearerTokenEnv(env, bearerTokenEnvName);
        index += 1;
        break;
      }
      case "--wrong-bearer-token-env":
        wrongBearerToken = readBearerTokenEnv(
          env,
          readValue(args, index, "--wrong-bearer-token-env"),
        );
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
      case "--hold-open-seconds":
        holdOpenSeconds = parseNgrokHoldOpenSeconds(
          readValue(args, index, arg),
          arg,
        );
        index += 1;
        break;
      case "--env": {
        const assignment = readValue(args, index, "--env");
        const [name, value] = parseEnvAssignment(assignment);
        if (name === "MCP_BEARER_TOKEN") {
          throw new Error(
            "Use --bearer-token-env instead of passing MCP_BEARER_TOKEN through --env.",
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

  if (wrongBearerToken === bearerToken) {
    throw new Error(
      "--wrong-bearer-token-env must resolve to a token different from the valid bearer token.",
    );
  }
  if (holdOpenSeconds > 0 && !bearerTokenEnvName) {
    throw new Error(
      "--hold-open-seconds requires --bearer-token-env so the manual client can use the same token without printing it.",
    );
  }

  return {
    help: false,
    command,
    args: commandArgs ?? [...DEFAULT_NGROK_HTTP_ARGS],
    cwd: workingDirectory,
    artifactRoot: resolve(cwd),
    evidenceArtifact,
    env: buildChildEnv(env, envOverrides, port, bearerToken),
    host,
    port,
    mcpPath,
    bearerToken,
    bearerTokenEnvName,
    wrongBearerToken,
    ngrokCommand,
    ngrokArgs,
    ngrokApiUrl,
    tunnelTimeoutMs,
    holdOpenSeconds,
  };
}

export function ngrokStaticBearerUsage(): string {
  return [
    "Usage: npm run smoke:ngrok-static-bearer -- [options]",
    "",
    "Launches the built HTTP MCP server in AUTH_MODE=static_bearer, starts",
    "ngrok, verifies remote missing/wrong bearer rejection, then runs the",
    "remote static-bearer smoke against the public /mcp URL. It does not call",
    "Substack and does not run write tools.",
    "",
    "Default commands:",
    "  node dist/http.js",
    "  ngrok http 8787",
    "",
    "Options:",
    "  --command <command>             Executable to launch for the local HTTP server. Default: node.",
    "  --arg <arg>                     Argument passed to the local HTTP command. Repeatable.",
    "  --cwd <path>                    Working directory for spawned commands.",
    "  --host <host>                   Local host used by health checks. Default: 127.0.0.1.",
    "  --port <port>                   Local HTTP/ngrok port. Default: 8787.",
    "  --mcp-path <path>               MCP endpoint path. Default: /mcp.",
    "  --bearer-token-env <name>       Read valid bearer token from env var instead of using the fake smoke token.",
    "  --wrong-bearer-token-env <name> Read wrong bearer token from env var.",
    "  --evidence-artifact <path>      Write sanitized Markdown evidence for gate 14.",
    "  --ngrok-command <command>       ngrok executable. Default: ngrok.",
    "  --ngrok-arg <arg>               Extra argument inserted after `ngrok http`. Repeatable.",
    "  --ngrok-api-url <url>           Local ngrok tunnel API. Default: http://127.0.0.1:4040/api/tunnels.",
    "  --tunnel-timeout-ms <ms>        Time to wait for ngrok public URL. Default: 15000.",
    "  --hold-open-seconds <s>          Keep the verified tunnel live for manual testing. Requires --bearer-token-env; range: 0-3600.",
    "  --env NAME=value                Override one non-token child environment variable. Repeatable.",
    "  --help                          Show this help.",
    "",
    "Examples:",
    "  npm run build",
    "  npm run smoke:ngrok-static-bearer",
    "  npm run smoke:ngrok-static-bearer -- --evidence-artifact .data/v1/gate-14-static-bearer-remote.md",
    "  npm run smoke:ngrok-static-bearer -- --bearer-token-env MCP_BEARER_TOKEN --hold-open-seconds 900 --evidence-artifact .data/v1/gate-14-static-bearer-remote.md",
  ].join("\n");
}

function buildChildEnv(
  env: NodeJS.ProcessEnv,
  overrides: Record<string, string>,
  port: number,
  bearerToken: string,
): Record<string, string> {
  return {
    ...getDefaultEnvironment(),
    ...DEFAULT_CHILD_ENV,
    ...pickAppEnv(env),
    PORT: String(port),
    MCP_TRANSPORT: "http",
    AUTH_MODE: "static_bearer",
    MCP_BEARER_TOKEN: bearerToken,
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
      "ngrok static-bearer evidence artifact must stay inside the project directory.",
    );
  }

  return artifact;
}

function parsePort(value: string | undefined, label: string): number {
  const raw = value?.trim() || String(DEFAULT_NGROK_PORT);
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${label} must be an integer from 1 to 65535.`);
  }
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${label} must be an integer from 1 to 65535.`);
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

function parseNgrokApiUrl(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "http:") {
    throw new Error("--ngrok-api-url must use http.");
  }
  return url;
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
  allowDashValue = false,
): string {
  const value = args[index + 1];
  if (!value || (!allowDashValue && value.startsWith("--"))) {
    throw new Error(`${flag} requires a value.`);
  }
  return value;
}
