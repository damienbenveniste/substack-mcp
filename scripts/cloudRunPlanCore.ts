import { normalizeOAuthJwtAlgorithms } from "../src/auth/oauth.js";
import {
  type AuthMode,
  DEFAULT_SUBSTACK_REQUEST_TIMEOUT_MS,
} from "../src/config.js";
import { parsePublicHttpsUrl } from "../src/safety/urlPolicy.js";

export const DEFAULT_CLOUD_RUN_REGION = "us-central1";
export const DEFAULT_CLOUD_RUN_SERVICE_NAME = "substack-draft-mcp";
export const DEFAULT_CLOUD_RUN_SERVICE_ACCOUNT = "substack-mcp-sa";
export const DEFAULT_SUBSTACK_SESSION_SECRET = "substack-session-token";
export const DEFAULT_PREVIEW_TOKEN_SECRET = "mcp-preview-token-secret";
export const DEFAULT_BEARER_TOKEN_SECRET = "mcp-bearer-token";
export const DEFAULT_MCP_PATH_SECRET = "mcp-path-secret";
export const DEFAULT_OAUTH_JWT_ALGORITHMS = ["RS256", "ES256"] as const;

const REQUIRED_APIS = [
  "run.googleapis.com",
  "cloudbuild.googleapis.com",
  "artifactregistry.googleapis.com",
  "secretmanager.googleapis.com",
] as const;

const CLOUD_RUN_SERVICE_JSON_PATH = ".data/cloud-run-service.json";
const CLOUD_RUN_DEPLOYMENT_ARTIFACT =
  ".data/v1/gate-12-cloud-run-deployment.md";
const CLOUD_RUN_SECRETS_ARTIFACT = ".data/v1/gate-13-cloud-run-secrets.md";
const CLOUD_RUN_LOGS_JSON_PATH = ".data/cloud-run-logs.json";
const CLOUD_RUN_LOGS_ARTIFACT = ".data/v1/gate-16-cloud-run-logs.md";
const STATIC_BEARER_REMOTE_ARTIFACT =
  ".data/v1/gate-14-static-bearer-remote.md";
const REMOTE_OAUTH_ARTIFACT = ".data/v1/remote-oauth.md";

export interface CloudRunPlanOptions {
  readonly help: false;
  readonly projectId: string;
  readonly region: string;
  readonly serviceName: string;
  readonly serviceAccount: string;
  readonly publicationUrl: string;
  readonly userId: number;
  readonly authMode: AuthMode;
  readonly publicBaseUrl?: string | undefined;
  readonly oauthAuthorizationServerUrl?: string | undefined;
  readonly oauthJwksUrl?: string | undefined;
  readonly oauthResourceDocumentationUrl?: string | undefined;
  readonly oauthJwtAlgorithms: readonly string[];
  readonly substackSessionSecret: string;
  readonly previewTokenSecret: string;
  readonly bearerTokenSecret: string;
  readonly mcpPathSecret?: string | undefined;
  readonly maxBodyBytes: number;
  readonly maxImageBytes: number;
  readonly substackRequestTimeoutMs: number;
  readonly confirmationTokenTtlSeconds: number;
}

export interface CloudRunPlanHelpOptions {
  readonly help: true;
}

export type CloudRunPlanCliOptions =
  | CloudRunPlanOptions
  | CloudRunPlanHelpOptions;

export interface CloudRunPlan {
  readonly project_id: string;
  readonly region: string;
  readonly service_name: string;
  readonly service_account_email: string;
  readonly auth_mode: AuthMode;
  readonly required_apis: readonly string[];
  readonly secret_names: readonly string[];
  readonly commands: readonly CloudRunPlanCommand[];
  readonly follow_up_commands: readonly CloudRunPlanCommand[];
  readonly notes: readonly string[];
}

export interface CloudRunPlanCommand {
  readonly label: string;
  readonly command: string;
}

interface MutableCloudRunPlanOptions {
  projectId?: string | undefined;
  region: string;
  serviceName: string;
  serviceAccount: string;
  publicationUrl?: string | undefined;
  userId?: number | undefined;
  authMode: AuthMode;
  publicBaseUrl?: string | undefined;
  oauthAuthorizationServerUrl?: string | undefined;
  oauthJwksUrl?: string | undefined;
  oauthResourceDocumentationUrl?: string | undefined;
  oauthJwtAlgorithms: readonly string[];
  substackSessionSecret: string;
  previewTokenSecret: string;
  bearerTokenSecret: string;
  mcpPathSecret?: string | undefined;
  maxBodyBytes: number;
  maxImageBytes: number;
  substackRequestTimeoutMs: number;
  confirmationTokenTtlSeconds: number;
}

