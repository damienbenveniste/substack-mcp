import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import { DEFAULT_CLOUD_RUN_SERVICE_NAME } from "./cloudRunPlanCore.js";

export type CloudRunLogsVerifyFormat = "text" | "json";

export interface CloudRunLogsVerifyRunOptions {
  readonly help: false;
  readonly logsJson: string;
  readonly artifactRoot: string;
  readonly evidenceArtifact?: string | undefined;
  readonly requireAuditEvents: boolean;
  readonly format: CloudRunLogsVerifyFormat;
}

export interface CloudRunLogsVerifyHelpOptions {
  readonly help: true;
}

export type CloudRunLogsVerifyOptions =
  | CloudRunLogsVerifyRunOptions
  | CloudRunLogsVerifyHelpOptions;

export interface CloudRunLogsVerifyReport {
  readonly ok: boolean;
  readonly entry_count: number;
  readonly audit_event_count: number;
  readonly checks: readonly CloudRunLogsVerifyCheck[];
  readonly findings: readonly CloudRunLogsFinding[];
}

export interface CloudRunLogsVerifyCheck {
  readonly id: string;
  readonly ok: boolean;
  readonly evidence: string;
}

export interface CloudRunLogsFinding {
  readonly id: string;
  readonly entry_index?: number | undefined;
  readonly path?: string | undefined;
  readonly evidence: string;
}

