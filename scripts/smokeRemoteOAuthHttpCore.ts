import { isAbsolute, relative, resolve } from "node:path";

import { type AuthScope, authScopes } from "../src/auth/scopes.js";
import { normalizeStaticBearerToken } from "../src/safety/staticBearerToken.js";
import {
  parseRemoteMcpUrl,
  type RemoteHealthResult,
  redactRemoteUrl,
} from "./smokeRemoteHttpCore.js";
import type {
  PreviewSmokeResult,
  ValidationSmokeResult,
} from "./smokeValidateTool.js";

export const DEFAULT_OAUTH_BEARER_TOKEN_ENV = "MCP_OAUTH_BEARER_TOKEN";

export interface RemoteOAuthSmokeRunOptions {
  readonly help: false;
  readonly loadEnvFile: boolean;
  readonly url: URL;
  readonly bearerToken: string;
  readonly bearerTokenEnvName: string;
  readonly artifactRoot: string;
  readonly evidenceArtifact?: string | undefined;
  readonly discoveryFetch?: RemoteOAuthDiscoveryFetch | undefined;
}

export interface RemoteOAuthSmokeHelpOptions {
  readonly help: true;
  readonly loadEnvFile: boolean;
}

export type RemoteOAuthSmokeOptions =
  | RemoteOAuthSmokeRunOptions
  | RemoteOAuthSmokeHelpOptions;

export interface RemoteOAuthMetadataSummary {
  readonly resource: string;
  readonly authorization_servers: readonly string[];
  readonly scopes_supported: readonly AuthScope[];
}

export type RemoteOAuthAuthorizationServerDiscoveryType =
  | "oauth-authorization-server"
  | "openid-configuration";

export interface RemoteOAuthAuthorizationServerSummary {
  readonly discovery_url: string;
  readonly discovery_type: RemoteOAuthAuthorizationServerDiscoveryType;
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly jwks_uri: string;
  readonly grant_types_supported: readonly string[];
  readonly response_types_supported: readonly string[];
  readonly code_challenge_methods_supported: readonly string[];
}

export interface RemoteOAuthMetadataCorsSummary {
  readonly metadata_allow_origin: string;
  readonly preflight_status: number;
  readonly preflight_allow_origin: string;
  readonly preflight_allows_authorization: true;
  readonly preflight_exposes_www_authenticate: true;
}

export interface RemoteOAuthSmokeResult {
  readonly ok: true;
  readonly auth_mode: "oauth";
  readonly endpoint: string;
  readonly health: RemoteHealthResult;
  readonly protected_resource_metadata_url: string;
  readonly metadata: RemoteOAuthMetadataSummary;
  readonly metadata_cors: RemoteOAuthMetadataCorsSummary;
  readonly authorization_server: RemoteOAuthAuthorizationServerSummary;
  readonly tool_count: number;
  readonly tools: string[];
  readonly validation: ValidationSmokeResult;
  readonly preview: PreviewSmokeResult;
}

export type RemoteOAuthMetadataCorsFetch = (
  url: URL,
  init?: RequestInit,
) => Promise<Pick<Response, "headers" | "status">>;

export type RemoteOAuthDiscoveryFetch = (
  url: URL,
) => Promise<Pick<Response, "ok" | "status" | "json">>;

