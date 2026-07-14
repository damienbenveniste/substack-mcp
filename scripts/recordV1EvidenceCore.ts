import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  parseV1EvidenceEntry,
  readV1EvidenceFile,
  type V1EvidenceFile,
  type V1RecordedGateEvidence,
} from "./v1AcceptanceStatusCore.js";
import {
  recordedEvidenceTextSafetyProblem,
  scanEvidenceArtifactText,
  verifiedAtSafetyProblem,
} from "./v1EvidenceSafety.js";

export type RecordV1EvidenceFormat = "text" | "json";

export interface RecordV1EvidenceRunOptions {
  readonly help: false;
  readonly cwd: string;
  readonly evidenceFile: string;
  readonly fixtureDir?: string | undefined;
  readonly gateId: number;
  readonly evidence: string;
  readonly verifiedAt?: string | undefined;
  readonly command?: string | undefined;
  readonly artifact?: string | undefined;
  readonly replace: boolean;
  readonly format: RecordV1EvidenceFormat;
}

export interface RecordV1EvidenceHelpOptions {
  readonly help: true;
}

export type RecordV1EvidenceOptions =
  | RecordV1EvidenceRunOptions
  | RecordV1EvidenceHelpOptions;

const MANUAL_OR_LIVE_GATE_IDS = [7, 8, 9, 11, 12, 13, 14, 15, 16] as const;
const MANUAL_OR_LIVE_GATE_ID_TEXT = MANUAL_OR_LIVE_GATE_IDS.join(", ");

export interface RecordV1EvidenceResult {
  readonly ok: true;
  readonly evidence_file: string;
  readonly gate_id: number;
  readonly replaced: boolean;
  readonly gate_count: number;
  readonly recorded: V1RecordedGateEvidence;
  readonly status_command: string;
  readonly release_gate_command: string;
}

export function parseRecordV1EvidenceArgs(
  args: readonly string[],
  cwd = process.cwd(),
): RecordV1EvidenceOptions {
  let evidenceFile = resolve(cwd, ".data", "v1-acceptance-evidence.json");
  let fixtureDir: string | undefined;
  let gateId: number | undefined;
  let evidence: string | undefined;
  let verifiedAt: string | undefined;
  let command: string | undefined;
  let artifact: string | undefined;
  let replace = false;
  let format: RecordV1EvidenceFormat = "text";
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
      case "--gate":
        gateId = parseGateId(readValue(args, index, arg));
        index += 1;
        break;
      case "--evidence":
        evidence = readValue(args, index, arg);
        index += 1;
        break;
      case "--verified-at":
        verifiedAt = readValue(args, index, arg);
        index += 1;
        break;
      case "--command":
        command = readValue(args, index, arg);
        index += 1;
        break;
      case "--artifact":
        artifact = normalizeProjectRelativePath(
          cwd,
          readValue(args, index, arg),
          "--artifact",
        );
        index += 1;
        break;
      case "--replace":
        replace = true;
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

  if (gateId === undefined) {
    throw new Error("--gate is required.");
  }
  if (evidence === undefined) {
    throw new Error("--evidence is required.");
  }

  return {
    help: false,
    cwd: resolve(cwd),
    evidenceFile,
    ...(fixtureDir ? { fixtureDir } : {}),
    gateId,
    evidence,
    ...(verifiedAt ? { verifiedAt } : {}),
    ...(command ? { command } : {}),
    ...(artifact ? { artifact } : {}),
    replace,
    format,
  };
}

