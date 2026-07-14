import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { normalizeOAuthJwtAlgorithms } from "../src/auth/oauth.js";
import type { AuthMode } from "../src/config.js";
import { parsePublicHttpsUrl } from "../src/safety/urlPolicy.js";
import {
  DEFAULT_BEARER_TOKEN_SECRET,
  DEFAULT_MCP_PATH_SECRET,
  DEFAULT_OAUTH_JWT_ALGORITHMS,
  DEFAULT_PREVIEW_TOKEN_SECRET,
  DEFAULT_SUBSTACK_SESSION_SECRET,
} from "./cloudRunPlanCore.js";

export type CloudRunVerifyFormat = "text" | "json";

export interface CloudRunVerifyRunOptions {
  readonly help: false;
  readonly serviceJson: string;
  readonly artifactRoot: string;
  readonly evidenceArtifact?: string | undefined;
  readonly authMode: AuthMode;
  readonly serviceAccountEmail?: string | undefined;
  readonly substackSessionSecret: string;
  readonly previewTokenSecret: string;
  readonly bearerTokenSecret: string;
  readonly mcpPathSecret?: string | undefined;
  readonly publicBaseUrl?: string | undefined;
  readonly oauthAuthorizationServerUrl?: string | undefined;
  readonly oauthJwksUrl?: string | undefined;
  readonly oauthResourceDocumentationUrl?: string | undefined;
  readonly publicationUrl?: string | undefined;
  readonly userId?: number | undefined;
  readonly maxBodyBytes?: number | undefined;
  readonly maxImageBytes?: number | undefined;
  readonly substackRequestTimeoutMs?: number | undefined;
  readonly confirmationTokenTtlSeconds?: number | undefined;
  readonly oauthJwtAlgorithms: readonly string[];
  readonly format: CloudRunVerifyFormat;
}

export interface CloudRunVerifyHelpOptions {
  readonly help: true;
}

export type CloudRunVerifyOptions =
  | CloudRunVerifyRunOptions
  | CloudRunVerifyHelpOptions;

export interface CloudRunVerifyReport {
  readonly ok: boolean;
  readonly service_url?: string | undefined;
  readonly auth_mode: AuthMode;
  readonly checks: readonly CloudRunVerifyCheck[];
}

export interface CloudRunVerifyCheck {
  readonly id: string;
  readonly ok: boolean;
  readonly evidence: string;
  readonly expected?: string | undefined;
  readonly actual?: string | undefined;
}

interface EnvEntry {
  readonly name: string;
  readonly value?: string | undefined;
  readonly secretName?: string | undefined;
  readonly secretVersion?: string | undefined;
}

interface ScaleValue {
  readonly value?: string | undefined;
  readonly source?: string | undefined;
}

