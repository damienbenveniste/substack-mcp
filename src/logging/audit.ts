import type { DraftPayloadStats } from "../tools/draftPayload.js";

export type AuditAction = "create_draft" | "update_draft" | "upload_image";
export type AuditOutcome = "success" | "failure" | "blocked";
export type AuditReason =
  | "validation"
  | "substack_client"
  | "image_prepare"
  | "published_draft"
  | "not_unpublished_draft";

export interface AuditLogger {
  readonly info: (
    fields: { readonly audit: AuditEventWithType },
    message: string,
  ) => void;
  readonly warn: (
    fields: { readonly audit: AuditEventWithType },
    message: string,
  ) => void;
}

export interface AuditEvent {
  readonly action: AuditAction;
  readonly outcome: AuditOutcome;
  readonly reason?: AuditReason | undefined;
  readonly draft_id?: number | undefined;
  readonly body_format?: "markdown_v1" | "blocks_v1" | undefined;
  readonly image_source?:
    | "remote_url"
    | "base64"
    | "data_uri"
    | "none"
    | "ambiguous"
    | undefined;
  readonly audience?: string | undefined;
  readonly title_present?: boolean | undefined;
  readonly subtitle_present?: boolean | undefined;
  readonly body_present?: boolean | undefined;
  readonly metadata_only?: boolean | undefined;
  readonly idempotency_key_present?: boolean | undefined;
  readonly idempotency_replay?: boolean | undefined;
  readonly alt_text_present?: boolean | undefined;
  readonly caption_present?: boolean | undefined;
  readonly stats?: DraftPayloadStats | undefined;
  readonly warning_count: number;
  readonly error_count: number;
}

export interface AuditEventWithType extends AuditEvent {
  readonly event_type: "mcp_audit";
}

export function writeAuditEvent(
  logger: AuditLogger | undefined,
  event: AuditEvent,
): void {
  if (!logger) {
    return;
  }

  const audit = {
    event_type: "mcp_audit" as const,
    ...event,
  };
  const message = "mcp audit event";

  if (event.outcome === "success") {
    logger.info({ audit }, message);
    return;
  }

  logger.warn({ audit }, message);
}
