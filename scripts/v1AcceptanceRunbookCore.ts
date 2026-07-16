import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { DEFAULT_CLOUD_RUN_SERVICE_NAME } from "./cloudRunPlanCore.js";
import {
  captureFixtureCommand,
  fixtureCompatibilityTestCommand,
  fixtureStatusCommand,
} from "./fixtureStatusCore.js";
import {
  buildV1AcceptanceStatus,
  type V1AcceptanceGate,
  type V1AcceptanceStatusReport,
} from "./v1AcceptanceStatusCore.js";
import { requiredCloudRunLogChecklistLabels } from "./v1EvidenceSafety.js";

const REQUIRED_FIXTURE_KINDS = [
  "inline-marks",
  "image",
  "code-block",
  "latex-block",
] as const;

export interface V1AcceptanceRunbookRunOptions {
  readonly help: false;
  readonly cwd: string;
  readonly evidenceFile?: string | undefined;
  readonly fixtureDir?: string | undefined;
  readonly output?: string | undefined;
  readonly gateIds?: readonly number[] | undefined;
  readonly mcpPathSecret?: string | undefined;
  readonly writeArtifacts: boolean;
}

export interface V1AcceptanceRunbookHelpOptions {
  readonly help: true;
}

export type V1AcceptanceRunbookOptions =
  | V1AcceptanceRunbookRunOptions
  | V1AcceptanceRunbookHelpOptions;

export interface V1AcceptanceRunbookResult {
  readonly markdown: string;
  readonly output?: string | undefined;
  readonly artifacts: readonly V1AcceptanceRunbookArtifact[];
  readonly manual_gate_count: number;
  readonly complete: boolean;
  readonly fixture_dir?: string | undefined;
  readonly fixture_capture_dir_arg?: string | undefined;
  readonly mcp_path_secret?: string | undefined;
}

export interface V1AcceptanceRunbookArtifact {
  readonly gate_id: number;
  readonly path: string;
  readonly created: boolean;
}

export function parseV1AcceptanceRunbookArgs(
  args: readonly string[],
  cwd = process.cwd(),
): V1AcceptanceRunbookOptions {
  let evidenceFile: string | undefined;
  let fixtureDir = resolve(cwd, "fixtures", "substack");
  let output: string | undefined;
  let mcpPathSecret: string | undefined;
  const gateIds: number[] = [];
  let writeArtifacts = false;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--evidence-file":
        evidenceFile = resolveInsideCwd(cwd, readValue(args, index, arg));
        index += 1;
        break;
      case "--fixture-dir":
        fixtureDir = resolveInsideCwd(cwd, readValue(args, index, arg), arg);
        index += 1;
        break;
      case "--output":
        output = resolveInsideCwd(cwd, readValue(args, index, arg));
        index += 1;
        break;
      case "--gate":
        gateIds.push(parseGateId(readValue(args, index, arg)));
        index += 1;
        break;
      case "--mcp-path-secret":
        mcpPathSecret = requiredString(readValue(args, index, arg), arg);
        index += 1;
        break;
      case "--write-artifacts":
        writeArtifacts = true;
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
    ...(output ? { output } : {}),
    ...(gateIds.length > 0 ? { gateIds: uniqueGateIds(gateIds) } : {}),
    ...(mcpPathSecret ? { mcpPathSecret } : {}),
    writeArtifacts,
  };
}

export function v1AcceptanceRunbookUsage(): string {
  return [
    "Usage: npm run v1:runbook -- [options]",
    "",
    "Renders a Markdown runbook for the manual/live V1 acceptance gates that",
    "still need evidence. This command does not run tests, call Substack,",
    "open ChatGPT, deploy Cloud Run, or independently prove acceptance.",
    "",
    "Options:",
    "  --evidence-file <path> Project-local JSON evidence file to overlay, same as v1:status.",
    "  --fixture-dir <path>   Project-local live fixture directory. Default: fixtures/substack.",
    "  --output <path>        Project-local Markdown file to write. Default: stdout.",
    "  --gate <id>            Render/write one manual/live gate. Repeat to include multiple gates.",
    "  --mcp-path-secret <name> Include optional Cloud Run MCP_PATH_SECRET Secret Manager checks in gate 12/13 commands.",
    "  --write-artifacts      Create missing suggested evidence Markdown templates under .data/v1/.",
    "  --help                 Show this help.",
    "",
    "Examples:",
    "  npm run v1:runbook",
    "  npm run v1:runbook -- --gate 7",
    "  npm run v1:runbook -- --gate 7 --fixture-dir fixtures/live",
    "  npm run v1:runbook -- --gate 12 --mcp-path-secret mcp-path-secret",
    "  npm run v1:runbook -- --gate 7 --write-artifacts",
    "  npm run v1:runbook -- --output .data/v1/manual-acceptance-runbook.md",
    "  npm run v1:runbook -- --write-artifacts",
    "  npm run v1:runbook -- --evidence-file .data/v1-acceptance-evidence.json",
  ].join("\n");
}