export function parseOAuthArgs(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd = process.cwd(),
): RemoteOAuthSmokeOptions {
  let urlValue = env.MCP_REMOTE_URL;
  let tokenEnvName = DEFAULT_OAUTH_BEARER_TOKEN_ENV;
  let loadEnvFile = true;
  let help = false;
  let evidenceArtifact: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--url":
        urlValue = readValue(args, index, "--url");
        index += 1;
        break;
      case "--bearer-token-env":
        tokenEnvName = readValue(args, index, "--bearer-token-env");
        index += 1;
        break;
      case "--no-env-file":
        loadEnvFile = false;
        break;
      case "--evidence-artifact":
        evidenceArtifact = resolveProjectArtifact(
          cwd,
          readValue(args, index, "--evidence-artifact"),
        );
        index += 1;
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (help) {
    return { help, loadEnvFile };
  }

  const bearerToken = normalizeStaticBearerToken(
    env[tokenEnvName],
    tokenEnvName,
  );
  if (!bearerToken) {
    throw new Error(
      `${tokenEnvName} must be set to run the remote OAuth HTTP smoke test.`,
    );
  }

  return {
    help,
    loadEnvFile,
    url: parseRemoteMcpUrl(urlValue),
    bearerToken,
    bearerTokenEnvName: tokenEnvName,
    artifactRoot: resolve(cwd),
    evidenceArtifact,
  };
}

export function oauthUsage(): string {
  return [
    "Usage: npm run smoke:remote-oauth -- --url <https://host/mcp> [options]",
    "",
    "Connects to a remote Streamable HTTP MCP endpoint with OAuth bearer auth,",
    "checks /healthz on the same origin, verifies OAuth protected-resource",
    "metadata, verifies authorization-server/OIDC discovery, lists tools,",
    "verifies the V1 draft-workflow tool surface, and calls validate_newsletter_content",
    "plus preview_draft with the rich Markdown fixture. It does not call Substack",
    "and does not run write tools.",
    "",
    "Environment:",
    "  MCP_REMOTE_URL            HTTPS remote MCP URL without embedded username/password. Used when --url is omitted.",
    `  ${DEFAULT_OAUTH_BEARER_TOKEN_ENV}     OAuth access token value only; do not include Authorization: header or bearer prefix.`,
    "",
    "Options:",
    "  --url <url>                 HTTPS remote MCP URL without embedded username/password. Path must be /mcp or /mcp/<secret>.",
    `  --bearer-token-env <name>   Read OAuth bearer token from this env var. Default: ${DEFAULT_OAUTH_BEARER_TOKEN_ENV}.`,
    "  --evidence-artifact <path>  Write sanitized Markdown evidence for the remote OAuth checklist.",
    "  --no-env-file               Do not load .env.local or .env.",
    "  --help                      Show this help.",
  ].join("\n");
}

export function protectedResourceMetadataUrl(mcpUrl: URL): URL {
  return new URL("/.well-known/oauth-protected-resource", mcpUrl.origin);
}

export async function assertOAuthMetadataCors(
  metadataUrl: URL,
  metadataResponse: Pick<Response, "headers">,
  fetchImpl: RemoteOAuthMetadataCorsFetch = fetch,
): Promise<RemoteOAuthMetadataCorsSummary> {
  const metadataAllowOrigin = readRequiredHeader(
    metadataResponse.headers,
    "access-control-allow-origin",
    "OAuth protected-resource metadata",
  );
  if (metadataAllowOrigin !== "*") {
    throw new Error(
      "OAuth protected-resource metadata must allow browser CORS reads with Access-Control-Allow-Origin: *.",
    );
  }

  const preflight = await fetchImpl(metadataUrl, { method: "OPTIONS" });
  if (preflight.status !== 204) {
    throw new Error(
      `OAuth protected-resource metadata preflight returned HTTP ${preflight.status}; expected 204.`,
    );
  }

  const preflightAllowOrigin = readRequiredHeader(
    preflight.headers,
    "access-control-allow-origin",
    "OAuth protected-resource metadata preflight",
  );
  if (preflightAllowOrigin !== "*") {
    throw new Error(
      "OAuth protected-resource metadata preflight must allow browser CORS reads with Access-Control-Allow-Origin: *.",
    );
  }

  const allowHeaders = headerTokens(
    preflight.headers.get("access-control-allow-headers"),
  );
  if (!allowHeaders.includes("authorization")) {
    throw new Error(
      "OAuth protected-resource metadata preflight must allow the authorization header.",
    );
  }

  const exposeHeaders = headerTokens(
    preflight.headers.get("access-control-expose-headers"),
  );
  if (!exposeHeaders.includes("www-authenticate")) {
    throw new Error(
      "OAuth protected-resource metadata preflight must expose WWW-Authenticate.",
    );
  }

  return {
    metadata_allow_origin: metadataAllowOrigin,
    preflight_status: preflight.status,
    preflight_allow_origin: preflightAllowOrigin,
    preflight_allows_authorization: true,
    preflight_exposes_www_authenticate: true,
  };
}

