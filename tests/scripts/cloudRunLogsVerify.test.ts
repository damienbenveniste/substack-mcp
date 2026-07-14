import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  renderCloudRunLogsEvidenceArtifact,
  writeCloudRunLogsEvidenceArtifact,
} from "../../scripts/cloudRunLogsEvidence.js";
import {
  cloudRunLogsVerifyUsage,
  parseCloudRunLogsVerifyArgs,
  readCloudRunLogsFile,
  renderCloudRunLogsVerifyReport,
  verifyCloudRunLogs,
} from "../../scripts/cloudRunLogsVerifyCore.js";

describe("parseCloudRunLogsVerifyArgs", () => {
  const cwd = "/repo/substack-mcp";

  it("parses a project-local log export path and output options", () => {
    expect(
      parseCloudRunLogsVerifyArgs(
        ["--logs-json", ".data/cloud-run-logs.json", "--json"],
        cwd,
      ),
    ).toEqual({
      help: false,
      logsJson: `${cwd}/.data/cloud-run-logs.json`,
      artifactRoot: cwd,
      evidenceArtifact: undefined,
      requireAuditEvents: false,
      format: "json",
    });

    expect(
      parseCloudRunLogsVerifyArgs(
        [
          "--logs-json",
          ".data/cloud-run-logs.json",
          "--require-audit-events",
          "--format",
          "text",
        ],
        cwd,
      ),
    ).toMatchObject({
      requireAuditEvents: true,
      format: "text",
    });
  });

  it("supports a project-local evidence artifact path", () => {
    expect(
      parseCloudRunLogsVerifyArgs(
        [
          "--logs-json",
          ".data/cloud-run-logs.json",
          "--evidence-artifact",
          ".data/v1/gate-16-cloud-run-logs.md",
        ],
        cwd,
      ),
    ).toMatchObject({
      help: false,
      artifactRoot: cwd,
      evidenceArtifact: ".data/v1/gate-16-cloud-run-logs.md",
    });
  });

  it("allows help and rejects invalid input", () => {
    expect(parseCloudRunLogsVerifyArgs(["--help"], cwd)).toEqual({
      help: true,
    });
    expect(parseCloudRunLogsVerifyArgs(["-h"], cwd)).toEqual({
      help: true,
    });
    expect(() => parseCloudRunLogsVerifyArgs([], cwd)).toThrow(
      "--logs-json is required.",
    );
    expect(() =>
      parseCloudRunLogsVerifyArgs(["--logs-json", "../logs.json"], cwd),
    ).toThrow("--logs-json must stay inside the project directory.");
    expect(() => parseCloudRunLogsVerifyArgs(["--logs-json"], cwd)).toThrow(
      "--logs-json requires a value.",
    );
    expect(() =>
      parseCloudRunLogsVerifyArgs(
        ["--logs-json", ".data/logs.json", "--evidence-artifact"],
        cwd,
      ),
    ).toThrow("--evidence-artifact requires a value.");
    expect(() =>
      parseCloudRunLogsVerifyArgs(
        [
          "--logs-json",
          ".data/logs.json",
          "--evidence-artifact",
          "../outside.md",
        ],
        cwd,
      ),
    ).toThrow("--evidence-artifact must stay inside the project directory.");
    expect(() =>
      parseCloudRunLogsVerifyArgs(
        ["--logs-json", ".data/logs.json", "--format", "yaml"],
        cwd,
      ),
    ).toThrow("--format must be one of: text, json.");
    expect(() => parseCloudRunLogsVerifyArgs(["--bogus"], cwd)).toThrow(
      "Unknown option: --bogus",
    );
  });
});