export function buildV1AcceptanceRunbook(
  options: Pick<
    V1AcceptanceRunbookRunOptions,
    "cwd" | "evidenceFile" | "gateIds" | "mcpPathSecret"
  > & {
    readonly fixtureDir?: string | undefined;
  },
): V1AcceptanceRunbookResult {
  const status = buildV1AcceptanceStatus({
    cwd: options.cwd,
    evidenceFile: options.evidenceFile,
    fixtureDir: options.fixtureDir,
  });
  const markdown = renderV1AcceptanceRunbook(status, options.gateIds, {
    mcpPathSecret: options.mcpPathSecret,
  });
  const manualGates = statusManualGates(status, options.gateIds);
  return {
    markdown,
    artifacts: manualGates.map((gate) => ({
      gate_id: gate.id,
      path: suggestedArtifactPath(gate),
      created: false,
    })),
    manual_gate_count: manualGates.length,
    complete: status.complete,
    fixture_dir: status.fixture_dir,
    ...(status.fixture_capture_dir_arg
      ? { fixture_capture_dir_arg: status.fixture_capture_dir_arg }
      : {}),
    ...(options.mcpPathSecret
      ? { mcp_path_secret: options.mcpPathSecret }
      : {}),
  };
}

export function writeV1AcceptanceRunbook(
  options: V1AcceptanceRunbookRunOptions,
): V1AcceptanceRunbookResult {
  const result = buildV1AcceptanceRunbook(options);
  const artifacts = options.writeArtifacts
    ? writeEvidenceArtifactTemplates(
        options.cwd,
        result.artifacts,
        result.fixture_capture_dir_arg,
        options.mcpPathSecret,
      )
    : result.artifacts;
  if (!options.output) {
    return {
      ...result,
      artifacts,
    };
  }

  mkdirSync(dirname(options.output), { recursive: true });
  writeFileSync(options.output, result.markdown);
  return {
    ...result,
    artifacts,
    output: options.output,
  };
}

export function renderV1AcceptanceRunbook(
  status: V1AcceptanceStatusReport,
  gateIds?: readonly number[] | undefined,
  commandOptions: {
    readonly mcpPathSecret?: string | undefined;
  } = {},
): string {
  const manualGates = statusManualGates(status, gateIds);
  const finalStatusCommand = v1StatusRequireCompleteCommand(
    status.fixture_capture_dir_arg,
  );
  const lines = [
    "# V1 manual/live acceptance runbook",
    "",
    "This runbook is generated from `npm run v1:status`. It does not run tests, call Substack, open ChatGPT, deploy Cloud Run, or independently prove acceptance.",
    "",
    "## Status",
    "",
    `- Complete: ${status.complete ? "yes" : "no"}`,
    `- Local evidence available: ${status.summary.local_evidence_available}/${status.summary.total}`,
    `- Manual/live evidence recorded: ${status.summary.manual_or_live_evidence_recorded}/${status.summary.total}`,
    `- Manual/live evidence still required: ${status.summary.manual_or_live_evidence_required}/${status.summary.total}`,
    `- Missing local artifacts: ${status.summary.missing_local_artifact}/${status.summary.total}`,
    ...(status.fixture_dir
      ? [`- Live fixture directory: ${status.fixture_dir}`]
      : []),
    `- Live fixtures: ${status.fixture_present_count}/${status.fixture_required_count} present, ${status.fixture_valid_count}/${status.fixture_required_count} valid, ${status.fixture_compatible_count}/${status.fixture_required_count} adapter-compatible`,
    ...(gateIds && gateIds.length > 0
      ? [`- Selected gates: ${uniqueGateIds(gateIds).join(", ")}`]
      : []),
    "",
    "## How To Use",
    "",
    "1. Run the suggested command or manual workflow for a gate.",
    "2. Save notes, screenshots, terminal output, or review details in the suggested artifact path when the gate needs durable evidence.",
    "3. Record the gate with `npm run v1:record`.",
    `4. Re-run \`${finalStatusCommand}\` before release.`,
    "",
    "## Manual/Live Gates",
    "",
  ];

  if (manualGates.length === 0) {
    lines.push(
      gateIds && gateIds.length > 0
        ? `No selected manual/live gates currently require evidence. Run \`${finalStatusCommand}\` for the final release gate.`
        : `No manual/live gates currently require evidence. Run \`${finalStatusCommand}\` for the final release gate.`,
    );
    return `${lines.join("\n")}\n`;
  }

  for (const gate of manualGates) {
    lines.push(
      ...renderRunbookGate(
        gate,
        status.fixture_capture_dir_arg,
        commandOptions.mcpPathSecret,
      ),
    );
  }

  return `${lines.join("\n")}\n`;
}

