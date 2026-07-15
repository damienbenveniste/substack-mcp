import { createHash } from "node:crypto";

import type {
  ImageBlock,
  InlineSpan,
  ListItemBlock,
  NewsletterBlock,
} from "./newsletterBlocks.js";

export interface SubstackPmDoc {
  readonly type: "doc";
  readonly content: readonly SubstackPmNode[];
}

export interface SubstackPmNode {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, unknown>> | undefined;
  readonly content?: readonly SubstackPmNode[] | undefined;
  readonly marks?: readonly SubstackPmMark[] | undefined;
  readonly text?: string | undefined;
}

export interface SubstackPmMark {
  readonly type: string;
  readonly attrs?: Readonly<Record<string, unknown>> | undefined;
}

export interface SubstackConversionResult {
  readonly doc: SubstackPmDoc;
  readonly warnings: readonly string[];
}

interface NativeNodeIdContext {
  nextOrdinal: number;
}

export function toSubstackProseMirror(
  blocks: readonly NewsletterBlock[],
): SubstackConversionResult {
  const warnings = new Set<string>();
  const nativeNodeIds: NativeNodeIdContext = { nextOrdinal: 0 };
  const content = blocks.flatMap((block) =>
    blockToNodes(block, warnings, nativeNodeIds),
  );

  return {
    doc: {
      type: "doc",
      content: content.length > 0 ? content : [{ type: "paragraph" }],
    },
    warnings: Array.from(warnings),
  };
}

function blockToNodes(
  block: NewsletterBlock,
  warnings: Set<string>,
  nativeNodeIds: NativeNodeIdContext,
): readonly SubstackPmNode[] {
  switch (block.type) {
    case "paragraph":
      return [
        withContent("paragraph", inlineSpansToNodes(block.children), undefined),
      ];
    case "heading":
      return [
        withContent("heading", inlineSpansToNodes(block.children), {
          level: block.level,
        }),
      ];
    case "blockquote":
      return [
        withContent(
          "blockquote",
          block.children.flatMap((child) =>
            blockToNodes(child, warnings, nativeNodeIds),
          ),
          undefined,
        ),
      ];
    case "bulleted_list":
      return [
        withContent(
          "bullet_list",
          block.items.map((item) =>
            listItemToNode(item, warnings, nativeNodeIds),
          ),
          undefined,
        ),
      ];
    case "ordered_list":
      return [
        withContent(
          "ordered_list",
          block.items.map((item) =>
            listItemToNode(item, warnings, nativeNodeIds),
          ),
          block.start ? { order: block.start } : undefined,
        ),
      ];
    case "horizontal_rule":
      return [{ type: "horizontal_rule" }];
    case "image":
      return imageToNodes(block, warnings);
    case "code_block":
      return [
        withContent(
          "highlighted_code_block",
          [{ type: "text", text: block.code }],
          {
            language: block.language ?? "plaintext",
            nodeId: stableNativeNodeId(nativeNodeIds, "highlighted-code", [
              block.language ?? "plaintext",
              block.code,
            ]),
          },
        ),
      ];
    case "latex_block":
      return [
        {
          type: "latex_block",
          attrs: {
            persistentExpression: block.latex,
            id: stableNativeNodeId(nativeNodeIds, "latex", [block.latex]),
          },
        },
      ];
    case "embed_url":
      warnings.add(
        "Embed URL mapping is provisional; preview uses a plain URL paragraph until a native embed fixture is captured.",
      );
      return [
        withContent(
          "paragraph",
          [
            {
              type: "text",
              text: block.url,
              marks: [{ type: "link", attrs: { href: block.url } }],
            },
          ],
          undefined,
        ),
      ];
  }
}

function listItemToNode(
  item: ListItemBlock,
  warnings: Set<string>,
  nativeNodeIds: NativeNodeIdContext,
): SubstackPmNode {
  const content = item.children.flatMap((child) =>
    blockToNodes(child, warnings, nativeNodeIds),
  );
  return withContent(
    "list_item",
    content.length > 0 ? content : [withContent("paragraph", [], undefined)],
    undefined,
  );
}

function stableNativeNodeId(
  context: NativeNodeIdContext,
  kind: "highlighted-code" | "latex",
  values: readonly string[],
): string {
  const ordinal = context.nextOrdinal;
  context.nextOrdinal += 1;
  const digest = createHash("sha256")
    .update(
      JSON.stringify({
        namespace: "substack-mcp-native-node-v1",
        kind,
        ordinal,
        values,
      }),
    )
    .digest("hex");
  const variant = (
    (Number.parseInt(digest.slice(16, 17), 16) & 0x3) |
    0x8
  ).toString(16);

  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-${variant}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function imageToNodes(
  image: ImageBlock,
  warnings: Set<string>,
): readonly SubstackPmNode[] {
  warnings.add(
    "Image node mapping is provisional until a live Substack image fixture is captured.",
  );

  const attrs: Record<string, unknown> = {
    src: image.src,
    imageSize: "normal",
    fullscreen: false,
    belowTheFold: false,
  };

  if (image.alt !== undefined) {
    attrs.alt = image.alt;
  }
  if (image.title !== undefined) {
    attrs.title = image.title;
  }
  if (image.width !== undefined) {
    attrs.width = image.width;
  }
  if (image.height !== undefined) {
    attrs.height = image.height;
  }

  const content: SubstackPmNode[] = [
    {
      type: "image2",
      attrs,
    },
  ];

  if (image.caption) {
    content.push(
      withContent(
        "caption",
        [{ type: "text", text: image.caption }],
        undefined,
      ),
    );
  }

  return [withContent("captionedImage", content, undefined)];
}

function inlineSpansToNodes(
  spans: readonly InlineSpan[],
): readonly SubstackPmNode[] {
  return spans
    .filter((span) => span.text.length > 0)
    .map((span) => {
      const marks = spanToMarks(span);
      return {
        type: "text",
        text: span.text,
        ...(marks.length > 0 ? { marks } : {}),
      };
    });
}

function spanToMarks(span: InlineSpan): readonly SubstackPmMark[] {
  const marks: SubstackPmMark[] = [];

  if (span.bold) {
    marks.push({ type: "strong" });
  }
  if (span.italic) {
    marks.push({ type: "em" });
  }
  if (span.code) {
    marks.push({ type: "code" });
  }
  if (span.href) {
    marks.push({ type: "link", attrs: { href: span.href } });
  }

  return marks;
}

function withContent(
  type: string,
  content: readonly SubstackPmNode[],
  attrs: Readonly<Record<string, unknown>> | undefined,
): SubstackPmNode {
  return {
    type,
    ...(attrs ? { attrs } : {}),
    ...(content.length > 0 ? { content } : {}),
  };
}
