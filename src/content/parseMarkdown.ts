import type {
  BlockContent,
  Content,
  DefinitionContent,
  FootnoteDefinition,
  Heading,
  Image,
  Link,
  LinkReference,
  List,
  ListItem,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
  Table,
} from "mdast";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { parseHttpUrl } from "../safety/urlPolicy.js";
import {
  type InlineSpan,
  type NewsletterBlock,
  normalizeCodeLanguage,
} from "./newsletterBlocks.js";

export interface MarkdownParseResult {
  readonly blocks: readonly NewsletterBlock[];
  readonly warnings: readonly string[];
  readonly unsupportedFeatures: readonly string[];
}

interface ParseState {
  readonly warnings: Set<string>;
  readonly unsupportedFeatures: Set<string>;
}

interface DirectiveExtraction {
  readonly markdown: string;
  readonly directives: ReadonlyMap<string, NewsletterBlock>;
  readonly warnings: readonly string[];
  readonly unsupportedFeatures: readonly string[];
}

interface MdastValueNode {
  readonly type: string;
  readonly value: string;
}

const parser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

export function parseMarkdown(markdown: string): MarkdownParseResult {
  const extracted = extractDirectiveBlocks(markdown);
  const tree = parser.parse(extracted.markdown) as Root;
  const state: ParseState = {
    warnings: new Set<string>(extracted.warnings),
    unsupportedFeatures: new Set<string>(extracted.unsupportedFeatures),
  };

  return {
    blocks: rootChildrenToBlocks(tree.children, state, extracted.directives),
    warnings: Array.from(state.warnings),
    unsupportedFeatures: Array.from(state.unsupportedFeatures),
  };
}

function rootChildrenToBlocks(
  children: readonly RootContent[],
  state: ParseState,
  directives: ReadonlyMap<string, NewsletterBlock>,
): readonly NewsletterBlock[] {
  return children.flatMap((child) =>
    rootChildToBlocks(child, state, directives),
  );
}

function rootChildToBlocks(
  child: RootContent,
  state: ParseState,
  directives: ReadonlyMap<string, NewsletterBlock>,
): readonly NewsletterBlock[] {
  switch (child.type) {
    case "paragraph":
      return paragraphToBlocks(child, state, directives);
    case "heading":
      return [headingToBlock(child, state)];
    case "blockquote":
      return [
        {
          type: "blockquote",
          children: rootChildrenToBlocks(child.children, state, directives),
        },
      ];
    case "list":
      return [listToBlock(child, state, directives)];
    case "thematicBreak":
      return [{ type: "horizontal_rule" }];
    case "code":
      return [
        {
          type: "code_block",
          language: normalizeCodeLanguage(child.lang ?? undefined),
          code: child.value,
        },
      ];
    case "html":
      addUnsupported(state, "raw_html", "Raw HTML is not supported in V1.");
      return [];
    case "definition":
      return [];
    case "footnoteDefinition":
      addUnsupported(state, "footnote", "Footnotes are not supported in V1.");
      return [];
    case "table":
      addUnsupported(
        state,
        "table",
        "Markdown tables are not supported in V1.",
      );
      return [];
    /* v8 ignore next 3 */
    case "yaml":
      addUnsupported(state, "frontmatter", "Frontmatter is ignored.");
      return [];
    default:
      if (isMathBlock(child)) {
        return [{ type: "latex_block", latex: child.value }];
      }

      /* v8 ignore start */
      addUnsupported(
        state,
        child.type,
        `Markdown node '${child.type}' is not supported in V1.`,
      );
      return [];
    /* v8 ignore stop */
  }
}

function paragraphToBlocks(
  paragraph: Paragraph,
  state: ParseState,
  directives: ReadonlyMap<string, NewsletterBlock>,
): readonly NewsletterBlock[] {
  const directive = directiveBlockFromParagraph(paragraph, directives);
  if (directive) {
    return [directive];
  }

  const onlyChild =
    paragraph.children.length === 1 ? paragraph.children[0] : undefined;
  if (onlyChild?.type === "image") {
    const image = imageToBlock(onlyChild, state);
    return image ? [image] : [];
  }

  const children = phrasingToSpans(paragraph.children, state, {});
  if (children.length === 0) {
    /* v8 ignore next */
    return [];
  }

  return [{ type: "paragraph", children }];
}