export function parseCloudRunPlanArgs(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): CloudRunPlanCliOptions {
  const options: MutableCloudRunPlanOptions = {
    projectId: env.GOOGLE_CLOUD_PROJECT ?? env.GCLOUD_PROJECT,
    region: env.CLOUD_RUN_REGION ?? DEFAULT_CLOUD_RUN_REGION,
    serviceName: env.CLOUD_RUN_SERVICE_NAME ?? DEFAULT_CLOUD_RUN_SERVICE_NAME,
    serviceAccount:
      env.CLOUD_RUN_SERVICE_ACCOUNT ?? DEFAULT_CLOUD_RUN_SERVICE_ACCOUNT,
    publicationUrl: env.SUBSTACK_PUBLICATION_URL,
    userId: parseOptionalPositiveInteger(
      env.SUBSTACK_USER_ID,
      "SUBSTACK_USER_ID",
    ),
    authMode: parseAuthMode(env.AUTH_MODE, "AUTH_MODE", "static_bearer"),
    publicBaseUrl: env.MCP_PUBLIC_BASE_URL,
    oauthAuthorizationServerUrl: env.OAUTH_AUTHORIZATION_SERVER_URL,
    oauthJwksUrl: env.OAUTH_JWKS_URL,
    oauthResourceDocumentationUrl: env.OAUTH_RESOURCE_DOCUMENTATION_URL,
    oauthJwtAlgorithms: parseOAuthJwtAlgorithms(
      env.OAUTH_JWT_ALGORITHMS,
      "OAUTH_JWT_ALGORITHMS",
    ),
    substackSessionSecret:
      env.SUBSTACK_SESSION_SECRET_NAME ?? DEFAULT_SUBSTACK_SESSION_SECRET,
    previewTokenSecret:
      env.PREVIEW_TOKEN_SECRET_NAME ?? DEFAULT_PREVIEW_TOKEN_SECRET,
    bearerTokenSecret:
      env.MCP_BEARER_TOKEN_SECRET_NAME ?? DEFAULT_BEARER_TOKEN_SECRET,
    mcpPathSecret: parseOptionalString(env.MCP_PATH_SECRET_NAME),
    maxBodyBytes: parsePositiveInteger(
      env.MAX_BODY_BYTES,
      "MAX_BODY_BYTES",
      750_000,
    ),
    maxImageBytes: parsePositiveInteger(
      env.MAX_IMAGE_BYTES,
      "MAX_IMAGE_BYTES",
      8_000_000,
    ),
    substackRequestTimeoutMs: parsePositiveInteger(
      env.SUBSTACK_REQUEST_TIMEOUT_MS,
      "SUBSTACK_REQUEST_TIMEOUT_MS",
      DEFAULT_SUBSTACK_REQUEST_TIMEOUT_MS,
    ),
    confirmationTokenTtlSeconds: parsePositiveInteger(
      env.CONFIRMATION_TOKEN_TTL_SECONDS,
      "CONFIRMATION_TOKEN_TTL_SECONDS",
      900,
    ),
  };
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--project-id":
        options.projectId = readValue(args, index, arg);
        index += 1;
        break;
      case "--region":
        options.region = readValue(args, index, arg);
        index += 1;
        break;
      case "--service-name":
        options.serviceName = readValue(args, index, arg);
        index += 1;
        break;
      case "--service-account":
        options.serviceAccount = readValue(args, index, arg);
        index += 1;
        break;
      case "--publication-url":
        options.publicationUrl = readValue(args, index, arg);
        index += 1;
        break;
      case "--user-id":
        options.userId = parsePositiveInteger(
          readValue(args, index, arg),
          "--user-id",
        );
        index += 1;
        break;
      case "--auth-mode":
        options.authMode = parseAuthMode(readValue(args, index, arg), arg);
        index += 1;
        break;
      case "--public-base-url":
        options.publicBaseUrl = readValue(args, index, arg);
        index += 1;
        break;
      case "--oauth-authorization-server-url":
        options.oauthAuthorizationServerUrl = readValue(args, index, arg);
        index += 1;
        break;
      case "--oauth-jwks-url":
        options.oauthJwksUrl = readValue(args, index, arg);
        index += 1;
        break;
      case "--oauth-resource-documentation-url":
        options.oauthResourceDocumentationUrl = readValue(args, index, arg);
        index += 1;
        break;
      case "--oauth-jwt-algorithms":
        options.oauthJwtAlgorithms = parseOAuthJwtAlgorithms(
          readValue(args, index, arg),
          arg,
        );
        index += 1;
        break;
      case "--substack-session-secret":
        options.substackSessionSecret = readValue(args, index, arg);
        index += 1;
        break;
      case "--preview-token-secret":
        options.previewTokenSecret = readValue(args, index, arg);
        index += 1;
        break;
      case "--bearer-token-secret":
        options.bearerTokenSecret = readValue(args, index, arg);
        index += 1;
        break;
      case "--mcp-path-secret":
        options.mcpPathSecret = readValue(args, index, arg);
        index += 1;
        break;
      case "--max-body-bytes":
        options.maxBodyBytes = parsePositiveInteger(
          readValue(args, index, arg),
          arg,
        );
        index += 1;
        break;
      case "--max-image-bytes":
        options.maxImageBytes = parsePositiveInteger(
          readValue(args, index, arg),
          arg,
        );
        index += 1;
        break;
      case "--substack-request-timeout-ms":
        options.substackRequestTimeoutMs = parsePositiveInteger(
          readValue(args, index, arg),
          arg,
        );
        index += 1;
        break;
      case "--confirmation-token-ttl-seconds":
        options.confirmationTokenTtlSeconds = parsePositiveInteger(
          readValue(args, index, arg),
          arg,
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
    return { help: true };
  }

  return finalizeOptions(options);
}

