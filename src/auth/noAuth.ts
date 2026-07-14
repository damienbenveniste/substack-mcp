import { type AuthPrincipal, localSingleUserPrincipal } from "./principal.js";

export function authorizeNoAuth(): AuthPrincipal {
  return localSingleUserPrincipal;
}
