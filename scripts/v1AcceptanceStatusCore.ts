import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

import {
  buildFixtureStatus,
  fixtureCompatibilityTestCommand,
  fixtureStatusCommand,
  type SubstackFixtureStatus,
} from "./fixtureStatusCore.js";
import { recordedEvidenceSafetyProblem } from "./v1EvidenceSafety.js";

export type V1AcceptanceStatusFormat = "text" | "json";
export type V1GateStatus =
  | "local_evidence_available"
  | "manual_or_live_evidence_recorded"
  | "manual_or_live_evidence_required"
  | "missing_local_artifact";

export interface V1AcceptanceStatusRunOptions {
  readonly help: false;
  readonly cwd: string;
  readonly evidenceFile?: string | undefined;
  readonly fixtureDir: string;
  readonly format: V1AcceptanceStatusFormat;
  readonly requireComplete: boolean;
}

export interface V1AcceptanceStatusHelpOptions {
  readonly help: true;
}

export type V1AcceptanceStatusOptions =
  | V1AcceptanceStatusRunOptions
  | V1AcceptanceStatusHelpOptions;

export interface V1AcceptanceGate {
  readonly id: number;
  readonly criterion: string;
  readonly status: V1GateStatus;
  readonly evidence: string;
  readonly next_action: string;
}

export interface V1AcceptanceSummary {
  readonly total: number;
  readonly local_evidence_available: number;
  readonly manual_or_live_evidence_recorded: number;
  readonly manual_or_live_evidence_required: number;
  readonly missing_local_artifact: number;
}

export interface V1AcceptanceStatusReport {
  readonly complete: boolean;
  readonly evidence_file?: string | undefined;
  readonly fixture_dir?: string | undefined;
  readonly fixture_capture_dir_arg?: string | undefined;
  readonly fixture_ready: boolean;
  readonly fixture_present_count: number;
  readonly fixture_valid_count: number;
  readonly fixture_compatible_count: number;
  readonly fixture_required_count: number;
  readonly summary: V1AcceptanceSummary;
  readonly gates: readonly V1AcceptanceGate[];
}

interface PackageJson {
  readonly scripts?: Readonly<Record<string, string>> | undefined;
}

const README_V1_REQUIRED_MARKERS = [
  "This project uses Substack's unofficial/internal API.",
  "## Safety Boundary",
  "V1 must not publish, schedule, delete, email, or create public Substack Notes.",
  "## Supported Formatting",
  "## Known Limitations",
  "## Quickstart",
  "## Substack Credentials",
  "Application or Storage",
  "Cookies",
  "connect.sid",
  "substack.sid",
  "Network tab",
  "SUBSTACK_USER_ID",
  "## MCP Inspector",
  "Claude Code setup examples",
  "Cursor examples",
  "## Remote MCP Clients with ngrok",
  "## Cloud Run",
  "## Secret Rotation",
  "Rotate `SUBSTACK_SESSION_TOKEN`",
  "Rotate `PREVIEW_TOKEN_SECRET`",
  "Rotate `MCP_BEARER_TOKEN`",
  "Secret Manager versions",
  "scripts/rotateLocalSecrets.md",
  "## Troubleshooting",
] as const;
const MANUAL_OR_LIVE_GATE_IDS = [7, 8, 9, 11, 12, 13, 14, 15, 16] as const;
const MANUAL_OR_LIVE_GATE_ID_TEXT = MANUAL_OR_LIVE_GATE_IDS.join(", ");
const DEFAULT_EVIDENCE_FILE = ".data/v1-acceptance-evidence.json";

export interface V1EvidenceFile {
  readonly version: 1;
  readonly gates: readonly V1RecordedGateEvidence[];
}

export interface V1RecordedGateEvidence {
  readonly id: number;
  readonly verified_at: string;
  readonly evidence: string;
  readonly command?: string | undefined;
  readonly artifact?: string | undefined;
}

