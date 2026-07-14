import { existsSync, readFileSync } from "node:fs";
import { delimiter, isAbsolute, join, relative, resolve } from "node:path";

import { assertOAuthConfig } from "../src/auth/oauth.js";
import { DEFAULT_PREVIEW_TOKEN_SECRET } from "../src/config.js";
import { normalizeMcpPathSecret } from "../src/safety/mcpPathSecret.js";
import { normalizeStaticBearerToken } from "../src/safety/staticBearerToken.js";
import { normalizeSubstackSessionToken } from "../src/safety/substackSessionToken.js";
import { parsePublicHttpsUrl } from "../src/safety/urlPolicy.js";
import {
  buildFixtureStatus,
  fixtureCompatibilityTestCommand,
  fixtureStatusCommand,
  resolveProjectFixtureDir,
} from "./fixtureStatusCore.js";
import {
  parseLiveSubstackEvidenceArtifacts,
  resolveLiveSubstackEvidenceArtifact,
} from "./liveSubstackEvidence.js";
import { parseRemoteMcpUrl } from "./smokeRemoteHttpCore.js";

export type V1PreflightFormat = "text" | "json";
export type V1PreflightCheckStatus = "ok" | "missing" | "warning";
export type V1PreflightScope = "local";

export interface V1AcceptancePreflightRunOptions {
  readonly help: false;
  readonly cwd: string;
  readonly fixtureDir: string;
  readonly format: V1PreflightFormat;
  readonly requireLive: boolean;
  readonly loadEnvFile: boolean;
  readonly scope?: V1PreflightScope | undefined;
}

export interface V1AcceptancePreflightHelpOptions {
  readonly help: true;
}

export type V1AcceptancePreflightOptions =
  | V1AcceptancePreflightRunOptions
  | V1AcceptancePreflightHelpOptions;

export interface V1PreflightCheck {
  readonly id: string;
  readonly status: V1PreflightCheckStatus;
  readonly label: string;
  readonly evidence: string;
  readonly next_action?: string | undefined;
}

export interface V1AcceptancePreflightReport {
  readonly scope?: V1PreflightScope | undefined;
  readonly live_ready: boolean;
  readonly summary: {
    readonly ok: number;
    readonly missing: number;
    readonly warning: number;
  };
  readonly checks: readonly V1PreflightCheck[];
}

export interface BuildV1AcceptancePreflightOptions {
  readonly cwd: string;
  readonly fixtureDir?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly nodeVersion?: string | undefined;
  readonly commandExists?: ((command: string) => boolean) | undefined;
  readonly scope?: V1PreflightScope | undefined;
}

interface PackageManifest {
  readonly scripts?: unknown;
  readonly engines?: unknown;
}

const REQUIRED_LIVE_ENV = [
  "SUBSTACK_PUBLICATION_URL",
  "SUBSTACK_SESSION_TOKEN",
  "SUBSTACK_USER_ID",
  "PREVIEW_TOKEN_SECRET",
] as const;

const REQUIRED_V1_SCRIPTS = [
  "auth:setup",
  "cloud-run:logs:verify",
  "cloud-run:plan",
  "cloud-run:verify",
  "create:fixture",
  "fixtures:status",
  "inspect:draft",
  "smoke:inspector",
  "smoke:docker-http",
  "smoke:http-local",
  "smoke:http-oauth",
  "smoke:http-static-bearer",
  "smoke:ngrok-noauth",
  "smoke:ngrok-oauth",
  "smoke:ngrok-static-bearer",
  "smoke:remote",
  "smoke:remote-noauth",
  "smoke:remote-oauth",
  "smoke:stdio",
  "test:live",
  "v1:preflight",
  "v1:record",
  "v1:runbook",
  "v1:status",
  "validate:v1-local",
] as const;
const REQUIRED_LOCAL_MCP_SCRIPTS = [
  "auth:setup",
  "build",
  "dev:http",
  "dev:stdio",
  "mcp:preflight",
  "smoke:http-local",
  "smoke:inspector",
  "smoke:stdio",
  "test:live",
  "test:mcp-local",
] as const;
const INSPECTOR_NODE_MIN_VERSION = [22, 7, 5] as const;
const INSPECTOR_NODE_MIN_VERSION_TEXT = "22.7.5";

