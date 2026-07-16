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
  previewDraftImagePatch,
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
  readonly previewDraft?: Pick<SubstackClient, "getDraft"> | undefined;
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
const DRAFT_WRITE_BOUNDARY = `This tool creates or modifies an unpublished Substack draft. ${FORBIDDEN_ACTIONS_BOUNDARY} ${MANUAL_REVIEW_BOUNDARY}`;
const IMAGE_UPLOAD_BOUNDARY = `This tool uploads image assets for use in unpublished drafts. ${FORBIDDEN_ACTIONS_BOUNDARY} ${MANUAL_REVIEW_BOUNDARY}`;
const EXACT_IMAGE_ARTIFACT_RULE =
  "Use the exact image artifact selected by the user or produced by image generation. Never redraw, recreate, replace, simplify, or substitute a fallback image merely to satisfy the tool schema.";

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
      description: `List recent Substack newsletter drafts for selecting a draft to review or update. Before replacing an update body, use get_draft with include_body to retrieve the existing draft content that must be preserved. ${READ_ONLY_BOUNDARY}`,
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
      description: `Fetch Substack newsletter draft metadata and, when include_body is true, its existing native body plus a one-based native image manifest. For a targeted image replacement, use the manifest with preview_draft.image_patch; do not reconstruct or pass the native body through blocks_v1. Ordinary body input remains a full replacement, so clients must include all existing content they intend to preserve. ${READ_ONLY_BOUNDARY}`,
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
      description: `Validate Markdown or explicit newsletter blocks without writing to Substack. For image blocks, keep the exact image_url returned by upload_image plus its alt text, caption, title, and dimensions through validation, preview, and write. ${READ_ONLY_BOUNDARY}`,
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
      description: `Preview the exact draft create or update without writing to Substack, and return a confirmation token plus a recursive manifest of every affected image. ${EXACT_IMAGE_ARTIFACT_RULE} For uploaded images, use the exact image_url returned by upload_image and preserve its alt text, visible caption, title metadata, and dimensions. Do not regenerate, redraw, re-download, transform, replace, or substitute the image. To replace one existing image safely, use action=update with image_patch and exactly one selector from get_draft; the server fetches the current native document and preserves all non-target JSON. Do not send body_format, body_markdown, blocks, or reconstructed native JSON with image_patch. upload_image uploads media only; preview_draft previews insertion only; create_draft or update_draft writes the image block. An ordinary update body is a full replacement, not a server-side merge. ${PREVIEW_BOUNDARY}`,
      inputSchema: PreviewDraftInputSchema,
      annotations: readOnlyToolAnnotations,
      ...securityMetadata(config.authMode, ["drafts:write"]),
    },
    async (input) => {
      const scopeError = requireToolScope(config, principal, "drafts:write");
      if (scopeError) {
        return scopeError;
      }

      const result =
        input.image_patch !== undefined
          ? await previewDraftImagePatch(input, config, {
              client: options.toolClients?.previewDraft,
            })
          : previewDraft(input, config);
      return previewToolResult(result);
    },
  );

  server.registerTool(
    "create_draft",
    {
      title: "Create Substack Draft",
      description: `Write the exact new draft content represented by a recent preview confirmation token. ${EXACT_IMAGE_ARTIFACT_RULE} When the preview contains images, write the exact image URLs and preserve their alt text, captions, titles, and dimensions; do not upload replacements, transform assets, or select alternate files. upload_image uploads media only and preview_draft previews insertion only; create_draft performs the draft write. ${DRAFT_WRITE_BOUNDARY}`,
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
      description: `Write the exact existing-draft changes represented by a recent preview confirmation token. ${EXACT_IMAGE_ARTIFACT_RULE} For a targeted replacement authorized with preview_draft.image_patch, pass the identical image_patch here; the server refetches the native document, changes exactly one image, preserves all non-target JSON, and rejects a stale confirmation if the draft changed after preview. For ordinary body input, the body is a full replacement and clients must include all content to preserve. Metadata-only updates leave the body unchanged. Caption is visible native caption text; title is separate image metadata. upload_image uploads media only and preview_draft previews insertion only; update_draft performs the draft write. ${DRAFT_WRITE_BOUNDARY}`,
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
      description: `Upload one exact image asset to Substack and return its image URL and metadata. ${EXACT_IMAGE_ARTIFACT_RULE} Use exactly one source, in this order: image_file for an image generated or uploaded in the current conversation; image_url for an existing remote image; image_base64 only when neither file nor URL input is available. Use svg or card only when the user explicitly requests that exact server-rendered source, never as a fallback for an unavailable artifact. Normalization validates the asset and must preserve its visual meaning unless the user explicitly requests a transformation. This tool uploads media only and does not insert or modify draft content. After upload, pass the exact image_url returned here, with its alt_text and caption, to preview_draft; verify the preview image manifest; then call create_draft or update_draft with the matching confirmation token. alt_text is accessibility text; caption becomes visible only after draft insertion. Uploaded image URLs may be publicly fetchable by anyone with the URL. ${IMAGE_UPLOAD_BOUNDARY}`,
      inputSchema: UploadImageInputSchema,
      annotations: uploadImageToolAnnotations,
      ...uploadImageMetadata(config.authMode),
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

function uploadImageMetadata(authMode: AppConfig["authMode"]): {
  readonly _meta: Readonly<Record<string, unknown>>;
} {
  return {
    _meta: {
      ...toolSecurityMetadata(authMode, ["images:write"]),
      "openai/fileParams": ["image_file"],
    },
  };
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
      image_patch: result.image_patch,
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
      error: result.error,
      image_url: result.image_url,
      filename: result.filename,
      format: result.format,
      width: result.width,
      height: result.height,
      size_bytes: result.size_bytes,
      sha256: result.sha256,
      source_type: result.source_type,
      source_artifact_id: result.source_artifact_id,
      source: result.source,
      processed: result.processed,
      preview_url: result.preview_url,
      alt_text: result.alt_text,
      caption: result.caption,
      warnings: [...result.warnings],
      warning_details: [...result.warning_details],
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
      images: [...result.images],
      image_patch: result.image_patch,
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