function headingToBlock(heading: Heading, state: ParseState): NewsletterBlock {
  return {
    type: "heading",
    level: heading.depth,
    children: phrasingToSpans(heading.children, state, {}),
  };
}

function listToBlock(
  list: List,
  state: ParseState,
  directives: ReadonlyMap<string, NewsletterBlock>,
): NewsletterBlock {
  const items = list.children.map((item) =>
    listItemToBlock(item, state, directives),
  );

  if (list.ordered) {
    return {
      type: "ordered_list",
      start: list.start ?? undefined,
      items,
    };
  }

  return {
    type: "bulleted_list",
    items,
  };
}

function listItemToBlock(
  item: ListItem,
  state: ParseState,
  directives: ReadonlyMap<string, NewsletterBlock>,
) {
  if (item.checked !== null && item.checked !== undefined) {
    addUnsupported(
      state,
      "task_list",
      "Task list checkboxes are not supported.",
    );
  }

  for (const child of item.children) {
    if (child.type === "list") {
      addUnsupported(
        state,
        "nested_list",
        "Nested lists are parsed best-effort in V1.",
      );
    }
  }

  return {
    children: item.children.flatMap((child) =>
      blockChildToBlocks(child, state, directives),
    ),
  };
}

function blockChildToBlocks(
  child: BlockContent | DefinitionContent,
  state: ParseState,
  directives: ReadonlyMap<string, NewsletterBlock>,
): readonly NewsletterBlock[] {
  return rootChildToBlocks(child as RootContent, state, directives);
}

interface SpanMarks {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly code?: boolean;
  readonly href?: string;
}

function phrasingToSpans(
  children: readonly PhrasingContent[],
  state: ParseState,
  marks: SpanMarks,
): readonly InlineSpan[] {
  return children.flatMap((child) => phrasingNodeToSpans(child, state, marks));
}

function phrasingNodeToSpans(
  child: PhrasingContent,
  state: ParseState,
  marks: SpanMarks,
): readonly InlineSpan[] {
  switch (child.type) {
    case "text":
      return [createSpan(child.value, marks)];
    case "strong":
      return phrasingToSpans(child.children, state, { ...marks, bold: true });
    case "emphasis":
      return phrasingToSpans(child.children, state, { ...marks, italic: true });
    case "inlineCode":
      return [createSpan(child.value, { ...marks, code: true })];
    case "link":
      return linkToSpans(child, state, marks);
    case "linkReference":
      return linkReferenceToSpans(child, state, marks);
    case "break":
      return [createSpan("\n", marks)];
    case "delete":
      addUnsupported(
        state,
        "strikethrough",
        "Strikethrough is not supported in V1.",
      );
      return phrasingToSpans(child.children, state, marks);
    case "image":
      addUnsupported(
        state,
        "inline_image",
        "Inline images are converted only when they are the whole paragraph.",
      );
      return [createSpan(child.alt ?? child.url, marks)];
    case "html":
      addUnsupported(state, "raw_html", "Inline raw HTML is not supported.");
      return [];
    case "footnoteReference":
      addUnsupported(
        state,
        "footnoteReference",
        "Footnote references are not supported in V1.",
      );
      return [];
    default:
      if (isInlineMath(child)) {
        addUnsupported(
          state,
          "inline_math",
          "Inline math is not supported; use a LaTeX block.",
        );
        return [createSpan(child.value, marks)];
      }

      addUnsupported(
        state,
        child.type,
        `Inline Markdown node '${child.type}' is not supported in V1.`,
      );
      return [];
  }
}

function linkToSpans(
  link: Link,
  state: ParseState,
  marks: SpanMarks,
): readonly InlineSpan[] {
  const href = validateDraftContentUrl(
    link.url,
    "link href",
    state,
    "link_url",
  );
  return phrasingToSpans(
    link.children,
    state,
    href ? { ...marks, href } : marks,
  );
}