function renderRunbookGate(
  gate: V1AcceptanceGate,
  fixtureDirArg: string | undefined,
  mcpPathSecret: string | undefined,
): string[] {
  const artifact = suggestedArtifactPath(gate);
  const commands = suggestedCommands(gate, fixtureDirArg, mcpPathSecret);
  const checklist = suggestedEvidenceChecklist(
    gate.id,
    fixtureDirArg,
    mcpPathSecret,
  );
  return [
    `### Gate ${gate.id}: ${gate.criterion}`,
    "",
    `Current status: \`${gate.status}\``,
    "",
    `Current evidence: ${gate.evidence}`,
    "",
    `Next action: ${gate.next_action}`,
    "",
    "Suggested command or workflow:",
    "",
    "```bash",
    ...commands,
    "```",
    "",
    "Required evidence checklist:",
    "",
    ...checklist.map((item) => `- [ ] ${item}`),
    "",
    `Suggested artifact: \`${artifact}\``,
    "",
    "Suggested evidence record:",
    "",
    "```bash",
    v1RecordCommand(gate.id, artifact, fixtureDirArg),
    "```",
    "",
  ];
}

function statusManualGates(
  status: V1AcceptanceStatusReport,
  gateIds?: readonly number[] | undefined,
): readonly V1AcceptanceGate[] {
  const selected = gateIds && gateIds.length > 0 ? new Set(gateIds) : undefined;
  return status.gates.filter(
    (gate) =>
      gate.status === "manual_or_live_evidence_required" &&
      (selected === undefined || selected.has(gate.id)),
  );
}

function writeEvidenceArtifactTemplates(
  cwd: string,
  artifacts: readonly V1AcceptanceRunbookArtifact[],
  fixtureDirArg: string | undefined,
  mcpPathSecret: string | undefined,
): readonly V1AcceptanceRunbookArtifact[] {
  return artifacts.map((artifact) => {
    const artifactPath = resolveInsideCwd(cwd, artifact.path);
    if (existsSync(artifactPath)) {
      return artifact;
    }

    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(
      artifactPath,
      renderEvidenceArtifactTemplate(
        artifact.gate_id,
        artifact.path,
        fixtureDirArg,
        mcpPathSecret,
      ),
    );
    return {
      ...artifact,
      created: true,
    };
  });
}