export function cloudRunPlanUsage(): string {
  return [
    "Usage: npm run cloud-run:plan -- --project-id <id> --publication-url <url> --user-id <id> [options]",
    "",
    "Prints a no-secret Cloud Run deployment command plan for this MCP server.",
    "It does not run gcloud, create resources, deploy, or read secret values.",
    "",
    "Required:",
    "  --project-id <id>                   GCP project id. Env: GOOGLE_CLOUD_PROJECT.",
    "  --publication-url <url>             Substack publication origin; copied paths normalize to the origin.",
    "  --user-id <id>                      Numeric Substack user id.",
    "",
    "Options:",
    `  --region <region>                  Default: ${DEFAULT_CLOUD_RUN_REGION}.`,
    `  --service-name <name>              Default: ${DEFAULT_CLOUD_RUN_SERVICE_NAME}.`,
    `  --service-account <name>           Default: ${DEFAULT_CLOUD_RUN_SERVICE_ACCOUNT}.`,
    "  --auth-mode <mode>                  noauth, static_bearer, or oauth. Default: static_bearer.",
    "  --public-base-url <url>             Required for oauth; public HTTPS Cloud Run/custom origin.",
    "  --oauth-authorization-server-url <url> Required for oauth.",
    "  --oauth-jwks-url <url>              Required for oauth.",
    "  --oauth-resource-documentation-url <url> Optional for oauth.",
    `  --oauth-jwt-algorithms <list>      Comma-separated asymmetric JWT algorithms. Default: ${DEFAULT_OAUTH_JWT_ALGORITHMS.join(",")}.`,
    `  --substack-session-secret <name>    Default: ${DEFAULT_SUBSTACK_SESSION_SECRET}.`,
    `  --preview-token-secret <name>       Default: ${DEFAULT_PREVIEW_TOKEN_SECRET}.`,
    `  --bearer-token-secret <name>        Default: ${DEFAULT_BEARER_TOKEN_SECRET}.`,
    `  --mcp-path-secret <name>            Optional Secret Manager secret for MCP_PATH_SECRET. Env: MCP_PATH_SECRET_NAME. Suggested: ${DEFAULT_MCP_PATH_SECRET}.`,
    "  --max-body-bytes <n>                Default: 750000.",
    "  --max-image-bytes <n>               Default: 8000000.",
    "  --substack-request-timeout-ms <n>    Default: 30000.",
    "  --confirmation-token-ttl-seconds <n> Default: 900.",
    "  --help                             Show this help.",
    "",
    "Examples:",
    "  npm run cloud-run:plan -- --project-id my-project --publication-url https://example.substack.com --user-id 123456",
    "  npm run cloud-run:plan -- --project-id my-project --publication-url https://example.substack.com --user-id 123456 --auth-mode oauth --public-base-url https://service-url --oauth-authorization-server-url https://auth.example.com --oauth-jwks-url https://auth.example.com/.well-known/jwks.json",
  ].join("\n");
}

