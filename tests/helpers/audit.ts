import type { AuditEventWithType } from "../../src/logging/audit.js";

export function captureAuditEvents(): {
  readonly events: AuditEventWithType[];
  readonly auditLogger: {
    readonly info: (
      fields: { readonly audit: AuditEventWithType },
      message: string,
    ) => void;
    readonly warn: (
      fields: { readonly audit: AuditEventWithType },
      message: string,
    ) => void;
  };
} {
  const events: AuditEventWithType[] = [];

  return {
    events,
    auditLogger: {
      info: (fields) => {
        events.push(fields.audit);
      },
      warn: (fields) => {
        events.push(fields.audit);
      },
    },
  };
}
