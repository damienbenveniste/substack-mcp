import { isAbsolute, relative, resolve } from "node:path";

import { normalizeMcpEndpointPath } from "../src/safety/mcpPathSecret.js";
import { normalizeStaticBearerToken } from "../src/safety/staticBearerToken.js";
import type {
  PreviewSmokeResult,
  ValidationSmokeResult,
} from "./smokeValidateTool.js";

export const EXPECTED_TOOL_NAMES = [
  "create_draft",
  "get_draft",
  "list_drafts",
  "preview_draft",
  "update_draft",
  "upload_image",
  "validate_newsletter_content",
] as const;
export const DEFAULT_REMOTE_WRONG_BEARER_TOKEN = "wrong-static-bearer-token";

export interface RemoteSmokeRunOptions {
  readonly help: false;
  readonly loadEnvFile: boolean;
  readonly url: URL;
  readonly bearerToken: string;
  readonly wrongBearerToken: string;
  readonly artifactRoot: string;
  readonly evidenceArtifact?: string | undefined;
}

export interface RemoteSmokeHelpOptions {
  readonly help: true;
  readonly loadEnvFile: boolean;
}

export type RemoteSmokeOptions = RemoteSmokeRunOptions | RemoteSmokeHelpOptions;

export interface RemoteSmokeResult {
  readonly ok: true;
  readonly auth_mode: "static_bearer";
  readonly endpoint: string;
  readonly health: RemoteHealthResult;
  readonly missing_bearer_status: 401;
  readonly wrong_bearer_status: 401;
  readonly tool_count: number;
  readonly tools: string[];
  readonly validation: ValidationSmokeResult;
  readonly preview: PreviewSmokeResult;
}

export interface RemoteHealthResult {
  readonly url: string;
  readonly status: number;
}

export type RemoteHealthFetch = (
  url: URL,
) => Promise<Pick<Response, "ok" | "status">>;

export function parseArgs(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd = process.cwd(),
): RemoteSmokeOptions {
  let urlValue = env.MCP_REMOTE_URL;
  let tokenEnvName = "MCP_BEARER_TOKEN";
  let wrongTokenEnvName: string | undefined;
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
      case "--wrong-bearer-token-env":
        wrongTokenEnvName = readValue(args, index, "--wrong-bearer-token-env");
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

  const url = parseRemoteMcpUrl(urlValue);
  const bearerToken = normalizeStaticBearerToken(
    env[tokenEnvName],
    tokenEnvName,
  );
  if (!bearerToken) {
    throw new Error(
      `${tokenEnvName} must be set to run the remote HTTP smoke test.`,
    );
  }
  const wrongBearerToken = wrongTokenEnvName
    ? normalizeStaticBearerToken(env[wrongTokenEnvName], wrongTokenEnvName)
    : DEFAULT_REMOTE_WRONG_BEARER_TOKEN;
  if (!wrongBearerToken) {
    throw new Error(
      `${wrongTokenEnvName} must be set to a non-empty bearer token.`,
    );
  }
  if (wrongBearerToken === bearerToken) {
    throw new Error(
      "--wrong-bearer-token-env must resolve to a token different from the valid bearer token.",
    );
  }

  return {
    help,
    loadEnvFile,
    url,
    bearerToken,
    wrongBearerToken,
    artifactRoot: resolve(cwd),
    evidenceArtifact,
  };
}

export function assertExpectedTools(toolNames: readonly string[]): void {
  const expected = [...EXPECTED_TOOL_NAMES].sort();
  const actual = [...toolNames].sort();
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    return;
  }

  throw new Error(
    [
      "Unexpected remote MCP tool surface.",
      `Expected: ${expected.join(", ")}`,
      `Received: ${actual.join(", ")}`,
    ].join("\n"),
  );
}

export function remoteHealthUrl(mcpUrl: URL): URL {
  return new URL("/healthz", mcpUrl.origin);
}

export async function assertRemoteHealth(
  mcpUrl: URL,
  fetchImpl: RemoteHealthFetch = fetch,
): Promise<RemoteHealthResult> {
  const healthUrl = remoteHealthUrl(mcpUrl);
  const response = await fetchImpl(healthUrl);
  if (!response.ok) {
    throw new Error(
      `Remote health check ${healthUrl.toString()} returned HTTP ${response.status}.`,
    );
  }

  return {
    url: healthUrl.toString(),
    status: response.status,
  };
}

export async function assertRemoteStaticBearerRejected(
  endpoint: URL,
  bearerToken: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<401> {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  };
  if (bearerToken) {
    headers.Authorization = `Bearer ${bearerToken}`;
  }

  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    }),
  });
  const challenge = response.headers.get("www-authenticate") ?? "";
  if (response.status !== 401 || !challenge.startsWith("Bearer ")) {
    throw new Error(
      `Expected remote static bearer rejection to return 401 with Bearer challenge, got HTTP ${response.status}.`,
    );
  }

  return 401;
}

export function redactRemoteUrl(url: URL): string {
  const path =
    url.pathname === "/mcp"
      ? "/mcp"
      : url.pathname.startsWith("/mcp/")
        ? "/mcp/<redacted>"
        : url.pathname;

  return `${url.origin}${path}`;
}

export function usage(): string {
  return [
    "Usage: npm run smoke:remote -- --url <https://host/mcp> [options]",
    "",
    "Connects to a remote Streamable HTTP MCP endpoint with static bearer auth,",
    "checks /healthz on the same origin, verifies missing/wrong bearer tokens",
    "return 401 with a Bearer challenge, lists tools, verifies the V1",
    "draft-only tool surface, and calls validate_newsletter_content plus",
    "preview_draft with the rich Markdown fixture. It does not call Substack",
    "and does not run write tools.",
    "",
    "Environment:",
    "  MCP_REMOTE_URL       HTTPS remote MCP URL without embedded username/password. Used when --url is omitted.",
    "  MCP_BEARER_TOKEN     Bearer token sent in the Authorization header.",
    "",
    "Options:",
    "  --url <url>                 HTTPS remote MCP URL without embedded username/password. Path must be /mcp or /mcp/<secret>.",
    "  --bearer-token-env <name>   Read bearer token from this env var. Default: MCP_BEARER_TOKEN.",
    "  --wrong-bearer-token-env <name>",
    "                              Read a distinct wrong token from this env var for rejection checks. Default: safe fake token.",
    "  --evidence-artifact <path>  Write sanitized Markdown evidence for gate 14.",
    "  --no-env-file               Do not load .env.local or .env.",
    "  --help                      Show this help.",
  ].join("\n");
}

export function isHelp(args: readonly string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

export function shouldLoadEnvFile(args: readonly string[]): boolean {
  return !args.includes("--no-env-file");
}

export function parseRemoteMcpUrl(value: string | undefined): URL {
  const raw = value?.trim();
  if (!raw) {
    throw new Error("MCP_REMOTE_URL or --url is required.");
  }

  const url = new URL(raw);
  if (url.protocol !== "https:") {
    throw new Error("Remote MCP URL must use https.");
  }
  if (url.username || url.password) {
    throw new Error("Remote MCP URL must not include username or password.");
  }
  normalizeMcpEndpointPath(url.pathname, "Remote MCP URL path");

  return url;
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

function resolveProjectArtifact(cwd: string, value: string): string {
  const root = resolve(cwd);
  const artifactPath = resolve(root, value);
  const artifact = relative(root, artifactPath);
  if (artifact === "" || artifact.startsWith("..") || isAbsolute(artifact)) {
    throw new Error(
      "remote static-bearer evidence artifact must stay inside the project directory.",
    );
  }

  return artifact;
}