export function buildCloudRunPlan(options: CloudRunPlanOptions): CloudRunPlan {
  const serviceAccountEmail = `${options.serviceAccount}@${options.projectId}.iam.gserviceaccount.com`;
  const secretNames = cloudRunSecretNames(options);
  const envVars = buildRuntimeEnvVars(options);
  const secretRefs = buildSecretRefs(options);
  const serviceUrlCommand = `gcloud run services describe ${shellArg(options.serviceName)} --region ${shellArg(options.region)} --format=${shellArg("value(status.url)")}`;
  const serviceUrlVariable = `SERVICE_URL=$(${serviceUrlCommand})`;
  const serviceJsonExportCommand = [
    "mkdir -p .data && gcloud run services describe",
    shellArg(options.serviceName),
    "--region",
    shellArg(options.region),
    "--format=json",
    ">",
    CLOUD_RUN_SERVICE_JSON_PATH,
  ].join(" ");
  const commands: CloudRunPlanCommand[] = [
    {
      label: "Set active gcloud project",
      command: `gcloud config set project ${shellArg(options.projectId)}`,
    },
    {
      label: "Enable required Google Cloud APIs",
      command: `gcloud services enable ${REQUIRED_APIS.map(shellArg).join(" ")}`,
    },
    {
      label: "Create Cloud Run service account",
      command: [
        "gcloud iam service-accounts create",
        shellArg(options.serviceAccount),
        "--display-name",
        shellArg("Substack Draft MCP Cloud Run service account"),
      ].join(" "),
    },
    ...secretCreateCommands(options),
    ...secretIamCommands(secretNames, serviceAccountEmail),
    {
      label: "Deploy Cloud Run service from source",
      command: [
        "gcloud run deploy",
        shellArg(options.serviceName),
        "--source .",
        "--region",
        shellArg(options.region),
        "--service-account",
        shellArg(serviceAccountEmail),
        "--allow-unauthenticated",
        "--min-instances=0",
        "--max-instances=1",
        "--memory=512Mi",
        "--cpu=1",
        "--timeout=60",
        "--set-env-vars",
        shellArg(envVars),
        "--set-secrets",
        shellArg(secretRefs),
      ].join(" "),
    },
    {
      label: "Read deployed service URL",
      command: serviceUrlCommand,
    },
  ];

  return {
    project_id: options.projectId,
    region: options.region,
    service_name: options.serviceName,
    service_account_email: serviceAccountEmail,
    auth_mode: options.authMode,
    required_apis: REQUIRED_APIS,
    secret_names: secretNames,
    commands,
    follow_up_commands: [
      {
        label: "Export service URL",
        command: serviceUrlVariable,
      },
      {
        label: "Export service JSON",
        command: serviceJsonExportCommand,
      },
      {
        label:
          "Verify exported service configuration and write gate 12 evidence",
        command: cloudRunVerifyCommand(
          options,
          CLOUD_RUN_SERVICE_JSON_PATH,
          CLOUD_RUN_DEPLOYMENT_ARTIFACT,
        ),
      },
      {
        label: "Write gate 13 Secret Manager evidence",
        command: cloudRunVerifyCommand(
          options,
          CLOUD_RUN_SERVICE_JSON_PATH,
          CLOUD_RUN_SECRETS_ARTIFACT,
        ),
      },
      {
        label: "Check deployed health endpoint",
        command: 'curl --fail --show-error "$SERVICE_URL/healthz"',
      },
      {
        label: "Create monthly budget alert",
        command: budgetAlertCommand(options),
      },
      {
        label: "Run remote read-only smoke",
        command: remoteSmokeCommand(options),
      },
      {
        label: "Export Cloud Run logs after live acceptance traffic",
        command: cloudRunLogsExportCommand(options),
      },
      {
        label: "Verify exported Cloud Run logs and write gate 16 evidence",
        command: cloudRunLogsVerifyCommand(
          CLOUD_RUN_LOGS_JSON_PATH,
          CLOUD_RUN_LOGS_ARTIFACT,
        ),
      },
    ],
    notes: notesFor(options),
  };
}

