import { readFileSync } from "node:fs";
import { type DotenvConfigOptions, config as loadDotenv } from "dotenv";

import { normalizeMcpPathSecret } from "./safety/mcpPathSecret.js";
import { normalizeStaticBearerToken } from "./safety/staticBearerToken.js";
import { normalizeSubstackSessionToken } from "./safety/substackSessionToken.js";
import { parseOptionalSubstackUserId } from "./safety/substackUserId.js";
import { parsePublicHttpsUrl } from "./safety/urlPolicy.js";

export type McpTransportMode = "http" | "stdio";
export type AuthMode = "noauth" | "static_bearer" | "oauth";

export interface AppConfig {
  readonly nodeEnv: string;
  readonly port: number;
  readonly host: string;
  readonly logLevel: string;
  readonly mcpTransport: McpTransportMode;
  readonly mcpPathSecret?: string | undefined;
  readonly publicationUrl?: string | undefined;
  readonly sessionToken?: string | undefined;
  readonly userId?: number | undefined;
  readonly userAgent: string;
  readonly previewTokenSecret: string;
  readonly maxBodyBytes: number;
  readonly maxImageBytes: number;
  readonly substackRequestTimeoutMs: number;
  readonly confirmationTokenTtlSeconds: number;
  readonly authMode: AuthMode;
  readonly staticBearerToken?: string | undefined;
  readonly publicBaseUrl?: string | undefined;
  readonly oauthAuthorizationServerUrl?: string | undefined;
  readonly oauthResourceDocumentationUrl?: string | undefined;
  readonly oauthJwksUrl?: string | undefined;
  readonly oauthJwtAlgorithms: readonly string[];
}

export interface LoadConfigOptions {
  readonly loadEnvFile?: boolean;
  readonly loadEnv?: () => void;
}

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export const DEFAULT_PREVIEW_TOKEN_SECRET =
  "development-only-preview-token-secret-change-me";
export const DEFAULT_SUBSTACK_REQUEST_TIMEOUT_MS = 30_000;
export const LOCAL_SUBSTACK_AUTH_FILE = ".data/substack-auth.json";

const SUBSTACK_AUTH_ENV_KEYS = [
  "SUBSTACK_PUBLICATION_URL",
  "SUBSTACK_SESSION_TOKEN",
  "SUBSTACK_USER_ID",
  "PREVIEW_TOKEN_SECRET",
] as const;

export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  options: LoadConfigOptions = {},
): AppConfig {
  if (options.loadEnvFile ?? true) {
    (options.loadEnv ?? loadLocalEnvFiles)();
  }

  const nodeEnv = env.NODE_ENV ?? "development";

  return {
    nodeEnv,
    port: parseInteger(env.PORT, 8787, "PORT"),
    host: optionalString(env.HOST) ?? defaultHost(nodeEnv),
    logLevel: env.LOG_LEVEL ?? "info",
    mcpTransport: parseEnum(
      env.MCP_TRANSPORT,
      ["http", "stdio"],
      "http",
      "MCP_TRANSPORT",
    ),
    mcpPathSecret: normalizeMcpPathSecret(env.MCP_PATH_SECRET),
    publicationUrl: normalizePublicationUrl(env.SUBSTACK_PUBLICATION_URL),
    sessionToken: normalizeSubstackSessionToken(env.SUBSTACK_SESSION_TOKEN),
    userId: parseOptionalSubstackUserId(env.SUBSTACK_USER_ID),
    userAgent: env.SUBSTACK_USER_AGENT ?? DEFAULT_USER_AGENT,
    previewTokenSecret:
      optionalString(env.PREVIEW_TOKEN_SECRET) ?? DEFAULT_PREVIEW_TOKEN_SECRET,
    maxBodyBytes: parseInteger(env.MAX_BODY_BYTES, 750_000, "MAX_BODY_BYTES"),
    maxImageBytes: parseInteger(
      env.MAX_IMAGE_BYTES,
      8_000_000,
      "MAX_IMAGE_BYTES",
    ),
    substackRequestTimeoutMs: parsePositiveInteger(
      env.SUBSTACK_REQUEST_TIMEOUT_MS,
      DEFAULT_SUBSTACK_REQUEST_TIMEOUT_MS,
      "SUBSTACK_REQUEST_TIMEOUT_MS",
    ),
    confirmationTokenTtlSeconds: parsePositiveInteger(
      env.CONFIRMATION_TOKEN_TTL_SECONDS,
      900,
      "CONFIRMATION_TOKEN_TTL_SECONDS",
    ),
    authMode: parseEnum(
      env.AUTH_MODE,
      ["noauth", "static_bearer", "oauth"],
      "noauth",
      "AUTH_MODE",
    ),
    staticBearerToken: normalizeStaticBearerToken(env.MCP_BEARER_TOKEN),
    publicBaseUrl: normalizeUrl(env.MCP_PUBLIC_BASE_URL),
    oauthAuthorizationServerUrl: normalizeUrl(
      env.OAUTH_AUTHORIZATION_SERVER_URL,
    ),
    oauthResourceDocumentationUrl: normalizeUrl(
      env.OAUTH_RESOURCE_DOCUMENTATION_URL,
    ),
    oauthJwksUrl: normalizeUrl(env.OAUTH_JWKS_URL),
    oauthJwtAlgorithms: parseStringList(
      env.OAUTH_JWT_ALGORITHMS,
      ["RS256", "ES256"],
      "OAUTH_JWT_ALGORITHMS",
    ),
  };
}

