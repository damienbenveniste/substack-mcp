import { isAbsolute, relative, resolve } from "node:path";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";

import type {
  PreviewSmokeResult,
  ValidationSmokeResult,
} from "./smokeValidateTool.js";

export const DEFAULT_STDIO_COMMAND = "node";
export const DEFAULT_STDIO_ARGS = ["dist/stdio.js"] as const;

const DEFAULT_CHILD_ENV = {
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
  MCP_TRANSPORT: "stdio",
  AUTH_MODE: "noauth",
  SUBSTACK_PUBLICATION_URL: "https://example.substack.com",
  SUBSTACK_SESSION_TOKEN: "stdio-smoke-session-token",
  SUBSTACK_USER_ID: "1",
  PREVIEW_TOKEN_SECRET: "stdio-smoke-preview-token-secret-with-enough-entropy",
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
  "MCP_PUBLIC_BASE_URL",
  "OAUTH_AUTHORIZATION_SERVER_URL",
  "OAUTH_RESOURCE_DOCUMENTATION_URL",
  "OAUTH_JWKS_URL",
  "OAUTH_JWT_ALGORITHMS",
] as const;

export interface LocalStdioSmokeRunOptions {
  readonly help: false;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly artifactRoot: string;
  readonly evidenceArtifact?: string | undefined;
  readonly env: Record<string, string>;
}

export interface LocalStdioSmokeHelpOptions {
  readonly help: true;
}

export type LocalStdioSmokeOptions =
  | LocalStdioSmokeRunOptions
  | LocalStdioSmokeHelpOptions;

export interface LocalStdioSmokeResult {
  readonly ok: true;
  readonly transport: "stdio";
  readonly command: string;
  readonly args: readonly string[];
  readonly tool_count: number;
  readonly tools: string[];
  readonly validation: ValidationSmokeResult;
  readonly preview: PreviewSmokeResult;
}

export function parseLocalStdioArgs(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  cwd = process.cwd(),
): LocalStdioSmokeOptions {
  let command = DEFAULT_STDIO_COMMAND;
  let commandArgs: string[] | undefined;
  let workingDirectory = cwd;
  let evidenceArtifact: string | undefined;
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
      case "--evidence-artifact":
        evidenceArtifact = resolveProjectArtifact(
          cwd,
          readValue(args, index, "--evidence-artifact"),
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

  return {
    help: false,
    command,
    args: commandArgs ?? [...DEFAULT_STDIO_ARGS],
    cwd: workingDirectory,
    artifactRoot: resolve(cwd),
    evidenceArtifact,
    env: buildChildEnv(env, envOverrides),
  };
}

export function localStdioUsage(): string {
  return [
    "Usage: npm run smoke:stdio -- [options]",
    "",
    "Launches the built stdio MCP server, lists tools over the MCP stdio",
    "transport, verifies the V1 draft-only tool surface, and calls",
    "validate_newsletter_content and preview_draft with the rich Markdown",
    "fixture. It does not call Substack and does not run write tools.",
    "",
    "Default command:",
    "  node dist/stdio.js",
    "",
    "Options:",
    "  --command <command>    Executable to launch. Default: node.",
    "  --arg <arg>            Argument passed to the command. Repeatable.",
    "  --cwd <path>           Working directory for the child process.",
    "  --evidence-artifact <path>",
    "                          Write sanitized Markdown evidence for gate 15.",
    "  --env NAME=value       Override one child environment variable. Repeatable.",
    "  --help                 Show this help.",
    "",
    "Examples:",
    "  npm run build",
    "  npm run smoke:stdio",
    "  npm run smoke:stdio -- --command tsx --arg src/stdio.ts",
  ].join("\n");
}

function buildChildEnv(
  env: NodeJS.ProcessEnv,
  overrides: Record<string, string>,
): Record<string, string> {
  return {
    ...getDefaultEnvironment(),
    ...DEFAULT_CHILD_ENV,
    ...pickAppEnv(env),
    MCP_TRANSPORT: "stdio",
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

function resolveProjectArtifact(cwd: string, value: string): string {
  const root = resolve(cwd);
  const artifactPath = resolve(root, value);
  const artifact = relative(root, artifactPath);
  if (artifact === "" || artifact.startsWith("..") || isAbsolute(artifact)) {
    throw new Error(
      "stdio evidence artifact must stay inside the project directory.",
    );
  }

  return artifact;
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