function renderEvidenceArtifactTemplate(
  gateId: number,
  artifact: string,
  fixtureDirArg: string | undefined,
  mcpPathSecret: string | undefined,
): string {
  const commands = suggestedCommands(
    { id: gateId },
    fixtureDirArg,
    mcpPathSecret,
  );
  const checklist = suggestedEvidenceChecklist(
    gateId,
    fixtureDirArg,
    mcpPathSecret,
  );
  const detailSection = suggestedEvidenceDetailSection(gateId, fixtureDirArg);
  return `${[
    `# V1 Acceptance Evidence - Gate ${gateId}`,
    "",
    "This file is a local operator evidence template. Keep it concise and reviewable.",
    "Complete every checklist item and replace placeholder text before recording this artifact; `v1:record` and `v1:status` reject unchecked checkboxes and placeholders.",
    "",
    "Do not paste Substack session cookies, bearer tokens, OAuth tokens, preview token secrets, private credentials, or full draft bodies.",
    "",
    "## Command Or Workflow",
    "",
    "```bash",
    ...commands,
    "```",
    "",
    "## Required Evidence Checklist",
    "",
    ...checklist.map((item) => `- [ ] ${item}`),
    "",
    "## Evidence Summary",
    "",
    "- Result:",
    "- Verified at:",
    "- Reviewer:",
    "- Relevant draft or service URL:",
    "",
    ...detailSection,
    "## Evidence Notes",
    "",
    "-",
    "",
    "## Record Command",
    "",
    "```bash",
    v1RecordCommand(gateId, artifact, fixtureDirArg),
    "```",
    "",
  ].join("\n")}\n`;
}

function suggestedEvidenceDetailSection(
  gateId: number,
  fixtureDirArg: string | undefined,
): readonly string[] {
  switch (gateId) {
    case 7:
      return [
        "## Gate 7 Manual Review Details",
        "",
        `- Fixture directory: ${fixtureDirArg ?? "fixtures/substack"}`,
        `- Fixture readiness command: \`${fixtureStatusCommand(fixtureDirArg, true)}\``,
        `- Fixture compatibility command: \`${fixtureCompatibilityTestCommand(fixtureDirArg)}\``,
        "- Fixture provenance review:",
        "- Draft URL or ID: <replace with Substack draft URL or numeric draft ID from the live acceptance draft>",
        "- Title/subtitle review:",
        "- Text formatting review:",
        "- Image rendering review:",
        "- Native code block rendering review:",
        "- Native LaTeX rendering review:",
        "- Substack preview review:",
        "- Unpublished status review:",
        "- Cleanup decision: <replace with kept, deleted, or left for review without publishing>",
        "",
      ];
    case 8:
      return [
        "## Gate 8 Update Review Details",
        "",
        "- Draft URL or ID: <replace with Substack draft URL or numeric draft ID from the live update flow>",
        "- Created title before update:",
        "- Updated title after update:",
        "- Update command: <replace with guarded live run command or explicit live MCP/client update_draft workflow>",
        "- Field update review:",
        "- Unpublished status after update:",
        "- Post-update `get_draft` review:",
        "- Draft body handling review:",
        "- Cleanup decision: <replace with kept, deleted, or left for review without publishing>",
        "",
      ];
    case 9:
      return [
        "## Gate 9 Read Review Details",
        "",
        "- Draft URL or ID read: <replace with Substack draft URL or numeric draft ID from the live read flow>",
        "- `list_drafts` result:",
        "- `get_draft` result:",
        "- Metadata fields reviewed:",
        "- Body inclusion review:",
        "- Post-update readback review:",
        "- Raw body/content handling:",
        "- Follow-up action: <replace with no-action reason, cleanup decision, or concrete follow-up>",
        "",
      ];
    case 11:
      return [
        "## Gate 11 ChatGPT Connector Details",
        "",
        "- Connector URL: <replace with public HTTPS /mcp URL or screenshot reference>",
        "- ChatGPT surface tested: <replace with workspace/account or connector screen reference>",
        "- Tool-list result: <replace with exactly seven V1 draft-workflow tools listed through the ChatGPT connector>",
        "- Manual flow result: <replace with ChatGPT validate/preview/create draft summary>",
        "- Draft or review reference: <replace with non-sensitive Substack draft URL, numeric draft ID, screenshot reference, or manual review reference>",
        "- Tunnel exposure window: <replace with bounded start/end time or numeric duration>",
        "- Unexpected traffic review: <replace with checked ngrok/local logs and no unexpected traffic or handled findings>",
        "- Rotation decision: <replace with rotated/stopped/not rotated plus reason>",
        "",
      ];
    case 12:
      return [
        "## Gate 12 Cloud Run Deployment Details",
        "",
        "- GCP project/region/service: <replace with non-sensitive project, region, and service reference>",
        "- Service URL checked: <replace with deployed Cloud Run HTTPS service URL and check reference>",
        "- Deploy command source: <replace with cloud-run:plan artifact or gcloud deploy command summary>",
        "- Health check result: <replace with /healthz status and timestamp>",
        "- Remote smoke result: <replace with auth-mode matching remote smoke command and result>",
        "- Auth mode deployed: <replace with noauth, static_bearer, or oauth and launch rationale>",
        "- Budget guard review: <replace with budget alert command/result or follow-up>",
        "- Path-secret review: <replace with not used or shell-only private path verification without the segment value>",
        "",
      ];
    case 13:
      return [
        "## Gate 13 Secret Manager Details",
        "",
        "- Secret references checked: <replace with Secret Manager reference check summary for SUBSTACK_SESSION_TOKEN and PREVIEW_TOKEN_SECRET>",
        "- Required secret names: <replace with session and preview Secret Manager resource names only, no values>",
        "- Runtime service account: <replace with deployed runtime service account email or service identity reference>",
        "- Secret access bindings: <replace with Secret Manager Secret Accessor IAM binding verification for the runtime service account>",
        "- Version policy: <replace with latest/pinned version decision and rotation notes>",
        "- Literal env review: <replace with confirmation secrets are references, not literal env values>",
        "- Secret value handling: <replace with confirmation no raw secret values were opened, pasted, exposed, or recorded>",
        "- Rotation follow-up: <replace with no-action reason or rotation/redeploy follow-up>",
        "",
      ];
    case 14:
      return [
        "## Gate 14 Header-Capable Client Details",
        "",
        "- Client tested: <replace with real header-capable HTTP client name and version>",
        "- Endpoint tested: <replace with public HTTPS /mcp endpoint tested through the header-capable client>",
        "- Header configuration method: <replace with how Authorization header was configured without the token value>",
        "- Tool-list result: <replace with exact seven V1 draft-workflow tools listed through the client>",
        "- Validation call result: <replace with validate_newsletter_content success through the client>",
        "- Rejection proof: <replace with missing and wrong bearer 401 rejection command or artifact reference>",
        "- Token redaction review: <replace with confirmation that no bearer token or token value is included, recorded, printed, pasted, exposed, or logged>",
        "",
      ];
    case 15:
      return [
        "## Gate 15 Manual Client Details",
        "",
        "- Client tested: <replace with Claude Code or Cursor version>",
        "- Config path or add command: <replace with Claude Code/Cursor stdio config path or add command>",
        "- Server entrypoint path: <replace with absolute path to dist/stdio.js>",
        "- Tool-list result: <replace with exact seven V1 draft-workflow tools listed through Claude Code or Cursor>",
        "- Validation call result: <replace with validate_newsletter_content success through Claude Code or Cursor>",
        "- Credential locality review: <replace with confirmation that Substack credentials came from local environment variables and were not recorded, committed, pasted into client config, or exposed remotely>",
        "",
      ];
    case 16:
      return [
        "## Gate 16 Cloud Run Log Review Details",
        "",
        "- Log export window: <replace with live Cloud Run log export start/end time or query window>",
        "- Cloud Run service/revision: <replace with Cloud Run service name and revision or service URL reference>",
        "- Live traffic exercised: <replace with acceptance traffic summary>",
        "- Log export command: <replace with gcloud logging read command including Cloud Run resource filter>",
        "- Verifier command: <replace with cloud-run:logs:verify command including --logs-json and --require-audit-events>",
        "- Audit event review: <replace with audit count and metadata-only confirmation>",
        "- Finding review: <replace with no findings or sanitized finding-category/count summary>",
        "- Raw log handling: <replace with retained/deleted path and access decision>",
        "- Follow-up action: <replace with rotation/redeploy/no action and reason>",
        "",
      ];
    default:
      return [];
  }
}