export function parseV1AcceptanceStatusArgs(
  args: readonly string[],
  cwd = process.cwd(),
): V1AcceptanceStatusOptions {
  let format: V1AcceptanceStatusFormat = "text";
  let requireComplete = false;
  let evidenceFile: string | undefined;
  let fixtureDir = resolve(cwd, "fixtures", "substack");
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--evidence-file":
        evidenceFile = resolveInsideCwd(cwd, readValue(args, index, arg), arg);
        index += 1;
        break;
      case "--fixture-dir":
        fixtureDir = resolveInsideCwd(cwd, readValue(args, index, arg), arg);
        index += 1;
        break;
      case "--format":
        format = parseFormat(readValue(args, index, arg));
        index += 1;
        break;
      case "--json":
        format = "json";
        break;
      case "--require-complete":
        requireComplete = true;
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
    ...(evidenceFile ? { evidenceFile } : {}),
    fixtureDir,
    format,
    requireComplete,
  };
}

export function v1AcceptanceStatusUsage(): string {
  return [
    "Usage: npm run v1:status -- [options]",
    "",
    "Reports the V1 acceptance criteria from the implementation plan.",
    "This command does not run tests, deploy Cloud Run, call Substack, or prove",
    "manual client acceptance. It separates repo-local evidence from manual/live gates.",
    "",
    "Options:",
    `  --evidence-file <path> Project-local JSON evidence file for manual/live gates. Defaults to ${DEFAULT_EVIDENCE_FILE} when it exists.`,
    "  --fixture-dir <path>   Project-local live fixture directory. Default: fixtures/substack.",
    "  --format <format>      text or json. Default: text.",
    "  --json                 Shortcut for --format json.",
    "  --require-complete     Exit non-zero when any gate still needs evidence.",
    "  --help                 Show this help.",
    "",
    "Examples:",
    "  npm run v1:status",
    `  npm run v1:status -- --evidence-file ${DEFAULT_EVIDENCE_FILE}`,
    "  npm run v1:status -- --fixture-dir fixtures/live",
    "  npm run v1:status -- --json",
    "  npm run v1:status -- --require-complete",
  ].join("\n");
}

