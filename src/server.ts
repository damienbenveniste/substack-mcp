import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { buildOAuthBearerChallenge } from "./auth/oauth.js";
import {
  type AuthPrincipal,
  localSingleUserPrincipal,
} from "./auth/principal.js";
import type { AuthScope } from "./auth/scopes.js";
import type { AppConfig } from "./config.js";
import type { AuditLogger } from "./logging/audit.js";
import type { SubstackClient } from "./substack/index.js";
import {
  draftWriteToolAnnotations,
  readOnlyToolAnnotations,
  type ToolSecurityMetadata,
  toolSecurityMetadata,
  uploadImageToolAnnotations,
} from "./tools/annotations.js";
import {
  CreateDraftInputSchema,
  type CreateDraftOutput,
  createDraft,
  summarizeCreateDraft,
} from "./tools/createDraft.js";
import {
  GetDraftInputSchema,
  type GetDraftOutput,
  getDraft,
  summarizeDraft,
} from "./tools/getDraft.js";
import {
  ListDraftsInputSchema,
  type ListDraftsOutput,
  listDrafts,
  summarizeDraftList,
} from "./tools/listDrafts.js";
import {
  PreviewDraftInputSchema,
  type PreviewDraftOutput,
  previewDraft,
  summarizePreview,
} from "./tools/previewDraft.js";
import {
  summarizeUpdateDraft,
  UpdateDraftInputSchema,
  type UpdateDraftOutput,
  updateDraft,
} from "./tools/updateDraft.js";
import {
  summarizeUploadImage,
  UploadImageInputSchema,
  type UploadImageOutput,
  uploadImage,
} from "./tools/uploadImage.js";
import {
  summarizeValidation,
  ValidateNewsletterContentInputSchema,
  type ValidateNewsletterContentOutput,
  validateNewsletterContent,
} from "./tools/validateNewsletterContent.js";

export interface CreateMcpServerOptions {
  readonly auditLogger?: AuditLogger | undefined;
  readonly principal?: AuthPrincipal | undefined;
  readonly toolClients?: ToolClientOverrides | undefined;
}

export interface ToolClientOverrides {
  readonly listDrafts?: Pick<SubstackClient, "listDrafts"> | undefined;
  readonly getDraft?: Pick<SubstackClient, "getDraft"> | undefined;
  readonly createDraft?: Pick<SubstackClient, "createDraft"> | undefined;
  readonly updateDraft?:
    | Pick<SubstackClient, "getDraft" | "updateDraft">
    | undefined;
  readonly uploadImage?: Pick<SubstackClient, "uploadImage"> | undefined;
}

const FORBIDDEN_ACTIONS_BOUNDARY =
  "It never publishes, schedules, deletes, emails, or creates public Notes.";
const MANUAL_REVIEW_BOUNDARY =
  "The user must review and publish manually inside Substack.";
const READ_ONLY_BOUNDARY = `This tool is read-only. ${FORBIDDEN_ACTIONS_BOUNDARY}`;
const PREVIEW_BOUNDARY = `This tool creates or modifies no Substack data. ${FORBIDDEN_ACTIONS_BOUNDARY}`;
const DRAFT_WRITE_BOUNDARY = `This tool creates or modifies a Substack draft only. ${FORBIDDEN_ACTIONS_BOUNDARY} ${MANUAL_REVIEW_BOUNDARY}`;
const IMAGE_UPLOAD_BOUNDARY = `This tool uploads image assets for draft use only. ${FORBIDDEN_ACTIONS_BOUNDARY} ${MANUAL_REVIEW_BOUNDARY}`;

