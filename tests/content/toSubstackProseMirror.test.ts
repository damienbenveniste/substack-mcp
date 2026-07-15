import { describe, expect, it } from "vitest";

import { toPreviewText } from "../../src/content/toPreviewText.js";
import { toSubstackProseMirror } from "../../src/content/toSubstackProseMirror.js";
import type { NewsletterBlock } from "../../src/index.js";

const nativeNodeIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("toSubstackProseMirror", () => {
  it("maps paragraphs and inline marks to ProseMirror nodes", () => {
    const result = toSubstackProseMirror([
      {
        type: "paragraph",
        children: [
          { text: "Plain " },
          { text: "bold", bold: true },
          { text: " italic", italic: true },
          { text: " code", code: true },
          { text: " link", href: "https://example.com" },
        ],
      },
    ]);

    expect(result.warnings).toEqual([]);
    expect(result.doc).toEqual({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Plain " },
            { type: "text", text: "bold", marks: [{ type: "strong" }] },
            { type: "text", text: " italic", marks: [{ type: "em" }] },
            { type: "text", text: " code", marks: [{ type: "code" }] },
            {
              type: "text",
              text: " link",
              marks: [{ type: "link", attrs: { href: "https://example.com" } }],
            },
          ],
        },
      ],
    });
  });

  it("maps structural blocks", () => {
    const blocks: readonly NewsletterBlock[] = [
      {
        type: "heading",
        level: 2,
        children: [{ text: "Heading" }],
      },
      {
        type: "blockquote",
        children: [{ type: "paragraph", children: [{ text: "Quote" }] }],
      },
      {
        type: "bulleted_list",
        items: [
          { children: [{ type: "paragraph", children: [{ text: "Bullet" }] }] },
        ],
      },
      {
        type: "ordered_list",
        start: 3,
        items: [
          { children: [{ type: "paragraph", children: [{ text: "Third" }] }] },
        ],
      },
      { type: "horizontal_rule" },
    ];

    expect(toSubstackProseMirror(blocks).doc.content).toEqual([
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "Heading" }],
      },
      {
        type: "blockquote",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Quote" }],
          },
        ],
      },
      {
        type: "bullet_list",
        content: [
          {
            type: "list_item",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Bullet" }],
              },
            ],
          },
        ],
      },
      {
        type: "ordered_list",
        attrs: { order: 3 },
        content: [
          {
            type: "list_item",
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: "Third" }],
              },
            ],
          },
        ],
      },
      { type: "horizontal_rule" },
    ]);
  });

  it("maps native code, LaTeX, and image captions alongside provisional image and embed blocks", () => {
    const result = toSubstackProseMirror([
      {
        type: "code_block",
        language: "typescript",
        code: "console.log('draft');",
      },
      {
        type: "image",
        src: "https://example.com/image.png",
        alt: "Alt",
        title: "Title",
        caption: "Caption",
        width: 640,
        height: 480,
      },
      { type: "latex_block", latex: "E = mc^2" },
      { type: "embed_url", url: "https://example.com/video" },
    ]);

    expect(result.warnings).toHaveLength(2);
    expect(result.doc.content[0]).toEqual({
      type: "highlighted_code_block",
      attrs: {
        language: "typescript",
        nodeId: expect.stringMatching(nativeNodeIdPattern),
      },
      content: [{ type: "text", text: "console.log('draft');" }],
    });
    expect(result.doc.content[1]).toEqual({
      type: "captionedImage",
      content: [
        {
          type: "image2",
          attrs: {
            src: "https://example.com/image.png",
            imageSize: "normal",
            fullscreen: false,
            belowTheFold: false,
            alt: "Alt",
            title: "Title",
            width: 640,
            height: 480,
          },
        },
        {
          type: "caption",
          content: [{ type: "text", text: "Caption" }],
        },
      ],
    });
    expect(result.doc.content[2]).toEqual({
      type: "latex_block",
      attrs: {
        persistentExpression: "E = mc^2",
        id: expect.stringMatching(nativeNodeIdPattern),
      },
    });
    expect(result.doc.content[3]).toEqual({
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "https://example.com/video",
          marks: [
            { type: "link", attrs: { href: "https://example.com/video" } },
          ],
        },
      ],
    });
    expect(result.warnings).not.toContain(
      expect.stringContaining("following paragraph fallback"),
    );
  });

  it("omits ordered-list attrs when the list uses the default start", () => {
    expect(
      toSubstackProseMirror([
        {
          type: "ordered_list",
          items: [
            {
              children: [{ type: "paragraph", children: [{ text: "First" }] }],
            },
          ],
        },
      ]).doc.content[0],
    ).toEqual({
      type: "ordered_list",
      content: [
        {
          type: "list_item",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "First" }],
            },
          ],
        },
      ],
    });
  });

  it("generates stable and distinct native block IDs", () => {
    const blocks: readonly NewsletterBlock[] = [
      { type: "code_block", code: "print('hello')" },
      { type: "code_block", code: "print('hello')" },
      { type: "latex_block", latex: "E = mc^2" },
    ];

    const first = toSubstackProseMirror(blocks).doc;
    const second = toSubstackProseMirror(blocks).doc;
    const firstCodeId = first.content[0]?.attrs?.nodeId;
    const secondCodeId = first.content[1]?.attrs?.nodeId;

    expect(first).toEqual(second);
    expect(first.content[0]?.attrs).toMatchObject({ language: "plaintext" });
    expect(firstCodeId).toEqual(expect.stringMatching(nativeNodeIdPattern));
    expect(secondCodeId).toEqual(expect.stringMatching(nativeNodeIdPattern));
    expect(firstCodeId).not.toBe(secondCodeId);
  });

  it("uses an empty paragraph for empty list items", () => {
    expect(
      toSubstackProseMirror([
        { type: "bulleted_list", items: [{ children: [] }] },
      ]).doc.content,
    ).toEqual([
      {
        type: "bullet_list",
        content: [
          {
            type: "list_item",
            content: [{ type: "paragraph" }],
          },
        ],
      },
    ]);
  });

  it("uses an empty paragraph for an empty body", () => {
    expect(toSubstackProseMirror([]).doc).toEqual({
      type: "doc",
      content: [{ type: "paragraph" }],
    });
  });

  it("omits absent image optional attributes", () => {
    const result = toSubstackProseMirror([
      {
        type: "image",
        src: "https://example.com/minimal.png",
      },
    ]);

    expect(result.doc.content[0]).toEqual({
      type: "captionedImage",
      content: [
        {
          type: "image2",
          attrs: {
            src: "https://example.com/minimal.png",
            imageSize: "normal",
            fullscreen: false,
            belowTheFold: false,
          },
        },
      ],
    });
  });
});

describe("toPreviewText", () => {
  it("normalizes whitespace and truncates long text", () => {
    const text = toPreviewText(
      [{ type: "paragraph", children: [{ text: "One   two\tthree four" }] }],
      13,
    );

    expect(text).toBe("One two th...");
  });
});
