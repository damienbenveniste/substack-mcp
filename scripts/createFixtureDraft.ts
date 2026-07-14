import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  type AppConfig,
  loadConfig,
  loadLocalEnvFiles,
} from "../src/config.js";
import { createSubstackClient } from "../src/substack/client.js";
import { createDraft } from "../src/tools/createDraft.js";
import { previewDraft } from "../src/tools/previewDraft.js";
import { uploadImage } from "../src/tools/uploadImage.js";
import { buildFixtureInspectCommand } from "./fixtureCommandHelpers.js";
import {
  buildInspectedDraftOutput,
  outputDirectory,
  SUBSTACK_FIXTURE_FILES,
  type SubstackFixtureKind,
} from "./inspectDraftCore.js";

const DEFAULT_FIXTURE_PATH = "fixtures/markdown/full-rich-draft.md";
const DEFAULT_SUBTITLE =
  "Created by scripts/createFixtureDraft.ts for live fixture discovery.";
const TEST_IMAGE_DATA_URI =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mP8z8BQDwAFgwJ/lJ2n4QAAAABJRU5ErkJggg==";
const MARKDOWN_IMAGE_URL_PATTERN =
  /(!\[[^\]]*]\()([^) "\t]+)((?:\s+"[^"]*")?\))/;
const IMAGE_DIRECTIVE_SRC_PATTERN = /^(\s*src:\s*)(\S+)(\s*)$/m;
const REQUIRED_LIVE_FIXTURE_KINDS: readonly SubstackFixtureKind[] = [
  "inline-marks",
  "image",
  "code-block",
  "latex-block",
];

type SingleFixtureDraftKind = "rich" | SubstackFixtureKind;
type FixtureDraftKind = SingleFixtureDraftKind | "all";

interface CliOptions {
  readonly kind: FixtureDraftKind;
  readonly fixturePath: string;
  readonly fixtureDir: string;
  readonly title?: string | undefined;
  readonly subtitle?: string | undefined;
  readonly audience?: "everyone" | "only_paid" | "founding" | "only_free";
  readonly imageUrl?: string | undefined;
  readonly dryRun: boolean;
  readonly capture: boolean;
  readonly loadEnvFile: boolean;
  readonly uploadTestImage: boolean;
  readonly help: boolean;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(args);
  if (options.help) {
    console.log(usage());
    return;
  }
  validateOptionCombination(options);

  if (options.loadEnvFile) {
    loadLocalEnvFiles();
  }

  const config = loadConfig(process.env, { loadEnvFile: false });
  const targetKinds =
    options.kind === "all" ? REQUIRED_LIVE_FIXTURE_KINDS : [options.kind];
  const results: Array<Awaited<ReturnType<typeof createFixtureDraft>>> = [];

  for (const kind of targetKinds) {
    results.push(await createFixtureDraft(kind, options, config));
  }