export function createMcpServer(
  config: AppConfig,
  options: CreateMcpServerOptions = {},
): McpServer {
  const server = new McpServer({
    name: "substack-draft-mcp",
    version: "0.1.0",
  });
  const principal = options.principal ?? localSingleUserPrincipal;

  server.registerTool(
    "list_drafts",
    {
      title: "List Substack Drafts",
      description: `List recent Substack newsletter drafts for selecting a draft to review or update. ${READ_ONLY_BOUNDARY}`,
      inputSchema: ListDraftsInputSchema,
      annotations: readOnlyToolAnnotations,
      ...securityMetadata(config.authMode, ["drafts:read"]),
    },
    async (input) => {
      const scopeError = requireToolScope(config, principal, "drafts:read");
      if (scopeError) {
        return scopeError;
      }

      const result = await listDrafts(input, config, {
        client: options.toolClients?.listDrafts,
      });
      return draftListToolResult(result);
    },
  );

  server.registerTool(
    "get_draft",
    {
      title: "Get Substack Draft",
      description: `Fetch Substack newsletter draft metadata and, when requested, the draft body. ${READ_ONLY_BOUNDARY}`,
      inputSchema: GetDraftInputSchema,
      annotations: readOnlyToolAnnotations,
      ...securityMetadata(config.authMode, ["drafts:read"]),
    },
    async (input) => {
      const scopeError = requireToolScope(config, principal, "drafts:read");
      if (scopeError) {
        return scopeError;
      }

      const result = await getDraft(input, config, {
        client: options.toolClients?.getDraft,
      });
      return draftToolResult(result);
    },
  );

  server.registerTool(
    "validate_newsletter_content",
    {
      title: "Validate Newsletter Content",
      description: `Validate Markdown or explicit newsletter blocks without writing to Substack. ${READ_ONLY_BOUNDARY}`,
      inputSchema: ValidateNewsletterContentInputSchema,
      annotations: readOnlyToolAnnotations,
      ...securityMetadata(config.authMode, ["drafts:read"]),
    },
    async (input) => {
      const scopeError = requireToolScope(config, principal, "drafts:read");
      if (scopeError) {
        return scopeError;
      }

      const result = validateNewsletterContent(input, config);
      return validationToolResult(result);
    },
  );

  server.registerTool(
    "preview_draft",
    {
      title: "Preview Draft",
      description: `Convert newsletter input into a minimized Substack draft preview and confirmation token without writing to Substack. ${PREVIEW_BOUNDARY}`,
      inputSchema: PreviewDraftInputSchema,
      annotations: readOnlyToolAnnotations,
      ...securityMetadata(config.authMode, ["drafts:write"]),
    },
    async (input) => {
      const scopeError = requireToolScope(config, principal, "drafts:write");
      if (scopeError) {
        return scopeError;
      }

      const result = previewDraft(input, config);
      return previewToolResult(result);
    },
  );

  server.registerTool(
    "create_draft",
    {
      title: "Create Substack Draft",
      description: `Create a Substack newsletter draft from a recent preview confirmation token. ${DRAFT_WRITE_BOUNDARY}`,
      inputSchema: CreateDraftInputSchema,
      annotations: draftWriteToolAnnotations,
      ...securityMetadata(config.authMode, ["drafts:write"]),
    },
    async (input) => {
      const scopeError = requireToolScope(config, principal, "drafts:write");
      if (scopeError) {
        return scopeError;
      }

      const result = await createDraft(input, config, {
        auditLogger: options.auditLogger,
        client: options.toolClients?.createDraft,
      });
      return createDraftToolResult(result);
    },
  );

  server.registerTool(
    "update_draft",
    {
      title: "Update Substack Draft",
      description: `Update an existing unpublished Substack newsletter draft from a recent preview confirmation token. ${DRAFT_WRITE_BOUNDARY}`,
      inputSchema: UpdateDraftInputSchema,
      annotations: draftWriteToolAnnotations,
      ...securityMetadata(config.authMode, ["drafts:write"]),
    },
    async (input) => {
      const scopeError = requireToolScope(config, principal, "drafts:write");
      if (scopeError) {
        return scopeError;
      }

      const result = await updateDraft(input, config, {
        auditLogger: options.auditLogger,
        client: options.toolClients?.updateDraft,
      });
      return updateDraftToolResult(result);
    },
  );

  server.registerTool(
    "upload_image",
    {
      title: "Upload Substack Image",
      description: `Upload an image to Substack and return a URL that can be inserted into a draft. Uploaded image URLs may be publicly fetchable by anyone with the URL. ${IMAGE_UPLOAD_BOUNDARY}`,
      inputSchema: UploadImageInputSchema,
      annotations: uploadImageToolAnnotations,
      ...securityMetadata(config.authMode, ["images:write"]),
    },
    async (input) => {
      const scopeError = requireToolScope(config, principal, "images:write");
      if (scopeError) {
        return scopeError;
      }

      const result = await uploadImage(input, config, {
        auditLogger: options.auditLogger,
        client: options.toolClients?.uploadImage,
      });
      return uploadImageToolResult(result);
    },
  );

  return server;
}

