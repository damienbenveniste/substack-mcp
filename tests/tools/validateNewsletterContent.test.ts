import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { computeContentStats } from "../../src/content/newsletterBlocks.js";
import {
  summarizeValidation,
  validateNewsletterContent,
} from "../../src/tools/validateNewsletterContent.js";

const fixturePath = join(process.cwd(), "fixtures/markdown/full-rich-draft.md");

describe("validateNewsletterContent", () => {
  it("returns stats for the rich Markdown fixture", () => {
    const body_markdown = readFileSync(fixturePath, "utf8");

    const result = validateNewsletterContent(
      {
        body_format: "markdown_v1",
        body_markdown,
      },
      { maxBodyBytes: 750_000 },
    );

    expect(result.ok).toBe(true);
    expect(result.stats.blocks).toBe(16);
    expect(result.stats.images).toBe(1);
    expect(result.stats.code_blocks).toBe(1);
    expect(result.stats.latex_blocks).toBe(1);
    expect(result.stats.links).toBe(1);
    expect(result.unsupported_features).toEqual(["table"]);
    expect(result.warnings).toContain(
      "LaTeX block mapping is provisional until a live Substack LaTeX fixture is captured; preview uses a latex code block fallback.",
    );
  });

  it("turns unsupported features into errors in strict mode", () => {
    const result = validateNewsletterContent(
      {
        body_format: "markdown_v1",
        body_markdown: "| A | B |\n| - | - |\n| 1 | 2 |",
        strict: true,
      },
      { maxBodyBytes: 750_000 },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "Unsupported features in strict mode: table.",
    );
  });

  it("rejects raw HTML by default", () => {
    const result = validateNewsletterContent(
      {
        body_format: "markdown_v1",
        body_markdown:
          'Before\n\n<iframe src="https://example.com"></iframe>\n\nAfter',
      },
      { maxBodyBytes: 750_000 },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Raw HTML is not supported in V1.");
    expect(result.unsupported_features).toEqual(["raw_html"]);
    expect(result.warnings).toContain("Raw HTML is not supported in V1.");
  });

  it("reports the plan-listed unsupported Markdown features through the public validator", () => {
    const result = validateNewsletterContent(
      {
        body_format: "markdown_v1",
        body_markdown: [
          "Paragraph with ~~strike~~, ![inline](https://example.com/inline.png), <span>html</span>, [reference][id], $x^2$, and a footnote.[^note]",
          "",
          "- [ ] task item",
          "  - nested item",
          "",
          "| A | B |",
          "| - | - |",
          "| 1 | 2 |",
          "",
          "[id]: https://example.com",
          "",
          "[^note]: Unsupported footnote",
        ].join("\n"),
      },
      { maxBodyBytes: 750_000 },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain("Raw HTML is not supported in V1.");
    expect(result.unsupported_features).toEqual(
      expect.arrayContaining([
        "strikethrough",
        "inline_image",
        "raw_html",
        "link_reference",
        "inline_math",
        "task_list",
        "nested_list",
        "table",
        "footnoteReference",
        "footnote",
      ]),
    );
    expect(result.unsupported_features).toHaveLength(10);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        "Strikethrough is not supported in V1.",
        "Inline images are converted only when they are the whole paragraph.",
        "Inline raw HTML is not supported.",
        "Reference-style links are parsed without resolving definitions.",
        "Inline math is not supported; use a LaTeX block.",
        "Task list checkboxes are not supported.",
        "Nested lists are parsed best-effort in V1.",
        "Markdown tables are not supported in V1.",
        "Footnote references are not supported in V1.",
        "Footnotes are not supported in V1.",
      ]),
    );
  });

  it("turns provisional LaTeX mapping into an error in strict mode", () => {
    const result = validateNewsletterContent(
      {
        body_format: "markdown_v1",
        body_markdown: "$$\nE = mc^2\n$$",
        strict: true,
      },
      { maxBodyBytes: 750_000 },
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "LaTeX block mapping is provisional until a live Substack LaTeX fixture is captured; strict mode requires native LaTeX fixture compatibility.",
    );
    expect(result.warnings).toContain(
      "LaTeX block mapping is provisional until a live Substack LaTeX fixture is captured; preview uses a latex code block fallback.",
    );
  });

  it("validates explicit blocks_v1 input", () => {
    const result = validateNewsletterContent(
      {
        body_format: "blocks_v1",
        blocks: [
          {
            type: "paragraph",
            children: [{ text: "Hello from blocks." }],
          },
          {
            type: "code_block",
            language: "typescript",
            code: "console.log('draft');",
          },
        ],
      },
      { maxBodyBytes: 750_000 },
    );

    expect(result.ok).toBe(true);
    expect(result.stats.blocks).toBe(2);
    expect(result.stats.code_blocks).toBe(1);
  });

  it("validates explicit Markdown directives", () => {
    const result = validateNewsletterContent(
      {
        body_format: "markdown_v1",
        body_markdown: `:::image
src: https://example.com/diagram.png
alt: Diagram
caption: Deployment flow
:::

:::latex
E = mc^2
:::
`,
      },
      { maxBodyBytes: 750_000 },
    );

    expect(result.ok).toBe(true);
    expect(result.stats.blocks).toBe(2);
    expect(result.stats.images).toBe(1);
    expect(result.stats.latex_blocks).toBe(1);
    expect(result.stats.words).toBe(6);
    expect(result.unsupported_features).toEqual([]);
  });

  it("rejects over-limit Markdown bodies", () => {
    const result = validateNewsletterContent(
      {
        body_format: "markdown_v1",
        body_markdown: "123456",
      },
      { maxBodyBytes: 5 },
    );

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("exceeds MAX_BODY_BYTES=5");
  });

  it("rejects over-limit blocks_v1 bodies", () => {
    const result = validateNewsletterContent(
      {
        body_format: "blocks_v1",
        blocks: [
          {
            type: "paragraph",
            children: [{ text: "123456" }],
          },
        ],
      },
      { maxBodyBytes: 5 },
    );

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("blocks is ");
    expect(result.errors[0]).toContain("exceeds MAX_BODY_BYTES=5");
  });

  it("requires body_markdown for markdown_v1", () => {
    const result = validateNewsletterContent(
      {
        body_format: "markdown_v1",
      },
      { maxBodyBytes: 750_000 },
    );

    expect(result.ok).toBe(false);
    expect(result.stats.blocks).toBe(0);
    expect(result.errors).toEqual([
      "body_markdown is required when body_format is markdown_v1.",
    ]);
    expect(summarizeValidation(result)).toBe(
      "Content validation failed with 1 error(s).",
    );
  });

  it("rejects body fields that do not match the selected body_format", () => {
    const markdownResult = validateNewsletterContent(
      {
        body_format: "markdown_v1",
        body_markdown: "Markdown body.",
        blocks: [{ type: "paragraph", children: [{ text: "Blocks body." }] }],
      },
      { maxBodyBytes: 750_000 },
    );

    expect(markdownResult.ok).toBe(false);
    expect(markdownResult.errors).toContain(
      "blocks must not be provided when body_format is markdown_v1.",
    );

    const blocksResult = validateNewsletterContent(
      {
        body_format: "blocks_v1",
        body_markdown: "Markdown body.",
        blocks: [{ type: "paragraph", children: [{ text: "Blocks body." }] }],
      },
      { maxBodyBytes: 750_000 },
    );

    expect(blocksResult.ok).toBe(false);
    expect(blocksResult.errors).toContain(
      "body_markdown must not be provided when body_format is blocks_v1.",
    );
  });

  it("returns parse errors for invalid blocks_v1 input", () => {
    const result = validateNewsletterContent(
      {
        body_format: "blocks_v1",
        blocks: [{ type: "image", src: "not-a-url" }],
      },
      { maxBodyBytes: 750_000 },
    );

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("src must be a valid URL.");
  });

  it("rejects unsafe blocks_v1 URLs", () => {
    const linkResult = validateNewsletterContent(
      {
        body_format: "blocks_v1",
        blocks: [
          {
            type: "paragraph",
            children: [
              {
                text: "Unsafe",
                href: "javascript:alert(1)",
              },
            ],
          },
        ],
      },
      { maxBodyBytes: 750_000 },
    );
    expect(linkResult.ok).toBe(false);
    expect(linkResult.errors).toContain(
      "0.children.0.href: href must use http:// or https://.",
    );

    const imageResult = validateNewsletterContent(
      {
        body_format: "blocks_v1",
        blocks: [{ type: "image", src: "http://127.0.0.1/image.png" }],
      },
      { maxBodyBytes: 750_000 },
    );
    expect(imageResult.ok).toBe(false);
    expect(imageResult.errors).toContain(
      "0.src: src must not point to localhost or private network addresses.",
    );

    const embedResult = validateNewsletterContent(
      {
        body_format: "blocks_v1",
        blocks: [{ type: "embed_url", url: "mailto:test@example.com" }],
      },
      { maxBodyBytes: 750_000 },
    );
    expect(embedResult.ok).toBe(false);
    expect(embedResult.errors).toContain(
      "0.url: url must use http:// or https://.",
    );
  });

  it("reports invalid non-array blocks_v1 input", () => {
    const result = validateNewsletterContent(
      {
        body_format: "blocks_v1",
        blocks: "not-blocks",
      },
      { maxBodyBytes: 750_000 },
    );

    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("Expected array");
  });

  it("summarizes successful validation with warnings", () => {
    const result = validateNewsletterContent(
      {
        body_format: "markdown_v1",
        body_markdown: "Text with $x$.",
      },
      { maxBodyBytes: 750_000 },
    );

    expect(summarizeValidation(result)).toContain("1 warning(s).");
  });

  it("summarizes successful validation without warnings", () => {
    const result = validateNewsletterContent(
      {
        body_format: "markdown_v1",
        body_markdown: "Plain text.",
      },
      { maxBodyBytes: 750_000 },
    );

    expect(summarizeValidation(result)).toBe(
      "Content validation passed: 1 block(s), 2 word(s), 0 image(s), 0 code block(s), 0 LaTeX block(s).",
    );
  });

  it("counts embed URLs and image captions in content stats", () => {
    const stats = computeContentStats([
      {
        type: "embed_url",
        url: "https://example.com/watch",
      },
      {
        type: "image",
        src: "https://example.com/image.png",
        alt: "Alt",
        caption: "Caption",
      },
    ]);

    expect(stats.blocks).toBe(2);
    expect(stats.links).toBe(1);
    expect(stats.images).toBe(1);
    expect(stats.words).toBe(6);
  });

  it("returns zero words for non-text blocks", () => {
    const stats = computeContentStats([{ type: "horizontal_rule" }]);

    expect(stats.blocks).toBe(1);
    expect(stats.words).toBe(0);
  });
});
