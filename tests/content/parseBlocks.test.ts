import { describe, expect, it } from "vitest";

import { parseBlocks } from "../../src/content/parseBlocks.js";

describe("parseBlocks", () => {
  it("normalizes optional code block language metadata", () => {
    expect(
      parseBlocks([
        {
          type: "code_block",
          language: "  typescript  ",
          code: "console.log('draft');",
        },
        {
          type: "code_block",
          language: "   ",
          code: "plain text",
        },
      ]),
    ).toEqual({
      blocks: [
        {
          type: "code_block",
          language: "typescript",
          code: "console.log('draft');",
        },
        {
          type: "code_block",
          language: undefined,
          code: "plain text",
        },
      ],
      errors: [],
    });
  });

  it("accepts public block URLs and rejects non-string code languages", () => {
    const accepted = parseBlocks([
      {
        type: "paragraph",
        children: [{ text: "Link", href: "https://example.com/post" }],
      },
      {
        type: "image",
        src: "https://example.com/image.png",
      },
      {
        type: "embed_url",
        url: "https://example.com/video",
      },
    ]);

    expect(accepted.errors).toEqual([]);
    expect(accepted.blocks).toHaveLength(3);

    const rejected = parseBlocks([
      {
        type: "code_block",
        language: 123,
        code: "console.log('draft');",
      },
    ]);

    expect(rejected.blocks).toEqual([]);
    expect(rejected.errors).toEqual([
      "0.language: Expected string, received number",
    ]);
  });

  it("rejects invalid explicit block URLs with field paths", () => {
    const result = parseBlocks([
      {
        type: "paragraph",
        children: [{ text: "Unsafe", href: "javascript:alert(1)" }],
      },
      {
        type: "image",
        src: "http://127.0.0.1/image.png",
      },
      {
        type: "embed_url",
        url: "mailto:test@example.com",
      },
    ]);

    expect(result.blocks).toEqual([]);
    expect(result.errors).toEqual([
      "0.children.0.href: href must use http:// or https://.",
      "1.src: src must not point to localhost or private network addresses.",
      "2.url: url must use http:// or https://.",
    ]);
  });
});