export function renderCloudRunPlan(plan: CloudRunPlan): string {
  const lines = [
    "# Cloud Run deployment plan",
    "",
    `Project: ${plan.project_id}`,
    `Region: ${plan.region}`,
    `Service: ${plan.service_name}`,
    `Service account: ${plan.service_account_email}`,
    `Auth mode: ${plan.auth_mode}`,
    "",
    "## Commands",
    ...plan.commands.flatMap((entry, index) => [
      "",
      `# ${index + 1}. ${entry.label}`,
      entry.command,
    ]),
    "",
    "## Follow-up verification",
    ...plan.follow_up_commands.flatMap((entry, index) => [
      "",
      `# ${index + 1}. ${entry.label}`,
      entry.command,
    ]),
    "",
    "## Notes",
    ...plan.notes.map((note) => `- ${note}`),
  ];

  return `${lines.join("\n")}\n`;
}

function finalizeOptions(
  options: MutableCloudRunPlanOptions,
): CloudRunPlanOptions {
  const projectId = requiredString(options.projectId, "--project-id");
  const publicationUrl = requiredPublicHttpsUrl(
    options.publicationUrl,
    "--publication-url",
  );
  const userId = requiredPositiveInteger(options.userId, "--user-id");
  const publicBaseUrl =
    options.publicBaseUrl === undefined
      ? undefined
      : requiredHttpsUrl(options.publicBaseUrl, "--public-base-url");
  const oauthAuthorizationServerUrl =
    options.oauthAuthorizationServerUrl === undefined
      ? undefined
      : requiredHttpsUrl(
          options.oauthAuthorizationServerUrl,
          "--oauth-authorization-server-url",
        );
  const oauthJwksUrl =
    options.oauthJwksUrl === undefined
      ? undefined
      : requiredHttpsUrl(options.oauthJwksUrl, "--oauth-jwks-url");
  const oauthResourceDocumentationUrl =
    options.oauthResourceDocumentationUrl === undefined
      ? undefined
      : requiredHttpsUrl(
          options.oauthResourceDocumentationUrl,
          "--oauth-resource-documentation-url",
        );
  const oauthJwtAlgorithms = normalizeOAuthJwtAlgorithms(
    options.oauthJwtAlgorithms,
  );

  if (options.authMode === "oauth") {
    requiredString(publicBaseUrl, "--public-base-url");
    requiredString(
      oauthAuthorizationServerUrl,
      "--oauth-authorization-server-url",
    );
    requiredString(oauthJwksUrl, "--oauth-jwks-url");
  }

  return {
    help: false,
    projectId,
    region: requiredString(options.region, "--region"),
    serviceName: requiredString(options.serviceName, "--service-name"),
    serviceAccount: requiredString(options.serviceAccount, "--service-account"),
    publicationUrl,
    userId,
    authMode: options.authMode,
    publicBaseUrl,
    oauthAuthorizationServerUrl,
    oauthJwksUrl,
    oauthResourceDocumentationUrl,
    oauthJwtAlgorithms,
    substackSessionSecret: requiredString(
      options.substackSessionSecret,
      "--substack-session-secret",
    ),
    previewTokenSecret: requiredString(
      options.previewTokenSecret,
      "--preview-token-secret",
    ),
    bearerTokenSecret: requiredString(
      options.bearerTokenSecret,
      "--bearer-token-secret",
    ),
    ...(options.mcpPathSecret !== undefined
      ? {
          mcpPathSecret: requiredString(
            options.mcpPathSecret,
            "--mcp-path-secret",
          ),
        }
      : {}),
    maxBodyBytes: options.maxBodyBytes,
    maxImageBytes: options.maxImageBytes,
    substackRequestTimeoutMs: options.substackRequestTimeoutMs,
    confirmationTokenTtlSeconds: options.confirmationTokenTtlSeconds,
  };
}

function buildRuntimeEnvVars(options: CloudRunPlanOptions): string {
  return Object.entries({
    NODE_ENV: "production",
    PORT: "8080",
    LOG_LEVEL: "info",
    MCP_TRANSPORT: "http",
    SUBSTACK_PUBLICATION_URL: options.publicationUrl,
    SUBSTACK_USER_ID: String(options.userId),
    AUTH_MODE: options.authMode,
    MAX_BODY_BYTES: String(options.maxBodyBytes),
    MAX_IMAGE_BYTES: String(options.maxImageBytes),
    SUBSTACK_REQUEST_TIMEOUT_MS: String(options.substackRequestTimeoutMs),
    CONFIRMATION_TOKEN_TTL_SECONDS: String(options.confirmationTokenTtlSeconds),
    ...(options.publicBaseUrl
      ? { MCP_PUBLIC_BASE_URL: options.publicBaseUrl }
      : {}),
    ...(options.oauthAuthorizationServerUrl
      ? { OAUTH_AUTHORIZATION_SERVER_URL: options.oauthAuthorizationServerUrl }
      : {}),
    ...(options.oauthJwksUrl ? { OAUTH_JWKS_URL: options.oauthJwksUrl } : {}),
    ...(options.oauthResourceDocumentationUrl
      ? {
          OAUTH_RESOURCE_DOCUMENTATION_URL:
            options.oauthResourceDocumentationUrl,
        }
      : {}),
    ...(options.authMode === "oauth"
      ? { OAUTH_JWT_ALGORITHMS: options.oauthJwtAlgorithms.join(",") }
      : {}),
  })
    .map(([name, value]) => `${name}=${value}`)
    .join(",");
}