export function parseV1AcceptancePreflightArgs(
  args: readonly string[],
  cwd = process.cwd(),
): V1AcceptancePreflightOptions {
  let format: V1PreflightFormat = "text";
  let requireLive = false;
  let loadEnvFile = true;
  let fixtureDir = resolve(cwd, "fixtures", "substack");
  let scope: V1PreflightScope | undefined;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--format":
        format = parseFormat(readValue(args, index, arg));
        index += 1;
        break;
      case "--fixture-dir":
        fixtureDir = resolveInsideCwd(cwd, readValue(args, index, arg), arg);
        index += 1;
        break;
      case "--json":
        format = "json";
        break;
      case "--local":
        scope = "local";
        break;
      case "--require-live":
        requireLive = true;
        break;
      case "--no-env-file":
        loadEnvFile = false;
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
    return { help: true };
  }

  return {
    help: false,
    cwd: resolve(cwd),
    fixtureDir,
    format,
    requireLive,
    loadEnvFile,
    ...(scope ? { scope } : {}),
  };
}

export function v1AcceptancePreflightUsage(): string {
  return [
    "Usage: npm run v1:preflight -- [options]",
    "",
    "Checks no-secret local prerequisites for the manual/live V1 acceptance",
    "gates. This command does not call Substack, open ChatGPT, deploy Cloud Run,",
    "or print secret values.",
    "Reports Node runtime/package-engine, live Substack env, live fixture env, live evidence artifact env, fixture, remote MCP URL env, MCP path secret env, auth-mode, Cloud Billing, and local tool readiness.",
    "",
    "Options:",
    "  --fixture-dir <path>  Project-local live fixture directory. Default: fixtures/substack.",
    "  --format <format>  text or json. Default: text.",
    "  --json             Shortcut for --format json.",
    "  --local            Check only localhost MCP and credentialed Substack test readiness.",
    "  --require-live     Exit non-zero unless required live prerequisites are ready.",
    "  --no-env-file      Do not load .env.local or .env before checking env names.",
    "  --help             Show this help.",
    "",
    "Examples:",
    "  npm run v1:preflight",
    "  npm run v1:preflight -- --fixture-dir fixtures/live",
    "  npm run v1:preflight -- --json",
    "  npm run mcp:preflight",
    "  npm run mcp:preflight -- --require-live",
    "  npm run v1:preflight -- --require-live",
  ].join("\n");
}

export function buildV1AcceptancePreflight(
  options: BuildV1AcceptancePreflightOptions,
): V1AcceptancePreflightReport {
  const env = options.env ?? process.env;
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const checks: V1PreflightCheck[] =
    options.scope === "local"
      ? [
          nodeVersionCheck(nodeVersion),
          inspectorNodeVersionCheck(nodeVersion),
          nodeEngineCheck(options.cwd),
          localMcpScriptsCheck(options.cwd),
          liveEnvCheck(env),
          liveTestOptInCheck(env),
          externalToolCheck(
            "tool_npx",
            "npx is available for local MCP Inspector testing.",
            "npx",
            options.commandExists,
            "Install npm/npx with Node.js before running `npm run smoke:inspector`.",
          ),
        ]
      : [
          nodeVersionCheck(nodeVersion),
          inspectorNodeVersionCheck(nodeVersion),
          nodeEngineCheck(options.cwd),
          scriptsCheck(options.cwd),
          liveEnvCheck(env),
          staticBearerEnvCheck(env),
          remoteMcpUrlEnvCheck(env),
          mcpPathSecretEnvCheck(env),
          oauthRemoteEnvCheck(env),
          billingAccountEnvCheck(env),
          liveTestOptInCheck(env),
          liveEvidenceArtifactEnvCheck(options.cwd, env),
          substackFixtureDirEnvCheck(
            options.cwd,
            resolve(options.cwd, options.fixtureDir ?? "fixtures/substack"),
            env,
          ),
          externalToolCheck(
            "tool_npx",
            "npx is available for MCP Inspector CLI gate 3 evidence.",
            "npx",
            options.commandExists,
            "Install npm/npx with Node.js before running `npm run smoke:inspector`.",
          ),
          externalToolCheck(
            "tool_ngrok",
            "ngrok CLI is available for ChatGPT developer-mode tunnel testing.",
            "ngrok",
            options.commandExists,
            "Install ngrok or use another public HTTPS tunnel before gate 11.",
          ),
          externalToolCheck(
            "tool_gcloud",
            "gcloud CLI is available for Cloud Run deployment.",
            "gcloud",
            options.commandExists,
            "Install and authenticate the Google Cloud CLI before gates 12 and 13.",
          ),
          externalToolCheck(
            "tool_docker",
            "Docker CLI is available for container smoke testing.",
            "docker",
            options.commandExists,
            "Install Docker before running `npm run smoke:docker-http`.",
          ),
          fixtureReadinessCheck(
            options.cwd,
            resolve(options.cwd, options.fixtureDir ?? "fixtures/substack"),
          ),
        ];
  const summary = summarize(checks);
  const liveReady = requiredLiveChecks(checks, options.scope).every(
    (check) => check.status === "ok",
  );

  return {
    ...(options.scope ? { scope: options.scope } : {}),
    live_ready: liveReady,
    summary,
    checks,
  };
}

