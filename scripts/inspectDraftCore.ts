import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { SubstackDraft } from "../src/substack/types.js";

export type SubstackFixtureKind =
  | "inline-marks"
  | "image"
  | "code-block"
  | "latex-block";

export const SUBSTACK_FIXTURE_FILES: Readonly<
  Record<SubstackFixtureKind, string>
> = {
  "inline-marks": "inline-marks-draft-body.json",
  image: "image-draft-body.json",
  "code-block": "code-block-draft-body.json",
  "latex-block": "latex-block-draft-body.json",
};

export interface InspectDraftRunOptions {
  readonly help: false;
  readonly draftId: number;
  readonly loadEnvFile: boolean;
  readonly includeRaw: boolean;
  readonly fixtureOutput: boolean;
  readonly outputPath?: string | undefined;
}

export interface InspectDraftHelpOptions {
  readonly help: true;
  readonly loadEnvFile: boolean;
}

export type InspectDraftOptions =
  | InspectDraftRunOptions
  | InspectDraftHelpOptions;

export interface InspectedDraftMetadataOutput {
  readonly id: number;
  readonly title?: string | undefined;
  readonly subtitle?: string | undefined;
  readonly audience?: string | undefined;
  readonly draft_body?: unknown;
  readonly raw?: unknown;
}

export type InspectedDraftOutput = InspectedDraftMetadataOutput | unknown;

export interface InspectDraftWriteResult {
  readonly ok: true;
  readonly draft_id: number;
  readonly output_path: string;
  readonly include_raw: boolean;
}

export function parseInspectDraftArgs(
  args: readonly string[],
  cwd = process.cwd(),
): InspectDraftOptions {
  let draftIdValue: string | undefined;
  let outputPath: string | undefined;
  let fixture: SubstackFixtureKind | undefined;
  let fixtureDir = resolve(cwd, "fixtures", "substack");
  let fixtureDirProvided = false;
  let includeRaw = false;
  let loadEnvFile = true;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }

    switch (arg) {
      case "--output":
        outputPath = resolveInsideCwd(cwd, readValue(args, index, arg), arg);
        index += 1;
        break;
      case "--fixture":
        fixture = parseFixtureKind(readValue(args, index, arg));
        index += 1;
        break;
      case "--fixture-dir":
        fixtureDir = resolveInsideCwd(cwd, readValue(args, index, arg), arg);
        fixtureDirProvided = true;
        index += 1;
        break;
      case "--include-raw":
        includeRaw = true;
        break;
      case "--no-env-file":
        loadEnvFile = false;
        break;
      case "--help":
      case "-h":
        help = true;
        break;
      default:
        if (arg.startsWith("--")) {
          throw new Error(`Unknown option: ${arg}`);
        }
        if (draftIdValue !== undefined) {
          throw new Error("Only one draft ID may be provided.");
        }
        draftIdValue = arg;
    }
  }

  if (help) {
    return { help, loadEnvFile };
  }

  if (outputPath && fixture) {
    throw new Error("--output and --fixture cannot be used together.");
  }
  if (fixture && includeRaw) {
    throw new Error(
      "--include-raw cannot be used with --fixture; fixture captures must stay compact and non-raw. Use --output .data/<file>.json for private raw inspection.",
    );
  }
  if (outputPath && includeRaw) {
    assertIgnoredRawOutputPath(cwd, outputPath);
  }
  if (outputPath && fixtureDirProvided) {
    throw new Error("--output and --fixture-dir cannot be used together.");
  }
  if (!fixture && fixtureDirProvided) {
    throw new Error("--fixture-dir requires --fixture.");
  }

  const draftId = parseDraftId(draftIdValue);
  return {
    help,
    draftId,
    loadEnvFile,
    includeRaw,
    fixtureOutput: fixture !== undefined,
    outputPath:
      outputPath ??
      (fixture ? join(fixtureDir, SUBSTACK_FIXTURE_FILES[fixture]) : undefined),
  };
}

export function inspectDraftUsage(): string {
  return [
    "Usage: npm run inspect:draft -- <draft_id> [options]",
    "",
    "Fetches a live Substack draft and prints JSON containing the parsed",
    "draft_body. Use only with purpose-built, non-sensitive drafts.",
    "",
    "Options:",
    "  --fixture <kind>      Write only the parsed draft_body to fixtures/substack/<expected-file>.",
    "                        Kinds: inline-marks, image, code-block, latex-block.",
    "  --fixture-dir <path>  Project-local directory for --fixture output. Default: fixtures/substack.",
    "  --output <path>       Write JSON to a project-relative output path.",
    "  --include-raw         Include the full raw Substack response. Only allowed with stdout or --output under .data/, not --fixture.",
    "  --no-env-file         Do not load .env.local or .env.",
    "  --help                Show this help.",
    "",
    "Examples:",
    "  npm run inspect:draft -- 12345",
    "  npm run inspect:draft -- 12345 --fixture latex-block",
    "  npm run inspect:draft -- 12345 --fixture image --fixture-dir fixtures/live",
    "  npm run inspect:draft -- 12345 --include-raw --output .data/inspect-draft-12345.json",
  ].join("\n");
}

export function buildInspectedDraftOutput(
  draft: SubstackDraft,
  options: Pick<InspectDraftRunOptions, "includeRaw" | "fixtureOutput">,
): InspectedDraftOutput {
  const draftBody =
    typeof draft.draft_body === "string"
      ? parseMaybeJson(draft.draft_body)
      : draft.draft_body;

  if (options.fixtureOutput) {
    return draftBody;
  }

  return {
    id: draft.id,
    title: draft.title,
    subtitle: draft.subtitle,
    audience: draft.audience,
    draft_body: draftBody,
    ...(options.includeRaw ? { raw: draft.raw } : {}),
  };
}

export function buildInspectDraftWriteResult(
  options: Pick<InspectDraftRunOptions, "draftId" | "includeRaw"> & {
    readonly outputPath: string;
  },
): InspectDraftWriteResult {
  return {
    ok: true,
    draft_id: options.draftId,
    output_path: options.outputPath,
    include_raw: options.includeRaw,
  };
}

export function outputDirectory(outputPath: string): string {
  return dirname(outputPath);
}

export function parseMaybeJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function parseDraftId(value: string | undefined): number {
  const raw = value?.trim() ?? "";
  const draftId = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(draftId) || draftId <= 0) {
    throw new Error("A positive numeric draft ID is required.");
  }

  return draftId;
}

function assertIgnoredRawOutputPath(cwd: string, outputPath: string): void {
  const rawRelativePath = relative(resolve(cwd), resolve(outputPath));
  const relativePath = rawRelativePath.split("\\").join("/");
  if (
    relativePath === ".data" ||
    relativePath.startsWith(".data/") ||
    relativePath.startsWith("./.data/")
  ) {
    return;
  }

  throw new Error(
    "--include-raw output files must be written under .data/ so raw Substack responses stay out of tracked project files.",
  );
}

function parseFixtureKind(value: string): SubstackFixtureKind {
  if (
    value === "inline-marks" ||
    value === "image" ||
    value === "code-block" ||
    value === "latex-block"
  ) {
    return value;
  }

  throw new Error(
    "--fixture must be one of: inline-marks, image, code-block, latex-block.",
  );
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