export function buildV1AcceptanceStatus(
  input:
    | string
    | {
        readonly cwd?: string | undefined;
        readonly evidenceFile?: string | undefined;
        readonly fixtureDir?: string | undefined;
      } = process.cwd(),
): V1AcceptanceStatusReport {
  const root = resolve(
    typeof input === "string" ? input : (input.cwd ?? process.cwd()),
  );
  const explicitEvidenceFile =
    typeof input === "string" ? undefined : input.evidenceFile;
  const evidenceFile = resolveEvidenceFile(root, explicitEvidenceFile);
  const fixtureDir =
    typeof input === "string"
      ? resolve(root, "fixtures", "substack")
      : resolve(root, input.fixtureDir ?? "fixtures/substack");
  const packageJson = readPackageJson(root);
  const readme = readOptionalText(root, "README.md");
  const implementationNotes = readOptionalText(root, "IMPLEMENTATION_NOTES.md");
  const fixtureStatus = buildFixtureStatus({
    fixtureDir,
    cwd: root,
  });
  const logSafetyArtifactStatus = localArtifactGate(root, [
    "src/logging/audit.ts",
    "tests/logging/audit.test.ts",
    "tests/logging/logger.test.ts",
    "tests/safety/redaction.test.ts",
    "scripts/cloudRunLogsVerify.ts",
    "tests/scripts/cloudRunLogsVerify.test.ts",
  ]);
  const recordedEvidence = evidenceFile
    ? readEvidenceFile(evidenceFile)
    : new Map<number, V1RecordedGateEvidence>();

  const gates = applyRecordedEvidence(
    [
      gate(
        1,
        "`npm test` passes.",
        hasScript(packageJson, "test")
          ? "local_evidence_available"
          : "missing_local_artifact",
        hasScript(packageJson, "test")
          ? "package.json defines `npm test`; run it before release."
          : "package.json does not define `npm test`.",
        "Run `npm test` and inspect the result.",
      ),
      gate(
        2,
        "`npm run build` passes.",
        hasScript(packageJson, "build")
          ? "local_evidence_available"
          : "missing_local_artifact",
        hasScript(packageJson, "build")
          ? "package.json defines `npm run build`; run it before release."
          : "package.json does not define `npm run build`.",
        "Run `npm run build` and inspect the result.",
      ),
      gate(
        3,
        "MCP Inspector lists all tools.",
        localInspectorCliGate(root, packageJson, readme),
        localInspectorCliGate(root, packageJson, readme) ===
          "local_evidence_available"
          ? "`npm run smoke:inspector` can run MCP Inspector CLI `tools/list`, verify the exact V1 draft-only tool surface, and write sanitized gate 3 evidence."
          : "MCP Inspector CLI smoke tooling, tests, or README documentation are missing.",
        "Run `npm run build` and `npm run smoke:inspector -- --evidence-artifact .data/v1/gate-03-mcp-inspector.md` before release.",
      ),
      gate(
        4,
        "`validate_newsletter_content` handles rich Markdown fixture.",
        localArtifactGate(root, [
          "fixtures/markdown/full-rich-draft.md",
          "tests/tools/validateNewsletterContent.test.ts",
          "scripts/smokeValidateTool.ts",
        ]),
        "Fixture, unit test, and shared smoke helper are present.",
        "Run `npm test -- tests/tools/validateNewsletterContent.test.ts` or the full validation suite.",
      ),
      gate(
        5,
        "`preview_draft` returns a confirmation token and useful warnings.",
        localArtifactGate(root, [
          "tests/tools/previewDraft.test.ts",
          "scripts/smokeValidateTool.ts",
        ]),
        "Preview unit tests and smoke helper are present.",
        "Run `npm test -- tests/tools/previewDraft.test.ts` or a smoke command that calls `preview_draft`.",
      ),
      gate(
        6,
        "`create_draft` rejects missing/invalid/expired confirmation tokens.",
        localArtifactGate(root, [
          "src/safety/confirmationToken.ts",
          "tests/safety/confirmationToken.test.ts",
          "tests/tools/createDraft.test.ts",
        ]),
        "Confirmation-token implementation and regression tests are present.",
        "Run `npm test -- tests/safety/confirmationToken.test.ts tests/tools/createDraft.test.ts`.",
      ),
      gate(
        7,
        "`create_draft` creates a rich Substack draft with native image, code, and LaTeX rendering.",
        "manual_or_live_evidence_required",
        richDraftEvidence(fixtureStatus, implementationNotes),
        richDraftNextAction(fixtureStatus),
      ),
      gate(
        8,
        "`update_draft` updates an existing unpublished draft.",
        "manual_or_live_evidence_required",
        fileExists(root, "tests/live/substackDraftFlow.test.ts")
          ? "Guarded live test harness covers update, but it requires real Substack credentials."
          : "No guarded live update test harness was found.",
        "Run the guarded live suite with credentials and `V1_LIVE_SUBSTACK_EVIDENCE_ARTIFACTS=.data/v1/gate-07-rich-draft-live-fixtures.md,.data/v1/gate-08-update-draft-live.md,.data/v1/gate-09-read-drafts-live.md`, then manually confirm the updated draft remains unpublished.",
      ),
      gate(
        9,
        "`list_drafts` and `get_draft` work.",
        "manual_or_live_evidence_required",
        fileExists(root, "tests/substack/client.test.ts") &&
          fileExists(root, "tests/live/substackDraftFlow.test.ts")
          ? "Mock Substack client tests and the guarded live flow cover `list_drafts` plus `get_draft`, but live Substack read acceptance is still required."
          : "Mock Substack client tests or the guarded live flow are missing.",
        "Run `V1_LIVE_SUBSTACK_EVIDENCE_ARTIFACTS=.data/v1/gate-07-rich-draft-live-fixtures.md,.data/v1/gate-08-update-draft-live.md,.data/v1/gate-09-read-drafts-live.md RUN_LIVE_SUBSTACK_TESTS=1 npm run test:live` or read tools against a real Substack account through an MCP client.",
      ),
      gate(
        10,
        "No publish/delete/schedule/Notes tool exists.",
        localArtifactGate(root, ["tests/server.test.ts"]),
        "Server tests cover the exact V1 tool surface and forbidden tool-name patterns.",
        "Run `npm test -- tests/server.test.ts`.",
      ),
      gate(
        11,
        "Local ngrok + ChatGPT connector works.",
        "manual_or_live_evidence_required",
        hasScript(packageJson, "smoke:ngrok-noauth") &&
          hasScript(packageJson, "smoke:remote-noauth")
          ? "`npm run smoke:ngrok-noauth` can launch local HTTP, start ngrok, run the remote noauth smoke, and keep the verified tunnel open for a bounded ChatGPT acceptance window, but ChatGPT connector acceptance is manual."
          : "`npm run smoke:ngrok-noauth` or `npm run smoke:remote-noauth` is missing.",
        "Run `npm run smoke:ngrok-noauth -- --use-local-credentials --hold-open-seconds 900 --evidence-artifact .data/v1/gate-11-chatgpt-ngrok.md`, then verify the connector in ChatGPT while the live endpoint notice is displayed.",
      ),
      gate(
        12,
        "Cloud Run deployment works.",
        "manual_or_live_evidence_required",
        hasScript(packageJson, "cloud-run:plan") &&
          hasScript(packageJson, "cloud-run:verify")
          ? "`npm run cloud-run:plan` generates artifact-writing gate 12/13 follow-ups with planned runtime-env assertions, deployed `/healthz`, budget-alert, remote smoke, and gate 16 log-verification follow-ups; live deployment evidence is still required from a real GCP project."
          : "`npm run cloud-run:plan` or `npm run cloud-run:verify` is missing.",
        "Run `npm run cloud-run:plan -- --project-id <id> --publication-url <url> --user-id <id>` in a real GCP project, then run its generated `cloud-run:verify` follow-up for gate 12 (`.data/v1/gate-12-cloud-run-deployment.md`), `/healthz`, and auth-mode matching remote smoke commands.",
      ),
      gate(
        13,
        "Cloud Run stores Substack session token, preview token secret, and MCP bearer token in Secret Manager.",
        "manual_or_live_evidence_required",
        fileExists(root, "tests/scripts/cloudRunPlan.test.ts") &&
          fileExists(root, "tests/scripts/cloudRunVerify.test.ts")
          ? "Cloud Run plan tests cover Secret Manager command generation and gate 13 evidence follow-up, while verify tests cover deployed service secret references and optional runtime-env assertions; actual secrets must still be created in GCP."
          : "Cloud Run plan or verify tests are missing.",
        "Create Secret Manager secrets, grant access to the Cloud Run service account, export the service JSON, and run the generated gate 13 `cloud-run:verify` follow-up (`.data/v1/gate-13-cloud-run-secrets.md`) to verify secret references and planned runtime env.",
      ),
      gate(
        14,
        "`AUTH_MODE=static_bearer` works for at least one HTTP client that supports headers.",
        "manual_or_live_evidence_required",
        hasScript(packageJson, "smoke:http-static-bearer") &&
          hasScript(packageJson, "smoke:ngrok-static-bearer") &&
          hasScript(packageJson, "smoke:remote")
          ? "`npm run smoke:ngrok-static-bearer` can launch local HTTP, start ngrok, verify remote bearer rejection, run the remote static-bearer smoke, and keep the verified tunnel open for a bounded client acceptance window, but real header-capable client acceptance is manual."
          : "Static-bearer smoke coverage is incomplete.",
        "Set a local `MCP_BEARER_TOKEN`, then run `npm run smoke:ngrok-static-bearer -- --bearer-token-env MCP_BEARER_TOKEN --hold-open-seconds 900 --evidence-artifact .data/v1/gate-14-static-bearer-remote.md` and verify a real header-capable client while the endpoint is live.",
      ),
      gate(
        15,
        "Claude Code or Cursor can connect through stdio using env-based credentials.",
        "manual_or_live_evidence_required",
        hasScript(packageJson, "smoke:stdio") &&
          fileExists(root, "examples/claude-code.md") &&
          fileExists(root, "examples/cursor.local.stdio.json")
          ? "Built stdio smoke and Claude/Cursor examples exist; real client acceptance is manual."
          : "stdio smoke or Claude/Cursor examples are missing.",
        "Run `npm run build` and `npm run smoke:stdio -- --evidence-artifact .data/v1/gate-15-stdio-client.md`, then add it to Claude Code or Cursor with local env credentials and call `validate_newsletter_content`.",
      ),
      gate(
        16,
        "No secrets appear in logs.",
        logSafetyArtifactStatus === "local_evidence_available"
          ? "manual_or_live_evidence_required"
          : "missing_local_artifact",
        logSafetyArtifactStatus === "local_evidence_available"
          ? "Audit logging, runtime logger redaction tests, secret redaction tests, exported Cloud Run log verifier, and Cloud Run plan follow-ups for gate 16 are present; actual live Cloud Run log evidence is still required."
          : "Audit logging, runtime logger redaction tests, secret redaction tests, or the exported Cloud Run log verifier are missing.",
        "Export Cloud Run logs after live acceptance, run `npm run cloud-run:logs:verify -- --logs-json .data/cloud-run-logs.json --require-audit-events --evidence-artifact .data/v1/gate-16-cloud-run-logs.md`, and record the result.",
      ),
      gate(
        17,
        "README includes local and remote setup for ChatGPT, Claude, Cursor, and Cloud Run.",
        readmeIncludesAll(readme, README_V1_REQUIRED_MARKERS)
          ? "local_evidence_available"
          : "missing_local_artifact",
        readmeIncludesAll(readme, README_V1_REQUIRED_MARKERS)
          ? "README contains the required warning, safety boundary, formatting, limitations, setup, credential, local and remote client, Cloud Run, rotation, and troubleshooting sections."
          : "README is missing one or more required warning, safety boundary, formatting, limitations, setup, credential, local or remote client, Cloud Run, rotation, or troubleshooting sections.",
        "Review README setup instructions before release.",
      ),
    ],
    recordedEvidence,
    fixtureStatus,
    root,
  );

  const summary = summarizeGates(gates);
  return {
    complete:
      summary.missing_local_artifact === 0 &&
      summary.manual_or_live_evidence_required === 0,
    ...(evidenceFile ? { evidence_file: evidenceFile } : {}),
    fixture_dir: fixtureStatus.fixture_dir,
    ...(fixtureStatus.capture_fixture_dir_arg
      ? { fixture_capture_dir_arg: fixtureStatus.capture_fixture_dir_arg }
      : {}),
    fixture_ready: fixtureStatus.ready,
    fixture_present_count: fixtureStatus.present_count,
    fixture_valid_count: fixtureStatus.valid_count,
    fixture_compatible_count: fixtureStatus.compatible_count,
    fixture_required_count: fixtureStatus.required_count,
    summary,
    gates,
  };
}