export function recordV1Evidence(
  options: RecordV1EvidenceRunOptions,
  now = new Date(),
): RecordV1EvidenceResult {
  assertManualOrLiveGateId(options.gateId);

  const existing = readExistingEvidenceFile(options.evidenceFile);
  const fixtureDirArg = options.fixtureDir
    ? normalizeProjectRelativePath(
        options.cwd,
        options.fixtureDir,
        "--fixture-dir",
      )
    : undefined;
  const artifact = options.artifact
    ? normalizeProjectRelativePath(options.cwd, options.artifact, "artifact")
    : undefined;
  const verifiedAt = options.verifiedAt ?? now.toISOString();
  if (artifact && !existsSync(resolve(options.cwd, artifact))) {
    throw new Error(`Artifact path does not exist: ${artifact}`);
  }
  assertVerifiedAtSafe(verifiedAt, now);
  assertRecordedEvidenceTextSafe("evidence", options.evidence);
  if (options.command) {
    assertRecordedEvidenceTextSafe("command", options.command);
  }
  if (artifact) {
    assertArtifactSafe(
      resolve(options.cwd, artifact),
      artifact,
      options.gateId,
    );
  }

  const recorded = parseV1EvidenceEntry({
    id: options.gateId,
    verified_at: verifiedAt,
    evidence: options.evidence,
    ...(options.command ? { command: options.command } : {}),
    ...(artifact ? { artifact } : {}),
  });
  const existingIndex = existing.gates.findIndex(
    (entry) => entry.id === recorded.id,
  );
  if (existingIndex >= 0 && !options.replace) {
    throw new Error(
      `Evidence for gate ${recorded.id} already exists. Pass --replace to update it.`,
    );
  }

  const gates =
    existingIndex >= 0
      ? existing.gates.map((entry, index) =>
          index === existingIndex ? recorded : entry,
        )
      : [...existing.gates, recorded];
  const output: V1EvidenceFile = {
    version: 1,
    gates: [...gates].sort((left, right) => left.id - right.id),
  };

  mkdirSync(dirname(options.evidenceFile), { recursive: true });
  writeFileSync(options.evidenceFile, `${JSON.stringify(output, null, 2)}\n`);

  return {
    ok: true,
    evidence_file: options.evidenceFile,
    gate_id: recorded.id,
    replaced: existingIndex >= 0,
    gate_count: output.gates.length,
    recorded,
    status_command: v1StatusCommand(
      options.cwd,
      options.evidenceFile,
      fixtureDirArg,
      false,
    ),
    release_gate_command: v1StatusCommand(
      options.cwd,
      options.evidenceFile,
      fixtureDirArg,
      true,
    ),
  };
}

export function renderRecordV1EvidenceResult(
  result: RecordV1EvidenceResult,
  format: RecordV1EvidenceFormat,
): string {
  if (format === "json") {
    return `${JSON.stringify(result, null, 2)}\n`;
  }

  return [
    "# V1 evidence recorded",
    "",
    `Evidence file: ${result.evidence_file}`,
    `Gate: ${result.gate_id}`,
    `Replaced existing entry: ${result.replaced ? "yes" : "no"}`,
    `Total recorded gates: ${result.gate_count}`,
    `Status command: ${result.status_command}`,
    `Release gate command: ${result.release_gate_command}`,
    "",
  ].join("\n");
}

export function recordV1EvidenceUsage(): string {
  return [
    `Usage: npm run v1:record -- --gate <${MANUAL_OR_LIVE_GATE_ID_TEXT}> --evidence <text> [options]`,
    "",
    "Records operator-supplied manual/live V1 acceptance evidence in a",
    "project-local JSON file. The record is for review; it does not run tests,",
    "call Substack, deploy Cloud Run, or independently prove acceptance.",
    "",
    "Options:",
    `  --gate <id>            Required manual/live V1 acceptance gate id, one of: ${MANUAL_OR_LIVE_GATE_ID_TEXT}.`,
    "  --evidence <text>      Required evidence summary.",
    "  --evidence-file <path> Project-local JSON file. Default: .data/v1-acceptance-evidence.json.",
    "  --fixture-dir <path>   Project-local live fixture directory to preserve in suggested status commands.",
    "  --verified-at <iso>    Verification timestamp. Default: current time.",
    "  --command <command>    Optional command used to produce evidence.",
    "  --artifact <path>      Optional project-local artifact path. Must exist and pass text safety plus gate-detail-section scans; required for v1:status to count the gate complete.",
    "  --replace              Replace an existing entry for the same gate.",
    "  --format <format>      text or json. Default: text.",
    "  --json                 Shortcut for --format json.",
    "  --help                 Show this help.",
    "",
    "Examples:",
    '  npm run v1:record -- --gate 11 --evidence "ChatGPT connector listed tools and completed the manual ngrok flow" --command "npm run smoke:ngrok-noauth -- --evidence-artifact .data/v1/gate-11-chatgpt-ngrok.md; ChatGPT connector manual workflow" --artifact .data/v1/gate-11-chatgpt-ngrok.md',
    '  npm run v1:record -- --gate 7 --fixture-dir fixtures/live --evidence "Live fixture-backed draft formatting passed" --command "npm run fixtures:status -- --fixture-dir fixtures/live --require-all; SUBSTACK_FIXTURE_DIR=fixtures/live npm test -- tests/content/substackFixtureCompatibility.test.ts; V1_LIVE_SUBSTACK_EVIDENCE_ARTIFACTS=.data/v1/gate-07-rich-draft-live-fixtures.md,.data/v1/gate-08-update-draft-live.md,.data/v1/gate-09-read-drafts-live.md RUN_LIVE_SUBSTACK_TESTS=1 npm run test:live" --artifact .data/v1/gate-07-rich-draft-live-fixtures.md',
    "  npm run v1:status -- --evidence-file .data/v1-acceptance-evidence.json",
  ].join("\n");
}