export function parseCloudRunVerifyArgs(
  args: readonly string[],
  cwd = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): CloudRunVerifyOptions {
  let serviceJson: string | undefined;
  let authMode = parseAuthMode(env.AUTH_MODE, "AUTH_MODE", "static_bearer");
  let serviceAccountEmail: string | undefined;
  let substackSessionSecret =
    env.SUBSTACK_SESSION_SECRET_NAME ?? DEFAULT_SUBSTACK_SESSION_SECRET;
  let previewTokenSecret =
    env.PREVIEW_TOKEN_SECRET_NAME ?? DEFAULT_PREVIEW_TOKEN_SECRET;
  let bearerTokenSecret =
    env.MCP_BEARER_TOKEN_SECRET_NAME ?? DEFAULT_BEARER_TOKEN_SECRET;
  let mcpPathSecret = parseOptionalString(env.MCP_PATH_SECRET_NAME);
  let publicBaseUrl = parseOptionalString(env.MCP_PUBLIC_BASE_URL);
  let oauthAuthorizationServerUrl = parseOptionalString(
    env.OAUTH_AUTHORIZATION_SERVER_URL,
  );
  let oauthJwksUrl = parseOptionalString(env.OAUTH_JWKS_URL);
  let oauthResourceDocumentationUrl = parseOptionalString(
    env.OAUTH_RESOURCE_DOCUMENTATION_URL,
  );
  let publicationUrl: string | undefined;
  let userId: number | undefined;
  let maxBodyBytes: number | undefined;
  let maxImageBytes: number | undefined;
  let substackRequestTimeoutMs: number | undefined;
  let confirmationTokenTtlSeconds: number | undefined;
  let oauthJwtAlgorithms = parseOAuthJwtAlgorithms(
    env.OAUTH_JWT_ALGORITHMS,
    "OAUTH_JWT_ALGORITHMS",
  );
  let format: CloudRunVerifyFormat = "text";
  let evidenceArtifact: string | undefined;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--service-json":
        serviceJson = resolveInsideCwd(cwd, readValue(args, index, arg));
        index += 1;
        break;
      case "--auth-mode":
        authMode = parseAuthMode(readValue(args, index, arg), arg);
        index += 1;
        break;
      case "--service-account-email":
        serviceAccountEmail = requiredString(readValue(args, index, arg), arg);
        index += 1;
        break;
      case "--substack-session-secret":
        substackSessionSecret = requiredString(
          readValue(args, index, arg),
          arg,
        );
        index += 1;
        break;
      case "--preview-token-secret":
        previewTokenSecret = requiredString(readValue(args, index, arg), arg);
        index += 1;
        break;
      case "--bearer-token-secret":
        bearerTokenSecret = requiredString(readValue(args, index, arg), arg);
        index += 1;
        break;
      case "--mcp-path-secret":
        mcpPathSecret = requiredString(readValue(args, index, arg), arg);
        index += 1;
        break;
      case "--public-base-url":
        publicBaseUrl = requiredPublicHttpsOrigin(
          readValue(args, index, arg),
          arg,
        );
        index += 1;
        break;
      case "--oauth-authorization-server-url":
        oauthAuthorizationServerUrl = requiredHttpsUrl(
          readValue(args, index, arg),
          arg,
        );
        index += 1;
        break;
      case "--oauth-jwks-url":
        oauthJwksUrl = requiredHttpsUrl(readValue(args, index, arg), arg);
        index += 1;
        break;
      case "--oauth-resource-documentation-url":
        oauthResourceDocumentationUrl = requiredHttpsUrl(
          readValue(args, index, arg),
          arg,
        );
        index += 1;
        break;
      case "--publication-url":
        publicationUrl = requiredPublicHttpsOrigin(
          readValue(args, index, arg),
          arg,
        );
        index += 1;
        break;
      case "--user-id":
        userId = parsePositiveInteger(readValue(args, index, arg), arg);
        index += 1;
        break;
      case "--max-body-bytes":
        maxBodyBytes = parsePositiveInteger(readValue(args, index, arg), arg);
        index += 1;
        break;
      case "--max-image-bytes":
        maxImageBytes = parsePositiveInteger(readValue(args, index, arg), arg);
        index += 1;
        break;
      case "--substack-request-timeout-ms":
        substackRequestTimeoutMs = parsePositiveInteger(
          readValue(args, index, arg),
          arg,
        );
        index += 1;
        break;
      case "--confirmation-token-ttl-seconds":
        confirmationTokenTtlSeconds = parsePositiveInteger(
          readValue(args, index, arg),
          arg,
        );
        index += 1;
        break;
      case "--oauth-jwt-algorithms":
        oauthJwtAlgorithms = parseOAuthJwtAlgorithms(
          readValue(args, index, arg),
          arg,
        );
        index += 1;
        break;
      case "--format":
        format = parseFormat(readValue(args, index, arg));
        index += 1;
        break;
      case "--evidence-artifact":
        evidenceArtifact = resolveArtifactInsideCwd(
          cwd,
          readValue(args, index, arg),
        );
        index += 1;
        break;
      case "--json":
        format = "json";
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
  if (!serviceJson) {
    throw new Error("--service-json is required.");
  }
  if (authMode === "oauth") {
    publicBaseUrl = requiredPublicHttpsOrigin(
      publicBaseUrl,
      "--public-base-url",
    );
    oauthAuthorizationServerUrl = requiredHttpsUrl(
      oauthAuthorizationServerUrl,
      "--oauth-authorization-server-url",
    );
    oauthJwksUrl = requiredHttpsUrl(oauthJwksUrl, "--oauth-jwks-url");
  }
  if (oauthResourceDocumentationUrl) {
    oauthResourceDocumentationUrl = requiredHttpsUrl(
      oauthResourceDocumentationUrl,
      "--oauth-resource-documentation-url",
    );
  }

  return {
    help: false,
    serviceJson,
    artifactRoot: resolve(cwd),
    evidenceArtifact,
    authMode,
    ...(serviceAccountEmail ? { serviceAccountEmail } : {}),
    substackSessionSecret,
    previewTokenSecret,
    bearerTokenSecret,
    ...(mcpPathSecret ? { mcpPathSecret } : {}),
    ...(publicBaseUrl ? { publicBaseUrl } : {}),
    ...(oauthAuthorizationServerUrl ? { oauthAuthorizationServerUrl } : {}),
    ...(oauthJwksUrl ? { oauthJwksUrl } : {}),
    ...(oauthResourceDocumentationUrl ? { oauthResourceDocumentationUrl } : {}),
    ...(publicationUrl ? { publicationUrl } : {}),
    ...(userId !== undefined ? { userId } : {}),
    ...(maxBodyBytes !== undefined ? { maxBodyBytes } : {}),
    ...(maxImageBytes !== undefined ? { maxImageBytes } : {}),
    ...(substackRequestTimeoutMs !== undefined
      ? { substackRequestTimeoutMs }
      : {}),
    ...(confirmationTokenTtlSeconds !== undefined
      ? { confirmationTokenTtlSeconds }
      : {}),
    oauthJwtAlgorithms,
    format,
  };
}

