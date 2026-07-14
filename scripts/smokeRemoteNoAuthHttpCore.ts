import { isAbsolute, relative, resolve } from "node:path";

import {
  parseRemoteMcpUrl,
  type RemoteHealthResult,
  redactRemoteUrl,
} from "./smokeRemoteHttpCore.js";
import type {
  PreviewSmokeResult,
  ValidationSmokeResult,
} from "./smokeValidateTool.js";

export interface RemoteNoAuthSmokeRunOptions {
  readonly help: false;
  readonly loadEnvFile: boolean;
  readonly url: URL;
  readonly artifactRoot: string;
  readonly evidenceArtifact?: string | undefined;
}

export interface RemoteNoAuthSmokeHelpOptions {
  readonly help: true;
  readonly loadEnvFile: boolean;
}

export type RemoteNoAuthSmokeOptions =
  | RemoteNoAuthSmokeRunOptions
  | RemoteNoAuthSmokeHelpOptions;

export interface RemoteNoAuthSmokeResult {
  readonly ok: true;
  readonly auth_mode: "noauth";
  readonly endpoint: string;
  readonly health: RemoteHealthResult;
  readonly tool_count: number;
  readonly tools: string[];
  readonly validation: ValidationSmokeResult;
  readonly preview: PreviewSmokeResult;
}

export function parseNoAuthArgs(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd = process.cwd(),
): RemoteNoAuthSmokeOptions {
  let urlValue = env.MCP_REMOTE_URL;
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

  return {
    help,
    loadEnvFile,
    url: parseRemoteMcpUrl(urlValue),
    artifactRoot: resolve(cwd),
    evidenceArtifact,
  };
}

export function noAuthUsage(): string {
  return [
    "Usage: npm run smoke:remote-noauth -- --url <https://host/mcp> [options]",
    "",
    "Connects to a remote Streamable HTTP MCP endpoint with no Authorization",
    "header, checks /healthz on the same origin, lists tools, verifies the V1",
    "draft-only tool surface, and calls validate_newsletter_content plus",
    "preview_draft with the rich Markdown fixture. It does not call Substack",
    "and does not run write tools.",
    "",
    "Use this for short-lived ChatGPT/ngrok developer-mode testing when the",
    "server is intentionally running with AUTH_MODE=noauth.",
    "",
    "Environment:",
    "  MCP_REMOTE_URL       HTTPS remote MCP URL without embedded username/password. Used when --url is omitted.",
    "",
    "Options:",
    "  --url <url>          HTTPS remote MCP URL without embedded username/password. Path must be /mcp or /mcp/<secret>.",
    "  --evidence-artifact <path>",
    "                       Write sanitized Markdown evidence for gate 11.",
    "  --no-env-file        Do not load .env.local or .env.",
    "  --help               Show this help.",
  ].join("\n");
}

export function redactNoAuthRemoteUrl(url: URL): string {
  return redactRemoteUrl(url);
}

export function isNoAuthHelp(args: readonly string[]): boolean {
  return args.includes("--help") || args.includes("-h");
}

export function shouldLoadNoAuthEnvFile(args: readonly string[]): boolean {
  return !args.includes("--no-env-file");
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
      "remote noauth evidence artifact must stay inside the project directory.",
    );
  }

  return artifact;
}