function suggestedEvidenceChecklist(
  gateId: number,
  fixtureDirArg?: string | undefined,
  mcpPathSecret?: string | undefined,
): readonly string[] {
  switch (gateId) {
    case 3:
      return [
        "MCP Inspector connected to `http://localhost:8787/mcp`.",
        "Inspector listed exactly the seven V1 draft-workflow tools.",
        "No publish, delete, schedule, email, or Notes tool appeared.",
      ];
    case 7:
      return [
        `\`${fixtureStatusCommand(fixtureDirArg, false)}\` was reviewed for any per-fixture capture or recapture actions.`,
        `\`${fixtureStatusCommand(fixtureDirArg, true)}\` passed with all four fixtures present, valid, and adapter-compatible.`,
        `\`${fixtureCompatibilityTestCommand(fixtureDirArg)}\` passed after live fixtures were captured.`,
        "Gate 7 fixture provenance identifies how each live fixture was captured or manually reviewed so adapter compatibility is not treated as native editor proof by itself.",
        "`RUN_LIVE_SUBSTACK_TESTS=1 npm run test:live` created a draft without publishing it.",
        "Manual Substack review confirmed title, subtitle, text formatting, image rendering, native code block rendering, native LaTeX rendering, preview behavior, unpublished status, and cleanup decision.",
      ];
    case 8:
      return [
        "Guarded live test updated an existing unpublished draft.",
        "Manual Substack review confirmed the draft remained unpublished.",
        "Evidence identifies a Substack draft URL or numeric draft ID without including draft body contents.",
        "Gate 8 update review details identify the live draft, title transition, update command, field update result, unpublished status, post-update readback, body handling, and cleanup decision without publishing.",
      ];
    case 9:
      return [
        "Live read flow listed recent drafts from the target publication.",
        "`get_draft` returned metadata for the expected unpublished draft.",
        "Evidence identifies a Substack draft URL or numeric draft ID from the live read flow.",
        "Evidence excludes full draft bodies unless a separate fixture capture command intentionally produced sanitized fixture JSON.",
        "Gate 9 read review details identify the draft, list result, get result, metadata reviewed, body-inclusion decision, post-update readback, raw-content handling, and follow-up action.",
      ];
    case 11:
      return [
        "Local server was exposed through a short-lived HTTPS tunnel.",
        "`npm run smoke:ngrok-noauth` launched local HTTP, started ngrok, and passed the remote noauth smoke.",
        "ChatGPT connector listed tools and completed the intended manual flow.",
        "Gate 11 ChatGPT connector details identify the public HTTPS /mcp connector URL, ChatGPT surface, exact seven-tool result, manual flow result, non-sensitive draft or review reference, tunnel exposure window, unexpected-traffic review, and rotation decision.",
      ];
    case 12:
      return [
        "Cloud Run deploy command completed in the target GCP project.",
        "Exported service JSON was verified with `npm run cloud-run:verify`, including OAuth metadata env when deployed with `AUTH_MODE=oauth`.",
        "Remote `/healthz` and the appropriate remote MCP smoke passed against the deployed service URL.",
        ...(mcpPathSecret
          ? [
              "`MCP_PATH_SECRET` was kept in the shell and remote smoke used the private `/mcp/<secret>` path without recording the path segment.",
            ]
          : []),
        "Gate 12 Cloud Run deployment details identify the project/region/service, service URL check, deploy command source, health check, remote smoke, deployed auth mode, budget guard, and path-secret review.",
      ];
    case 13:
      return [
        "`cloud-run:verify` confirmed Secret Manager references for required runtime secrets and OAuth metadata env when deployed with `AUTH_MODE=oauth`.",
        "Service account secret-access bindings were created for the deployed Cloud Run service account.",
        ...(mcpPathSecret
          ? [
              `\`cloud-run:verify -- --mcp-path-secret ${mcpPathSecret}\` confirmed \`MCP_PATH_SECRET\` is a Secret Manager reference, not a literal env var.`,
            ]
          : []),
        "No raw Substack session token, preview secret, or bearer token value is included in this artifact.",
        "Gate 13 Secret Manager details identify the required secret references, secret names, runtime service account, access bindings, version policy, literal-env review, secret-value handling, and rotation follow-up.",
      ];
    case 14:
      return [
        "Remote HTTP client sent the configured `Authorization: Bearer` header.",
        "`npm run smoke:ngrok-static-bearer` passed against a public tunnel or `npm run smoke:remote` passed against another remote endpoint, including missing/wrong bearer `401` rejection checks.",
        "Evidence confirms missing or wrong bearer tokens are rejected, without including the token value.",
        "Gate 14 header-capable client details identify the client version, public HTTPS /mcp endpoint reference, header configuration method, tool-list result, validation result, rejection proof, and token-redaction review.",
      ];
    case 15:
      return [
        "Built stdio entrypoint was configured in Claude Code or Cursor with local env-based credentials.",
        "Client listed the V1 draft-workflow tools.",
        "Client successfully called `validate_newsletter_content`.",
        "Gate 15 manual client details identify the client version, Claude Code/Cursor stdio config path or add command, entrypoint path, tool-list result, validation result, and local-credentials review.",
      ];
    case 16:
      return [...requiredCloudRunLogChecklistLabels()];
    default:
      return [
        "Manual workflow completed.",
        "Evidence is concise, reviewable, and free of secrets.",
      ];
  }
}