function requireToolScope(
  config: AppConfig,
  principal: AuthPrincipal,
  requiredScope: AuthScope,
) {
  if (principal.scopes.includes(requiredScope)) {
    return undefined;
  }

  const message = `Authentication required: missing ${requiredScope} scope.`;

  return {
    structuredContent: {
      ok: false,
      errors: [message],
      required_scope: requiredScope,
    },
    content: [
      {
        type: "text" as const,
        text: message,
      },
    ],
    _meta:
      config.authMode === "oauth"
        ? {
            "mcp/www_authenticate": [
              `${buildOAuthBearerChallenge(config)}, error="insufficient_scope", error_description="Missing required scope: ${requiredScope}"`,
            ],
          }
        : undefined,
    isError: true,
  };
}

function securityMetadata(
  authMode: AppConfig["authMode"],
  scopes: Parameters<typeof toolSecurityMetadata>[1],
): { readonly _meta: ToolSecurityMetadata } | Record<string, never> {
  const _meta = toolSecurityMetadata(authMode, scopes);
  return _meta ? { _meta } : {};
}

function createDraftToolResult(result: CreateDraftOutput) {
  return {
    structuredContent: {
      ok: result.ok,
      errors: [...result.errors],
      draft_id: result.draft_id,
      draft_title: result.draft_title,
      draft_url: result.draft_url,
      message: result.message,
      warnings: [...result.warnings],
    },
    content: [
      {
        type: "text" as const,
        text: summarizeCreateDraft(result),
      },
    ],
    isError: !result.ok,
  };
}

function updateDraftToolResult(result: UpdateDraftOutput) {
  return {
    structuredContent: {
      ok: result.ok,
      errors: [...result.errors],
      draft_id: result.draft_id,
      draft_title: result.draft_title,
      draft_url: result.draft_url,
      message: result.message,
      warnings: [...result.warnings],
    },
    content: [
      {
        type: "text" as const,
        text: summarizeUpdateDraft(result),
      },
    ],
    isError: !result.ok,
  };
}

function uploadImageToolResult(result: UploadImageOutput) {
  return {
    structuredContent: {
      ok: result.ok,
      errors: [...result.errors],
      image_url: result.image_url,
      alt_text: result.alt_text,
      caption: result.caption,
      message: result.message,
    },
    content: [
      {
        type: "text" as const,
        text: summarizeUploadImage(result),
      },
    ],
    isError: !result.ok,
  };
}

function draftListToolResult(result: ListDraftsOutput) {
  return {
    structuredContent: {
      ok: result.ok,
      errors: [...result.errors],
      drafts: [...result.drafts],
      offset: result.offset,
      limit: result.limit,
    },
    content: [
      {
        type: "text" as const,
        text: summarizeDraftList(result),
      },
    ],
    isError: !result.ok,
  };
}

function draftToolResult(result: GetDraftOutput) {
  return {
    structuredContent: {
      ok: result.ok,
      errors: [...result.errors],
      draft: result.draft,
      include_body: result.include_body,
    },
    content: [
      {
        type: "text" as const,
        text: summarizeDraft(result),
      },
    ],
    isError: !result.ok,
  };
}

function validationToolResult(result: ValidateNewsletterContentOutput) {
  return {
    structuredContent: {
      ok: result.ok,
      errors: [...result.errors],
      warnings: [...result.warnings],
      stats: result.stats,
      unsupported_features: [...result.unsupported_features],
    },
    content: [
      {
        type: "text" as const,
        text: summarizeValidation(result),
      },
    ],
    isError: !result.ok,
  };
}

function previewToolResult(result: PreviewDraftOutput) {
  return {
    structuredContent: {
      ok: result.ok,
      errors: [...result.errors],
      action: result.action,
      draft_id: result.draft_id,
      title: result.title,
      subtitle: result.subtitle,
      audience: result.audience,
      preview_text: result.preview_text,
      warnings: [...result.warnings],
      stats: result.stats,
      confirmation_token: result.confirmation_token,
      confirmation_expires_at: result.confirmation_expires_at,
      payload_debug: result.payload_debug,
    },
    content: [
      {
        type: "text" as const,
        text: summarizePreview(result),
      },
    ],
    isError: !result.ok,
  };
}
