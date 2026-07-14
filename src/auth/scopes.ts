export const authScopes = [
  "drafts:read",
  "drafts:write",
  "images:write",
] as const;

export type AuthScope = (typeof authScopes)[number];