function resolveEvidenceFile(
  root: string,
  explicitEvidenceFile: string | undefined,
): string | undefined {
  if (explicitEvidenceFile) {
    return resolve(root, explicitEvidenceFile);
  }

  const defaultEvidenceFile = resolve(root, DEFAULT_EVIDENCE_FILE);
  return existsSync(defaultEvidenceFile) ? defaultEvidenceFile : undefined;
}

export function renderV1AcceptanceStatus(
  status: V1AcceptanceStatusReport,
  format: V1AcceptanceStatusFormat,
): string {
  if (format === "json") {
    return `${JSON.stringify(status, null, 2)}\n`;
  }

  const lines = [
    "# V1 acceptance status",
    "",
    "This report does not run tests, deploy Cloud Run, call Substack, or prove manual client acceptance.",
    "Operator-supplied evidence files are records to review, not independent validation.",
    "",
    `Complete: ${status.complete ? "yes" : "no"}`,
    ...(status.evidence_file ? [`Evidence file: ${status.evidence_file}`] : []),
    `Local evidence available: ${status.summary.local_evidence_available}/${status.summary.total}`,
    `Manual/live evidence recorded: ${status.summary.manual_or_live_evidence_recorded}/${status.summary.total}`,
    `Manual/live evidence required: ${status.summary.manual_or_live_evidence_required}/${status.summary.total}`,
    `Missing local artifact: ${status.summary.missing_local_artifact}/${status.summary.total}`,
    ...(status.fixture_dir
      ? [`Live fixture directory: ${status.fixture_dir}`]
      : []),
    `Live fixture readiness: ${
      status.fixture_ready ? "yes" : "no"
    } (${status.fixture_present_count}/${status.fixture_required_count} present, ${status.fixture_valid_count}/${status.fixture_required_count} valid, ${status.fixture_compatible_count}/${status.fixture_required_count} adapter-compatible)`,
    "",
    "## Gates",
    ...status.gates.map(renderGate),
  ];

  return `${lines.join("\n")}\n`;
}

