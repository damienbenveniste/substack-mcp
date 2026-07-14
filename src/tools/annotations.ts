import type { AuthScope } from "../auth/scopes.js";
import type { AuthMode } from "../config.js";

export const readOnlyToolAnnotations = {
  readOnlyHint: true,
} as const;

export const draftWriteToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: false,
} as const;

export const uploadImageToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  openWorldHint: true,
} as const;

export interface NoAuthSecurityScheme {
  readonly type: "noauth";
}

export interface OAuth2SecurityScheme {
  readonly type: "oauth2";
  readonly scopes: readonly AuthScope[];
}

export type ToolSecurityScheme = NoAuthSecurityScheme | OAuth2SecurityScheme;

export type ToolSecurityMetadata = Readonly<Record<string, unknown>> & {
  readonly securitySchemes: readonly ToolSecurityScheme[];
};

export function toolSecurityMetadata(
  authMode: AuthMode,
  scopes: readonly AuthScope[],
): ToolSecurityMetadata | undefined {
  if (authMode === "noauth") {
    return { securitySchemes: [{ type: "noauth" }] };
  }

  if (authMode === "oauth") {
    return { securitySchemes: [{ type: "oauth2", scopes }] };
  }

  return undefined;
}