const SECRET_PATTERNS: readonly {
  readonly id: string;
  readonly pattern: RegExp;
}[] = [
  {
    id: "connect_sid_cookie",
    pattern: /connect\.sid=(?:"[^"]*"|'[^']*'|[^;\s"]+)/gi,
  },
  {
    id: "substack_sid_cookie",
    pattern: /substack\.sid=(?:"[^"]*"|'[^']*'|[^;\s"]+)/gi,
  },
  {
    id: "authorization_bearer",
    pattern:
      /\bauthorization\b["']?\s*[:=]\s*["']?Bearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  },
  {
    id: "bearer_token",
    pattern: /Bearer\s+(?!resource_metadata=)[A-Za-z0-9._~+/-]{20,}=*/gi,
  },
  {
    id: "secret_env_assignment",
    pattern:
      /(\b(?:SUBSTACK_SESSION_TOKEN|PREVIEW_TOKEN_SECRET|MCP_BEARER_TOKEN|MCP_PATH_SECRET)\b"?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi,
  },
  {
    id: "mcp_path_secret",
    pattern: /\/mcp\/(?!<redacted>(?:[/?#"'\\\s,}]|$))[A-Za-z0-9._~-]+/gi,
  },
];

const SENSITIVE_FIELD_NAMES = new Set([
  "authorization",
  "cookie",
  "setcookie",
  "substacksessiontoken",
  "previewtokensecret",
  "mcpbearertoken",
  "mcppathsecret",
  "confirmationtoken",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "sessiontoken",
]);

const DRAFT_BODY_FIELD_NAMES = new Set([
  "draftbody",
  "bodymarkdown",
  "bodyjson",
  "rawbody",
  "requestbody",
  "body",
  "markdown",
  "blocks",
  "content",
]);

const ALLOWED_AUDIT_FIELDS = new Set([
  "event_type",
  "action",
  "outcome",
  "reason",
  "draft_id",
  "body_format",
  "image_source",
  "audience",
  "title_present",
  "subtitle_present",
  "body_present",
  "metadata_only",
  "idempotency_key_present",
  "idempotency_replay",
  "alt_text_present",
  "caption_present",
  "stats",
  "warning_count",
  "error_count",
]);

export function parseCloudRunLogsVerifyArgs(
  args: readonly string[],
  cwd = process.cwd(),
): CloudRunLogsVerifyOptions {
  let logsJson: string | undefined;
  let evidenceArtifact: string | undefined;
  let requireAuditEvents = false;
  let format: CloudRunLogsVerifyFormat = "text";
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--logs-json":
        logsJson = resolveInsideCwd(cwd, readValue(args, index, arg));
        index += 1;
        break;
      case "--evidence-artifact":
        evidenceArtifact = resolveArtifactInsideCwd(
          cwd,
          readValue(args, index, arg),
        );
        index += 1;
        break;
      case "--require-audit-events":
        requireAuditEvents = true;
        break;
      case "--format":
        format = parseFormat(readValue(args, index, arg));
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
  if (!logsJson) {
    throw new Error("--logs-json is required.");
  }

  return {
    help: false,
    logsJson,
    artifactRoot: cwd,
    evidenceArtifact,
    requireAuditEvents,
    format,
  };
}

export function cloudRunLogsVerifyUsage(): string {
  return [
    "Usage: npm run cloud-run:logs:verify -- --logs-json <path> [options]",
    "",
    "Verifies an exported Cloud Logging JSON or NDJSON file for V1 log-safety",
    "evidence. This command does not run gcloud, call Cloud Run, read Secret",
    "Manager values, or print log entry contents.",
    "",
    "Export example:",
    `  mkdir -p .data && gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="${DEFAULT_CLOUD_RUN_SERVICE_NAME}"' --format=json --limit=100 > .data/cloud-run-logs.json`,
    "",
    "Options:",
    "  --logs-json <path>       Required project-local JSON/NDJSON log export.",
    "  --evidence-artifact <path>",
    "                         Write sanitized Markdown evidence for gate 16.",
    "  --require-audit-events   Fail unless at least one `mcp_audit` event is present.",
    "  --format <format>        text or json. Default: text.",
    "  --json                   Shortcut for --format json.",
    "  --help                   Show this help.",
    "",
    "Examples:",
    "  npm run cloud-run:logs:verify -- --logs-json .data/cloud-run-logs.json",
    "  npm run cloud-run:logs:verify -- --logs-json .data/cloud-run-logs.json --require-audit-events --evidence-artifact .data/v1/gate-16-cloud-run-logs.md",
    "  npm run cloud-run:logs:verify -- --logs-json .data/cloud-run-logs.json --require-audit-events --json",
  ].join("\n");
}

export function readCloudRunLogsFile(filePath: string): {
  readonly raw: string;
  readonly entries: readonly unknown[];
} {
  if (!existsSync(filePath)) {
    throw new Error(`Cloud Run logs JSON does not exist: ${filePath}`);
  }

  const raw = readFileSync(filePath, "utf8");
  return {
    raw,
    entries: parseLogEntries(raw),
  };
}

export function verifyCloudRunLogs(
  input: { readonly raw: string; readonly entries: readonly unknown[] },
  options: Pick<CloudRunLogsVerifyRunOptions, "requireAuditEvents"> = {
    requireAuditEvents: false,
  },
): CloudRunLogsVerifyReport {
  const findings = [
    ...secretPatternFindings(input.raw),
    ...entryFindings(input.entries),
  ];
  const auditEventCount = input.entries.reduce<number>(
    (count, entry) => count + findAuditEvents(entry).length,
    0,
  );
  const secretFindings = findings.filter(
    (finding) =>
      finding.id === "secret_pattern" || finding.id === "sensitive_field",
  );
  const draftBodyFindings = findings.filter(
    (finding) => finding.id === "draft_body_field",
  );
  const auditFindings = findings.filter(
    (finding) => finding.id === "unexpected_audit_field",
  );
  const checks: CloudRunLogsVerifyCheck[] = [
    {
      id: "log_entries_present",
      ok: input.entries.length > 0,
      evidence: `${input.entries.length} exported log entr${
        input.entries.length === 1 ? "y" : "ies"
      } parsed.`,
    },
    {
      id: "no_secret_patterns_or_fields",
      ok: secretFindings.length === 0,
      evidence:
        secretFindings.length === 0
          ? "No cookie, bearer, secret env, private MCP path, or sensitive field-name leaks were detected."
          : `${secretFindings.length} secret-related finding(s) detected.`,
    },
    {
      id: "no_draft_body_fields",
      ok: draftBodyFindings.length === 0,
      evidence:
        draftBodyFindings.length === 0
          ? "No draft body, Markdown, blocks, or content fields were detected."
          : `${draftBodyFindings.length} draft-body field finding(s) detected.`,
    },
    {
      id: "audit_events_metadata_only",
      ok:
        auditFindings.length === 0 &&
        (!options.requireAuditEvents || auditEventCount > 0),
      evidence:
        auditFindings.length === 0
          ? `${auditEventCount} mcp_audit event(s) use the allowed metadata field set.`
          : `${auditFindings.length} unexpected audit field finding(s) detected.`,
    },
  ];

  return {
    ok: checks.every((check) => check.ok),
    entry_count: input.entries.length,
    audit_event_count: auditEventCount,
    checks,
    findings,
  };
}

export function renderCloudRunLogsVerifyReport(
  report: CloudRunLogsVerifyReport,
  format: CloudRunLogsVerifyFormat,
): string {
  if (format === "json") {
    return `${JSON.stringify(report, null, 2)}\n`;
  }

  const lines = [
    "# Cloud Run log verification",
    "",
    "This report verifies exported logs without printing log entry contents.",
    "",
    `OK: ${report.ok ? "yes" : "no"}`,
    `Entries: ${report.entry_count}`,
    `Audit events: ${report.audit_event_count}`,
    "",
    "## Checks",
    ...report.checks.map(
      (check) =>
        `- ${check.ok ? "ok" : "failed"}: ${check.id} - ${check.evidence}`,
    ),
    "",
    "## Findings",
    ...(report.findings.length === 0
      ? ["No findings."]
      : report.findings.map(renderFinding)),
  ];

  return `${lines.join("\n")}\n`;
}

function parseLogEntries(raw: string): readonly unknown[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (isRecord(parsed) && Array.isArray(parsed.entries)) {
      return parsed.entries;
    }
    return [parsed];
  } catch {
    return parseNdjson(trimmed);
  }
}

function parseNdjson(raw: string): readonly unknown[] {
  return raw.split(/\r?\n/).map((line, index) => {
    try {
      return JSON.parse(line) as unknown;
    } catch (error) {
      throw new Error(
        `Invalid Cloud Run logs JSON on line ${index + 1}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  });
}

function secretPatternFindings(raw: string): readonly CloudRunLogsFinding[] {
  return SECRET_PATTERNS.flatMap(({ id, pattern }) => {
    pattern.lastIndex = 0;
    return pattern.test(raw)
      ? [
          {
            id: "secret_pattern",
            evidence: `Matched ${id} pattern in exported log text.`,
          },
        ]
      : [];
  });
}

function entryFindings(
  entries: readonly unknown[],
): readonly CloudRunLogsFinding[] {
  return entries.flatMap((entry, entryIndex) => [
    ...fieldFindings(entry, {
      entryIndex,
      path: "$",
    }),
    ...findAuditEvents(entry).flatMap((audit) =>
      unexpectedAuditFieldFindings(audit.value, {
        entryIndex,
        path: audit.path,
      }),
    ),
  ]);
}

function fieldFindings(
  value: unknown,
  context: { readonly entryIndex: number; readonly path: string },
): readonly CloudRunLogsFinding[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      fieldFindings(item, {
        entryIndex: context.entryIndex,
        path: `${context.path}[${index}]`,
      }),
    );
  }

  if (!isRecord(value)) {
    return [];
  }

  return Object.entries(value).flatMap(([key, child]) => {
    const path = `${context.path}.${key}`;
    const normalized = normalizeKey(key);
    const findings: CloudRunLogsFinding[] = [];
    if (SENSITIVE_FIELD_NAMES.has(normalized)) {
      findings.push({
        id: "sensitive_field",
        entry_index: context.entryIndex,
        path,
        evidence: `Sensitive field name \`${key}\` was present.`,
      });
    }
    if (DRAFT_BODY_FIELD_NAMES.has(normalized)) {
      findings.push({
        id: "draft_body_field",
        entry_index: context.entryIndex,
        path,
        evidence: `Draft body/content field name \`${key}\` was present.`,
      });
    }

    return [
      ...findings,
      ...fieldFindings(child, {
        entryIndex: context.entryIndex,
        path,
      }),
    ];
  });
}

function findAuditEvents(
  value: unknown,
  path = "$",
): readonly {
  readonly path: string;
  readonly value: Record<string, unknown>;
}[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) =>
      findAuditEvents(item, `${path}[${index}]`),
    );
  }
  if (!isRecord(value)) {
    return [];
  }

  const matches =
    value.event_type === "mcp_audit"
      ? [
          {
            path,
            value,
          },
        ]
      : [];

  return [
    ...matches,
    ...Object.entries(value).flatMap(([key, child]) =>
      findAuditEvents(child, `${path}.${key}`),
    ),
  ];
}

