import type { SubstackDraft } from "../substack/types.js";

export function selectDraftBody(
  draft: Pick<SubstackDraft, "body" | "draft_body">,
): unknown {
  return draft.draft_body ?? draft.body;
}