export function renderV1AcceptancePreflight(
  report: V1AcceptancePreflightReport,
  format: V1PreflightFormat,
): string {
  if (format === "json") {
    return `${JSON.stringify(report, null, 2)}\n`;
  }

  const localScope = report.scope === "local";
  const lines = [
    localScope ? "# Local MCP test preflight" : "# V1 acceptance preflight",
    "",
    localScope
      ? "This report checks localhost MCP and credentialed Substack test prerequisites. It does not call Substack, use ngrok, deploy Cloud Run, or print secret values."
      : "This report checks local prerequisites only. It does not call Substack, open ChatGPT, deploy Cloud Run, or print secret values.",
    "",
    `${localScope ? "Live-test ready" : "Live-ready"}: ${report.live_ready ? "yes" : "no"}`,
    `OK: ${report.summary.ok}`,
    `Missing: ${report.summary.missing}`,
    `Warnings: ${report.summary.warning}`,
    "",
    "## Checks",
    ...report.checks.flatMap((check) => [
      `- ${check.status}: ${check.id}`,
      `  ${check.label}`,
      `  Evidence: ${check.evidence}`,
      ...(check.next_action ? [`  Next: ${check.next_action}`] : []),
    ]),
  ];

  return `${lines.join("\n")}\n`;
}

export function shouldFailV1AcceptancePreflight(
  report: Pick<V1AcceptancePreflightReport, "live_ready">,
  options: Pick<V1AcceptancePreflightRunOptions, "requireLive">,
): boolean {
  return options.requireLive && !report.live_ready;
}

function nodeVersionCheck(nodeVersion: string): V1PreflightCheck {
  const major = Number(nodeVersion.split(".")[0]);
  const ok = Number.isInteger(major) && major >= 20;
  return {
    id: "node_version",
    status: ok ? "ok" : "missing",
    label: "Node.js runtime is 20 or newer.",
    evidence: `node ${nodeVersion}`,
    ...(ok
      ? {}
      : { next_action: "Install Node.js 20+ before running V1 tooling." }),
  };
}

function inspectorNodeVersionCheck(nodeVersion: string): V1PreflightCheck {
  const parsed = parseNodeVersion(nodeVersion);
  const ok =
    parsed !== undefined &&
    compareNodeVersion(parsed, INSPECTOR_NODE_MIN_VERSION) >= 0;
  return {
    id: "inspector_node_version",
    status: ok ? "ok" : "warning",
    label:
      "Node.js runtime supports the current MCP Inspector CLI gate 3 helper.",
    evidence: `node ${nodeVersion}; @modelcontextprotocol/inspector@latest currently requires node >=${INSPECTOR_NODE_MIN_VERSION_TEXT}.`,
    ...(ok
      ? {}
      : {
          next_action: `Use Node.js ${INSPECTOR_NODE_MIN_VERSION_TEXT}+ when running \`npm run smoke:inspector\`, or use manual MCP Inspector UI verification for gate 3.`,
        }),
  };
}