function unexpectedAuditFieldFindings(
  audit: Record<string, unknown>,
  context: { readonly entryIndex: number; readonly path: string },
): readonly CloudRunLogsFinding[] {
  return Object.keys(audit)
    .filter((key) => !ALLOWED_AUDIT_FIELDS.has(key))
    .map((key) => ({
      id: "unexpected_audit_field",
      entry_index: context.entryIndex,
      path: `${context.path}.${key}`,
      evidence: `Unexpected audit field \`${key}\` was present.`,
    }));
}

function renderFinding(finding: CloudRunLogsFinding): string {
  const location = [
    finding.entry_index !== undefined
      ? `entry ${finding.entry_index}`
      : undefined,
    finding.path,
  ]
    .filter(Boolean)
    .join(" ");
  return `- ${finding.id}${location ? ` (${location})` : ""}: ${
    finding.evidence
  }`;
}

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseFormat(value: string): CloudRunLogsVerifyFormat {
  if (value === "text" || value === "json") {
    return value;
  }

  throw new Error("--format must be one of: text, json.");
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
    throw new Error("--logs-json must stay inside the project directory.");
  }

  return outputPath;
}

function resolveArtifactInsideCwd(cwd: string, value: string): string {
  const root = resolve(cwd);
  const outputPath = resolve(root, value);
  const relativePath = relative(root, outputPath);
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