function suggestedArtifactPath(gate: Pick<V1AcceptanceGate, "id">): string {
  return `.data/v1/gate-${String(gate.id).padStart(2, "0")}-${gateSlug(gate.id)}.md`;
}

function gateSlug(id: number): string {
  switch (id) {
    case 3:
      return "mcp-inspector";
    case 7:
      return "rich-draft-live-fixtures";
    case 8:
      return "update-draft-live";
    case 9:
      return "read-drafts-live";
    case 11:
      return "chatgpt-ngrok";
    case 12:
      return "cloud-run-deployment";
    case 13:
      return "cloud-run-secrets";
    case 14:
      return "static-bearer-remote";
    case 15:
      return "stdio-client";
    case 16:
      return "cloud-run-logs";
    default:
      return "manual-evidence";
  }
}

function suggestedCommands(
  gate: Pick<V1AcceptanceGate, "id">,
  fixtureDirArg?: string | undefined,
  mcpPathSecret?: string | undefined,
): readonly string[] {
  switch (gate.id) {
    case 3:
      return [
        "npm run build",
        "npm run smoke:inspector -- --evidence-artifact .data/v1/gate-03-mcp-inspector.md",
      ];
    case 7:
      return [
        fixtureStatusCommand(fixtureDirArg, false),
        "# If only one fixture is missing or stale, capture that fixture directly:",
        ...REQUIRED_FIXTURE_KINDS.map((kind) =>
          captureFixtureCommand(kind, fixtureDirArg),
        ),
        "# Or capture all four required fixtures in one live run:",
        captureFixtureCommand("all", fixtureDirArg),
        fixtureStatusCommand(fixtureDirArg, true),
        fixtureCompatibilityTestCommand(fixtureDirArg),
        "V1_LIVE_SUBSTACK_EVIDENCE_ARTIFACTS=.data/v1/gate-07-rich-draft-live-fixtures.md,.data/v1/gate-08-update-draft-live.md,.data/v1/gate-09-read-drafts-live.md RUN_LIVE_SUBSTACK_TESTS=1 npm run test:live",
      ];
    case 8:
      return [
        "V1_LIVE_SUBSTACK_EVIDENCE_ARTIFACTS=.data/v1/gate-07-rich-draft-live-fixtures.md,.data/v1/gate-08-update-draft-live.md,.data/v1/gate-09-read-drafts-live.md RUN_LIVE_SUBSTACK_TESTS=1 npm run test:live",
        "# Then complete the update review detail fields in the artifact without pasting draft body content.",
      ];
    case 9:
      return [
        "V1_LIVE_SUBSTACK_EVIDENCE_ARTIFACTS=.data/v1/gate-07-rich-draft-live-fixtures.md,.data/v1/gate-08-update-draft-live.md,.data/v1/gate-09-read-drafts-live.md RUN_LIVE_SUBSTACK_TESTS=1 npm run test:live",
        "# Then complete the read review detail fields in the artifact without pasting raw draft body content.",
      ];
    case 11:
      return [
        "npm run build",
        "npm run mcp:preflight -- --require-live",
        "npm run smoke:ngrok-noauth -- --use-local-credentials --hold-open-seconds 900 --evidence-artifact .data/v1/gate-11-chatgpt-ngrok.md",
        "# While the live endpoint notice is displayed, register or refresh the ChatGPT connector and complete the manual flow.",
        "# After the bounded window closes, complete the connector-detail fields in the artifact.",
      ];
    case 12:
      return [
        cloudRunPlanCommand(mcpPathSecret),
        "SERVICE_URL=$(gcloud run services describe substack-draft-mcp --region us-central1 --format='value(status.url)')",
        "mkdir -p .data && gcloud run services describe substack-draft-mcp --region us-central1 --format=json > .data/cloud-run-service.json",
        cloudRunVerifyCommand(
          ".data/v1/gate-12-cloud-run-deployment.md",
          mcpPathSecret,
        ),
        oauthCloudRunVerifyComment(),
        'curl --fail --show-error "$SERVICE_URL/healthz"',
        "# Run the auth-mode matching remote smoke from the `cloud-run:plan` follow-up output.",
        staticBearerRemoteSmokeCommand(mcpPathSecret),
        noAuthRemoteSmokeComment(mcpPathSecret),
        oauthRemoteSmokeComment(mcpPathSecret),
        "# Then complete the Cloud Run deployment detail fields in the artifact without pasting raw service JSON or secret values.",
      ];
    case 13:
      return [
        "mkdir -p .data && gcloud run services describe substack-draft-mcp --region us-central1 --format=json > .data/cloud-run-service.json",
        cloudRunVerifyCommand(
          ".data/v1/gate-13-cloud-run-secrets.md",
          mcpPathSecret,
        ),
        oauthCloudRunVerifyComment(),
        "# Then complete the Secret Manager detail fields in the artifact without opening or pasting secret values.",
      ];
    case 14:
      return [
        "npm run build",
        ': "$' +
          '{MCP_BEARER_TOKEN:?Set MCP_BEARER_TOKEN to a local test token first}"',
        "npm run smoke:ngrok-static-bearer -- --bearer-token-env MCP_BEARER_TOKEN --hold-open-seconds 900 --evidence-artifact .data/v1/gate-14-static-bearer-remote.md",
        "# While the live endpoint notice is displayed, connect a real header-capable HTTP client and complete the manual flow.",
        "# After the bounded window closes, complete the client-detail fields in the artifact.",
      ];
    case 15:
      return [
        "npm run build",
        "npm run smoke:stdio -- --evidence-artifact .data/v1/gate-15-stdio-client.md",
        "# Then connect Claude Code or Cursor through stdio and complete the manual checklist and client-detail fields in the artifact.",
      ];
    case 16:
      return [
        `mkdir -p .data && gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="${DEFAULT_CLOUD_RUN_SERVICE_NAME}"' --format=json --limit=100 > .data/cloud-run-logs.json`,
        "npm run cloud-run:logs:verify -- --logs-json .data/cloud-run-logs.json --require-audit-events --evidence-artifact .data/v1/gate-16-cloud-run-logs.md",
        "# Then complete the manual log-review detail fields in the artifact without pasting raw log entries.",
      ];
    default:
      return ["# Run the manual workflow described in the gate next action."];
  }
}