export function cloudRunVerifyUsage(): string {
  return [
    "Usage: npm run cloud-run:verify -- --service-json <path> [options]",
    "",
    "Verifies a no-secret Cloud Run service description exported with:",
    '  gcloud run services describe "$SERVICE_NAME" --region "$REGION" --format=json > .data/cloud-run-service.json',
    "",
    "This command does not run gcloud, call Cloud Run, read Secret Manager values,",
    "or prove that the service is reachable. It checks the exported JSON for",
    "the expected service URL, min/max instances, service account, runtime env,",
    "and Secret Manager environment references.",
    "",
    "Options:",
    "  --service-json <path>             Required project-local JSON export.",
    "  --auth-mode <mode>                noauth, static_bearer, or oauth. Default: static_bearer.",
    "  --service-account-email <email>   Optional exact service account assertion.",
    `  --substack-session-secret <name>  Default: ${DEFAULT_SUBSTACK_SESSION_SECRET}.`,
    `  --preview-token-secret <name>     Default: ${DEFAULT_PREVIEW_TOKEN_SECRET}.`,
    `  --bearer-token-secret <name>      Default: ${DEFAULT_BEARER_TOKEN_SECRET}.`,
    `  --mcp-path-secret <name>          Optional Secret Manager secret for MCP_PATH_SECRET. Env: MCP_PATH_SECRET_NAME. Suggested: ${DEFAULT_MCP_PATH_SECRET}.`,
    "  --public-base-url <url>           Required exact MCP_PUBLIC_BASE_URL assertion for oauth.",
    "  --oauth-authorization-server-url <url> Required exact OAUTH_AUTHORIZATION_SERVER_URL assertion for oauth.",
    "  --oauth-jwks-url <url>            Required exact OAUTH_JWKS_URL assertion for oauth.",
    "  --oauth-resource-documentation-url <url> Optional exact OAUTH_RESOURCE_DOCUMENTATION_URL assertion for oauth.",
    "  --publication-url <url>           Optional exact SUBSTACK_PUBLICATION_URL assertion.",
    "  --user-id <id>                    Optional exact SUBSTACK_USER_ID assertion.",
    "  --max-body-bytes <n>              Optional exact MAX_BODY_BYTES assertion.",
    "  --max-image-bytes <n>             Optional exact MAX_IMAGE_BYTES assertion.",
    "  --substack-request-timeout-ms <n>  Optional exact SUBSTACK_REQUEST_TIMEOUT_MS assertion.",
    "  --confirmation-token-ttl-seconds <n> Optional exact CONFIRMATION_TOKEN_TTL_SECONDS assertion.",
    `  --oauth-jwt-algorithms <list>     Comma-separated asymmetric JWT algorithms for oauth. Default: ${DEFAULT_OAUTH_JWT_ALGORITHMS.join(",")}.`,
    "  --format <format>                 text or json. Default: text.",
    "  --evidence-artifact <path>        Write sanitized Markdown evidence for gates 12 and 13.",
    "  --json                            Shortcut for --format json.",
    "  --help                            Show this help.",
    "",
    "Examples:",
    "  npm run cloud-run:verify -- --service-json .data/cloud-run-service.json --auth-mode static_bearer --service-account-email substack-mcp-sa@my-project.iam.gserviceaccount.com",
    "  npm run cloud-run:verify -- --service-json .data/cloud-run-service.json --auth-mode oauth --public-base-url https://service-url --oauth-authorization-server-url https://auth.example.com --oauth-jwks-url https://auth.example.com/.well-known/jwks.json --json",
  ].join("\n");
}