function assertArtifactSafe(
  filePath: string,
  artifact: string,
  gateId: number,
): void {
  const problem = scanEvidenceArtifactText(filePath, artifact, gateId);
  if (problem) {
    throw new Error(problem.replace(/\.$/, ""));
  }
}

function assertRecordedEvidenceTextSafe(label: string, text: string): void {
  const problem = recordedEvidenceTextSafetyProblem(label, text);
  if (problem) {
    throw new Error(problem);
  }
}

function assertVerifiedAtSafe(verifiedAt: string, now: Date): void {
  const problem = verifiedAtSafetyProblem(verifiedAt, now);
  if (problem) {
    throw new Error(problem);
  }
}

function readExistingEvidenceFile(filePath: string): V1EvidenceFile {
  if (!existsSync(filePath)) {
    return {
      version: 1,
      gates: [],
    };
  }

  return readV1EvidenceFile(filePath);
}

function parseGateId(value: string): number {
  const gateId = Number(value);
  if (!Number.isInteger(gateId) || gateId < 1 || gateId > 17) {
    throw new Error("--gate must be an integer from 1 to 17.");
  }
  assertManualOrLiveGateId(gateId);
  return gateId;
}

function assertManualOrLiveGateId(gateId: number): void {
  if (
    !MANUAL_OR_LIVE_GATE_IDS.includes(
      gateId as (typeof MANUAL_OR_LIVE_GATE_IDS)[number],
    )
  ) {
    throw new Error(
      `Gate ${gateId} is repo-local and cannot be recorded in the manual/live evidence file. Record one of: ${MANUAL_OR_LIVE_GATE_ID_TEXT}.`,
    );
  }
}

function parseFormat(value: string): RecordV1EvidenceFormat {
  if (value === "text" || value === "json") {
    return value;
  }

  throw new Error("--format must be one of: text, json.");
}

function v1StatusCommand(
  cwd: string,
  evidenceFile: string,
  fixtureDirArg: string | undefined,
  requireComplete: boolean,
): string {
  const args = [
    "--evidence-file",
    shellArg(relative(cwd, evidenceFile)),
    ...(fixtureDirArg ? ["--fixture-dir", shellArg(fixtureDirArg)] : []),
    ...(requireComplete ? ["--require-complete"] : []),
  ];
  return `npm run v1:status -- ${args.join(" ")}`;
}

function shellArg(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/u.test(value)) {
    return value;
  }

  return `'${value.replace(/'/g, "'\\''")}'`;
}

function resolveInsideCwd(cwd: string, value: string, flag: string): string {
  return resolveProjectPath(cwd, value, flag);
}

function normalizeProjectRelativePath(
  cwd: string,
  value: string,
  flag: string,
): string {
  return resolveProjectPathParts(cwd, value, flag).relativePath;
}

function resolveProjectPath(cwd: string, value: string, flag: string): string {
  return resolveProjectPathParts(cwd, value, flag).outputPath;
}

function resolveProjectPathParts(
  cwd: string,
  value: string,
  flag: string,
): { readonly outputPath: string; readonly relativePath: string } {
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

  return { outputPath, relativePath };
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
