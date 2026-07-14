import { collectPlainText, type NewsletterBlock } from "./newsletterBlocks.js";

export function toPreviewText(
  blocks: readonly NewsletterBlock[],
  maxCharacters = 1_200,
): string {
  const text = collectPlainText(blocks)
    .join("\n\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (text.length <= maxCharacters) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxCharacters - 3)).trimEnd()}...`;
}