export function shouldFailV1AcceptanceStatus(
  status: Pick<V1AcceptanceStatusReport, "complete">,
  options: Pick<V1AcceptanceStatusRunOptions, "requireComplete">,
): boolean {
  return options.requireComplete && !status.complete;
}

function gate(
  id: number,
  criterion: string,
  status: V1GateStatus,
  evidence: string,
  nextAction: string,
): V1AcceptanceGate {
  return {
    id,
    criterion,
    status,
    evidence,
    next_action: nextAction,
  };
}

function summarizeGates(
  gates: readonly V1AcceptanceGate[],
): V1AcceptanceSummary {
  return {
    total: gates.length,
    local_evidence_available: gates.filter(
      (gate) => gate.status === "local_evidence_available",
    ).length,
    manual_or_live_evidence_recorded: gates.filter(
      (gate) => gate.status === "manual_or_live_evidence_recorded",
    ).length,
    manual_or_live_evidence_required: gates.filter(
      (gate) => gate.status === "manual_or_live_evidence_required",
    ).length,
    missing_local_artifact: gates.filter(
      (gate) => gate.status === "missing_local_artifact",
    ).length,
  };
}

function renderGate(gate: V1AcceptanceGate): string {
  return [
    `- ${gate.id}. ${gate.status}: ${gate.criterion}`,
    `  Evidence: ${gate.evidence}`,
    `  Next: ${gate.next_action}`,
  ].join("\n");
}