function nodeEngineCheck(cwd: string): V1PreflightCheck {
  const manifest = readPackageManifest(cwd);
  const engines = manifest?.engines;
  const node =
    typeof engines === "object" &&
    engines !== null &&
    !Array.isArray(engines) &&
    typeof (engines as { readonly node?: unknown }).node === "string"
      ? (engines as { readonly node: string }).node.trim()
      : "";
  const ok = nodeEngineDeclaresNode20Floor(node);
  return {
    id: "node_engine",
    status: ok ? "ok" : "missing",
    label: "package.json declares the Node.js 20+ runtime contract.",
    evidence: node ? `engines.node: ${node}` : "engines.node missing",
    ...(ok ? {} : { next_action: "Set package.json engines.node to >=20." }),
  };
}

function scriptsCheck(cwd: string): V1PreflightCheck {
  return requiredScriptsCheck(
    cwd,
    REQUIRED_V1_SCRIPTS,
    "v1_scripts",
    "Required V1 helper npm scripts are present.",
  );
}

function localMcpScriptsCheck(cwd: string): V1PreflightCheck {
  return requiredScriptsCheck(
    cwd,
    REQUIRED_LOCAL_MCP_SCRIPTS,
    "local_mcp_scripts",
    "Required local MCP test npm scripts are present.",
  );
}

function requiredScriptsCheck(
  cwd: string,
  requiredScripts: readonly string[],
  id: string,
  label: string,
): V1PreflightCheck {
  const scripts = readPackageScripts(cwd);
  const missing = requiredScripts.filter(
    (script) => typeof scripts[script] !== "string",
  );
  return {
    id,
    status: missing.length === 0 ? "ok" : "missing",
    label,
    evidence:
      missing.length === 0
        ? `present: ${requiredScripts.join(", ")}`
        : `missing: ${missing.join(", ")}`,
    ...(missing.length === 0
      ? {}
      : { next_action: "Restore the missing package.json scripts." }),
  };
}

function liveEnvCheck(env: NodeJS.ProcessEnv): V1PreflightCheck {
  const missing = REQUIRED_LIVE_ENV.filter((name) => !hasEnvValue(env, name));
  const present = REQUIRED_LIVE_ENV.filter((name) => hasEnvValue(env, name));
  const invalid = liveEnvValidationProblems(env);
  const ready = missing.length === 0 && invalid.length === 0;
  return {
    id: "live_substack_env",
    status: ready ? "ok" : "missing",
    label:
      "Live Substack env names needed by fixture capture and live tests are configured.",
    evidence: [
      present.length > 0 ? `present: ${present.join(", ")}` : "present: none",
      missing.length > 0 ? `missing: ${missing.join(", ")}` : "missing: none",
      invalid.length > 0 ? `invalid: ${invalid.join("; ")}` : "invalid: none",
    ].join("; "),
    ...(ready
      ? {}
      : {
          next_action:
            "Run `npm run auth:setup` to create .data/substack-auth.json; for manual or automated configuration, set valid live Substack env values in .env.local, .env, or the shell before live gates.",
        }),
  };
}

function liveEnvValidationProblems(env: NodeJS.ProcessEnv): readonly string[] {
  const problems: string[] = [];
  const publicationUrl = env.SUBSTACK_PUBLICATION_URL?.trim();
  if (publicationUrl) {
    const parsed = parsePublicHttpsUrl(
      publicationUrl,
      "SUBSTACK_PUBLICATION_URL",
    );
    if (!parsed.ok) {
      problems.push(parsed.errors.join(" "));
    }
  }

  const userId = env.SUBSTACK_USER_ID?.trim();
  if (userId) {
    const parsed = Number(userId);
    if (!/^\d+$/.test(userId) || !Number.isSafeInteger(parsed) || parsed <= 0) {
      problems.push("SUBSTACK_USER_ID must be a positive integer.");
    }
  }

  const sessionToken = env.SUBSTACK_SESSION_TOKEN?.trim();
  if (sessionToken) {
    try {
      normalizeSubstackSessionToken(sessionToken);
    } catch (error) {
      problems.push(
        error instanceof Error
          ? error.message
          : "SUBSTACK_SESSION_TOKEN is invalid.",
      );
    }
  }

  if (env.PREVIEW_TOKEN_SECRET?.trim() === DEFAULT_PREVIEW_TOKEN_SECRET) {
    problems.push("PREVIEW_TOKEN_SECRET must not use the development default.");
  }

  return problems;
}