function buildSecretRefs(options: CloudRunPlanOptions): string {
  return [
    `SUBSTACK_SESSION_TOKEN=${options.substackSessionSecret}:latest`,
    `PREVIEW_TOKEN_SECRET=${options.previewTokenSecret}:latest`,
    ...(options.authMode === "static_bearer"
      ? [`MCP_BEARER_TOKEN=${options.bearerTokenSecret}:latest`]
      : []),
    ...(options.mcpPathSecret
      ? [`MCP_PATH_SECRET=${options.mcpPathSecret}:latest`]
      : []),
  ].join(",");
}

function secretCreateCommands(
  options: CloudRunPlanOptions,
): CloudRunPlanCommand[] {
  const commands: CloudRunPlanCommand[] = [
    {
      label: "Create Substack session secret from shell variable",
      command: `: "\${SUBSTACK_SESSION_TOKEN:?Set SUBSTACK_SESSION_TOKEN in this shell first}" && printf %s "$SUBSTACK_SESSION_TOKEN" | gcloud secrets create ${shellArg(options.substackSessionSecret)} --data-file=-`,
    },
    {
      label: "Create preview token secret",
      command: `PREVIEW_TOKEN_SECRET_VALUE=$(openssl rand -base64 32) && printf %s "$PREVIEW_TOKEN_SECRET_VALUE" | gcloud secrets create ${shellArg(options.previewTokenSecret)} --data-file=-`,
    },
  ];

  if (options.authMode === "static_bearer") {
    commands.push({
      label: "Create static bearer token secret",
      command: `MCP_BEARER_TOKEN=$(openssl rand -base64 32) && printf %s "$MCP_BEARER_TOKEN" | gcloud secrets create ${shellArg(options.bearerTokenSecret)} --data-file=-`,
    });
  }

  if (options.mcpPathSecret) {
    commands.push({
      label: "Create optional MCP path secret from shell variable",
      command: `: "\${MCP_PATH_SECRET:?Set MCP_PATH_SECRET to one URL-safe path segment first}" && printf %s "$MCP_PATH_SECRET" | gcloud secrets create ${shellArg(options.mcpPathSecret)} --data-file=-`,
    });
  }

  return commands;
}

function secretIamCommands(
  secretNames: readonly string[],
  serviceAccountEmail: string,
): CloudRunPlanCommand[] {
  return secretNames.map((secretName) => ({
    label: `Grant service account access to ${secretName}`,
    command: [
      "gcloud secrets add-iam-policy-binding",
      shellArg(secretName),
      "--member",
      shellArg(`serviceAccount:${serviceAccountEmail}`),
      "--role",
      shellArg("roles/secretmanager.secretAccessor"),
    ].join(" "),
  }));
}

function cloudRunSecretNames(options: CloudRunPlanOptions): string[] {
  return [
    options.substackSessionSecret,
    options.previewTokenSecret,
    ...(options.authMode === "static_bearer"
      ? [options.bearerTokenSecret]
      : []),
    ...(options.mcpPathSecret ? [options.mcpPathSecret] : []),
  ];
}