export function loadLocalEnvFiles(
  loader: (options?: DotenvConfigOptions) => unknown = loadDotenv,
  authLoader: () => void = loadLocalSubstackAuthFile,
): void {
  loader({ path: ".env.local", override: false });
  authLoader();
  loader({ override: false });
}

export function loadLocalSubstackAuthFile(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (path: string, encoding: BufferEncoding) => string = readFileSync,
  path = LOCAL_SUBSTACK_AUTH_FILE,
): void {
  let text: string;
  try {
    text = readFile(path, "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return;
    }
    throw error;
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${path} must contain valid JSON.`);
  }
  if (!isRecord(raw)) {
    throw new Error(`${path} must contain a JSON object.`);
  }

  for (const key of SUBSTACK_AUTH_ENV_KEYS) {
    const value = raw[key];
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`${path} must contain a non-empty string for ${key}.`);
    }
    if (env[key] === undefined) {
      env[key] = value;
    }
  }
}

export function getMcpPath(config: Pick<AppConfig, "mcpPathSecret">): string {
  return config.mcpPathSecret ? `/mcp/${config.mcpPathSecret}` : "/mcp";
}

export function assertRuntimeSecretConfig(
  config: Pick<AppConfig, "nodeEnv" | "previewTokenSecret">,
): void {
  if (
    config.nodeEnv === "production" &&
    config.previewTokenSecret === DEFAULT_PREVIEW_TOKEN_SECRET
  ) {
    throw new Error(
      "PREVIEW_TOKEN_SECRET is required when NODE_ENV=production.",
    );
  }
}

export function assertMcpTransportConfig(
  config: Pick<AppConfig, "mcpTransport">,
  expected: McpTransportMode,
): void {
  if (config.mcpTransport !== expected) {
    throw new Error(
      `MCP_TRANSPORT=${config.mcpTransport} cannot be used with the ${expected} entrypoint.`,
    );
  }
}

function defaultHost(nodeEnv: string): string {
  return nodeEnv === "production" ? "0.0.0.0" : "127.0.0.1";
}

function normalizePublicationUrl(
  value: string | undefined,
): string | undefined {
  const raw = optionalString(value);
  if (!raw) {
    return undefined;
  }

  const parsed = parsePublicHttpsUrl(raw, "SUBSTACK_PUBLICATION_URL");
  if (!parsed.ok) {
    throw new Error(parsed.errors.join(" "));
  }

  return parsed.url.origin;
}

function normalizeUrl(value: string | undefined): string | undefined {
  const raw = optionalString(value);
  if (!raw) {
    return undefined;
  }

  return raw.replace(/\/+$/, "");
}

function optionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as Error & { readonly code?: string }).code === "ENOENT"
  );
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  const raw = value?.trim();
  if (!raw) {
    return fallback;
  }

  const parsed = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  return parsed;
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  const parsed = parseInteger(value, fallback, name);
  if (parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function parseEnum<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
  name: string,
): T {
  if (!value) {
    return fallback;
  }

  if (allowed.includes(value as T)) {
    return value as T;
  }

  throw new Error(`${name} must be one of: ${allowed.join(", ")}`);
}

function parseStringList(
  value: string | undefined,
  fallback: readonly string[],
  name: string,
): readonly string[] {
  const raw = optionalString(value);
  if (!raw) {
    return fallback;
  }

  const values = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (values.length === 0) {
    throw new Error(`${name} must contain at least one value`);
  }

  return values;
}
