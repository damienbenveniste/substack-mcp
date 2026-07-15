import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface ToolCaller {
  callTool(request: {
    readonly name: string;
    readonly arguments?: Record<string, unknown>;
  }): Promise<unknown>;
}

export interface ValidationSmokeResult {
  readonly ok: true;
  readonly fixture: string;
  readonly blocks: number;
  readonly words: number;
  readonly images: number;
  readonly code_blocks: number;
  readonly latex_blocks: number;
  readonly links: number;
  readonly warning_count: number;
  readonly unsupported_features: readonly string[];
}

export interface PreviewSmokeResult {
  readonly ok: true;
  readonly fixture: string;
  readonly action: "create";
  readonly title: string;
  readonly blocks: number;
  readonly words: number;
  readonly images: number;
  readonly code_blocks: number;
  readonly latex_blocks: number;
  readonly warning_count: number;
  readonly confirmation_token_parts: number;
  readonly confirmation_expires_at: string;
  readonly preview_text_chars: number;
  readonly payload_debug_doc_type: string;
  readonly payload_debug_top_level_nodes: number;
}

const RICH_FIXTURE_PATH = "fixtures/markdown/full-rich-draft.md";
const PREVIEW_TITLE = "[MCP SMOKE] Rich Draft Preview";
const TABLE_FIXTURE_WARNING = "Markdown tables are not supported in V1.";

export async function assertValidateNewsletterContentTool(
  client: ToolCaller,
  cwd = process.cwd(),
): Promise<ValidationSmokeResult> {
  const bodyMarkdown = readFileSync(join(cwd, RICH_FIXTURE_PATH), "utf8");
  const result = asRecord(
    await client.callTool({
      name: "validate_newsletter_content",
      arguments: {
        body_format: "markdown_v1",
        body_markdown: bodyMarkdown,
      },
    }),
  );

  if (result.isError) {
    throw new Error("validate_newsletter_content returned an MCP error.");
  }

  const structured = asRecord(result.structuredContent);
  if (structured.ok !== true) {
    throw new Error("validate_newsletter_content did not return ok=true.");
  }

  const stats = asRecord(structured.stats);
  const warnings = readStringArray(structured.warnings, "warnings");
  const unsupportedFeatures = readStringArray(
    structured.unsupported_features,
    "unsupported_features",
  );

  assertNumber(stats.blocks, 16, "stats.blocks");
  assertNumber(stats.images, 1, "stats.images");
  assertNumber(stats.code_blocks, 1, "stats.code_blocks");
  assertNumber(stats.latex_blocks, 1, "stats.latex_blocks");
  assertNumber(stats.links, 1, "stats.links");
  if (!warnings.includes(TABLE_FIXTURE_WARNING)) {
    throw new Error(
      "validate_newsletter_content did not return the table fixture warning.",
    );
  }
  if (JSON.stringify(unsupportedFeatures) !== JSON.stringify(["table"])) {
    throw new Error(
      `validate_newsletter_content returned unexpected unsupported features: ${unsupportedFeatures.join(", ")}`,
    );
  }

  const blocks = readNumber(stats.blocks, "stats.blocks");
  const words = readNumber(stats.words, "stats.words");
  const images = readNumber(stats.images, "stats.images");
  const codeBlocks = readNumber(stats.code_blocks, "stats.code_blocks");
  const latexBlocks = readNumber(stats.latex_blocks, "stats.latex_blocks");
  const links = readNumber(stats.links, "stats.links");

  return {
    ok: true,
    fixture: RICH_FIXTURE_PATH,
    blocks,
    words,
    images,
    code_blocks: codeBlocks,
    latex_blocks: latexBlocks,
    links,
    warning_count: warnings.length,
    unsupported_features: unsupportedFeatures,
  };
}

