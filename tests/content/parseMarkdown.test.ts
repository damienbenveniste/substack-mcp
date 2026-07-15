import { describe, expect, it } from "vitest";

import { parseMarkdown } from "../../src/content/parseMarkdown.js";

describe("parseMarkdown", () => {
  it("parses rich Markdown into newsletter blocks", () => {
    const result = parseMarkdown(`# Title

Paragraph with **bold**, *italic*, \`code\`, and [link](https://example.com).

> Quoted text.

- First
- Second

1. One
2. Two

---

![Alt text](https://example.com/image.png "Caption")

\`\`\`python
print("hello")
\`\`\`

$$
E = mc^2
$$
`);

    expect(result.unsupportedFeatures).toEqual([]);
    expect(result.blocks.map((block) => block.type)).toEqual([
      "heading",
      "paragraph",
      "blockquote",
      "bulleted_list",
      "ordered_list",
      "horizontal_rule",
      "image",
      "code_block",
      "latex_block",
    ]);
  });

  it("warns for unsupported Markdown features", () => {
    const result = parseMarkdown(`Text with $x^2$.

| A | B |
| - | - |
| 1 | 2 |

<div>raw</div>
`);

    expect(result.unsupportedFeatures).toEqual([
      "inline_math",
      "table",
      "raw_html",
    ]);
    expect(result.warnings).toHaveLength(3);
  });

  it("drops unsafe draft content URLs with warnings", () => {
    const result = parseMarkdown(`[unsafe link](javascript:alert(1))

![private image](http://127.0.0.1/image.png)

:::image
src: file:///tmp/image.png
alt: local file
:::
`);

    expect(result.unsupportedFeatures).toEqual(["image_url", "link_url"]);
    expect(result.warnings).toEqual([
      "image src must use http:// or https://.",
      "link href must use http:// or https://.",
      "image src must not point to localhost or private network addresses.",
    ]);
    expect(result.blocks).toEqual([
      {
        type: "paragraph",
        children: [
          {
            text: "unsafe link",
            bold: undefined,
            italic: undefined,
            code: undefined,
            href: undefined,
          },
        ],
      },
    ]);
  });

  it("warns for best-effort GFM and inline constructs", () => {
    const result = parseMarkdown(`- [x] Task item
  - Nested item

Paragraph with ~~strike~~, ![inline](https://example.com/inline.png), <span>html</span>, [ref][id], and a footnote.[^note]\\
Next line.

[id]: https://example.com

[^note]: Unsupported footnote
`);

    expect(result.unsupportedFeatures).toEqual([
      "task_list",
      "nested_list",
      "strikethrough",
      "inline_image",
      "raw_html",
      "link_reference",
      "footnoteReference",
      "footnote",
    ]);
  });

  it("handles optional image and code block fields", () => {
    const result = parseMarkdown(`![](https://example.com/no-alt.png)

\`\`\`
plain code
\`\`\`

\`\`\`  typescript${"  "}
console.log("draft");
\`\`\`
`);

    expect(result.blocks).toEqual([
      {
        type: "image",
        src: "https://example.com/no-alt.png",
        alt: "",
        title: undefined,
      },
      {
        type: "code_block",
        language: undefined,
        code: "plain code",
      },
      {
        type: "code_block",
        language: "typescript",
        code: 'console.log("draft");',
      },
    ]);
  });

  it("parses latex-tagged fences as LaTeX while preserving other code fences", () => {
    const result = parseMarkdown(`\`\`\`latex
\\int_0^1 x^2\\,dx = \\frac{1}{3}
\`\`\`

\`\`\`typescript
const draftOnly = true;
\`\`\`

\`\`\`
plain code
\`\`\`
`);

    expect(result.warnings).toEqual([]);
    expect(result.unsupportedFeatures).toEqual([]);
    expect(result.blocks).toEqual([
      {
        type: "latex_block",
        latex: "\\int_0^1 x^2\\,dx = \\frac{1}{3}",
      },
      {
        type: "code_block",
        language: "typescript",
        code: "const draftOnly = true;",
      },
      {
        type: "code_block",
        language: undefined,
        code: "plain code",
      },
    ]);
  });

  it("parses explicit image and LaTeX directives", () => {
    const result = parseMarkdown(`:::image
src: https://example.com/directive.png
alt: Directive alt
caption: Directive caption
title: Directive title
width: 640
height: 480
:::

:::latex
\\int_0^1 x^2\\,dx = \\frac{1}{3}
:::
`);

    expect(result.unsupportedFeatures).toEqual([]);
    expect(result.blocks).toEqual([
      {
        type: "image",
        src: "https://example.com/directive.png",
        alt: "Directive alt",
        caption: "Directive caption",
        title: "Directive title",
        width: 640,
        height: 480,
      },
      {
        type: "latex_block",
        latex: "\\int_0^1 x^2\\,dx = \\frac{1}{3}",
      },
    ]);
  });

  it("warns for invalid directives without treating fenced code as directives", () => {
    const result = parseMarkdown(`:::image
alt: Missing source
not a key/value line

width: wide
unknown: ignored
:::

:::latex
:::

\`\`\`markdown
:::latex
This stays code.
:::
\`\`\`
`);

    expect(result.unsupportedFeatures).toEqual([
      "image_directive",
      "latex_directive",
    ]);
    expect(result.warnings).toEqual([
      "Image directive line is not a key/value pair: not a key/value line",
      "Image directive field 'unknown' is not supported in V1.",
      "Image directive width must be a positive integer.",
      "Image directive is missing src.",
      "LaTeX directive is empty.",
    ]);
    expect(result.blocks).toEqual([
      {
        type: "code_block",
        language: "markdown",
        code: ":::latex\nThis stays code.\n:::",
      },
    ]);
  });
});
