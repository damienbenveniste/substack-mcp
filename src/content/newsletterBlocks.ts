export type NewsletterBlock =
  | ParagraphBlock
  | HeadingBlock
  | BlockquoteBlock
  | BulletedListBlock
  | OrderedListBlock
  | HorizontalRuleBlock
  | ImageBlock
  | CodeBlock
  | LatexBlock
  | EmbedUrlBlock;

export interface InlineSpan {
  readonly text: string;
  readonly bold?: boolean | undefined;
  readonly italic?: boolean | undefined;
  readonly code?: boolean | undefined;
  readonly href?: string | undefined;
}

export interface ParagraphBlock {
  readonly type: "paragraph";
  readonly children: readonly InlineSpan[];
}

export interface HeadingBlock {
  readonly type: "heading";
  readonly level: 1 | 2 | 3 | 4 | 5 | 6;
  readonly children: readonly InlineSpan[];
}

export interface BlockquoteBlock {
  readonly type: "blockquote";
  readonly children: readonly NewsletterBlock[];
}

export interface BulletedListBlock {
  readonly type: "bulleted_list";
  readonly items: readonly ListItemBlock[];
}

export interface OrderedListBlock {
  readonly type: "ordered_list";
  readonly start?: number | undefined;
  readonly items: readonly ListItemBlock[];
}

export interface ListItemBlock {
  readonly children: readonly NewsletterBlock[];
}

export interface HorizontalRuleBlock {
  readonly type: "horizontal_rule";
}

export interface ImageBlock {
  readonly type: "image";
  readonly src: string;
  readonly alt?: string | undefined;
  readonly caption?: string | undefined;
  readonly title?: string | undefined;
  readonly width?: number | undefined;
  readonly height?: number | undefined;
}

export interface CodeBlock {
  readonly type: "code_block";
  readonly language?: string | undefined;
  readonly code: string;
}

export interface LatexBlock {
  readonly type: "latex_block";
  readonly latex: string;
}

export interface EmbedUrlBlock {
  readonly type: "embed_url";
  readonly url: string;
}

export interface ContentStats {
  readonly characters: number;
  readonly words: number;
  readonly blocks: number;
  readonly images: number;
  readonly code_blocks: number;
  readonly latex_blocks: number;
  readonly links: number;
}

export const PROVISIONAL_LATEX_BLOCK_WARNING =
  "LaTeX block mapping is provisional until a live Substack LaTeX fixture is captured; preview uses a latex code block fallback.";

export function normalizeCodeLanguage(
  value: string | undefined,
): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

export function computeContentStats(
  blocks: readonly NewsletterBlock[],
): ContentStats {
  const text = collectPlainText(blocks).join("\n");

  return {
    characters: text.length,
    words: countWords(text),
    blocks: countBlocks(blocks),
    images: countBlocksOfType(blocks, "image"),
    code_blocks: countBlocksOfType(blocks, "code_block"),
    latex_blocks: countBlocksOfType(blocks, "latex_block"),
    links: countLinks(blocks),
  };
}

export function collectPlainText(
  blocks: readonly NewsletterBlock[],
): readonly string[] {
  return blocks.flatMap((block) => {
    switch (block.type) {
      case "paragraph":
      case "heading":
        return [block.children.map((span) => span.text).join("")];
      case "blockquote":
        return collectPlainText(block.children);
      case "bulleted_list":
      case "ordered_list":
        return block.items.flatMap((item) => collectPlainText(item.children));
      case "image":
        return [block.alt, block.caption].filter(isPresent);
      case "code_block":
        return [block.code];
      case "latex_block":
        return [block.latex];
      case "embed_url":
        return [block.url];
      case "horizontal_rule":
        return [];
    }

    /* v8 ignore next */
    return [];
  });
}

function countBlocks(blocks: readonly NewsletterBlock[]): number {
  return blocks.reduce((total, block) => {
    switch (block.type) {
      case "blockquote":
        return total + 1 + countBlocks(block.children);
      case "bulleted_list":
      case "ordered_list":
        return (
          total +
          1 +
          block.items.reduce(
            (itemTotal, item) => itemTotal + countBlocks(item.children),
            0,
          )
        );
      default:
        return total + 1;
    }
  }, 0);
}

function countBlocksOfType(
  blocks: readonly NewsletterBlock[],
  type: NewsletterBlock["type"],
): number {
  return blocks.reduce((total, block) => {
    const self = block.type === type ? 1 : 0;

    switch (block.type) {
      case "blockquote":
        return total + self + countBlocksOfType(block.children, type);
      case "bulleted_list":
      case "ordered_list":
        return (
          total +
          self +
          block.items.reduce(
            (itemTotal, item) =>
              itemTotal + countBlocksOfType(item.children, type),
            0,
          )
        );
      default:
        return total + self;
    }
  }, 0);
}

function countLinks(blocks: readonly NewsletterBlock[]): number {
  return blocks.reduce((total, block) => {
    switch (block.type) {
      case "paragraph":
      case "heading":
        return total + block.children.filter((span) => span.href).length;
      case "blockquote":
        return total + countLinks(block.children);
      case "bulleted_list":
      case "ordered_list":
        return (
          total +
          block.items.reduce(
            (itemTotal, item) => itemTotal + countLinks(item.children),
            0,
          )
        );
      case "embed_url":
        return total + 1;
      default:
        return total;
    }
  }, 0);
}

function countWords(text: string): number {
  return text.match(/\b[\p{L}\p{N}'-]+\b/gu)?.length ?? 0;
}

function isPresent(value: string | undefined): value is string {
  return value !== undefined && value.length > 0;
}