function applyRecordedEvidence(
  gates: readonly V1AcceptanceGate[],
  recordedEvidence: ReadonlyMap<number, V1RecordedGateEvidence>,
  fixtureStatus: SubstackFixtureStatus,
  root: string,
): readonly V1AcceptanceGate[] {
  if (recordedEvidence.size === 0) {
    return gates;
  }

  return gates.map((gate) => {
    const evidence = recordedEvidence.get(gate.id);
    if (!evidence || gate.status !== "manual_or_live_evidence_required") {
      return gate;
    }

    const safetyProblem = recordedEvidenceSafetyProblem(root, evidence);
    if (safetyProblem) {
      return {
        ...gate,
        evidence: `${gate.evidence} Recorded evidence (${evidence.verified_at}) could not be accepted: ${safetyProblem}`,
        next_action:
          "Redact, remove, or restore the recorded evidence and artifact before release.",
      };
    }

    if (!evidence.artifact) {
      return {
        ...gate,
        evidence: `${gate.evidence} Recorded evidence (${evidence.verified_at}) is missing an artifact path; run v1:record with --artifact <path> after writing a durable evidence artifact.`,
        next_action:
          "Write or restore a durable evidence artifact and re-record this gate with --artifact before release.",
      };
    }

    if (gate.id === 7 && !fixtureStatus.ready) {
      return {
        ...gate,
        evidence: `${gate.evidence} Recorded evidence (${evidence.verified_at}): ${evidence.evidence} Fixture readiness is still required before this gate can be recorded complete.`,
      };
    }

    return {
      ...gate,
      status: "manual_or_live_evidence_recorded",
      evidence: recordedEvidenceText(gate.evidence, evidence),
      next_action:
        "Review the recorded evidence before release and keep the referenced artifact available.",
    };
  });
}

