import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import type {
  ImageBlock,
  NewsletterBlock,
} from "../src/content/newsletterBlocks.js";
import {
  type SubstackPmDoc,
  type SubstackPmNode,
  toSubstackProseMirror,
} from "../src/content/toSubstackProseMirror.js";
import {
  SUBSTACK_FIXTURE_FILES,
  type SubstackFixtureKind,
} from "./inspectDraftCore.js";

export type FixtureStatusFormat = "text" | "json";

export interface FixtureStatusRunOptions {
  readonly help: false;
  readonly fixtureDir: string;
  readonly format: FixtureStatusFormat;
  readonly requireAll: boolean;
}

export interface FixtureStatusHelpOptions {
  readonly help: true;
}

export type FixtureStatusOptions =
  | FixtureStatusRunOptions
  | FixtureStatusHelpOptions;

export interface RequiredSubstackFixture {
  readonly kind: SubstackFixtureKind;
  readonly file: string;
  readonly purpose: string;
}

export interface SubstackFixtureStatus {
  readonly fixture_dir: string;
  readonly capture_fixture_dir_arg?: string | undefined;
  readonly required_count: number;
  readonly present_count: number;
  readonly valid_count: number;
  readonly compatible_count: number;
  readonly all_present: boolean;
  readonly all_valid: boolean;
  readonly all_compatible: boolean;
  readonly ready: boolean;
  readonly missing: readonly SubstackFixtureKind[];
  readonly invalid: readonly SubstackFixtureKind[];
  readonly incompatible: readonly SubstackFixtureKind[];
  readonly fixtures: readonly SubstackFixtureCheck[];
}

export interface SubstackFixtureCheck {
  readonly kind: SubstackFixtureKind;
  readonly file: string;
  readonly path: string;
  readonly purpose: string;
  readonly next_action: string;
  readonly present: boolean;
  readonly valid: boolean;
  readonly compatible: boolean;
  readonly error?: string | undefined;
  readonly compatibility_error?: string | undefined;
  readonly summary?: SubstackFixtureDocSummary | undefined;
}

export interface SubstackFixtureDocSummary {
  readonly top_level_nodes: number;
  readonly node_types: Readonly<Record<string, number>>;
  readonly mark_types: Readonly<Record<string, number>>;
  readonly image_node_types: readonly string[];
  readonly latex_candidate_node_types: readonly string[];
}

export const REQUIRED_SUBSTACK_FIXTURES: readonly RequiredSubstackFixture[] = [
  {
    kind: "inline-marks",
    file: SUBSTACK_FIXTURE_FILES["inline-marks"],
    purpose: "inline bold, italic, code, and link mark shape",
  },
  {
    kind: "image",
    file: SUBSTACK_FIXTURE_FILES.image,
    purpose: "native image node and caption shape",
  },
  {
    kind: "code-block",
    file: SUBSTACK_FIXTURE_FILES["code-block"],
    purpose: "native code block node shape",
  },
  {
    kind: "latex-block",
    file: SUBSTACK_FIXTURE_FILES["latex-block"],
    purpose: "native LaTeX equation node shape",
  },
];

export function parseFixtureStatusArgs(
  args: readonly string[],
  cwd = process.cwd(),
): FixtureStatusOptions {
  let fixtureDir = resolve(cwd, "fixtures", "substack");
  let format: FixtureStatusFormat = "text";
  let requireAll = false;
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--fixture-dir":
        fixtureDir = resolveInsideCwd(cwd, readValue(args, index, arg));
        index += 1;
        break;
      case "--format":
        format = parseFormat(readValue(args, index, arg));
        index += 1;
        break;
      case "--json":
        format = "json";
        break;
      case "--require-all":
        requireAll = true;
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
    fixtureDir,
    format,
    requireAll,
  };
}