export function summarizeOAuthMetadata(
  value: unknown,
  expectedResource: string,
): RemoteOAuthMetadataSummary {
  const record = asRecord(value);
  const resource = readString(record, "resource");
  if (resource !== expectedResource) {
    throw new Error(
      `OAuth protected-resource metadata resource mismatch. Expected ${expectedResource}.`,
    );
  }

  const authorizationServers = readStringArray(record, "authorization_servers");
  if (authorizationServers.length === 0) {
    throw new Error(
      "OAuth protected-resource metadata did not include authorization_servers.",
    );
  }
  for (const authorizationServer of authorizationServers) {
    const parsed = parseHttpsMetadataUrl(
      authorizationServer,
      "authorization_servers",
    );
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
  }

  const supported = readStringArray(record, "scopes_supported");
  const scopesSupported = authScopes.filter((scope) =>
    supported.includes(scope),
  );
  if (scopesSupported.length !== authScopes.length) {
    throw new Error(
      `OAuth protected-resource metadata did not include all required scopes: ${authScopes.join(", ")}.`,
    );
  }

  return {
    resource,
    authorization_servers: authorizationServers,
    scopes_supported: scopesSupported,
  };
}

export async function fetchOAuthAuthorizationServerDiscovery(
  authorizationServers: readonly string[],
  fetchImpl: RemoteOAuthDiscoveryFetch = fetch,
): Promise<RemoteOAuthAuthorizationServerSummary> {
  const errors: string[] = [];

  for (const authorizationServer of authorizationServers) {
    for (const candidate of authorizationServerDiscoveryCandidates(
      authorizationServer,
    )) {
      const response = await fetchImpl(candidate.url).catch(
        (error: unknown) => {
          errors.push(
            `${candidate.url.toString()}: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          return undefined;
        },
      );
      if (!response) {
        continue;
      }
      if (!response.ok) {
        errors.push(`${candidate.url.toString()}: HTTP ${response.status}`);
        continue;
      }

      return summarizeOAuthAuthorizationServerDiscovery(
        await response.json(),
        authorizationServer,
        candidate.url,
        candidate.type,
      );
    }
  }

  throw new Error(
    `OAuth authorization-server discovery failed. Tried ${authorizationServers.join(", ")}. ${errors.join("; ")}`,
  );
}

export function summarizeOAuthAuthorizationServerDiscovery(
  value: unknown,
  expectedIssuer: string,
  discoveryUrl: URL,
  discoveryType: RemoteOAuthAuthorizationServerDiscoveryType,
): RemoteOAuthAuthorizationServerSummary {
  const record = asRecord(value);
  const issuer = readString(record, "issuer");
  if (issuer !== expectedIssuer) {
    throw new Error(
      `OAuth authorization-server discovery issuer mismatch. Expected ${expectedIssuer}.`,
    );
  }

  const authorizationEndpoint = readRequiredHttpsUrl(
    record,
    "authorization_endpoint",
    "OAuth authorization-server discovery",
  );
  const tokenEndpoint = readRequiredHttpsUrl(
    record,
    "token_endpoint",
    "OAuth authorization-server discovery",
  );
  const jwksUri = readRequiredHttpsUrl(
    record,
    "jwks_uri",
    "OAuth authorization-server discovery",
  );
  const grantTypesSupported = readStringArray(record, "grant_types_supported");
  if (!grantTypesSupported.includes("authorization_code")) {
    throw new Error(
      "OAuth authorization-server discovery must advertise authorization_code grant support.",
    );
  }

  const responseTypesSupported = readStringArray(
    record,
    "response_types_supported",
  );
  if (!responseTypesSupported.includes("code")) {
    throw new Error(
      "OAuth authorization-server discovery must advertise code response support.",
    );
  }

  const codeChallengeMethodsSupported = readStringArray(
    record,
    "code_challenge_methods_supported",
  );
  if (!codeChallengeMethodsSupported.includes("S256")) {
    throw new Error(
      "OAuth authorization-server discovery must advertise PKCE S256 support.",
    );
  }

  return {
    discovery_url: discoveryUrl.toString(),
    discovery_type: discoveryType,
    issuer,
    authorization_endpoint: authorizationEndpoint,
    token_endpoint: tokenEndpoint,
    jwks_uri: jwksUri,
    grant_types_supported: grantTypesSupported,
    response_types_supported: responseTypesSupported,
    code_challenge_methods_supported: codeChallengeMethodsSupported,
  };
}

export function authorizationServerDiscoveryCandidates(
  issuer: string,
): readonly {
  readonly url: URL;
  readonly type: RemoteOAuthAuthorizationServerDiscoveryType;
}[] {
  const url = new URL(issuer);
  const path = url.pathname.replace(/\/+$/u, "");
  const oauthPath = `/.well-known/oauth-authorization-server${path === "" ? "" : path}`;
  const oidcPath = `${path === "" ? "" : path}/.well-known/openid-configuration`;

  return [
    {
      url: new URL(oauthPath, url.origin),
      type: "oauth-authorization-server",
    },
    {
      url: new URL(oidcPath, url.origin),
      type: "openid-configuration",
    },
  ];
}

export function redactOAuthRemoteUrl(url: URL): string {
  return redactRemoteUrl(url);
}

export function isOAuthHelp(args: readonly string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

export function shouldLoadOAuthEnvFile(args: readonly string[]): boolean {
  return !args.includes("--no-env-file");
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readString(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readStringArray(
  record: Record<string, unknown>,
  key: string,
): string[] {
  const value = record[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function readRequiredHttpsUrl(
  record: Record<string, unknown>,
  key: string,
  context: string,
): string {
  const value = readString(record, key);
  if (!value) {
    throw new Error(`${context} did not include ${key}.`);
  }

  const parsed = parseHttpsMetadataUrl(value, key);
  if (!parsed.ok) {
    throw new Error(parsed.error);
  }

  return value;
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

function readRequiredHeader(
  headers: Pick<Headers, "get">,
  name: string,
  context: string,
): string {
  const value = headers.get(name);
  if (!value) {
    throw new Error(`${context} response did not include ${name}.`);
  }

  return value;
}

function headerTokens(value: string | null): string[] {
  return (value ?? "")
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}

function parseHttpsMetadataUrl(
  value: string,
  fieldName: string,
): { readonly ok: true } | { readonly ok: false; readonly error: string } {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      return {
        ok: false,
        error: `OAuth protected-resource metadata ${fieldName} must contain only https URLs.`,
      };
    }
    if (url.username || url.password) {
      return {
        ok: false,
        error: `OAuth protected-resource metadata ${fieldName} must not include username or password.`,
      };
    }
    return { ok: true };
  } catch {
    return {
      ok: false,
      error: `OAuth protected-resource metadata ${fieldName} must contain valid absolute URLs.`,
    };
  }
}

function resolveProjectArtifact(cwd: string, value: string): string {
  const root = resolve(cwd);
  const artifactPath = resolve(root, value);
  const artifact = relative(root, artifactPath);
  if (artifact === "" || artifact.startsWith("..") || isAbsolute(artifact)) {
    throw new Error(
      "remote OAuth evidence artifact must stay inside the project directory.",
    );
  }

  return artifact;
}
