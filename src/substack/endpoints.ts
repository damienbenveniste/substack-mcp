export function draftsManagementEndpoint(
  offset: number,
  limit: number,
): string {
  const params = new URLSearchParams({
    offset: String(offset),
    limit: String(limit),
    order_by: "draft_updated_at",
    order_direction: "desc",
  });

  return `/api/v1/post_management/drafts?${params.toString()}`;
}

export function draftEndpoint(draftId: number): string {
  return `/api/v1/drafts/${draftId}`;
}

export function draftsEndpoint(): string {
  return "/api/v1/drafts";
}

export function imageEndpoint(): string {
  return "/api/v1/image";
}

export function publicationEndpoint(): string {
  return "/api/v1/publication";
}