export function fixtureStatusUsage(): string {
  return [
    "Usage: npm run fixtures:status -- [options]",
    "",
    "Reports whether required live Substack draft-body fixtures are present",
    "parse as ProseMirror doc JSON, and round-trip through the adapter. It",
    "does not call Substack.",
    "",
    "Options:",
    "  --fixture-dir <path>  Project-local fixture directory. Default: fixtures/substack.",
    "  --format <format>     text or json. Default: text.",
    "  --json                Shortcut for --format json.",
    "  --require-all         Exit non-zero when any required fixture is missing, invalid, or incompatible.",
    "  --help                Show this help.",
    "",
    "Examples:",
    "  npm run fixtures:status",
    "  npm run fixtures:status -- --fixture-dir fixtures/live",
    "  npm run fixtures:status -- --json",
    "  npm run fixtures:status -- --require-all",
  ].join("\n");
}

export function buildFixtureStatus(
  options: Pick<FixtureStatusRunOptions, "fixtureDir"> & {
    readonly cwd?: string | undefined;
  },
): SubstackFixtureStatus {
  const captureFixtureDirArg = captureFixtureDirCommandArg(
    options.cwd ?? process.cwd(),
    options.fixtureDir,
  );
  const fixtures = REQUIRED_SUBSTACK_FIXTURES.map((fixture) =>
    inspectFixture(options.fixtureDir, fixture, captureFixtureDirArg),
  );
  const missing = fixtures
    .filter((fixture) => !fixture.present)
    .map((fixture) => fixture.kind);
  const invalid = fixtures
    .filter((fixture) => fixture.present && !fixture.valid)
    .map((fixture) => fixture.kind);
  const incompatible = fixtures
    .filter((fixture) => fixture.valid && !fixture.compatible)
    .map((fixture) => fixture.kind);
  const presentCount = fixtures.filter((fixture) => fixture.present).length;
  const validCount = fixtures.filter((fixture) => fixture.valid).length;
  const compatibleCount = fixtures.filter(
    (fixture) => fixture.compatible,
  ).length;
  const allPresent = missing.length === 0;
  const allValid = invalid.length === 0;
  const allCompatible = incompatible.length === 0;

  return {
    fixture_dir: options.fixtureDir,
    ...(captureFixtureDirArg
      ? { capture_fixture_dir_arg: captureFixtureDirArg }
      : {}),
    required_count: fixtures.length,
    present_count: presentCount,
    valid_count: validCount,
    compatible_count: compatibleCount,
    all_present: allPresent,
    all_valid: allValid,
    all_compatible: allCompatible,
    ready: allPresent && allValid && allCompatible,
    missing,
    invalid,
    incompatible,
    fixtures,
  };
}

export function renderFixtureStatus(
  status: SubstackFixtureStatus,
  format: FixtureStatusFormat,
): string {
  if (format === "json") {
    return `${JSON.stringify(status, null, 2)}\n`;
  }

  const lines = [
    "# Substack fixture status",
    "",
    `Directory: ${status.fixture_dir}`,
    `Ready: ${status.ready ? "yes" : "no"}`,
    `Present: ${status.present_count}/${status.required_count}`,
    `Valid: ${status.valid_count}/${status.required_count}`,
    `Adapter compatible: ${status.compatible_count}/${status.required_count}`,
    "",
    "## Fixtures",
    ...status.fixtures.map(renderFixtureLine),
    "",
    `Run \`${captureFixtureCommand(
      "all",
      status.capture_fixture_dir_arg,
    )}\` to create and capture all missing fixtures, or \`${inspectFixtureCommand(
      "<kind>",
      status.capture_fixture_dir_arg,
    )}\` for an existing purpose-built draft.`,
  ];

  if (!status.ready) {
    lines.push(
      `Use \`${fixtureStatusCommand(
        status.capture_fixture_dir_arg,
        true,
      )}\` as the release gate once fixtures are expected to exist.`,
    );
  }

  return `${lines.join("\n")}\n`;
}

