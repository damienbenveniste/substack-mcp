import type { AuthScope } from "./scopes.js";

export interface AuthPrincipal {
  readonly userId: string;
  readonly scopes: readonly AuthScope[];
}

export const localSingleUserPrincipal: AuthPrincipal = {
  userId: "local-single-user",
  scopes: ["drafts:read", "drafts:write", "images:write"],
};