function staticBearerEnvCheck(env: NodeJS.ProcessEnv): V1PreflightCheck {
  const rawToken = env.MCP_BEARER_TOKEN;
  const present = hasEnvValue(env, "MCP_BEARER_TOKEN");
  let invalid: string | undefined;
  if (present) {
    try {
      normalizeStaticBearerToken(rawToken);
    } catch (error) {
      invalid =
        error instanceof Error ? error.message : "MCP_BEARER_TOKEN is invalid.";
    }
  }
  const ok = present && !invalid;
  return {
    id: "static_bearer_env",
    status: ok ? "ok" : "warning",
    label:
      "MCP_BEARER_TOKEN is configured for static-bearer remote HTTP testing.",
    evidence: present ? `present; invalid: ${invalid ?? "none"}` : "missing",
    ...(ok
      ? {}
      : {
          next_action:
            "Set MCP_BEARER_TOKEN to the token value only before testing AUTH_MODE=static_bearer remotely.",
        }),
  };
}

function remoteMcpUrlEnvCheck(env: NodeJS.ProcessEnv): V1PreflightCheck {
  if (!hasEnvValue(env, "MCP_REMOTE_URL")) {
    return {
      id: "remote_mcp_url_env",
      status: "ok",
      label: "MCP_REMOTE_URL is safe when used for remote MCP smoke testing.",
      evidence: "not set; remote smoke commands can use --url instead",
    };
  }

  const value = env.MCP_REMOTE_URL;
  try {
    parseRemoteMcpUrl(value);
  } catch (error) {
    return {
      id: "remote_mcp_url_env",
      status: "warning",
      label: "MCP_REMOTE_URL is safe when used for remote MCP smoke testing.",
      evidence: `present; invalid: ${remoteMcpUrlValidationMessage(error)}`,
      next_action:
        "Set MCP_REMOTE_URL to an HTTPS /mcp or /mcp/<secret> URL without embedded credentials, or pass --url to the remote smoke command.",
    };
  }

  return {
    id: "remote_mcp_url_env",
    status: "ok",
    label: "MCP_REMOTE_URL is safe when used for remote MCP smoke testing.",
    evidence: "present; valid HTTPS MCP endpoint path",
  };
}

function mcpPathSecretEnvCheck(env: NodeJS.ProcessEnv): V1PreflightCheck {
  if (!hasEnvValue(env, "MCP_PATH_SECRET")) {
    return {
      id: "mcp_path_secret_env",
      status: "ok",
      label:
        "MCP_PATH_SECRET is safe when used for private /mcp/<secret> endpoints.",
      evidence: "not set; MCP endpoint remains /mcp",
    };
  }

  try {
    normalizeMcpPathSecret(env.MCP_PATH_SECRET);
  } catch (error) {
    return {
      id: "mcp_path_secret_env",
      status: "warning",
      label:
        "MCP_PATH_SECRET is safe when used for private /mcp/<secret> endpoints.",
      evidence: `present; invalid: ${error instanceof Error ? error.message : "MCP_PATH_SECRET is invalid."}`,
      next_action:
        "Set MCP_PATH_SECRET to one URL-safe path segment without slashes, spaces, '.', or '..', or leave it unset to use /mcp.",
    };
  }

  return {
    id: "mcp_path_secret_env",
    status: "ok",
    label:
      "MCP_PATH_SECRET is safe when used for private /mcp/<secret> endpoints.",
    evidence: "present; valid single URL-safe path segment",
  };
}