export function shouldFailFixtureStatus(
  status: Pick<SubstackFixtureStatus, "ready">,
  options: Pick<FixtureStatusRunOptions, "requireAll">,
): boolean {
  return options.requireAll && !status.ready;
}

function inspectFixture(
  fixtureDir: string,
  fixture: RequiredSubstackFixture,
  captureFixtureDirArg: string | undefined,
): SubstackFixtureCheck {
  const fixturePath = join(fixtureDir, fixture.file);
  if (!existsSync(fixturePath)) {
    return {
      kind: fixture.kind,
      file: fixture.file,
      path: fixturePath,
      purpose: fixture.purpose,
      next_action: fixtureNextAction(fixture, "missing", captureFixtureDirArg),
      present: false,
      valid: false,
      compatible: false,
    };
  }

  try {
    const doc = readFixtureDoc(fixturePath);
    const summary = summarizeDoc(doc);
    validateFixtureShape(fixture.kind, doc, summary);
    const compatibilityError = fixtureCompatibilityError(fixture.kind, doc);
    return {
      kind: fixture.kind,
      file: fixture.file,
      path: fixturePath,
      purpose: fixture.purpose,
      next_action: fixtureNextAction(
        fixture,
        compatibilityError === undefined ? "ready" : "incompatible",
        captureFixtureDirArg,
      ),
      present: true,
      valid: true,
      compatible: compatibilityError === undefined,
      ...(compatibilityError
        ? { compatibility_error: compatibilityError }
        : {}),
      summary,
    };
  } catch (error) {
    return {
      kind: fixture.kind,
      file: fixture.file,
      path: fixturePath,
      purpose: fixture.purpose,
      next_action: fixtureNextAction(fixture, "invalid", captureFixtureDirArg),
      present: true,
      valid: false,
      compatible: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function readFixtureDoc(filePath: string): SubstackPmDoc {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `Invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  assertReusableFixtureHasNoMetadata(parsed);

  const draftBody =
    isRecord(parsed) && "draft_body" in parsed ? parsed.draft_body : parsed;
  const doc = parseDraftBody(draftBody);

  if (!isSubstackPmDoc(doc)) {
    throw new Error("Fixture does not contain a Substack draft_body doc.");
  }

  return doc;
}

function assertReusableFixtureHasNoMetadata(parsed: unknown): void {
  if (!isRecord(parsed) || !("draft_body" in parsed)) {
    return;
  }

  const metadataKeys = Object.keys(parsed).filter(
    (key) => key !== "draft_body",
  );
  if (metadataKeys.length === 0) {
    return;
  }

  throw new Error(
    `Reusable fixture files must contain only draft_body; remove top-level metadata field(s): ${metadataKeys.join(", ")}.`,
  );
}

function parseDraftBody(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(
      `draft_body string is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function summarizeDoc(doc: SubstackPmDoc): SubstackFixtureDocSummary {
  const nodeTypes = new Map<string, number>();
  const markTypes = new Map<string, number>();
  const imageNodeTypes = new Set<string>();
  const latexCandidateNodeTypes = new Set<string>();

  for (const node of doc.content) {
    walkNode(node, {
      nodeTypes,
      markTypes,
      imageNodeTypes,
      latexCandidateNodeTypes,
    });
  }

  return {
    top_level_nodes: doc.content.length,
    node_types: Object.fromEntries([...nodeTypes.entries()].sort()),
    mark_types: Object.fromEntries([...markTypes.entries()].sort()),
    image_node_types: [...imageNodeTypes].sort(),
    latex_candidate_node_types: [...latexCandidateNodeTypes].sort(),
  };
}

function validateFixtureShape(
  kind: SubstackFixtureKind,
  doc: SubstackPmDoc,
  summary: SubstackFixtureDocSummary,
): void {
  switch (kind) {
    case "inline-marks":
      requireAnyMark(summary, ["strong", "bold"], "bold");
      requireAnyMark(summary, ["em", "italic"], "italic");
      requireAnyMark(summary, ["code"], "inline code");
      requireAnyMark(summary, ["link"], "link");
      break;
    case "image":
      if (!findFirstNode(doc, hasImageSrc)) {
        throw new Error(
          "image fixture does not contain an image node with a string src.",
        );
      }
      break;
    case "code-block":
      if (!findFirstNode(doc, isCodeBlockLikeNode)) {
        throw new Error(
          "code-block fixture does not contain a code-like block node.",
        );
      }
      if (!textContent(doc).includes("print('hello')")) {
        throw new Error(
          "code-block fixture does not contain the expected sample code.",
        );
      }
      break;
    case "latex-block": {
      const nativeLatexNode = findFirstNode(doc, isNativeLatexCandidateNode);
      if (!nativeLatexNode) {
        throw new Error(
          "latex-block fixture does not contain a native LaTeX/equation node candidate.",
        );
      }
      if (!nodeValueText(nativeLatexNode).includes("E = mc^2")) {
        throw new Error(
          "latex-block fixture does not contain the expected sample equation.",
        );
      }
      break;
    }
  }
}

function fixtureCompatibilityError(
  kind: SubstackFixtureKind,
  doc: SubstackPmDoc,
): string | undefined {
  const converted = toSubstackProseMirror(sampleBlocksForFixture(kind, doc));
  if (isDeepStrictEqual(converted.doc, doc)) {
    return undefined;
  }

  return [
    `${kind} fixture is valid, but adapter output does not match the captured draft_body.`,
    `First difference: ${firstStructuralDifference(converted.doc, doc)}.`,
    `Adapter summary: ${formatDocSummary(summarizeDoc(converted.doc))}.`,
    `Captured summary: ${formatDocSummary(summarizeDoc(doc))}.`,
  ].join(" ");
}

function sampleBlocksForFixture(
  kind: SubstackFixtureKind,
  doc: SubstackPmDoc,
): readonly NewsletterBlock[] {
  switch (kind) {
    case "inline-marks":
      return [
        {
          type: "paragraph",
          children: [
            { text: "Plain " },
            { text: "bold", bold: true },
            { text: " " },
            { text: "italic", italic: true },
            { text: " " },
            { text: "code", code: true },
            { text: " " },
            { text: "link", href: "https://example.com" },
          ],
        },
      ];
    case "image":
      return [imageBlockFromFixture(doc)];
    case "code-block":
      return [
        {
          type: "code_block",
          language: "python",
          code: "print('hello')",
        },
      ];
    case "latex-block":
      return [
        {
          type: "latex_block",
          latex: "E = mc^2",
        },
      ];
  }
}

function imageBlockFromFixture(doc: SubstackPmDoc): ImageBlock {
  const imageNode = findFirstNode(doc, hasImageSrc);

  if (!imageNode?.attrs || typeof imageNode.attrs.src !== "string") {
    throw new Error("image-draft-body.json does not contain an image src.");
  }

  const caption = extractImageCaption(doc);

  return {
    type: "image",
    src: imageNode.attrs.src,
    ...(typeof imageNode.attrs.alt === "string"
      ? { alt: imageNode.attrs.alt }
      : {}),
    ...(typeof imageNode.attrs.title === "string"
      ? { title: imageNode.attrs.title }
      : {}),
    ...(typeof imageNode.attrs.width === "number"
      ? { width: imageNode.attrs.width }
      : {}),
    ...(typeof imageNode.attrs.height === "number"
      ? { height: imageNode.attrs.height }
      : {}),
    ...(caption !== undefined ? { caption } : {}),
  };
}

function extractImageCaption(doc: SubstackPmDoc): string | undefined {
  const imageContainer = doc.content.find((node) =>
    Boolean(findFirstNode(node, hasImageSrc)),
  );
  const nativeCaption =
    imageContainer === undefined ? "" : textContent(imageContainer).trim();
  if (nativeCaption.length > 0) {
    return nativeCaption;
  }

  const fallbackCaption = doc.content
    .filter((node) => !findFirstNode(node, hasImageSrc))
    .map((node) => textContent(node).trim())
    .filter((text) => text.length > 0)
    .join("\n");

  return fallbackCaption.length > 0 ? fallbackCaption : undefined;
}

function requireAnyMark(
  summary: SubstackFixtureDocSummary,
  names: readonly string[],
  label: string,
): void {
  if (names.some((name) => summary.mark_types[name] !== undefined)) {
    return;
  }

  throw new Error(
    `inline-marks fixture does not contain a ${label} mark (${names.join(" or ")}).`,
  );
}

function firstStructuralDifference(
  adapter: unknown,
  captured: unknown,
): string {
  return describeStructuralDifference(adapter, captured, "doc") ?? "unknown";
}

function describeStructuralDifference(
  adapter: unknown,
  captured: unknown,
  path: string,
): string | undefined {
  if (isDeepStrictEqual(adapter, captured)) {
    return undefined;
  }

  if (Array.isArray(adapter) || Array.isArray(captured)) {
    if (!Array.isArray(adapter) || !Array.isArray(captured)) {
      return `${path}: adapter is ${describeValueKind(adapter)}, captured is ${describeValueKind(captured)}`;
    }

    if (adapter.length !== captured.length) {
      return `${path}.length: adapter has ${adapter.length}, captured has ${captured.length}`;
    }

    for (let index = 0; index < adapter.length; index += 1) {
      const difference = describeStructuralDifference(
        adapter[index],
        captured[index],
        `${path}[${index}]`,
      );
      if (difference) {
        return difference;
      }
    }

    return `${path}: array values differ`;
  }

  if (isRecord(adapter) || isRecord(captured)) {
    if (!isRecord(adapter) || !isRecord(captured)) {
      return `${path}: adapter is ${describeValueKind(adapter)}, captured is ${describeValueKind(captured)}`;
    }

    const adapterKeys = Object.keys(adapter);
    const keys = [
      ...adapterKeys,
      ...Object.keys(captured).filter((key) => !adapterKeys.includes(key)),
    ];
    for (const key of keys) {
      const adapterHasKey = Object.hasOwn(adapter, key);
      const capturedHasKey = Object.hasOwn(captured, key);
      const childPath = `${path}.${key}`;
      if (!adapterHasKey) {
        return `${childPath}: adapter field missing`;
      }
      if (!capturedHasKey) {
        return `${childPath}: captured field missing`;
      }

      const difference = describeStructuralDifference(
        adapter[key],
        captured[key],
        childPath,
      );
      if (difference) {
        return difference;
      }
    }

    return `${path}: object values differ`;
  }

  return `${path}: adapter ${describeScalar(adapter)}, captured ${describeScalar(captured)}`;
}

function describeValueKind(value: unknown): string {
  if (Array.isArray(value)) {
    return "array";
  }
  if (value === null) {
    return "null";
  }
  return typeof value;
}

function describeScalar(value: unknown): string {
  if (typeof value === "string") {
    return `string length ${value.length}`;
  }
  if (typeof value === "number") {
    return "number";
  }
  if (typeof value === "boolean") {
    return "boolean";
  }
  if (value === null) {
    return "null";
  }
  return "unknown";
}

function formatDocSummary(summary: SubstackFixtureDocSummary): string {
  return [
    `top_level_nodes=${summary.top_level_nodes}`,
    `node_types={${formatCounts(summary.node_types)}}`,
    `mark_types={${formatCounts(summary.mark_types)}}`,
    `image_node_types=[${summary.image_node_types.join(", ") || "none"}]`,
    `latex_candidate_node_types=[${
      summary.latex_candidate_node_types.join(", ") || "none"
    }]`,
  ].join("; ");
}

function formatCounts(counts: Readonly<Record<string, number>>): string {
  const entries = Object.entries(counts).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return entries.length === 0
    ? "none"
    : entries.map(([key, value]) => `${key}:${value}`).join(", ");
}

function walkNode(
  node: SubstackPmNode,
  state: {
    readonly nodeTypes: Map<string, number>;
    readonly markTypes: Map<string, number>;
    readonly imageNodeTypes: Set<string>;
    readonly latexCandidateNodeTypes: Set<string>;
  },
): void {
  state.nodeTypes.set(node.type, (state.nodeTypes.get(node.type) ?? 0) + 1);

  for (const mark of node.marks ?? []) {
    state.markTypes.set(mark.type, (state.markTypes.get(mark.type) ?? 0) + 1);
  }

  if (isImageLikeNode(node)) {
    state.imageNodeTypes.add(node.type);
  }

  if (isLatexCandidateNode(node)) {
    state.latexCandidateNodeTypes.add(node.type);
  }

  for (const child of node.content ?? []) {
    walkNode(child, state);
  }
}

function isImageLikeNode(node: SubstackPmNode): boolean {
  return /image/i.test(node.type) || typeof node.attrs?.src === "string";
}

function hasImageSrc(node: SubstackPmNode): boolean {
  return typeof node.attrs?.src === "string";
}

function isCodeBlockLikeNode(node: SubstackPmNode): boolean {
  return /code/i.test(node.type);
}

function isLatexCandidateNode(node: SubstackPmNode): boolean {
  const values = [
    node.type,
    ...Object.entries(node.attrs ?? {}).map(
      ([key, value]) => `${key}:${value}`,
    ),
  ];
  return values.some((value) => /latex|equation|math/i.test(value));
}

function isNativeLatexCandidateNode(node: SubstackPmNode): boolean {
  if (/code/i.test(node.type)) {
    return false;
  }

  const values = [
    node.type,
    ...Object.entries(node.attrs ?? {}).map(
      ([key, value]) => `${key}:${value}`,
    ),
  ];
  return values.some((value) => /latex|equation|math/i.test(value));
}

function findFirstNode(
  node: SubstackPmDoc | SubstackPmNode,
  predicate: (node: SubstackPmNode) => boolean,
): SubstackPmNode | undefined {
  const children = "content" in node ? node.content : undefined;
  if (!children) {
    return undefined;
  }

  for (const child of children) {
    if (predicate(child)) {
      return child;
    }

    const nested = findFirstNode(child, predicate);
    if (nested) {
      return nested;
    }
  }

  return undefined;
}

function textContent(node: SubstackPmDoc | SubstackPmNode): string {
  const ownText =
    "text" in node && typeof node.text === "string" ? node.text : "";
  const children = "content" in node ? node.content : undefined;
  const childText = children?.map(textContent).join("") ?? "";
  return `${ownText}${childText}`;
}

function nodeValueText(node: SubstackPmNode): string {
  const attrText = Object.values(node.attrs ?? {})
    .map((value) => String(value))
    .join(" ");
  return `${node.type} ${attrText} ${textContent(node)}`;
}

function renderFixtureLine(fixture: SubstackFixtureCheck): string {
  const next = `\n  Next: ${fixture.next_action}`;

  if (!fixture.present) {
    return `- ${fixture.kind}: missing (${fixture.file})${next}`;
  }

  if (!fixture.valid) {
    return `- ${fixture.kind}: invalid (${fixture.file}) - ${fixture.error}${next}`;
  }

  if (!fixture.compatible) {
    return `- ${fixture.kind}: incompatible (${fixture.file}) - ${fixture.compatibility_error}${next}`;
  }

  const nodeTypes = Object.keys(fixture.summary?.node_types ?? {}).join(", ");
  const summary = nodeTypes.length > 0 ? `; nodes: ${nodeTypes}` : "";
  return `- ${fixture.kind}: valid and compatible (${fixture.file}${summary})${next}`;
}

function fixtureNextAction(
  fixture: RequiredSubstackFixture,
  status: "missing" | "invalid" | "incompatible" | "ready",
  captureFixtureDirArg: string | undefined,
): string {
  const captureCommand = captureFixtureCommand(
    fixture.kind,
    captureFixtureDirArg,
  );
  const inspectCommand = inspectFixtureCommand(
    fixture.kind,
    captureFixtureDirArg,
  );

  switch (status) {
    case "missing":
      return `Run \`${captureCommand}\` to create and capture this purpose-built fixture, or \`${inspectCommand}\` if a matching draft already exists.`;
    case "invalid":
      return `Replace ${fixture.file} by rerunning \`${captureCommand}\` or by capturing an existing purpose-built draft with \`${inspectCommand}\`.`;
    case "incompatible":
      return `Compare ${fixture.file} with the current adapter output, then update the adapter mapping or recapture a fresh purpose-built draft with \`${captureCommand}\`.`;
    case "ready":
      return "No action needed.";
  }
}

export function captureFixtureCommand(
  kind: SubstackFixtureKind | "all",
  captureFixtureDirArg: string | undefined,
): string {
  const baseCommand = `npm run create:fixture -- --kind ${kind} --capture`;
  if (!captureFixtureDirArg) {
    return baseCommand;
  }

  return `${baseCommand} --fixture-dir ${shellArg(captureFixtureDirArg)}`;
}

export function inspectFixtureCommand(
  kind: SubstackFixtureKind | "<kind>",
  captureFixtureDirArg: string | undefined,
): string {
  const baseCommand = `npm run inspect:draft -- <draft_id> --fixture ${kind}`;
  if (!captureFixtureDirArg) {
    return baseCommand;
  }

  return `${baseCommand} --fixture-dir ${shellArg(captureFixtureDirArg)}`;
}

export function fixtureStatusCommand(
  captureFixtureDirArg: string | undefined,
  requireAll: boolean,
): string {
  const args = [
    ...(captureFixtureDirArg
      ? ["--fixture-dir", shellArg(captureFixtureDirArg)]
      : []),
    ...(requireAll ? ["--require-all"] : []),
  ];
  return args.length === 0
    ? "npm run fixtures:status"
    : `npm run fixtures:status -- ${args.join(" ")}`;
}

export function fixtureCompatibilityTestCommand(
  captureFixtureDirArg: string | undefined,
): string {
  const command =
    "npm test -- tests/content/substackFixtureCompatibility.test.ts";
  if (!captureFixtureDirArg) {
    return command;
  }

  return `SUBSTACK_FIXTURE_DIR=${shellArg(captureFixtureDirArg)} ${command}`;
}

function captureFixtureDirCommandArg(
  cwd: string,
  fixtureDir: string,
): string | undefined {
  const root = resolve(cwd);
  const resolvedFixtureDir = resolve(fixtureDir);
  if (resolvedFixtureDir === resolve(root, "fixtures", "substack")) {
    return undefined;
  }

  const relativePath = relative(root, resolvedFixtureDir);
  if (
    relativePath === "" ||
    relativePath.startsWith("..") ||
    isAbsolute(relativePath)
  ) {
    return undefined;
  }

  return relativePath;
}

function shellArg(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/u.test(value)) {
    return value;
  }

  return `'${value.replace(/'/g, "'\\''")}'`;
}

function parseFormat(value: string): FixtureStatusFormat {
  if (value === "text" || value === "json") {
    return value;
  }

  throw new Error("--format must be one of: text, json.");
}

export function resolveProjectFixtureDir(
  cwd: string,
  value: string,
  flag = "--fixture-dir",
): string {
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

function resolveInsideCwd(cwd: string, value: string): string {
  return resolveProjectFixtureDir(cwd, value);
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

function isSubstackPmDoc(value: unknown): value is SubstackPmDoc {
  return (
    isRecord(value) && value.type === "doc" && Array.isArray(value.content)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