function remoteSmokeCommand(options: CloudRunPlanOptions): string {
  const urlExpression = options.mcpPathSecret
    ? '"$SERVICE_URL/mcp/$MCP_PATH_SECRET"'
    : '"$SERVICE_URL/mcp"';
  const pathSecretGuard = options.mcpPathSecret
    ? ': "$' +
      '{MCP_PATH_SECRET:?Set MCP_PATH_SECRET to the deployed MCP path segment first}" && '
    : "";
  if (options.authMode === "noauth") {
    return `${pathSecretGuard}npm run smoke:remote-noauth -- --url ${urlExpression}`;
  }

  if (options.authMode === "oauth") {
    return `${pathSecretGuard}: "\${MCP_OAUTH_BEARER_TOKEN:?Set MCP_OAUTH_BEARER_TOKEN to a real access token first}" && MCP_OAUTH_BEARER_TOKEN="$MCP_OAUTH_BEARER_TOKEN" npm run smoke:remote-oauth -- --url ${urlExpression} --evidence-artifact ${shellArg(REMOTE_OAUTH_ARTIFACT)}`;
  }

  return `${pathSecretGuard}: "\${MCP_BEARER_TOKEN:?Set MCP_BEARER_TOKEN to the deployed static bearer token first}" && MCP_BEARER_TOKEN="$MCP_BEARER_TOKEN" npm run smoke:remote -- --url ${urlExpression} --evidence-artifact ${shellArg(STATIC_BEARER_REMOTE_ARTIFACT)}`;
}

function cloudRunVerifyCommand(
  options: CloudRunPlanOptions,
  serviceJsonPath: string,
  evidenceArtifact?: string | undefined,
): string {
  return [
    "npm run cloud-run:verify --",
    "--service-json",
    shellArg(serviceJsonPath),
    "--auth-mode",
    shellArg(options.authMode),
    "--service-account-email",
    shellArg(
      `${options.serviceAccount}@${options.projectId}.iam.gserviceaccount.com`,
    ),
    "--publication-url",
    shellArg(options.publicationUrl),
    "--user-id",
    shellArg(String(options.userId)),
    "--max-body-bytes",
    shellArg(String(options.maxBodyBytes)),
    "--max-image-bytes",
    shellArg(String(options.maxImageBytes)),
    "--substack-request-timeout-ms",
    shellArg(String(options.substackRequestTimeoutMs)),
    "--confirmation-token-ttl-seconds",
    shellArg(String(options.confirmationTokenTtlSeconds)),
    "--substack-session-secret",
    shellArg(options.substackSessionSecret),
    "--preview-token-secret",
    shellArg(options.previewTokenSecret),
    ...(options.authMode === "static_bearer"
      ? ["--bearer-token-secret", shellArg(options.bearerTokenSecret)]
      : []),
    ...(options.mcpPathSecret
      ? ["--mcp-path-secret", shellArg(options.mcpPathSecret)]
      : []),
    ...(options.authMode === "oauth"
      ? [
          "--public-base-url",
          shellArg(requiredString(options.publicBaseUrl, "--public-base-url")),
          "--oauth-authorization-server-url",
          shellArg(
            requiredString(
              options.oauthAuthorizationServerUrl,
              "--oauth-authorization-server-url",
            ),
          ),
          "--oauth-jwks-url",
          shellArg(requiredString(options.oauthJwksUrl, "--oauth-jwks-url")),
          ...(options.oauthResourceDocumentationUrl
            ? [
                "--oauth-resource-documentation-url",
                shellArg(options.oauthResourceDocumentationUrl),
              ]
            : []),
          "--oauth-jwt-algorithms",
          shellArg(options.oauthJwtAlgorithms.join(",")),
        ]
      : []),
    ...(evidenceArtifact
      ? ["--evidence-artifact", shellArg(evidenceArtifact)]
      : []),
  ].join(" ");
}

function cloudRunLogsExportCommand(options: CloudRunPlanOptions): string {
  return [
    "mkdir -p .data && gcloud logging read",
    shellArg(
      `resource.type="cloud_run_revision" AND resource.labels.service_name="${options.serviceName}"`,
    ),
    "--format=json",
    "--limit=100",
    ">",
    CLOUD_RUN_LOGS_JSON_PATH,
  ].join(" ");
}

function cloudRunLogsVerifyCommand(
  logsJsonPath: string,
  evidenceArtifact: string,
): string {
  return [
    "npm run cloud-run:logs:verify --",
    "--logs-json",
    shellArg(logsJsonPath),
    "--require-audit-events",
    "--evidence-artifact",
    shellArg(evidenceArtifact),
  ].join(" ");
}

function budgetAlertCommand(options: CloudRunPlanOptions): string {
  return [
    ': "$' +
      '{BILLING_ACCOUNT_ID:?Set BILLING_ACCOUNT_ID to the Cloud Billing account id first}"',
    "&&",
    "gcloud billing budgets create",
    "--billing-account",
    '"$BILLING_ACCOUNT_ID"',
    "--display-name",
    shellArg(`${options.serviceName} monthly budget`),
    "--budget-amount",
    "5USD",
    "--calendar-period",
    "month",
    "--filter-projects",
    shellArg(`projects/${options.projectId}`),
    "--threshold-rule",
    "percent=0.50",
    "--threshold-rule",
    "percent=0.90",
    "--threshold-rule",
    "percent=1.00",
  ].join(" ");
}

