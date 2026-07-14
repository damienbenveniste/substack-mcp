import { isAbsolute, relative, resolve } from "node:path";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

import { normalizeMcpEndpointPath } from "../src/safety/mcpPathSecret.js";
import { parseNgrokHoldOpenSeconds } from "./ngrokHoldOpen.js";
import type { RemoteNoAuthSmokeResult } from "./smokeRemoteNoAuthHttpCore.js";

export const DEFAULT_NGROK_HTTP_COMMAND = "node";
export const DEFAULT_NGROK_HTTP_ARGS = ["dist/http.js"] as const;
export const DEFAULT_NGROK_COMMAND = "ngrok";
export const DEFAULT_NGROK_HOST = "127.0.0.1";
export const DEFAULT_NGROK_PORT = 8787;
export const DEFAULT_NGROK_MCP_PATH = "/mcp";
export const DEFAULT_NGROK_API_URL = "http://127.0.0.1:4040/api/tunnels";

const DEFAULT_CHILD_ENV = {
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  MCP_TRANSPORT: "http",
  AUTH_MODE: "noauth",
  SUBSTACK_PUBLICATION_URL: "https://example.substack.com",
  SUBSTACK_SESSION_TOKEN: "ngrok-smoke-session-token",
  SUBSTACK_USER_ID: "1",
  PREVIEW_TOKEN_SECRET: "ngrok-smoke-preview-token-secret-with-enough-entropy",
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

export interface NgrokNoAuthSmokeRunOptions {
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
  readonly ngrokCommand: string;
  readonly ngrokArgs: readonly string[];
  readonly ngrokApiUrl: URL;
  readonly tunnelTimeoutMs: number;
  readonly holdOpenSeconds: number;
  readonly useLocalCredentials: boolean;
}

export interface NgrokNoAuthSmokeHelpOptions {
  readonly help: true;
}

export type NgrokNoAuthSmokeOptions =
  | NgrokNoAuthSmokeRunOptions
  | NgrokNoAuthSmokeHelpOptions;

export interface NgrokNoAuthSmokeResult {
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
  readonly remote: RemoteNoAuthSmokeResult;
}

export interface NgrokTunnelApiResponse {
  readonly tunnels?: readonly unknown[] | undefined;
}

export function parseNgrokNoAuthArgs(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd = process.cwd(),
): NgrokNoAuthSmokeOptions {
  let command = DEFAULT_NGROK_HTTP_COMMAND;
  let commandArgs: string[] | undefined;
  let workingDirectory = cwd;
  let host = DEFAULT_NGROK_HOST;
  let port = parsePort(env.PORT, "PORT");
  let mcpPath = DEFAULT_NGROK_MCP_PATH;
  let evidenceArtifact: string | undefined;
  let ngrokCommand = DEFAULT_NGROK_COMMAND;
  const ngrokArgs: string[] = [];
  let ngrokApiUrl = new URL(DEFAULT_NGROK_API_URL);
  let tunnelTimeoutMs = 15_000;
  let holdOpenSeconds = 0;
  let useLocalCredentials = false;
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
      case "--use-local-credentials":
        useLocalCredentials = true;
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

  if (useLocalCredentials && holdOpenSeconds === 0) {
    throw new Error(
      "--use-local-credentials requires a non-zero --hold-open-seconds window for explicit manual acceptance.",
    );
  }

  return {
    help: false,
    command,
    args: commandArgs ?? [...DEFAULT_NGROK_HTTP_ARGS],
    cwd: workingDirectory,
    artifactRoot: resolve(cwd),
    evidenceArtifact,
    env: buildChildEnv(env, envOverrides, port),
    host,
    port,
    mcpPath,
    ngrokCommand,
    ngrokArgs,
    ngrokApiUrl,
    tunnelTimeoutMs,
    holdOpenSeconds,
    useLocalCredentials,
  };
}

export function ngrokNoAuthUsage(): string {
  return [
    "Usage: npm run smoke:ngrok-noauth -- [options]",
    "",
    "Launches the built HTTP MCP server in AUTH_MODE=noauth, starts ngrok,",
    "discovers the HTTPS tunnel URL from the local ngrok API, then runs the",
    "remote noauth smoke against the public /mcp URL. It does not call",
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
    "  --evidence-artifact <path>",
    "                            Write sanitized Markdown evidence for gate 11.",
    "  --ngrok-command <command> ngrok executable. Default: ngrok.",
    "  --ngrok-arg <arg>         Extra argument inserted after `ngrok http`. Repeatable.",
    "  --ngrok-api-url <url>     Local ngrok tunnel API. Default: http://127.0.0.1:4040/api/tunnels.",
    "  --tunnel-timeout-ms <ms>  Time to wait for ngrok public URL. Default: 15000.",
    "  --hold-open-seconds <s>    Keep the verified tunnel live for manual testing. Range: 0-3600; default: 0.",
    "  --use-local-credentials    Load .env.local/.env for a guarded live draft flow. Requires --hold-open-seconds.",
    "  --env NAME=value          Override one child environment variable. Repeatable.",
    "  --help                    Show this help.",
    "",
    "Examples:",
    "  npm run build",
    "  npm run smoke:ngrok-noauth",
    "  npm run smoke:ngrok-noauth -- --evidence-artifact .data/v1/gate-11-chatgpt-ngrok.md",
    "  npm run smoke:ngrok-noauth -- --hold-open-seconds 900 --evidence-artifact .data/v1/gate-11-chatgpt-ngrok.md",
    "  npm run smoke:ngrok-noauth -- --use-local-credentials --hold-open-seconds 900 --evidence-artifact .data/v1/gate-11-chatgpt-ngrok.md",
  ].join("\n");
}

export function ngrokArgsForPort(
  options: Pick<NgrokNoAuthSmokeRunOptions, "ngrokArgs" | "port">,
): readonly string[] {
  return ["http", ...options.ngrokArgs, String(options.port)];
}

export function localBaseUrl(
  options: Pick<NgrokNoAuthSmokeRunOptions, "host" | "port">,
): string {
  return `http://${options.host}:${options.port}`;
}

export function remoteMcpUrl(publicUrl: URL, mcpPath: string): URL {
  return new URL(mcpPath, publicUrl.origin);
}

export function selectNgrokPublicUrl(
  response: unknown,
  port: number,
): URL | undefined {
  const tunnels =
    isRecord(response) && Array.isArray(response.tunnels)
      ? response.tunnels
      : [];
  const candidates = tunnels
    .filter(isRecord)
    .map((tunnel) => ({
      publicUrl: readHttpsUrl(tunnel.public_url),
      addr: isRecord(tunnel.config) ? readString(tunnel.config.addr) : "",
    }))
    .filter((candidate) => candidate.publicUrl !== undefined);

  const matching = candidates.find((candidate) =>
    candidate.addr.includes(String(port)),
  );
  return matching?.publicUrl ?? candidates[0]?.publicUrl;
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
    AUTH_MODE: "noauth",
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
      "ngrok noauth evidence artifact must stay inside the project directory.",
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

function readHttpsUrl(value: unknown): URL | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