export function readCloudRunServiceJson(filePath: string): unknown {
  if (!existsSync(filePath)) {
    throw new Error(`Cloud Run service JSON does not exist: ${filePath}`);
  }

  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid Cloud Run service JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

export function verifyCloudRunService(
  service: unknown,
  options: Pick<
    CloudRunVerifyRunOptions,
    | "authMode"
    | "serviceAccountEmail"
    | "substackSessionSecret"
    | "previewTokenSecret"
    | "bearerTokenSecret"
    | "mcpPathSecret"
    | "publicBaseUrl"
    | "oauthAuthorizationServerUrl"
    | "oauthJwksUrl"
    | "oauthResourceDocumentationUrl"
    | "publicationUrl"
    | "userId"
    | "maxBodyBytes"
    | "maxImageBytes"
    | "substackRequestTimeoutMs"
    | "confirmationTokenTtlSeconds"
  > & {
    readonly oauthJwtAlgorithms?: readonly string[] | undefined;
  },
): CloudRunVerifyReport {
  const serviceUrl = readServiceUrl(service);
  const envEntries = readEnvEntries(service);
  const minScale = readMinScale(service);
  const maxScale = readMaxScale(service);
  const serviceAccount = readServiceAccount(service);
  const checks: CloudRunVerifyCheck[] = [
    check(
      "service_url_https",
      serviceUrl?.startsWith("https://") === true,
      "Cloud Run service exposes an HTTPS service URL.",
      "HTTPS status URL",
      serviceUrl ?? "missing",
    ),
    check(
      "min_instances_zero",
      minScale.value === "0",
      "Cloud Run min instances are configured for request-based idle cost control.",
      "0",
      scaleEvidence(minScale),
    ),
    check(
      "max_instances_one",
      maxScale.value === "1",
      "Cloud Run max instances are capped for the private V1 deployment.",
      "1",
      scaleEvidence(maxScale),
    ),
    check(
      "service_account",
      options.serviceAccountEmail
        ? serviceAccount === options.serviceAccountEmail
        : serviceAccount !== undefined,
      options.serviceAccountEmail
        ? "Cloud Run service uses the expected service account."
        : "Cloud Run service has an explicit service account.",
      options.serviceAccountEmail ?? "configured service account",
      serviceAccount ?? "missing",
    ),
    checkEnvValue(envEntries, "NODE_ENV", "production"),
    checkEnvValue(envEntries, "MCP_TRANSPORT", "http"),
    checkEnvValue(envEntries, "AUTH_MODE", options.authMode),
    ...optionalEnvValueCheck(
      envEntries,
      "SUBSTACK_PUBLICATION_URL",
      options.publicationUrl,
    ),
    ...optionalEnvValueCheck(envEntries, "SUBSTACK_USER_ID", options.userId),
    ...optionalEnvValueCheck(
      envEntries,
      "MAX_BODY_BYTES",
      options.maxBodyBytes,
    ),
    ...optionalEnvValueCheck(
      envEntries,
      "MAX_IMAGE_BYTES",
      options.maxImageBytes,
    ),
    ...optionalEnvValueCheck(
      envEntries,
      "SUBSTACK_REQUEST_TIMEOUT_MS",
      options.substackRequestTimeoutMs,
    ),
    ...optionalEnvValueCheck(
      envEntries,
      "CONFIRMATION_TOKEN_TTL_SECONDS",
      options.confirmationTokenTtlSeconds,
    ),
    ...(options.authMode === "oauth"
      ? [
          checkEnvValue(
            envEntries,
            "MCP_PUBLIC_BASE_URL",
            requiredString(options.publicBaseUrl ?? "", "--public-base-url"),
          ),
          checkEnvValue(
            envEntries,
            "OAUTH_AUTHORIZATION_SERVER_URL",
            requiredString(
              options.oauthAuthorizationServerUrl ?? "",
              "--oauth-authorization-server-url",
            ),
          ),
          checkEnvValue(
            envEntries,
            "OAUTH_JWKS_URL",
            requiredString(options.oauthJwksUrl ?? "", "--oauth-jwks-url"),
          ),
          ...optionalEnvValueCheck(
            envEntries,
            "OAUTH_RESOURCE_DOCUMENTATION_URL",
            options.oauthResourceDocumentationUrl,
          ),
          checkEnvValue(
            envEntries,
            "OAUTH_JWT_ALGORITHMS",
            (options.oauthJwtAlgorithms ?? DEFAULT_OAUTH_JWT_ALGORITHMS).join(
              ",",
            ),
          ),
        ]
      : []),
    checkSecretRef(
      envEntries,
      "SUBSTACK_SESSION_TOKEN",
      options.substackSessionSecret,
    ),
    checkSecretRef(
      envEntries,
      "PREVIEW_TOKEN_SECRET",
      options.previewTokenSecret,
    ),
    ...(options.authMode === "static_bearer"
      ? [
          checkSecretRef(
            envEntries,
            "MCP_BEARER_TOKEN",
            options.bearerTokenSecret,
          ),
        ]
      : [
          check(
            "mcp_bearer_token_absent",
            findEnvEntry(envEntries, "MCP_BEARER_TOKEN") === undefined,
            "MCP_BEARER_TOKEN is not configured when auth mode does not need static bearer auth.",
            "absent",
            findEnvEntry(envEntries, "MCP_BEARER_TOKEN")
              ? "configured"
              : "absent",
          ),
        ]),
    ...(options.mcpPathSecret
      ? [checkSecretRef(envEntries, "MCP_PATH_SECRET", options.mcpPathSecret)]
      : [
          checkEnvAbsent(
            envEntries,
            "MCP_PATH_SECRET",
            "MCP_PATH_SECRET is absent unless a private MCP path segment is explicitly expected.",
          ),
        ]),
  ];

  return {
    ok: checks.every((entry) => entry.ok),
    ...(serviceUrl ? { service_url: serviceUrl } : {}),
    auth_mode: options.authMode,
    checks,
  };
}

export function renderCloudRunVerifyReport(
  report: CloudRunVerifyReport,
  format: CloudRunVerifyFormat,
): string {
  if (format === "json") {
    return `${JSON.stringify(report, null, 2)}\n`;
  }

  const lines = [
    "# Cloud Run service verification",
    "",
    "This report verifies an exported service JSON file. It does not run gcloud, call Cloud Run, read Secret Manager values, or prove live reachability.",
    "",
    `Complete: ${report.ok ? "yes" : "no"}`,
    `Auth mode: ${report.auth_mode}`,
    ...(report.service_url ? [`Service URL: ${report.service_url}`] : []),
    "",
    "## Checks",
    ...report.checks.flatMap((entry) => [
      `- ${entry.ok ? "ok" : "fail"}: ${entry.id}`,
      `  Evidence: ${entry.evidence}`,
      ...(entry.expected ? [`  Expected: ${entry.expected}`] : []),
      ...(entry.actual ? [`  Actual: ${entry.actual}`] : []),
    ]),
  ];

  return `${lines.join("\n")}\n`;
}

function optionalEnvValueCheck(
  entries: readonly EnvEntry[],
  name: string,
  expected: string | number | undefined,
): CloudRunVerifyCheck[] {
  return expected === undefined
    ? []
    : [checkEnvValue(entries, name, String(expected))];
}

function checkEnvValue(
  entries: readonly EnvEntry[],
  name: string,
  expected: string,
): CloudRunVerifyCheck {
  const entry = findEnvEntry(entries, name);
  return check(
    `env_${name.toLowerCase()}`,
    entry?.value === expected,
    `Cloud Run runtime env ${name} has the expected value.`,
    `${name}=${expected}`,
    entry?.value === undefined
      ? entry?.secretName
        ? `${name}=<secret-ref>`
        : "missing"
      : `${name}=${entry.value}`,
  );
}

function checkSecretRef(
  entries: readonly EnvEntry[],
  name: string,
  expectedSecret: string,
): CloudRunVerifyCheck {
  const entry = findEnvEntry(entries, name);
  const secretMatches =
    entry?.secretName !== undefined &&
    secretNameMatches(entry.secretName, expectedSecret);
  return check(
    `secret_${name.toLowerCase()}`,
    secretMatches && entry?.value === undefined,
    `Cloud Run env ${name} is backed by the expected Secret Manager secret reference.`,
    `${name}=${expectedSecret}:latest`,
    secretRefEvidence(entry),
  );
}

function checkEnvAbsent(
  entries: readonly EnvEntry[],
  name: string,
  evidence: string,
): CloudRunVerifyCheck {
  const entry = findEnvEntry(entries, name);
  return check(
    `${name.toLowerCase()}_absent`,
    entry === undefined,
    evidence,
    "absent",
    entry ? secretRefEvidence(entry) : "absent",
  );
}

function check(
  id: string,
  ok: boolean,
  evidence: string,
  expected?: string,
  actual?: string,
): CloudRunVerifyCheck {
  return {
    id,
    ok,
    evidence,
    ...(expected ? { expected } : {}),
    ...(actual ? { actual } : {}),
  };
}

function readServiceUrl(service: unknown): string | undefined {
  return (
    readStringPath(service, ["status", "url"]) ??
    readStringPath(service, ["uri"]) ??
    readStringPath(service, ["status", "address", "url"])
  );
}

function readServiceAccount(service: unknown): string | undefined {
  return (
    readStringPath(service, ["template", "serviceAccount"]) ??
    readStringPath(service, ["template", "serviceAccountName"]) ??
    readStringPath(service, ["spec", "template", "spec", "serviceAccountName"])
  );
}

function readMinScale(service: unknown): ScaleValue {
  return readScale(service, "minInstanceCount", [
    "autoscaling.knative.dev/minScale",
    "run.googleapis.com/minScale",
  ]);
}

function readMaxScale(service: unknown): ScaleValue {
  return readScale(service, "maxInstanceCount", [
    "autoscaling.knative.dev/maxScale",
    "run.googleapis.com/maxScale",
  ]);
}

function readScale(
  service: unknown,
  v2Field: "minInstanceCount" | "maxInstanceCount",
  annotationKeys: readonly string[],
): ScaleValue {
  const v2Value = readStringOrNumberPath(service, [
    "template",
    "scaling",
    v2Field,
  ]);
  if (v2Value !== undefined) {
    return { value: v2Value, source: `template.scaling.${v2Field}` };
  }

  for (const key of annotationKeys) {
    const paths = [
      ["spec", "template", "metadata", "annotations", key],
      ["metadata", "annotations", key],
    ];
    for (const path of paths) {
      const value = readStringOrNumberPath(service, path);
      if (value !== undefined) {
        return { value, source: path.join(".") };
      }
    }
  }

  return {};
}

function scaleEvidence(scale: ScaleValue): string {
  return scale.value === undefined
    ? "missing"
    : `${scale.value}${scale.source ? ` from ${scale.source}` : ""}`;
}

function readEnvEntries(service: unknown): EnvEntry[] {
  return readContainers(service).flatMap((container) => {
    const env = asArray(container.env);
    return env.flatMap((value) => {
      const record = asRecord(value);
      if (!record) {
        return [];
      }

      const name = readString(record.name);
      if (!name) {
        return [];
      }

      const secretRef =
        asRecord(asRecord(record.valueSource)?.secretKeyRef) ??
        asRecord(asRecord(record.valueFrom)?.secretKeyRef);
      const secretName =
        readString(secretRef?.secret) ?? readString(secretRef?.name);
      const secretVersion =
        readString(secretRef?.version) ?? readString(secretRef?.key);
      const literalValue = readString(record.value);

      return [
        {
          name,
          ...(literalValue !== undefined ? { value: literalValue } : {}),
          ...(secretName ? { secretName } : {}),
          ...(secretVersion ? { secretVersion } : {}),
        },
      ];
    });
  });
}

function readContainers(service: unknown): Record<string, unknown>[] {
  return [
    ...asArray(readPath(service, ["template", "containers"])),
    ...asArray(readPath(service, ["spec", "template", "spec", "containers"])),
  ].flatMap((value) => {
    const record = asRecord(value);
    return record ? [record] : [];
  });
}

function findEnvEntry(
  entries: readonly EnvEntry[],
  name: string,
): EnvEntry | undefined {
  return entries.find((entry) => entry.name === name);
}

function secretRefEvidence(entry: EnvEntry | undefined): string {
  if (!entry) {
    return "missing";
  }
  if (entry.value !== undefined) {
    return `${entry.name}=<literal-value>`;
  }
  if (!entry.secretName) {
    return `${entry.name}=<no-secret-ref>`;
  }

  return `${entry.name}=${displaySecretName(entry.secretName)}:${
    entry.secretVersion ?? "unknown"
  }`;
}

function secretNameMatches(actual: string, expected: string): boolean {
  return actual === expected || actual.endsWith(`/secrets/${expected}`);
}

function displaySecretName(value: string): string {
  const match = /\/secrets\/([^/]+)$/.exec(value);
  return match?.[1] ?? value;
}

function readStringPath(
  value: unknown,
  path: readonly string[],
): string | undefined {
  return readString(readPath(value, path));
}

function readStringOrNumberPath(
  value: unknown,
  path: readonly string[],
): string | undefined {
  const found = readPath(value, path);
  if (typeof found === "string") {
    return found;
  }
  if (typeof found === "number") {
    return String(found);
  }
  return undefined;
}

function readPath(value: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>((current, key) => {
    const record = asRecord(current);
    return record?.[key];
  }, value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function parseAuthMode(
  value: string | undefined,
  name: string,
  fallback?: AuthMode,
): AuthMode {
  const candidate = value === undefined || value === "" ? fallback : value;

  if (
    candidate === "noauth" ||
    candidate === "static_bearer" ||
    candidate === "oauth"
  ) {
    return candidate;
  }

  throw new Error(`${name} must be one of: noauth, static_bearer, oauth.`);
}

function parseFormat(value: string): CloudRunVerifyFormat {
  if (value === "text" || value === "json") {
    return value;
  }

  throw new Error("--format must be one of: text, json.");
}

function parseOAuthJwtAlgorithms(
  value: string | undefined,
  name: string,
): readonly string[] {
  const raw = value?.trim();
  if (!raw) {
    return DEFAULT_OAUTH_JWT_ALGORITHMS;
  }

  try {
    return normalizeOAuthJwtAlgorithms(raw.split(","));
  } catch (error) {
    if (error instanceof Error) {
      throw error;
    }
    throw new Error(`${name} is invalid.`);
  }
}

function parseOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parsePositiveInteger(value: string | undefined, name: string): number {
  const raw = value?.trim();
  if (!raw) {
    throw new Error(`${name} is required.`);
  }

  const parsed = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

function requiredPublicHttpsOrigin(
  value: string | undefined,
  name: string,
): string {
  const raw = requiredString(value ?? "", name);
  const parsed = parsePublicHttpsUrl(raw, name);
  if (!parsed.ok) {
    throw new Error(parsed.errors.join(" "));
  }

  return parsed.url.origin;
}

function requiredHttpsUrl(value: string | undefined, name: string): string {
  const raw = requiredString(value ?? "", name);
  const url = new URL(raw);
  if (url.protocol !== "https:") {
    throw new Error(`${name} must be an https URL.`);
  }
  if (url.username || url.password) {
    throw new Error(`${name} must not include username or password.`);
  }

  return url.toString().replace(/\/+$/, "");
}

function requiredString(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${name} is required.`);
  }

  return trimmed;
}

function resolveInsideCwd(cwd: string, value: string): string {
  const root = resolve(cwd);
  const outputPath = resolve(root, value);
  const relativePath = relative(root, outputPath);
  if (
    relativePath === "" ||
    relativePath.startsWith("..") ||
    isAbsolute(relativePath)
  ) {
    throw new Error("--service-json must stay inside the project directory.");
  }

  return outputPath;
}

function resolveArtifactInsideCwd(cwd: string, value: string): string {
  const root = resolve(cwd);
  const artifactPath = resolve(root, value);
  const relativePath = relative(root, artifactPath);
  if (
    relativePath === "" ||
    relativePath.startsWith("..") ||
    isAbsolute(relativePath)
  ) {
    throw new Error(
      "--evidence-artifact must stay inside the project directory.",
    );
  }

  return relativePath;
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