function cloudRunPlanCommand(mcpPathSecret?: string | undefined): string {
  return [
    "npm run cloud-run:plan -- --project-id <id> --publication-url <url> --user-id <id>",
    ...(mcpPathSecret ? [`--mcp-path-secret ${shellArg(mcpPathSecret)}`] : []),
  ].join(" ");
}

function cloudRunVerifyCommand(
  evidenceArtifact: string,
  mcpPathSecret?: string | undefined,
): string {
  return [
    "npm run cloud-run:verify -- --service-json .data/cloud-run-service.json",
    "--auth-mode <mode>",
    "--publication-url <url>",
    "--user-id <id>",
    "--max-body-bytes 750000",
    "--max-image-bytes 8000000",
    "--substack-request-timeout-ms 30000",
    "--confirmation-token-ttl-seconds 900",
    ...(mcpPathSecret ? [`--mcp-path-secret ${shellArg(mcpPathSecret)}`] : []),
    `--evidence-artifact ${shellArg(evidenceArtifact)}`,
  ].join(" ");
}

function oauthCloudRunVerifyComment(): string {
  return "# For OAuth deployments, use the full `cloud-run:plan` generated `cloud-run:verify` command or add `--public-base-url`, `--oauth-authorization-server-url`, `--oauth-jwks-url`, optional `--oauth-resource-documentation-url`, and `--oauth-jwt-algorithms`.";
}