function notesFor(options: CloudRunPlanOptions): string[] {
  return [
    "Run npm run build and npm run smoke:docker-http before deploying.",
    "Replace placeholder secret input values at execution time; do not paste secrets into the repository.",
    "Cloud Run must allow unauthenticated ingress so MCP clients can reach the HTTPS endpoint; app-level auth still runs inside the service.",
    "Create a Cloud Billing budget alert immediately after deployment. The generated follow-up uses a $5 monthly budget with 50%, 90%, and 100% thresholds for this project.",
    "Export and verify Cloud Run logs after live acceptance traffic. The generated follow-up writes only sanitized gate 16 evidence and requires at least one safe audit event.",
    ...(options.mcpPathSecret
      ? [
          "MCP_PATH_SECRET is deployed from Secret Manager; keep the path segment in the shell for smoke commands and do not paste it into docs, logs, or evidence.",
        ]
      : []),
    ...(options.authMode === "noauth"
      ? [
          "AUTH_MODE=noauth is for short-lived personal testing only. Rotate the Substack session token after exposure.",
        ]
      : []),
    ...(options.authMode === "static_bearer"
      ? [
          "AUTH_MODE=static_bearer is for remote clients that can send Authorization headers; ChatGPT connector use should prefer OAuth.",
        ]
      : []),
    ...(options.authMode === "oauth"
      ? [
          `AUTH_MODE=oauth still requires a real authorization server and browser login flow before durable ChatGPT use; fill the manual launch-review section in ${REMOTE_OAUTH_ARTIFACT} after the smoke command passes.`,
        ]
      : []),
  ];
}

function parseAuthMode(
  value: string | undefined,
  name: string,
  fallback?: AuthMode,
): AuthMode {
  if (!value) {
    if (fallback) {
      return fallback;
    }
    throw new Error(`${name} must be one of: noauth, static_bearer, oauth.`);
  }

  if (value === "noauth" || value === "static_bearer" || value === "oauth") {
    return value;
  }

  throw new Error(`${name} must be one of: noauth, static_bearer, oauth.`);
}

function parseOptionalPositiveInteger(
  value: string | undefined,
  name: string,
): number | undefined {
  return value === undefined || value.trim() === ""
    ? undefined
    : parsePositiveInteger(value, name);
}

function parseOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseOAuthJwtAlgorithms(
  value: string | undefined,
  name: string,
): readonly string[] {
  const raw = value?.trim();
  if (!raw) {
    return DEFAULT_OAUTH_JWT_ALGORITHMS;
  }

  return normalizeOAuthJwtAlgorithms(raw.split(",")).map((algorithm) => {
    const trimmed = algorithm.trim();
    if (!trimmed) {
      throw new Error(`${name} must contain at least one value.`);
    }
    return trimmed;
  });
}

function parsePositiveInteger(
  value: string | undefined,
  name: string,
  fallback?: number,
): number {
  const raw = value?.trim();
  if (raw === undefined || raw === "") {
    if (fallback !== undefined) {
      return fallback;
    }
    throw new Error(`${name} is required.`);
  }

  const parsed = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }

  return parsed;
}

function requiredPositiveInteger(
  value: number | undefined,
  name: string,
): number {
  if (value === undefined) {
    throw new Error(`${name} is required.`);
  }

  return value;
}

function requiredString(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    throw new Error(`${name} is required.`);
  }

  return trimmed;
}

function requiredPublicHttpsUrl(
  value: string | undefined,
  name: string,
): string {
  const raw = requiredString(value, name);
  const parsed = parsePublicHttpsUrl(raw, name);
  if (!parsed.ok) {
    throw new Error(parsed.errors.join(" "));
  }

  return parsed.url.origin;
}

function requiredHttpsUrl(value: string | undefined, name: string): string {
  const raw = requiredString(value, name);
  const url = new URL(raw);
  if (url.protocol !== "https:") {
    throw new Error(`${name} must be an https URL.`);
  }
  if (url.username || url.password) {
    throw new Error(`${name} must not include username or password.`);
  }

  return url.toString().replace(/\/+$/, "");
}

function shellArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
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
