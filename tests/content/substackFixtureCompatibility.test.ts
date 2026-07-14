import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolveProjectFixtureDir } from "../../scripts/fixtureStatusCore.js";
import type { ImageBlock } from "../../src/content/newsletterBlocks.js";
import {
  type SubstackPmDoc,
  type SubstackPmNode,
  toSubstackProseMirror,
} from "../../src/content/toSubstackProseMirror.js";

const FIXTURE_DIR = substackFixtureDirFromEnv(process.env.SUBSTACK_FIXTURE_DIR);

describe("Substack live fixture compatibility", () => {
  const inlineMarksFixture = substackFixture("inline-marks-draft-body.json");
  const codeBlockFixture = substackFixture("code-block-draft-body.json");
  const imageFixture = substackFixture("image-draft-body.json");
  const latexFixture = substackFixture("latex-block-draft-body.json");

  const inlineMarksIt = inlineMarksFixture.exists ? it : it.skip;
  inlineMarksIt("matches the captured inline mark node shape", () => {
    const result = toSubstackProseMirror([
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
    ]);

    expect(result.doc).toEqual(inlineMarksFixture.readDoc());
  });

  const codeBlockIt = codeBlockFixture.exists ? it : it.skip;
  codeBlockIt("matches the captured code block node shape", () => {
    const result = toSubstackProseMirror([
      {
        type: "code_block",
        language: "python",
        code: "print('hello')",
      },
    ]);

    expect(result.doc).toEqual(codeBlockFixture.readDoc());
  });

  const imageIt = imageFixture.exists ? it : it.skip;
  imageIt("matches the captured image node shape", () => {
    const fixtureDoc = imageFixture.readDoc();
    const imageBlock = imageBlockFromFixture(fixtureDoc);
    const result = toSubstackProseMirror([imageBlock]);

    expect(result.doc).toEqual(fixtureDoc);
  });

  const latexIt = latexFixture.exists ? it : it.skip;
  latexIt("matches the captured native LaTeX block node shape", () => {
    const result = toSubstackProseMirror([
      {
        type: "latex_block",
        latex: "E = mc^2",
      },
    ]);

    expect(result.doc).toEqual(latexFixture.readDoc());
  });
});

interface SubstackFixture {
  readonly exists: boolean;
  readonly readDoc: () => SubstackPmDoc;
}

function substackFixture(fileName: string): SubstackFixture {
  const filePath = join(FIXTURE_DIR, fileName);
  return {
    exists: existsSync(filePath),
    readDoc: () => readFixtureDoc(filePath),
  };
}

function readFixtureDoc(filePath: string): SubstackPmDoc {
  const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  assertReusableFixtureHasNoMetadata(filePath, parsed);
  const draftBody =
    isRecord(parsed) && "draft_body" in parsed ? parsed.draft_body : parsed;
  const doc =
    typeof draftBody === "string"
      ? (JSON.parse(draftBody) as unknown)
      : draftBody;

  if (!isSubstackPmDoc(doc)) {
    throw new Error(`${filePath} does not contain a Substack draft_body doc.`);
  }

  return doc;
}

function assertReusableFixtureHasNoMetadata(
  filePath: string,
  parsed: unknown,
): void {
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
    `${filePath} must contain only draft_body; remove top-level metadata field(s): ${metadataKeys.join(", ")}.`,
  );
}

function imageBlockFromFixture(doc: SubstackPmDoc): ImageBlock {
  const imageNode = findFirstNode(
    doc,
    (node) => typeof node.attrs?.src === "string",
  );

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
    Boolean(
      findFirstNode(node, (child) => typeof child.attrs?.src === "string"),
    ),
  );
  const nativeCaption =
    imageContainer === undefined ? "" : textContent(imageContainer).trim();
  if (nativeCaption.length > 0) {
    return nativeCaption;
  }

  const fallbackCaption = doc.content
    .filter(
      (node) =>
        !findFirstNode(node, (child) => typeof child.attrs?.src === "string"),
    )
    .map((node) => textContent(node).trim())
    .filter((text) => text.length > 0)
    .join("\n");

  return fallbackCaption.length > 0 ? fallbackCaption : undefined;
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

function textContent(node: SubstackPmNode): string {
  const ownText = typeof node.text === "string" ? node.text : "";
  const childText = node.content?.map(textContent).join("") ?? "";
  return `${ownText}${childText}`;
}

function isSubstackPmDoc(value: unknown): value is SubstackPmDoc {
  return (
    isRecord(value) && value.type === "doc" && Array.isArray(value.content)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function substackFixtureDirFromEnv(value: string | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) {
    return join(process.cwd(), "fixtures", "substack");
  }

  return resolveProjectFixtureDir(
    process.cwd(),
    trimmed,
    "SUBSTACK_FIXTURE_DIR",
  );
}