function linkReferenceToSpans(
  link: LinkReference,
  state: ParseState,
  marks: SpanMarks,
): readonly InlineSpan[] {
  addUnsupported(
    state,
    "link_reference",
    "Reference-style links are parsed without resolving definitions.",
  );

  return phrasingToSpans(link.children, state, marks);
}

function imageToBlock(
  image: Image,
  state: ParseState,
): NewsletterBlock | undefined {
  const src = validateDraftContentUrl(
    image.url,
    "image src",
    state,
    "image_url",
  );
  if (!src) {
    return undefined;
  }

  return {
    type: "image",
    src,
    alt: image.alt ?? undefined,
    title: image.title ?? undefined,
  };
}

function directiveBlockFromParagraph(
  paragraph: Paragraph,
  directives: ReadonlyMap<string, NewsletterBlock>,
): NewsletterBlock | undefined {
  const onlyChild =
    paragraph.children.length === 1 ? paragraph.children[0] : undefined;
  if (onlyChild?.type !== "text") {
    return undefined;
  }

  return directives.get(onlyChild.value);
}

function extractDirectiveBlocks(markdown: string): DirectiveExtraction {
  const lines = markdown.split(/\r?\n/);
  const output: string[] = [];
  const directives = new Map<string, NewsletterBlock>();
  const warnings = new Set<string>();
  const unsupportedFeatures = new Set<string>();
  let fenceMarker: string | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    fenceMarker = updateFenceMarker(line, fenceMarker);
    if (fenceMarker) {
      output.push(line);
      continue;
    }

    const directiveName = parseDirectiveOpening(line);
    if (!directiveName) {
      output.push(line);
      continue;
    }

    const closeIndex = findDirectiveClose(lines, index + 1);
    if (closeIndex === -1) {
      addUnsupportedValues(
        warnings,
        unsupportedFeatures,
        "directive",
        `Unclosed Markdown ${directiveName} directive is not supported.`,
      );
      output.push(...lines.slice(index));
      break;
    }

    const bodyLines = lines.slice(index + 1, closeIndex);
    const block =
      directiveName === "latex"
        ? parseLatexDirective(bodyLines, warnings, unsupportedFeatures)
        : parseImageDirective(bodyLines, warnings, unsupportedFeatures);

    if (block) {
      const token = `SUBSTACK_MCP_DIRECTIVE_${directives.size}`;
      directives.set(token, block);
      output.push("", token, "");
    }

    index = closeIndex;
  }

  return {
    markdown: output.join("\n"),
    directives,
    warnings: Array.from(warnings),
    unsupportedFeatures: Array.from(unsupportedFeatures),
  };
}

function parseDirectiveOpening(line: string): "image" | "latex" | undefined {
  const match = line.trim().match(/^:::(image|latex)\s*$/iu);
  if (!match) {
    return undefined;
  }

  return match[1]?.toLowerCase() as "image" | "latex";
}

function findDirectiveClose(lines: readonly string[], start: number): number {
  for (let index = start; index < lines.length; index += 1) {
    if ((lines[index] ?? "").trim() === ":::") {
      return index;
    }
  }

  return -1;
}

function parseLatexDirective(
  lines: readonly string[],
  warnings: Set<string>,
  unsupportedFeatures: Set<string>,
): NewsletterBlock | undefined {
  const latex = trimBoundary(lines.join("\n"));
  if (latex.length === 0) {
    addUnsupportedValues(
      warnings,
      unsupportedFeatures,
      "latex_directive",
      "LaTeX directive is empty.",
    );
    return undefined;
  }

  return {
    type: "latex_block",
    latex,
  };
}