describe("verifyCloudRunLogs", () => {
  it("accepts safe exported logs with audit metadata only", () => {
    const input = {
      raw: JSON.stringify(safeEntries()),
      entries: safeEntries(),
    };
    const report = verifyCloudRunLogs(input, { requireAuditEvents: true });
    const text = renderCloudRunLogsVerifyReport(report, "text");

    expect(report).toMatchObject({
      ok: true,
      entry_count: 2,
      audit_event_count: 1,
    });
    expect(text).toContain("OK: yes");
    expect(text).toContain("No findings.");
  });

  it("accepts idempotency replay audit metadata without treating it as a leak", () => {
    const entries = [
      {
        jsonPayload: {
          audit: {
            event_type: "mcp_audit",
            action: "create_draft",
            outcome: "success",
            draft_id: 123,
            body_format: "markdown_v1",
            body_present: true,
            idempotency_key_present: true,
            idempotency_replay: true,
            warning_count: 1,
            error_count: 0,
            stats: {
              block_count: 3,
            },
          },
        },
      },
    ];

    const report = verifyCloudRunLogs(
      {
        raw: JSON.stringify(entries),
        entries,
      },
      { requireAuditEvents: true },
    );

    expect(report).toMatchObject({
      ok: true,
      entry_count: 1,
      audit_event_count: 1,
      findings: [],
    });
  });

  it("fails when audit events are required but absent", () => {
    const report = verifyCloudRunLogs(
      {
        raw: JSON.stringify([{ textPayload: "health check" }]),
        entries: [{ textPayload: "health check" }],
      },
      { requireAuditEvents: true },
    );

    expect(report.ok).toBe(false);
    expect(
      report.checks.find((check) => check.id === "audit_events_metadata_only"),
    ).toMatchObject({
      ok: false,
      evidence: "0 mcp_audit event(s) use the allowed metadata field set.",
    });
  });

  it("flags secret patterns, sensitive fields, draft bodies, and unsafe audit fields", () => {
    const report = verifyCloudRunLogs({
      raw: JSON.stringify([
        {
          jsonPayload: {
            authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
            audit: {
              event_type: "mcp_audit",
              action: "create_draft",
              outcome: "success",
              warning_count: 0,
              error_count: 0,
              draft_body: { type: "doc" },
            },
          },
          textPayload: "connect.sid=secret",
        },
      ]),
      entries: [
        {
          jsonPayload: {
            authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
            audit: {
              event_type: "mcp_audit",
              action: "create_draft",
              outcome: "success",
              warning_count: 0,
              error_count: 0,
              draft_body: { type: "doc" },
            },
          },
          textPayload: "connect.sid=secret",
        },
      ],
    });
    const rendered = renderCloudRunLogsVerifyReport(report, "text");

    expect(report.ok).toBe(false);
    expect(report.findings.map((finding) => finding.id)).toEqual(
      expect.arrayContaining([
        "secret_pattern",
        "sensitive_field",
        "draft_body_field",
        "unexpected_audit_field",
      ]),
    );
    expect(rendered).toContain("$.jsonPayload.authorization");
    expect(rendered).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(rendered).not.toContain("connect.sid=secret");
  });

  it("flags unredacted MCP path secrets while allowing redacted paths", () => {
    const report = verifyCloudRunLogs({
      raw: JSON.stringify([
        {
          httpRequest: {
            requestUrl: "https://example.run.app/mcp/private-path",
          },
          jsonPayload: {
            mcpPathSecret: "private-path",
          },
        },
        {
          httpRequest: {
            requestUrl: "https://example.run.app/mcp/<redacted>",
          },
        },
      ]),
      entries: [
        {
          httpRequest: {
            requestUrl: "https://example.run.app/mcp/private-path",
          },
          jsonPayload: {
            mcpPathSecret: "private-path",
          },
        },
        {
          httpRequest: {
            requestUrl: "https://example.run.app/mcp/<redacted>",
          },
        },
      ],
    });
    const rendered = renderCloudRunLogsVerifyReport(report, "text");

    expect(report.ok).toBe(false);
    expect(report.findings.map((finding) => finding.id)).toEqual(
      expect.arrayContaining(["secret_pattern", "sensitive_field"]),
    );
    expect(rendered).toContain("Matched mcp_path_secret pattern");
    expect(rendered).toContain("$.jsonPayload.mcpPathSecret");
    expect(rendered).not.toContain("private-path");
    expect(rendered).not.toContain("/mcp/private-path");
  });

  it("reads JSON objects with entries and newline-delimited JSON", () => {
    withTempLogs((logsFile) => {
      writeFileSync(logsFile, JSON.stringify({ entries: safeEntries() }));
      expect(readCloudRunLogsFile(logsFile).entries).toHaveLength(2);

      writeFileSync(
        logsFile,
        safeEntries()
          .map((entry) => JSON.stringify(entry))
          .join("\n"),
      );
      expect(readCloudRunLogsFile(logsFile).entries).toHaveLength(2);
    });
  });

  it("handles empty, missing, and malformed log exports", () => {
    withTempLogs((logsFile) => {
      writeFileSync(logsFile, "");
      expect(readCloudRunLogsFile(logsFile).entries).toHaveLength(0);

      writeFileSync(logsFile, "{");
      expect(() => readCloudRunLogsFile(logsFile)).toThrow(
        "Invalid Cloud Run logs JSON on line 1",
      );

      expect(() => readCloudRunLogsFile(`${logsFile}.missing`)).toThrow(
        "Cloud Run logs JSON does not exist",
      );
    });
  });

  it("renders JSON output and documents usage", () => {
    const report = verifyCloudRunLogs({
      raw: "[]",
      entries: [],
    });
    const parsed = JSON.parse(
      renderCloudRunLogsVerifyReport(report, "json"),
    ) as {
      readonly ok: boolean;
      readonly entry_count: number;
    };

    expect(parsed.ok).toBe(false);
    expect(parsed.entry_count).toBe(0);
    expect(cloudRunLogsVerifyUsage()).toContain(
      "npm run cloud-run:logs:verify",
    );
    expect(cloudRunLogsVerifyUsage()).toContain(
      "mkdir -p .data && gcloud logging read",
    );
    expect(cloudRunLogsVerifyUsage()).toContain(
      'resource.labels.service_name="substack-draft-mcp"',
    );
    expect(cloudRunLogsVerifyUsage()).toContain("--evidence-artifact");
    expect(cloudRunLogsVerifyUsage()).toContain("--require-audit-events");
  });
});