function recordedEvidenceText(
  originalEvidence: string,
  recorded: V1RecordedGateEvidence,
): string {
  const parts = [
    originalEvidence,
    `Recorded evidence (${recorded.verified_at}): ${recorded.evidence}`,
  ];
  if (recorded.command) {
    parts.push(`Command: ${recorded.command}`);
  }
  if (recorded.artifact) {
    parts.push(`Artifact: ${recorded.artifact}`);
  }
  return parts.join(" ");
}

function richDraftEvidence(
  fixtureStatus: SubstackFixtureStatus,
  implementationNotes: string,
): string {
  const fixtureText = fixtureStatus.ready
    ? "All live fixture files are present, feature-valid, and adapter-compatible."
    : [
        "Live fixtures are not ready",
        `(${fixtureStatus.present_count}/${fixtureStatus.required_count} present,`,
        `${fixtureStatus.valid_count}/${fixtureStatus.required_count} valid,`,
        `${fixtureStatus.compatible_count}/${fixtureStatus.required_count} adapter-compatible).`,
      ].join(" ");
  const liveHarnessText = implementationNotes.includes(
    "Guarded live integration",
  )
    ? "Guarded live integration harness is documented."
    : "Guarded live integration harness is not documented in implementation notes.";
  return `${fixtureText} ${liveHarnessText}`;
}

function richDraftNextAction(fixtureStatus: SubstackFixtureStatus): string {
  const fixtureStatusReviewCommand = fixtureStatusCommand(
    fixtureStatus.capture_fixture_dir_arg,
    false,
  );
  const fixtureStatusGateCommand = fixtureStatusCommand(
    fixtureStatus.capture_fixture_dir_arg,
    true,
  );
  const compatibilityTestCommand = fixtureCompatibilityTestCommand(
    fixtureStatus.capture_fixture_dir_arg,
  );
  return `Run \`${fixtureStatusReviewCommand}\` for per-fixture capture commands, capture missing or stale fixtures, run \`${fixtureStatusGateCommand}\`, run \`${compatibilityTestCommand}\` so the captured Substack shapes are asserted by tests, run \`V1_LIVE_SUBSTACK_EVIDENCE_ARTIFACTS=.data/v1/gate-07-rich-draft-live-fixtures.md,.data/v1/gate-08-update-draft-live.md,.data/v1/gate-09-read-drafts-live.md RUN_LIVE_SUBSTACK_TESTS=1 npm run test:live\`, complete the gate 7 fixture provenance review, and manually review the draft in Substack.`;
}

function localArtifactGate(
  root: string,
  paths: readonly string[],
): V1GateStatus {
  return paths.every((path) => fileExists(root, path))
    ? "local_evidence_available"
    : "missing_local_artifact";
}