function parseImageDirective(
  lines: readonly string[],
  warnings: Set<string>,
  unsupportedFeatures: Set<string>,
): NewsletterBlock | undefined {
  const fields = new Map<string, string>();
  for (const line of lines) {
    if (line.trim() === "") {
      continue;
    }

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/u);
    if (!match) {
      addUnsupportedValues(
        warnings,
        unsupportedFeatures,
        "image_directive",
        `Image directive line is not a key/value pair: ${line.trim()}`,
      );
      continue;
    }

    const key = match[1]?.toLowerCase();
    const value = match[2]?.trim() ?? "";
    if (!key || !isImageDirectiveKey(key)) {
      addUnsupportedValues(
        warnings,
        unsupportedFeatures,
        "image_directive",
        `Image directive field '${match[1]}' is not supported in V1.`,
      );
      continue;
    }

    fields.set(key, value);
  }

  const src = optionalField(fields.get("src"));
  const width = optionalPositiveInteger(fields.get("width"), "width", warnings);
  const height = optionalPositiveInteger(
    fields.get("height"),
    "height",
    warnings,
  );
  if (!src) {
    addUnsupportedValues(
      warnings,
      unsupportedFeatures,
      "image_directive",
      "Image directive is missing src.",
    );
    return undefined;
  }
  const parsedSrc = parseHttpUrl(src, "image src");
  if (!parsedSrc.ok) {
    for (const error of parsedSrc.errors) {
      addUnsupportedValues(warnings, unsupportedFeatures, "image_url", error);
    }
    return undefined;
  }

  return {
    type: "image",
    src: parsedSrc.url.toString(),
    alt: optionalField(fields.get("alt")),
    caption: optionalField(fields.get("caption")),
    title: optionalField(fields.get("title")),
    width,
    height,
  };
}

function validateDraftContentUrl(
  value: string,
  fieldName: string,
  state: ParseState,
  feature: string,
): string | undefined {
  const parsed = parseHttpUrl(value, fieldName);
  if (!parsed.ok) {
    for (const error of parsed.errors) {
      addUnsupported(state, feature, error);
    }
    return undefined;
  }

  return parsed.url.toString();
}

function isImageDirectiveKey(
  key: string,
): key is "src" | "alt" | "caption" | "title" | "width" | "height" {
  return ["src", "alt", "caption", "title", "width", "height"].includes(key);
}

function optionalPositiveInteger(
  value: string | undefined,
  field: string,
  warnings: Set<string>,
): number | undefined {
  const raw = optionalField(value);
  if (!raw) {
    return undefined;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || String(parsed) !== raw) {
    warnings.add(`Image directive ${field} must be a positive integer.`);
    return undefined;
  }

  return parsed;
}

function optionalField(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function trimBoundary(value: string): string {
  return value
    .replace(/^\s*\n/u, "")
    .replace(/\n\s*$/u, "")
    .trim();
}

function updateFenceMarker(
  line: string,
  current: string | undefined,
): string | undefined {
  if (current) {
    return line.trimStart().startsWith(current) ? undefined : current;
  }

  const match = line.match(/^\s{0,3}(`{3,}|~{3,})/u);
  return match?.[1];
}

function createSpan(text: string, marks: SpanMarks): InlineSpan {
  return {
    text,
    bold: marks.bold,
    italic: marks.italic,
    code: marks.code,
    href: marks.href,
  };
}

function addUnsupported(
  state: ParseState,
  feature: string,
  warning: string,
): void {
  addUnsupportedValues(
    state.warnings,
    state.unsupportedFeatures,
    feature,
    warning,
  );
}

function addUnsupportedValues(
  warnings: Set<string>,
  unsupportedFeatures: Set<string>,
  feature: string,
  warning: string,
): void {
  unsupportedFeatures.add(feature);
  warnings.add(warning);
}

function isMathBlock(
  child: RootContent,
): child is RootContent & MdastValueNode {
  return child.type === "math" && hasStringValue(child);
}

function isInlineMath(
  child: PhrasingContent,
): child is PhrasingContent & MdastValueNode {
  return child.type === "inlineMath" && hasStringValue(child);
}

function hasStringValue(value: unknown): value is MdastValueNode {
  return (
    typeof value === "object" &&
    value !== null &&
    "value" in value &&
    typeof value.value === "string"
  );
}

export type UnsupportedMarkdownNode = FootnoteDefinition | Table | Content;
