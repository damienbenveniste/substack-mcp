export function isEditableUnpublishedDraft(draft: {
  readonly draft?: boolean | undefined;
  readonly is_draft?: boolean | undefined;
  readonly is_published?: boolean | undefined;
  readonly post_date?: string | null | undefined;
  readonly published_at?: string | null | undefined;
  readonly status?: string | undefined;
}): boolean {
  if (draft.draft === false || draft.is_draft === false) {
    return false;
  }

  if (!hasPositiveUnpublishedDraftMarker(draft)) {
    return false;
  }

  if (isKnownNonDraftStatus(draft.status)) {
    return false;
  }

  if (draft.is_published === true) {
    return false;
  }

  if (hasNonEmptyString(draft.published_at)) {
    return false;
  }

  if (hasNonEmptyString(draft.post_date)) {
    return false;
  }

  return true;
}

function hasPositiveUnpublishedDraftMarker(draft: {
  readonly draft?: boolean | undefined;
  readonly is_draft?: boolean | undefined;
  readonly is_published?: boolean | undefined;
  readonly status?: string | undefined;
}): boolean {
  return (
    draft.draft === true ||
    draft.is_draft === true ||
    draft.is_published === false ||
    isKnownDraftStatus(draft.status)
  );
}

function hasNonEmptyString(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function isKnownDraftStatus(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }

  return ["draft", "unpublished"].includes(value.trim().toLowerCase());
}

function isKnownNonDraftStatus(value: string | undefined): boolean {
  if (value === undefined) {
    return false;
  }

  return ["published", "scheduled", "archived", "deleted"].includes(
    value.trim().toLowerCase(),
  );
}