function oauthRemoteEnvCheck(env: NodeJS.ProcessEnv): V1PreflightCheck {
  const authMode = env.AUTH_MODE?.trim() || "noauth";
  if (!["noauth", "static_bearer", "oauth"].includes(authMode)) {
    return {
      id: "oauth_remote_env",
      status: "warning",
      label:
        "OAuth metadata env is configured when AUTH_MODE=oauth for durable ChatGPT/public HTTP use.",
      evidence: "AUTH_MODE is invalid.",
      next_action: "Set AUTH_MODE to one of: noauth, static_bearer, oauth.",
    };
  }

  if (authMode !== "oauth") {
    return {
      id: "oauth_remote_env",
      status: "ok",
      label:
        "OAuth metadata env is configured when AUTH_MODE=oauth for durable ChatGPT/public HTTP use.",
      evidence: `AUTH_MODE=${authMode}; OAuth metadata is not required for this mode.`,
    };
  }

  try {
    assertOAuthConfig({
      publicBaseUrl: optionalEnv(env, "MCP_PUBLIC_BASE_URL"),
      oauthAuthorizationServerUrl: optionalEnv(
        env,
        "OAUTH_AUTHORIZATION_SERVER_URL",
      ),
      oauthResourceDocumentationUrl: optionalEnv(
        env,
        "OAUTH_RESOURCE_DOCUMENTATION_URL",
      ),
      oauthJwksUrl: optionalEnv(env, "OAUTH_JWKS_URL"),
      oauthJwtAlgorithms: oauthAlgorithms(env),
    });
  } catch (error) {
    return {
      id: "oauth_remote_env",
      status: "warning",
      label:
        "OAuth metadata env is configured when AUTH_MODE=oauth for durable ChatGPT/public HTTP use.",
      evidence: `AUTH_MODE=oauth; ${error instanceof Error ? error.message : "OAuth metadata is invalid."}`,
      next_action:
        "Set MCP_PUBLIC_BASE_URL, OAUTH_AUTHORIZATION_SERVER_URL, and OAUTH_JWKS_URL to absolute https URLs without embedded credentials before OAuth remote acceptance.",
    };
  }

  return {
    id: "oauth_remote_env",
    status: "ok",
    label:
      "OAuth metadata env is configured when AUTH_MODE=oauth for durable ChatGPT/public HTTP use.",
    evidence: `AUTH_MODE=oauth; required OAuth metadata is present and uses https; algorithms: ${oauthAlgorithms(env).join(", ")}`,
  };
}

function remoteMcpUrlValidationMessage(error: unknown): string {
  if (error instanceof TypeError) {
    return "MCP_REMOTE_URL must be a valid absolute URL.";
  }

  return error instanceof Error ? error.message : "MCP_REMOTE_URL is invalid.";
}

function billingAccountEnvCheck(env: NodeJS.ProcessEnv): V1PreflightCheck {
  const present = hasEnvValue(env, "BILLING_ACCOUNT_ID");
  return {
    id: "billing_account_env",
    status: present ? "ok" : "warning",
    label:
      "BILLING_ACCOUNT_ID is configured for the Cloud Run budget-alert follow-up.",
    evidence: present ? "present" : "missing",
    ...(present
      ? {}
      : {
          next_action:
            "Set BILLING_ACCOUNT_ID in the shell before running the generated Cloud Billing budget-alert command.",
        }),
  };
}

function liveTestOptInCheck(env: NodeJS.ProcessEnv): V1PreflightCheck {
  const enabled = env.RUN_LIVE_SUBSTACK_TESTS === "1";
  return {
    id: "live_test_opt_in",
    status: enabled ? "ok" : "warning",
    label:
      "RUN_LIVE_SUBSTACK_TESTS=1 is set for the guarded live test command.",
    evidence: enabled ? "enabled" : "not enabled",
    ...(enabled
      ? {}
      : {
          next_action:
            "Set RUN_LIVE_SUBSTACK_TESTS=1 on the command that runs live tests.",
        }),
  };
}