  if (options.kind === "all") {
    console.log(
      JSON.stringify(
        {
          ok: true,
          dry_run: options.dryRun,
          capture: options.capture,
          fixture_kind: "all",
          fixture_dir: options.fixtureDir,
          gate_7_fixture_provenance_review:
            gate7FixtureProvenanceReview(results),
          fixtures: results,
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(JSON.stringify(results[0], null, 2));
}

async function createFixtureDraft(
  kind: SingleFixtureDraftKind,
  options: CliOptions,
  config: AppConfig,
) {
  const fixturePath = resolve(options.fixturePath);
  const title = fixtureTitle(kind, options);
  const subtitle = options.subtitle ?? DEFAULT_SUBTITLE;
  let bodyMarkdown = await fixtureMarkdown(kind, fixturePath);
  let imageSource: string | undefined;

  if (options.imageUrl) {
    const replacement = replaceFirstFixtureImageUrl(
      bodyMarkdown,
      options.imageUrl,
    );
    bodyMarkdown = replacement.markdown;
    imageSource = replacement.replaced ? "provided-url" : "not-found";
  } else if (
    !options.dryRun &&
    options.uploadTestImage &&
    hasReplaceableImageUrl(bodyMarkdown)
  ) {
    const image = await uploadImage(
      {
        image_base64: TEST_IMAGE_DATA_URI,
        alt_text: "One pixel fixture image",
        caption: "Live fixture image",
        filename_hint: "mcp-fixture.png",
      },
      config,
    );
    if (!image.ok || !image.image_url) {
      throw new Error(
        `Fixture image upload failed: ${image.errors.join("; ")}`,
      );
    }

    const replacement = replaceFirstFixtureImageUrl(
      bodyMarkdown,
      image.image_url,
    );
    bodyMarkdown = replacement.markdown;
    imageSource = replacement.replaced ? "uploaded-test-image" : "not-found";
  }

  const preview = previewDraft(
    {
      action: "create",
      title,
      subtitle,
      ...(options.audience ? { audience: options.audience } : {}),
      body_format: "markdown_v1",
      body_markdown: bodyMarkdown,
      include_payload_debug: true,
    },
    config,
  );

  if (!preview.ok || !preview.confirmation_token) {
    throw new Error(`Fixture preview failed: ${preview.errors.join("; ")}`);
  }

  if (options.dryRun) {
    return {
      ok: true,
      dry_run: true,
      fixture_kind: kind,
      fixture_dir: options.fixtureDir,
      ...(kind === "rich" ? { fixture_path: fixturePath } : {}),
      title,
      subtitle,
      audience: preview.audience,
      image_source: imageSource ?? "fixture",
      provenance_review: fixtureProvenanceReview({
        kind,
        dryRun: true,
        fixtureDir: options.fixtureDir,
      }),
      warnings: preview.warnings,
      stats: preview.stats,
      payload_debug: preview.payload_debug,
    };
  }

  const created = await createDraft(
    {
      title,
      subtitle,
      ...(options.audience ? { audience: options.audience } : {}),
      body_format: "markdown_v1",
      body_markdown: bodyMarkdown,
      confirmation_token: preview.confirmation_token,
    },
    config,
  );

  if (!created.ok || created.draft_id === undefined) {
    throw new Error(
      `Fixture draft creation failed: ${created.errors.join("; ")}`,
    );
  }

  const inspectCommand = buildFixtureInspectCommand(
    created.draft_id,
    kind,
    options.fixtureDir,
  );
  const capturedFixture =
    options.capture && kind !== "rich"
      ? await captureFixtureDraft(
          created.draft_id,
          kind,
          options.fixtureDir,
          config,
        )
      : undefined;

  return {
    ok: true,
    dry_run: false,
    fixture_kind: kind,
    fixture_dir: options.fixtureDir,
    ...(kind === "rich" ? { fixture_path: fixturePath } : {}),
    title,
    subtitle,
    image_source: imageSource ?? "fixture",
    draft_id: created.draft_id,
    draft_url: created.draft_url,
    warnings: [...preview.warnings, ...created.warnings],
    inspect_command: inspectCommand,
    provenance_review: fixtureProvenanceReview({
      kind,
      dryRun: false,
      fixtureDir: options.fixtureDir,
      draftId: created.draft_id,
      inspectCommand,
      capturedFixturePath: capturedFixture?.output_path,
    }),
    ...(capturedFixture
      ? {
          captured_fixture: capturedFixture,
        }
      : {}),
  };
}

function gate7FixtureProvenanceReview(
  results: ReadonlyArray<Awaited<ReturnType<typeof createFixtureDraft>>>,
): string {
  if (results.every((result) => result.dry_run)) {
    return "Dry run only; no live Substack fixture was created or captured. Run `npm run create:fixture -- --kind all --capture` with live credentials, then copy the emitted per-fixture provenance reviews into the gate 7 evidence artifact.";
  }

  return results
    .filter((result) => result.fixture_kind !== "rich")
    .map((result) => result.provenance_review)
    .join(" ");
}

function fixtureProvenanceReview(options: {
  readonly kind: SingleFixtureDraftKind;
  readonly dryRun: boolean;
  readonly fixtureDir: string;
  readonly draftId?: number | undefined;
  readonly inspectCommand?: string | undefined;
  readonly capturedFixturePath?: string | undefined;
}): string {
  if (options.dryRun) {
    return options.kind === "rich"
      ? "Dry run only; no live Substack acceptance draft or reusable fixture was created."
      : `Dry run only for ${options.kind}; no live Substack fixture was created or captured.`;
  }

  if (options.kind === "rich") {
    return `Created rich live Substack acceptance draft ${options.draftId}; review its native editor rendering manually before recording gate 7.`;
  }

  if (options.capturedFixturePath) {
    return `${options.kind} fixture captured from purpose-built live Substack draft ${options.draftId} into ${displayProjectPath(options.capturedFixturePath)} as body-only, non-raw draft_body JSON; review the native Substack editor shape before recording gate 7.`;
  }

  return `${options.kind} purpose-built live Substack fixture draft ${options.draftId} created; capture it with \`${options.inspectCommand}\`, then review the native Substack editor shape before recording gate 7.`;
}

async function captureFixtureDraft(
  draftId: number,
  kind: SubstackFixtureKind,
  fixtureDir: string,
  config: AppConfig,
): Promise<{
  readonly output_path: string;
  readonly include_raw: false;
}> {
  const outputPath = join(fixtureDir, SUBSTACK_FIXTURE_FILES[kind]);
  const client = createSubstackClient(config);
  const draft = await client.getDraft(draftId);
  const inspected = buildInspectedDraftOutput(draft, {
    includeRaw: false,
    fixtureOutput: true,
  });
  await mkdir(outputDirectory(outputPath), { recursive: true });
  await writeFile(
    outputPath,
    `${JSON.stringify(inspected, null, 2)}\n`,
    "utf8",
  );

  return {
    output_path: outputPath,
    include_raw: false,
  };
}

export function replaceFirstMarkdownImageUrl(
  markdown: string,
  nextUrl: string,
): { readonly markdown: string; readonly replaced: boolean } {
  return replaceFirstFixtureImageUrl(markdown, nextUrl);
}

function replaceFirstFixtureImageUrl(
  markdown: string,
  nextUrl: string,
): { readonly markdown: string; readonly replaced: boolean } {
  if (MARKDOWN_IMAGE_URL_PATTERN.test(markdown)) {
    return {
      markdown: markdown.replace(MARKDOWN_IMAGE_URL_PATTERN, `$1${nextUrl}$3`),
      replaced: true,
    };
  }

  if (!IMAGE_DIRECTIVE_SRC_PATTERN.test(markdown)) {
    return { markdown, replaced: false };
  }

  return {
    markdown: markdown.replace(IMAGE_DIRECTIVE_SRC_PATTERN, `$1${nextUrl}$3`),
    replaced: true,
  };
}

function hasReplaceableImageUrl(markdown: string): boolean {
  return (
    MARKDOWN_IMAGE_URL_PATTERN.test(markdown) ||
    IMAGE_DIRECTIVE_SRC_PATTERN.test(markdown)
  );
}

async function fixtureMarkdown(
  kind: SingleFixtureDraftKind,
  fixturePath: string,
): Promise<string> {
  if (kind === "rich") {
    return await readFile(fixturePath, "utf8");
  }

  return purposeBuiltFixtureMarkdown(kind);
}

function purposeBuiltFixtureMarkdown(kind: SubstackFixtureKind): string {
  switch (kind) {
    case "inline-marks":
      return "Plain **bold** *italic* `code` [link](https://example.com)\n";
    case "image":
      return [
        ":::image",
        "src: https://example.com/mcp-fixture-image.png",
        "alt: One pixel fixture image",
        "caption: Live fixture image",
        "title: Live fixture image",
        "width: 1",
        "height: 1",
        ":::",
        "",
      ].join("\n");
    case "code-block":
      return "```python\nprint('hello')\n```\n";
    case "latex-block":
      return "$$\nE = mc^2\n$$\n";
  }
}

function fixtureKindLabel(kind: SingleFixtureDraftKind): string {
  return kind === "rich" ? "Rich draft" : `${kind} fixture`;
}

function fixtureTitle(
  kind: SingleFixtureDraftKind,
  options: CliOptions,
): string {
  if (options.title) {
    return options.kind === "all"
      ? `${options.title} - ${fixtureKindLabel(kind)}`
      : options.title;
  }

  return `[MCP FIXTURE] ${fixtureKindLabel(kind)} ${new Date().toISOString()}`;
}

function parseArgs(args: readonly string[]): CliOptions {
  const options: {
    kind: FixtureDraftKind;
    fixturePath: string;
    fixtureDir: string;
    title?: string | undefined;
    subtitle?: string | undefined;
    audience?: "everyone" | "only_paid" | "founding" | "only_free";
    imageUrl?: string | undefined;
    dryRun: boolean;
    capture: boolean;
    loadEnvFile: boolean;
    uploadTestImage: boolean;
    help: boolean;
  } = {
    kind: "rich",
    fixturePath: DEFAULT_FIXTURE_PATH,
    fixtureDir: resolve("fixtures", "substack"),
    dryRun: false,
    capture: false,
    loadEnvFile: true,
    uploadTestImage: true,
    help: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--kind":
        options.kind = parseFixtureKind(readValue(args, index, arg));
        index += 1;
        break;
      case "--fixture":
        options.fixturePath = readValue(args, index, arg);
        index += 1;
        break;
      case "--fixture-dir":
        options.fixtureDir = resolveInsideCwd(readValue(args, index, arg), arg);
        index += 1;
        break;
      case "--title":
        options.title = readValue(args, index, arg);
        index += 1;
        break;
      case "--subtitle":
        options.subtitle = readValue(args, index, arg);
        index += 1;
        break;
      case "--audience":
        options.audience = parseAudience(readValue(args, index, arg));
        index += 1;
        break;
      case "--image-url":
        options.imageUrl = readValue(args, index, arg);
        index += 1;
        break;
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--capture":
        options.capture = true;
        break;
      case "--no-env-file":
        options.loadEnvFile = false;
        break;
      case "--no-upload-test-image":
        options.uploadTestImage = false;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }

  return options;
}

function validateOptionCombination(options: CliOptions): void {
  if (!options.capture) {
    return;
  }

  if (options.dryRun) {
    throw new Error("--capture cannot be used with --dry-run.");
  }

  if (options.kind === "rich") {
    throw new Error(
      "--capture requires --kind inline-marks, image, code-block, latex-block, or all.",
    );
  }
}

function parseFixtureKind(value: string): FixtureDraftKind {
  if (
    value === "rich" ||
    value === "all" ||
    value === "inline-marks" ||
    value === "image" ||
    value === "code-block" ||
    value === "latex-block"
  ) {
    return value;
  }

  throw new Error(
    "--kind must be one of: rich, all, inline-marks, image, code-block, latex-block.",
  );
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

function parseAudience(
  value: string,
): "everyone" | "only_paid" | "founding" | "only_free" {
  if (
    value === "everyone" ||
    value === "only_paid" ||
    value === "founding" ||
    value === "only_free"
  ) {
    return value;
  }

  throw new Error(
    "--audience must be one of: everyone, only_paid, founding, only_free.",
  );
}

function resolveInsideCwd(value: string, flag: string): string {
  const root = resolve();
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

function displayProjectPath(value: string): string {
  const root = resolve();
  const relativePath = relative(root, resolve(value));
  if (
    relativePath !== "" &&
    !relativePath.startsWith("..") &&
    !isAbsolute(relativePath)
  ) {
    return relativePath;
  }

  return value;
}

function usage(): string {
  return [
    "Usage: npm run create:fixture -- [options]",
    "",
    "Creates a live Substack draft from a Markdown fixture for adapter discovery.",
    "Use --dry-run to validate conversion without Substack network calls.",
    "",
    "Options:",
    "  --kind <kind>             rich, all, inline-marks, image, code-block, or latex-block. Default: rich.",
    `  --fixture <path>          Markdown fixture path. Default: ${DEFAULT_FIXTURE_PATH}`,
    "  --fixture-dir <path>      Project-local fixture capture directory. Default: fixtures/substack.",
    "  --title <title>           Draft title. Default: timestamped fixture title.",
    `  --subtitle <subtitle>     Draft subtitle. Default: ${DEFAULT_SUBTITLE}`,
    "  --audience <audience>     everyone, only_paid, founding, or only_free.",
    "  --image-url <url>         Replace the first Markdown image URL before preview/create.",
    "  --dry-run                 Preview only; do not upload images or create a draft.",
    "  --capture                 After live draft creation, fetch it back and write the expected fixture JSON file.",
    "  --no-env-file             Do not load .env.local or .env.",
    "  --no-upload-test-image    Do not upload the built-in test image before creating.",
    "  --help                    Show this help.",
  ].join("\n");
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