describe("Cloud Run logs evidence artifacts", () => {
  it("renders sanitized gate 16 evidence without raw log contents", () => {
    const report = verifyCloudRunLogs(
      {
        raw: JSON.stringify(safeEntries()),
        entries: safeEntries(),
      },
      { requireAuditEvents: true },
    );
    const rendered = renderCloudRunLogsEvidenceArtifact(
      report,
      "2026-07-08T12:00:00Z",
    );

    expect(rendered).toContain("# V1 Cloud Run Log Safety Evidence");
    expect(rendered).toContain("- Complete: yes");
    expect(rendered).toContain("- Exported entries parsed: 2");
    expect(rendered).toContain("- Audit events found: 1");
    expect(rendered).toContain("No findings.");
    expect(rendered).toContain("## Manual Log Review Details");
    expect(rendered).toContain(
      "- Log export window: <replace with live Cloud Run log export start/end time or query window>",
    );
    expect(rendered).toContain(
      "- Cloud Run service/revision: <replace with Cloud Run service name and revision or service URL reference>",
    );
    expect(rendered).toContain(
      "- Log export command: <replace with gcloud logging read command including Cloud Run resource filter>",
    );
    expect(rendered).toContain(
      "- Verifier command: <replace with cloud-run:logs:verify command including --logs-json and --require-audit-events>",
    );
    expect(rendered).toContain(
      "- Audit event review: <replace with audit count and metadata-only confirmation>",
    );
    expect(rendered).toContain(
      "- Finding review: <replace with no findings or sanitized finding-category/count summary>",
    );
    expect(rendered).toContain(
      "- Raw log handling: <replace with retained/deleted path and access decision>",
    );
    expect(rendered).toContain(
      "- Follow-up action: <replace with rotation/redeploy/no action and reason>",
    );
    expect(rendered).toContain("npm run v1:record -- --gate 16");
    expect(rendered).not.toContain("https://example.run.app/healthz");
    expect(rendered).not.toContain("draft_id");
    expect(rendered).not.toContain("Authorization: Bearer");
  });

  it("summarizes failed findings by category only", () => {
    const report = verifyCloudRunLogs({
      raw: JSON.stringify([
        {
          jsonPayload: {
            authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
            audit: {
              event_type: "mcp_audit",
              action: "create_draft",
              outcome: "success",
              draft_body: { type: "doc" },
            },
          },
        },
      ]),
      entries: [
        {
          jsonPayload: {
            authorization: "Bearer abcdefghijklmnopqrstuvwxyz",
            audit: {
              event_type: "mcp_audit",
              action: "create_draft",
              outcome: "success",
              draft_body: { type: "doc" },
            },
          },
        },
      ],
    });
    const rendered = renderCloudRunLogsEvidenceArtifact(
      report,
      "2026-07-08T12:00:00Z",
    );

    expect(rendered).toContain("- Complete: no");
    expect(rendered).toContain("- draft content field: 1 finding(s)");
    expect(rendered).toContain("- secret pattern: 2 finding(s)");
    expect(rendered).toContain("- sensitive field: 1 finding(s)");
    expect(rendered).toContain("- unexpected audit field: 1 finding(s)");
    expect(rendered).not.toContain("abcdefghijklmnopqrstuvwxyz");
    expect(rendered).not.toContain("$.jsonPayload.authorization");
    expect(rendered).not.toContain("draft_body: {");
  });

  it("writes a project-local artifact with a generated timestamp", () => {
    withTempProject((cwd) => {
      const result = writeCloudRunLogsEvidenceArtifact({
        cwd,
        artifact: ".data/v1/gate-16-cloud-run-logs.md",
        report: verifyCloudRunLogs(
          {
            raw: JSON.stringify(safeEntries()),
            entries: safeEntries(),
          },
          { requireAuditEvents: true },
        ),
      });

      expect(result.artifact).toBe(".data/v1/gate-16-cloud-run-logs.md");
      expect(existsSync(result.path)).toBe(true);
      const artifact = readFileSync(result.path, "utf8");

      expect(artifact).toMatch(/- Verified at: \d{4}-\d{2}-\d{2}T/);
      expect(artifact).toContain(
        "--artifact .data/v1/gate-16-cloud-run-logs.md",
      );
      expect(artifact).toContain(
        "npm run cloud-run:logs:verify -- --logs-json .data/cloud-run-logs.json --require-audit-events --evidence-artifact .data/v1/gate-16-cloud-run-logs.md",
      );
      expect(artifact).not.toContain("<this file>");
    });
  });

  it("rejects paths outside the project", () => {
    withTempProject((cwd) => {
      expect(() =>
        writeCloudRunLogsEvidenceArtifact({
          cwd,
          artifact: "../outside.md",
          report: verifyCloudRunLogs({ raw: "[]", entries: [] }),
        }),
      ).toThrow(
        "V1 Cloud Run logs evidence artifact must stay inside the project directory.",
      );
    });
  });

  it("rejects secret-like rendered content before writing", () => {
    withTempProject((cwd) => {
      expect(() =>
        writeCloudRunLogsEvidenceArtifact({
          cwd,
          artifact: ".data/v1/gate-16-cloud-run-logs.md",
          report: {
            ok: false,
            entry_count: 1,
            audit_event_count: 0,
            checks: [
              {
                id: "unsafe",
                ok: false,
                evidence: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
              },
            ],
            findings: [],
          },
        }),
      ).toThrow(
        "V1 evidence artifact .data/v1/gate-16-cloud-run-logs.md contains secret-like content",
      );
    });
  });
});

function safeEntries(): readonly unknown[] {
  return [
    {
      jsonPayload: {
        audit: {
          event_type: "mcp_audit",
          action: "create_draft",
          outcome: "success",
          draft_id: 123,
          body_format: "markdown_v1",
          body_present: true,
          warning_count: 0,
          error_count: 0,
          stats: {
            block_count: 3,
          },
        },
      },
    },
    {
      httpRequest: {
        requestMethod: "GET",
        requestUrl: "https://example.run.app/mcp/<redacted>",
      },
    },
  ];
}

function withTempLogs(run: (logsFile: string) => void): void {
  const tempRoot = mkdtempSync(join(tmpdir(), "cloud-run-logs-"));
  const logsFile = join(tempRoot, "logs.json");

  try {
    writeFileSync(logsFile, JSON.stringify([]));
    run(logsFile);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function withTempProject(run: (cwd: string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), "cloud-run-logs-evidence-"));
  try {
    run(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