function liveEvidenceArtifactEnvCheck(
  cwd: string,
  env: NodeJS.ProcessEnv,
): V1PreflightCheck {
  const configured =
    hasEnvValue(env, "V1_LIVE_SUBSTACK_EVIDENCE_ARTIFACT") ||
    hasEnvValue(env, "V1_LIVE_SUBSTACK_EVIDENCE_ARTIFACTS");
  if (!configured) {
    return {
      id: "live_evidence_artifact_env",
      status: "ok",
      label:
        "Optional live evidence artifact env writes project-local Markdown artifacts.",
      evidence:
        "not set; live tests can run without writing evidence artifacts",
    };
  }

  const artifacts = parseLiveSubstackEvidenceArtifacts(env);
  if (artifacts.length === 0) {
    return {
      id: "live_evidence_artifact_env",
      status: "warning",
      label:
        "Optional live evidence artifact env writes project-local Markdown artifacts.",
      evidence: "configured; invalid: no artifact paths configured",
      next_action:
        "Set V1_LIVE_SUBSTACK_EVIDENCE_ARTIFACTS to one or more project-local Markdown paths, or leave it unset.",
    };
  }

  for (const artifact of artifacts) {
    try {
      resolveLiveSubstackEvidenceArtifact(cwd, artifact);
    } catch (error) {
      return {
        id: "live_evidence_artifact_env",
        status: "warning",
        label:
          "Optional live evidence artifact env writes project-local Markdown artifacts.",
        evidence: `configured: ${artifacts.length} artifact path(s); invalid: ${
          error instanceof Error
            ? error.message
            : "V1 live evidence artifact is invalid."
        }`,
        next_action:
          "Set V1_LIVE_SUBSTACK_EVIDENCE_ARTIFACTS to project-local Markdown paths such as .data/v1/gate-07-rich-draft-live-fixtures.md, .data/v1/gate-08-update-draft-live.md, and .data/v1/gate-09-read-drafts-live.md.",
      };
    }
  }

  return {
    id: "live_evidence_artifact_env",
    status: "ok",
    label:
      "Optional live evidence artifact env writes project-local Markdown artifacts.",
    evidence: `configured: ${artifacts.length} project-local artifact path(s)`,
  };
}

function substackFixtureDirEnvCheck(
  cwd: string,
  fixtureDir: string,
  env: NodeJS.ProcessEnv,
): V1PreflightCheck {
  if (!hasEnvValue(env, "SUBSTACK_FIXTURE_DIR")) {
    return {
      id: "substack_fixture_dir_env",
      status: "ok",
      label:
        "SUBSTACK_FIXTURE_DIR is safe when used by the live fixture compatibility test.",
      evidence: "not set; compatibility test uses fixtures/substack",
    };
  }

  let envFixtureDir: string;
  try {
    envFixtureDir = resolveProjectFixtureDir(
      cwd,
      env.SUBSTACK_FIXTURE_DIR ?? "",
      "SUBSTACK_FIXTURE_DIR",
    );
  } catch (error) {
    return {
      id: "substack_fixture_dir_env",
      status: "warning",
      label:
        "SUBSTACK_FIXTURE_DIR is safe when used by the live fixture compatibility test.",
      evidence: `present; invalid: ${error instanceof Error ? error.message : "SUBSTACK_FIXTURE_DIR is invalid."}`,
      next_action:
        "Set SUBSTACK_FIXTURE_DIR to a project-local fixture directory, or leave it unset and pass --fixture-dir to V1 helper commands instead.",
    };
  }

  if (resolve(envFixtureDir) !== resolve(fixtureDir)) {
    return {
      id: "substack_fixture_dir_env",
      status: "warning",
      label:
        "SUBSTACK_FIXTURE_DIR is safe when used by the live fixture compatibility test.",
      evidence:
        "present; valid project-local fixture directory, but it differs from the preflight fixture directory",
      next_action:
        "Use the same project-local fixture directory in SUBSTACK_FIXTURE_DIR and the --fixture-dir option for v1:preflight, v1:status, and v1:runbook.",
    };
  }

  return {
    id: "substack_fixture_dir_env",
    status: "ok",
    label:
      "SUBSTACK_FIXTURE_DIR is safe when used by the live fixture compatibility test.",
    evidence: "present; matches the preflight fixture directory",
  };
}

function externalToolCheck(
  id: string,
  label: string,
  command: string,
  injectedCommandExists: ((command: string) => boolean) | undefined,
  nextAction: string,
): V1PreflightCheck {
  const exists = injectedCommandExists
    ? injectedCommandExists(command)
    : commandExists(command);
  return {
    id,
    status: exists ? "ok" : "warning",
    label,
    evidence: exists
      ? `${command} found on PATH`
      : `${command} not found on PATH`,
    ...(exists ? {} : { next_action: nextAction }),
  };
}