export async function assertPreviewDraftTool(
  client: ToolCaller,
  cwd = process.cwd(),
): Promise<PreviewSmokeResult> {
  const bodyMarkdown = readFileSync(join(cwd, RICH_FIXTURE_PATH), "utf8");
  const result = asRecord(
    await client.callTool({
      name: "preview_draft",
      arguments: {
        action: "create",
        title: PREVIEW_TITLE,
        body_format: "markdown_v1",
        body_markdown: bodyMarkdown,
        include_payload_debug: true,
      },
    }),
    "preview_draft",
  );

  if (result.isError) {
    throw new Error("preview_draft returned an MCP error.");
  }

  const structured = asRecord(result.structuredContent, "preview_draft");
  if (structured.ok !== true) {
    throw new Error("preview_draft did not return ok=true.");
  }
  if (structured.action !== "create") {
    throw new Error("preview_draft returned an unexpected action.");
  }
  if (structured.title !== PREVIEW_TITLE) {
    throw new Error("preview_draft returned an unexpected title.");
  }

  const stats = asRecord(structured.stats, "preview_draft");
  const warnings = readStringArray(
    structured.warnings,
    "warnings",
    "preview_draft",
  );
  const confirmationToken = readString(
    structured.confirmation_token,
    "confirmation_token",
    "preview_draft",
  );
  const confirmationExpiresAt = readString(
    structured.confirmation_expires_at,
    "confirmation_expires_at",
    "preview_draft",
  );
  const previewText = readString(
    structured.preview_text,
    "preview_text",
    "preview_draft",
  );
  const payloadDebug = asRecord(structured.payload_debug, "preview_draft");
  const payloadDebugDocType = readString(
    payloadDebug.draft_body_doc_type,
    "payload_debug.draft_body_doc_type",
    "preview_draft",
  );

  assertNumber(stats.blocks, 16, "stats.blocks", "preview_draft");
  assertNumber(stats.images, 1, "stats.images", "preview_draft");
  assertNumber(stats.code_blocks, 1, "stats.code_blocks", "preview_draft");
  assertNumber(stats.latex_blocks, 1, "stats.latex_blocks", "preview_draft");

  if (!warnings.includes(TABLE_FIXTURE_WARNING)) {
    throw new Error("preview_draft did not return the table fixture warning.");
  }

  const tokenParts = confirmationToken.split(".").length;
  if (tokenParts !== 2) {
    throw new Error("preview_draft returned a malformed confirmation token.");
  }

  if (Number.isNaN(Date.parse(confirmationExpiresAt))) {
    throw new Error("preview_draft returned a malformed confirmation expiry.");
  }

  if (payloadDebugDocType !== "doc") {
    throw new Error(
      `preview_draft returned payload_debug.draft_body_doc_type=${payloadDebugDocType}, expected doc.`,
    );
  }

  const blocks = readNumber(stats.blocks, "stats.blocks", "preview_draft");
  const words = readNumber(stats.words, "stats.words", "preview_draft");
  const images = readNumber(stats.images, "stats.images", "preview_draft");
  const codeBlocks = readNumber(
    stats.code_blocks,
    "stats.code_blocks",
    "preview_draft",
  );
  const latexBlocks = readNumber(
    stats.latex_blocks,
    "stats.latex_blocks",
    "preview_draft",
  );
  const topLevelNodes = readNumber(
    payloadDebug.top_level_nodes,
    "payload_debug.top_level_nodes",
    "preview_draft",
  );

  return {
    ok: true,
    fixture: RICH_FIXTURE_PATH,
    action: "create",
    title: PREVIEW_TITLE,
    blocks,
    words,
    images,
    code_blocks: codeBlocks,
    latex_blocks: latexBlocks,
    warning_count: warnings.length,
    confirmation_token_parts: tokenParts,
    confirmation_expires_at: confirmationExpiresAt,
    preview_text_chars: previewText.length,
    payload_debug_doc_type: payloadDebugDocType,
    payload_debug_top_level_nodes: topLevelNodes,
  };
}

function asRecord(
  value: unknown,
  toolName = "validate_newsletter_content",
): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  throw new Error(`${toolName} returned malformed structured content.`);
}

function readStringArray(
  value: unknown,
  name: string,
  toolName = "validate_newsletter_content",
): readonly string[] {
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value;
  }

  throw new Error(`${toolName} returned malformed ${name}.`);
}

function readString(value: unknown, name: string, toolName: string): string {
  if (typeof value === "string" && value.length > 0) {
    return value;
  }

  throw new Error(`${toolName} returned malformed ${name}.`);
}

function readNumber(
  value: unknown,
  name: string,
  toolName = "validate_newsletter_content",
): number {
  if (typeof value !== "number") {
    throw new Error(`${toolName} returned malformed ${name}.`);
  }

  return value;
}

function assertNumber(
  value: unknown,
  expected: number,
  name: string,
  toolName = "validate_newsletter_content",
): void {
  const actual = readNumber(value, name, toolName);
  if (actual !== expected) {
    throw new Error(
      `${toolName} returned ${name}=${actual}, expected ${expected}.`,
    );
  }
}