function localInspectorCliGate(
  root: string,
  packageJson: PackageJson,
  readme: string,
): V1GateStatus {
  return hasScript(packageJson, "smoke:inspector") &&
    hasScript(packageJson, "smoke:http-local") &&
    readme.includes("@modelcontextprotocol/inspector") &&
    readme.includes("npm run smoke:inspector") &&
    [
      "scripts/smokeLocalHttp.ts",
      "scripts/smokeLocalHttpCore.ts",
      "scripts/localHttpEvidence.ts",
      "tests/scripts/smokeLocalHttp.test.ts",
    ].every((path) => fileExists(root, path))
    ? "local_evidence_available"
    : "missing_local_artifact";
}

function readPackageJson(root: string): PackageJson {
  try {
    return JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as
      | PackageJson
      | Record<string, unknown>;
  } catch {
    return {};
  }
}

function readEvidenceFile(
  filePath: string,
): Map<number, V1RecordedGateEvidence> {
  const evidenceFile = readV1EvidenceFile(filePath);
  const evidenceByGate = new Map<number, V1RecordedGateEvidence>();
  for (const evidence of evidenceFile.gates) {
    if (!isManualOrLiveGateId(evidence.id)) {
      throw new Error(
        `V1 evidence gate ${evidence.id} is repo-local and cannot be recorded in the manual/live evidence file. Record one of: ${MANUAL_OR_LIVE_GATE_ID_TEXT}.`,
      );
    }
    if (evidenceByGate.has(evidence.id)) {
      throw new Error(`Duplicate V1 evidence entry for gate ${evidence.id}.`);
    }
    evidenceByGate.set(evidence.id, evidence);
  }
  return evidenceByGate;
}

export function readV1EvidenceFile(filePath: string): V1EvidenceFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid V1 evidence file JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  return parseV1EvidenceFile(parsed);
}

export function parseV1EvidenceFile(value: unknown): V1EvidenceFile {
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.gates)) {
    throw new Error(
      "V1 evidence file must contain { version: 1, gates: [...] }.",
    );
  }

  return {
    version: 1,
    gates: value.gates.map(parseV1EvidenceEntry),
  };
}

export function parseV1EvidenceEntry(value: unknown): V1RecordedGateEvidence {
  if (!isRecord(value)) {
    throw new Error("Each V1 evidence gate entry must be an object.");
  }

  const id = value.id;
  if (typeof id !== "number" || !Number.isInteger(id) || id < 1 || id > 17) {
    throw new Error("V1 evidence gate id must be an integer from 1 to 17.");
  }

  const verifiedAt = readNonEmptyString(value.verified_at, "verified_at");
  if (Number.isNaN(Date.parse(verifiedAt))) {
    throw new Error("V1 evidence verified_at must be a parseable timestamp.");
  }

  return {
    id,
    verified_at: verifiedAt,
    evidence: readNonEmptyString(value.evidence, "evidence"),
    ...(value.command !== undefined
      ? { command: readNonEmptyString(value.command, "command") }
      : {}),
    ...(value.artifact !== undefined
      ? { artifact: readNonEmptyString(value.artifact, "artifact") }
      : {}),
  };
}

function readNonEmptyString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `V1 evidence field ${fieldName} must be a non-empty string.`,
    );
  }
  return value;
}

function isManualOrLiveGateId(
  gateId: number,
): gateId is (typeof MANUAL_OR_LIVE_GATE_IDS)[number] {
  return MANUAL_OR_LIVE_GATE_IDS.includes(
    gateId as (typeof MANUAL_OR_LIVE_GATE_IDS)[number],
  );
}

function readOptionalText(root: string, path: string): string {
  try {
    return readFileSync(resolve(root, path), "utf8");
  } catch {
    return "";
  }
}

function hasScript(packageJson: PackageJson, scriptName: string): boolean {
  return typeof packageJson.scripts?.[scriptName] === "string";
}

function fileExists(root: string, path: string): boolean {
  return existsSync(resolve(root, path));
}

function readmeIncludesAll(
  readme: string,
  requiredSnippets: readonly string[],
): boolean {
  return requiredSnippets.every((snippet) => readme.includes(snippet));
}

function parseFormat(value: string): V1AcceptanceStatusFormat {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