function staticBearerRemoteSmokeCommand(
  mcpPathSecret?: string | undefined,
): string {
  return [
    mcpPathSecretGuard(mcpPathSecret),
    ': "$' +
      '{MCP_BEARER_TOKEN:?Set MCP_BEARER_TOKEN to the deployed static bearer token first}" && MCP_BEARER_TOKEN="$MCP_BEARER_TOKEN" npm run smoke:remote -- --url',
    mcpEndpointUrl(mcpPathSecret),
    "--evidence-artifact .data/v1/gate-14-static-bearer-remote.md",
  ]
    .filter(Boolean)
    .join(" ");
}

function noAuthRemoteSmokeComment(mcpPathSecret?: string | undefined): string {
  return [
    "# For noauth testing:",
    mcpPathSecretGuard(mcpPathSecret),
    "npm run smoke:remote-noauth -- --url",
    mcpEndpointUrl(mcpPathSecret),
  ]
    .filter(Boolean)
    .join(" ");
}

function oauthRemoteSmokeComment(mcpPathSecret?: string | undefined): string {
  return [
    "# For OAuth testing:",
    mcpPathSecretGuard(mcpPathSecret),
    ': "$' +
      '{MCP_OAUTH_BEARER_TOKEN:?Set MCP_OAUTH_BEARER_TOKEN to a real access token first}" && MCP_OAUTH_BEARER_TOKEN="$MCP_OAUTH_BEARER_TOKEN" npm run smoke:remote-oauth -- --url',
    mcpEndpointUrl(mcpPathSecret),
    "--evidence-artifact .data/v1/remote-oauth.md",
  ]
    .filter(Boolean)
    .join(" ");
}

function mcpPathSecretGuard(mcpPathSecret?: string | undefined): string {
  return mcpPathSecret
    ? ': "$' +
        '{MCP_PATH_SECRET:?Set MCP_PATH_SECRET to the deployed MCP path segment first}" &&'
    : "";
}

function mcpEndpointUrl(mcpPathSecret?: string | undefined): string {
  return mcpPathSecret
    ? '"$SERVICE_URL/mcp/$MCP_PATH_SECRET"'
    : '"$SERVICE_URL/mcp"';
}

function v1StatusRequireCompleteCommand(
  fixtureDirArg?: string | undefined,
): string {
  const args = [
    "--evidence-file .data/v1-acceptance-evidence.json",
    ...(fixtureDirArg ? [`--fixture-dir ${shellArg(fixtureDirArg)}`] : []),
    "--require-complete",
  ];
  return `npm run v1:status -- ${args.join(" ")}`;
}

function v1RecordCommand(
  gateId: number,
  artifact: string,
  fixtureDirArg?: string | undefined,
): string {
  const args = [
    `--gate ${gateId}`,
    ...(fixtureDirArg ? [`--fixture-dir ${shellArg(fixtureDirArg)}`] : []),
    '--evidence "<replace with evidence summary>"',
    '--command "<replace with command or manual workflow>"',
    `--artifact ${shellArg(artifact)}`,
  ];
  return `npm run v1:record -- ${args.join(" ")}`;
}

function shellArg(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/u.test(value)) {
    return value;
  }

  return `'${value.replace(/'/g, "'\\''")}'`;
}

function resolveInsideCwd(cwd: string, value: string, flag = "path"): string {
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

function parseGateId(value: string): number {
  const gateId = Number(value);
  if (!Number.isInteger(gateId) || gateId < 1 || gateId > 17) {
    throw new Error("--gate must be an integer from 1 to 17.");
  }

  return gateId;
}

function requiredString(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`${name} is required.`);
  }

  return trimmed;
}

function uniqueGateIds(gateIds: readonly number[]): readonly number[] {
  return [...new Set(gateIds)];
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
