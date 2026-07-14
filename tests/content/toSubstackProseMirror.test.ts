import { describe, expect, it } from "vitest";

import { toPreviewText } from "../../src/content/toPreviewText.js";
import { toSubstackProseMirror } from "../../src/content/toSubstackProseMirror.js";
import type { NewsletterBlock } from "../../src/index.js";

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

  it("maps provisional code, image, latex, and embed blocks with warnings", () => {
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

    expect(result.warnings).toHaveLength(4);
    expect(result.doc.content[0]).toEqual({
      type: "code_block",
      attrs: { lang: "typescript" },
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
      ],
    });
    expect(result.doc.content[2]).toEqual({
      type: "paragraph",
      content: [{ type: "text", text: "Caption" }],
    });
    expect(result.doc.content[3]).toEqual({
      type: "code_block",
      attrs: { lang: "latex" },
      content: [{ type: "text", text: "E = mc^2" }],
    });
    expect(result.doc.content[4]).toEqual({
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