function fixtureReadinessCheck(
  cwd: string,
  fixtureDir: string,
): V1PreflightCheck {
  const status = buildFixtureStatus({
    fixtureDir,
    cwd,
  });
  return {
    id: "fixture_readiness",
    status: status.ready ? "ok" : "missing",
    label:
      "Required live Substack draft-body fixtures are present, valid, and adapter-compatible.",
    evidence: `${status.present_count}/${status.required_count} present, ${status.valid_count}/${status.required_count} valid, ${status.compatible_count}/${status.required_count} adapter-compatible; directory: ${status.fixture_dir}`,
    ...(status.ready
      ? {}
      : {
          next_action: `Run \`${fixtureStatusCommand(
            status.capture_fixture_dir_arg,
            false,
          )}\` for per-fixture capture commands, capture missing or stale fixtures, then run \`${fixtureStatusCommand(
            status.capture_fixture_dir_arg,
            true,
          )}\` and \`${fixtureCompatibilityTestCommand(
            status.capture_fixture_dir_arg,
          )}\`.`,
        }),
  };
}

function requiredLiveChecks(
  checks: readonly V1PreflightCheck[],
  scope?: V1PreflightScope | undefined,
): readonly V1PreflightCheck[] {
  if (scope === "local") {
    return checks.filter((check) =>
      [
        "node_version",
        "node_engine",
        "local_mcp_scripts",
        "live_substack_env",
      ].includes(check.id),
    );
  }

  return checks.filter((check) =>
    [
      "node_version",
      "node_engine",
      "v1_scripts",
      "live_substack_env",
      "fixture_readiness",
    ].includes(check.id),
  );
}

function summarize(checks: readonly V1PreflightCheck[]): {
  readonly ok: number;
  readonly missing: number;
  readonly warning: number;
} {
  return {
    ok: checks.filter((check) => check.status === "ok").length,
    missing: checks.filter((check) => check.status === "missing").length,
    warning: checks.filter((check) => check.status === "warning").length,
  };
}

function readPackageScripts(cwd: string): Readonly<Record<string, unknown>> {
  const manifest = readPackageManifest(cwd);
  const scripts = manifest?.scripts;
  return typeof scripts === "object" &&
    scripts !== null &&
    !Array.isArray(scripts)
    ? (scripts as Readonly<Record<string, unknown>>)
    : {};
}

function readPackageManifest(cwd: string): PackageManifest | undefined {
  const packagePath = resolve(cwd, "package.json");
  if (!existsSync(packagePath)) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
    ) {
      return parsed as PackageManifest;
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function nodeEngineDeclaresNode20Floor(value: string): boolean {
  return /(?:^|\|\|\s*)>=\s*20(?:\.\d+){0,2}(?:$|[\s<>=|])/u.test(value);
}

function parseNodeVersion(
  value: string,
): readonly [number, number, number] | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(value.trim());
  if (!match) {
    return undefined;
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return [major, minor, patch];
}

function compareNodeVersion(
  left: readonly [number, number, number],
  right: readonly [number, number, number],
): number {
  const [leftMajor, leftMinor, leftPatch] = left;
  const [rightMajor, rightMinor, rightPatch] = right;
  for (const [leftPart, rightPart] of [
    [leftMajor, rightMajor],
    [leftMinor, rightMinor],
    [leftPatch, rightPatch],
  ] as const) {
    const diff = leftPart - rightPart;
    if (diff !== 0) {
      return diff;
    }
  }
  return 0;
}

function hasEnvValue(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name];
  return typeof value === "string" && value.trim().length > 0;
}

function optionalEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function oauthAlgorithms(env: NodeJS.ProcessEnv): readonly string[] {
  const raw = optionalEnv(env, "OAUTH_JWT_ALGORITHMS");
  if (!raw) {
    return ["RS256", "ES256"];
  }

  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function commandExists(command: string): boolean {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter(Boolean)
    .some((entry) => existsSync(join(entry, command)));
}

function parseFormat(value: string): V1PreflightFormat {
  if (value === "text" || value === "json") {
    return value;
  }

  throw new Error("--format must be one of: text, json.");
}

function resolveInsideCwd(cwd: string, value: string, flag: string): string {
  const root = resolve(cwd);
  const outputPath = resolve(root, value);
  const relativePath = relative(root, outputPath);
  if (
    relativePath === "" ||
    relativePath.startsWith("..") ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`${flag} must stay inside the project directory.`);
  }

  return outputPath;
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
