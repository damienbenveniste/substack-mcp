import { describe, expect, it } from "vitest";

import {
  type AuditEventWithType,
  type AuditLogger,
  writeAuditEvent,
} from "../../src/logging/audit.js";
import { captureAuditEvents } from "../helpers/audit.js";

describe("writeAuditEvent", () => {
  it("uses warn for non-success audit events and no-ops without a logger", () => {
    const failure = {
      action: "create_draft",
      outcome: "failure",
      reason: "validation",
      warning_count: 0,
      error_count: 1,
    } satisfies Parameters<typeof writeAuditEvent>[1];

    writeAuditEvent(undefined, failure);

    const calls: Array<{
      readonly level: "info" | "warn";
      readonly audit: AuditEventWithType;
      readonly message: string;
    }> = [];
    const logger: AuditLogger = {
      info: (fields, message) => {
        calls.push({ level: "info", audit: fields.audit, message });
      },
      warn: (fields, message) => {
        calls.push({ level: "warn", audit: fields.audit, message });
      },
    };

    writeAuditEvent(logger, failure);

    expect(calls).toEqual([
      {
        level: "warn",
        audit: {
          event_type: "mcp_audit",
          ...failure,
        },
        message: "mcp audit event",
      },
    ]);
  });
});

describe("captureAuditEvents", () => {
  it("captures warn-level audit events for write tool tests", () => {
    const { auditLogger, events } = captureAuditEvents();
    const audit = {
      event_type: "mcp_audit",
      action: "upload_image",
      outcome: "failure",
      reason: "validation",
      warning_count: 0,
      error_count: 1,
    } satisfies AuditEventWithType;

    auditLogger.warn({ audit }, "mcp audit event");

    expect(events).toEqual([audit]);
  });
});
