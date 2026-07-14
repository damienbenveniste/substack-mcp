import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  parseRecordV1EvidenceArgs,
  recordV1Evidence,
  recordV1EvidenceUsage,
  renderRecordV1EvidenceResult,
} from "../../scripts/recordV1EvidenceCore.js";
import { buildV1AcceptanceStatus } from "../../scripts/v1AcceptanceStatusCore.js";

describe("parseRecordV1EvidenceArgs", () => {
  const cwd = "/repo/substack-mcp";

  it("parses required and optional evidence fields", () => {
    expect(
      parseRecordV1EvidenceArgs(
        [
          "--gate",
          "11",
          "--evidence",
          "ChatGPT connector created a draft.",
          "--verified-at",
          "2026-07-08T12:00:00Z",
          "--command",
          "npm run smoke:remote-noauth -- --url https://example.ngrok.app/mcp",
          "--artifact",
          ".data/v1/chatgpt.md",
          "--replace",
          "--json",
        ],
        cwd,
      ),
    ).toEqual({
      help: false,
      cwd,
      evidenceFile: `${cwd}/.data/v1-acceptance-evidence.json`,
      gateId: 11,
      evidence: "ChatGPT connector created a draft.",
      verifiedAt: "2026-07-08T12:00:00Z",
      command:
        "npm run smoke:remote-noauth -- --url https://example.ngrok.app/mcp",
      artifact: ".data/v1/chatgpt.md",
      replace: true,
      format: "json",
    });
  });

  it("parses a custom project-local evidence file", () => {
    expect(
      parseRecordV1EvidenceArgs(
        [
          "--evidence-file",
          ".data/custom-evidence.json",
          "--fixture-dir",
          "fixtures/live captures",
          "--gate",
          "15",
          "--evidence",
          "Claude Code connected through stdio.",
        ],
        cwd,
      ),
    ).toMatchObject({
      evidenceFile: `${cwd}/.data/custom-evidence.json`,
      fixtureDir: `${cwd}/fixtures/live captures`,
      gateId: 15,
      format: "text",
    });

    expect(
      parseRecordV1EvidenceArgs(
        [
          "--gate",
          "15",
          "--evidence",
          "Claude Code connected through stdio.",
          "--format",
          "text",
        ],
        cwd,
      ),
    ).toMatchObject({
      format: "text",
    });
  });

  it("allows help and rejects invalid inputs", () => {
    expect(parseRecordV1EvidenceArgs(["--help"], cwd)).toEqual({
      help: true,
    });
    expect(() => parseRecordV1EvidenceArgs([], cwd)).toThrow(
      "--gate is required.",
    );
    expect(() => parseRecordV1EvidenceArgs(["--gate", "11"], cwd)).toThrow(
      "--evidence is required.",
    );
    expect(() =>
      parseRecordV1EvidenceArgs(["--gate", "18", "--evidence", "x"], cwd),
    ).toThrow("--gate must be an integer from 1 to 17.");
    expect(() =>
      parseRecordV1EvidenceArgs(["--gate", "3", "--evidence", "x"], cwd),
    ).toThrow(
      "Gate 3 is repo-local and cannot be recorded in the manual/live evidence file. Record one of: 7, 8, 9, 11, 12, 13, 14, 15, 16.",
    );
    expect(() =>
      parseRecordV1EvidenceArgs(["--gate", "--evidence", "x"], cwd),
    ).toThrow("--gate requires a value.");
    expect(() =>
      parseRecordV1EvidenceArgs(
        [
          "--evidence-file",
          "../outside.json",
          "--gate",
          "11",
          "--evidence",
          "x",
        ],
        cwd,
      ),
    ).toThrow("--evidence-file must stay inside the project directory.");
    expect(() =>
      parseRecordV1EvidenceArgs(
        [
          "--fixture-dir",
          "../outside-fixtures",
          "--gate",
          "11",
          "--evidence",
          "x",
        ],
        cwd,
      ),
    ).toThrow("--fixture-dir must stay inside the project directory.");
    expect(() =>
      parseRecordV1EvidenceArgs(
        ["--gate", "11", "--evidence", "x", "--artifact", "../outside.md"],
        cwd,
      ),
    ).toThrow("--artifact must stay inside the project directory.");
    expect(() =>
      parseRecordV1EvidenceArgs(
        ["--bogus", "--gate", "3", "--evidence", "x"],
        cwd,
      ),
    ).toThrow("Unknown option: --bogus");
    expect(() =>
      parseRecordV1EvidenceArgs(
        ["--gate", "11", "--evidence", "x", "--format", "yaml"],
        cwd,
      ),
    ).toThrow("--format must be one of: text, json.");
  });
});

describe("recordV1Evidence", () => {
  it("creates an evidence file and records a manual gate", () => {
    withTempProject((cwd) => {
      const evidenceFile = join(cwd, ".data", "v1-acceptance-evidence.json");
      const artifact = ".data/v1/gate-11-chatgpt-ngrok.md";
      mkdirSync(join(cwd, ".data", "v1"), { recursive: true });
      writeFileSync(join(cwd, artifact), manualArtifactText(11));

      const result = recordV1Evidence(
        {
          help: false,
          cwd,
          evidenceFile,
          gateId: 11,
          evidence: "ChatGPT connector acceptance passed.",
          verifiedAt: "2026-07-08T12:00:00Z",
          command:
            "npm run smoke:remote-noauth -- --url https://example.ngrok.app/mcp --evidence-artifact .data/v1/gate-11-chatgpt-ngrok.md",
          artifact,
          replace: false,
          format: "text",
        },
        new Date("2026-07-08T13:00:00Z"),
      );
      const parsed = JSON.parse(readFileSync(evidenceFile, "utf8")) as {
        readonly gates: ReadonlyArray<{ readonly id: number }>;
      };
      const status = buildV1AcceptanceStatus({
        cwd,
        evidenceFile,
      });

      expect(result).toMatchObject({
        ok: true,
        evidence_file: evidenceFile,
        gate_id: 11,
        replaced: false,
        gate_count: 1,
        status_command:
          "npm run v1:status -- --evidence-file .data/v1-acceptance-evidence.json",
        release_gate_command:
          "npm run v1:status -- --evidence-file .data/v1-acceptance-evidence.json --require-complete",
      });
      expect(parsed.gates.map((entry) => entry.id)).toEqual([11]);
      expect(status.gates.find((gate) => gate.id === 11)).toMatchObject({
        status: "manual_or_live_evidence_recorded",
      });
    });
  });

  it("rejects duplicate gate evidence unless replace is set", () => {
    withTempProject((cwd) => {
      const evidenceFile = join(cwd, ".data", "v1-acceptance-evidence.json");
      const options = {
        help: false as const,
        cwd,
        evidenceFile,
        gateId: 11,
        evidence: "ChatGPT connector acceptance passed.",
        verifiedAt: "2026-07-08T12:00:00Z",
        replace: false,
        format: "text" as const,
      };

      recordV1Evidence(options);
      expect(() => recordV1Evidence(options)).toThrow(
        "Evidence for gate 11 already exists. Pass --replace to update it.",
      );

      const replaced = recordV1Evidence({
        ...options,
        evidence: "Updated ChatGPT connector acceptance evidence.",
        replace: true,
      });
      const parsed = JSON.parse(readFileSync(evidenceFile, "utf8")) as {
        readonly gates: ReadonlyArray<{
          readonly id: number;
          readonly evidence: string;
        }>;
      };

      expect(replaced.replaced).toBe(true);
      expect(parsed.gates).toMatchObject([
        {
          id: 11,
          evidence: "Updated ChatGPT connector acceptance evidence.",
        },
      ]);
    });
  });

  it("rejects future verification timestamps before writing records", () => {
    withTempProject((cwd) => {
      const evidenceFile = join(cwd, ".data", "v1-acceptance-evidence.json");

      expect(() =>
        recordV1Evidence(
          {
            help: false,
            cwd,
            evidenceFile,
            gateId: 11,
            evidence: "ChatGPT connector acceptance passed.",
            verifiedAt: "2026-07-08T13:02:00Z",
            replace: false,
            format: "text",
          },
          new Date("2026-07-08T13:00:00Z"),
        ),
      ).toThrow(
        "V1 evidence verified_at is in the future: 2026-07-08T13:02:00Z.",
      );
    });
  });

  it("keeps recorded gates sorted by gate id", () => {
    withTempProject((cwd) => {
      const evidenceFile = join(cwd, ".data", "v1-acceptance-evidence.json");

      recordV1Evidence({
        help: false,
        cwd,
        evidenceFile,
        gateId: 11,
        evidence: "ChatGPT connector acceptance passed.",
        verifiedAt: "2026-07-08T12:00:00Z",
        replace: false,
        format: "text",
      });
      recordV1Evidence({
        help: false,
        cwd,
        evidenceFile,
        gateId: 8,
        evidence: "Live update-draft acceptance passed.",
        verifiedAt: "2026-07-08T12:01:00Z",
        replace: false,
        format: "text",
      });

      const parsed = JSON.parse(readFileSync(evidenceFile, "utf8")) as {
        readonly gates: ReadonlyArray<{ readonly id: number }>;
      };

      expect(parsed.gates.map((entry) => entry.id)).toEqual([8, 11]);
    });
  });

  it("preserves custom fixture directories in suggested status commands", () => {
    withTempProject((cwd) => {
      const evidenceFile = join(cwd, ".data", "v1 acceptance evidence.json");
      const artifact = ".data/v1/gate-07-rich-draft-live-fixtures.md";
      mkdirSync(join(cwd, ".data", "v1"), { recursive: true });
      writeFileSync(join(cwd, artifact), manualArtifactText(7));

      const result = recordV1Evidence(
        {
          help: false,
          cwd,
          evidenceFile,
          fixtureDir: join(cwd, "fixtures", "live captures"),
          gateId: 7,
          evidence: "Live fixture-backed draft formatting passed.",
          artifact,
          replace: false,
          format: "text",
        },
        new Date("2026-07-08T13:00:00Z"),
      );
      const text = renderRecordV1EvidenceResult(result, "text");

      expect(result.status_command).toBe(
        "npm run v1:status -- --evidence-file '.data/v1 acceptance evidence.json' --fixture-dir 'fixtures/live captures'",
      );
      expect(result.release_gate_command).toBe(
        "npm run v1:status -- --evidence-file '.data/v1 acceptance evidence.json' --fixture-dir 'fixtures/live captures' --require-complete",
      );
      expect(text).toContain("Release gate command:");
      expect(text).toContain("--require-complete");
    });
  });

  it("rejects repo-local gates before writing evidence", () => {
    withTempProject((cwd) => {
      const evidenceFile = join(cwd, ".data", "v1-acceptance-evidence.json");

      expect(() =>
        recordV1Evidence({
          help: false,
          cwd,
          evidenceFile,
          gateId: 3,
          evidence: "MCP Inspector listed all seven tools.",
          replace: false,
          format: "text",
        }),
      ).toThrow(
        "Gate 3 is repo-local and cannot be recorded in the manual/live evidence file. Record one of: 7, 8, 9, 11, 12, 13, 14, 15, 16.",
      );
    });
  });

  it("requires referenced artifacts to exist", () => {
    withTempProject((cwd) => {
      const evidenceFile = join(cwd, ".data", "v1-acceptance-evidence.json");

      expect(() =>
        recordV1Evidence({
          help: false,
          cwd,
          evidenceFile,
          gateId: 14,
          evidence: "Remote static bearer smoke passed.",
          artifact: ".data/v1/static-bearer.md",
          replace: false,
          format: "text",
        }),
      ).toThrow("Artifact path does not exist: .data/v1/static-bearer.md");
    });
  });

  it("rejects secret-like evidence text and commands before writing records", () => {
    withTempProject((cwd) => {
      const evidenceFile = join(cwd, ".data", "v1-acceptance-evidence.json");

      expect(() =>
        recordV1Evidence({
          help: false,
          cwd,
          evidenceFile,
          gateId: 11,
          evidence: "ChatGPT connector passed with Bearer abcdefghijklmnop",
          replace: false,
          format: "text",
        }),
      ).toThrow("V1 evidence evidence contains secret-like content");
      expect(() =>
        recordV1Evidence({
          help: false,
          cwd,
          evidenceFile,
          gateId: 11,
          evidence: "ChatGPT connector passed.",
          command:
            "curl -H 'Authorization: Bearer abcdefghijklmnop' https://example.com/mcp",
          replace: false,
          format: "text",
        }),
      ).toThrow("V1 evidence command contains secret-like content");
      expect(() =>
        recordV1Evidence({
          help: false,
          cwd,
          evidenceFile,
          gateId: 11,
          evidence:
            "ChatGPT connector passed at https://example.com/mcp/private-path.",
          replace: false,
          format: "text",
        }),
      ).toThrow("V1 evidence evidence contains secret-like content");
      expect(() =>
        recordV1Evidence({
          help: false,
          cwd,
          evidenceFile,
          gateId: 12,
          evidence: "Cloud Run deployment passed.",
          command: "MCP_PATH_SECRET=private-path npm run smoke:remote-noauth",
          replace: false,
          format: "text",
        }),
      ).toThrow("V1 evidence command contains secret-like content");
    });
  });

  it("rejects placeholder evidence text and commands before writing records", () => {
    withTempProject((cwd) => {
      const evidenceFile = join(cwd, ".data", "v1-acceptance-evidence.json");

      expect(() =>
        recordV1Evidence({
          help: false,
          cwd,
          evidenceFile,
          gateId: 11,
          evidence: "<replace with evidence summary>",
          replace: false,
          format: "text",
        }),
      ).toThrow("V1 evidence evidence contains unfilled placeholder text");
      expect(() =>
        recordV1Evidence({
          help: false,
          cwd,
          evidenceFile,
          gateId: 12,
          evidence: "Cloud Run deployment evidence passed.",
          command: "npm run smoke:remote -- --url https://<cloud-run-host>/mcp",
          replace: false,
          format: "text",
        }),
      ).toThrow("V1 evidence command contains unfilled placeholder text");
    });
  });

  it("rejects text artifacts that contain secrets or draft body fields", () => {
    withTempProject((cwd) => {
      const evidenceFile = join(cwd, ".data", "v1-acceptance-evidence.json");
      mkdirSync(join(cwd, ".data", "v1"), { recursive: true });
      const artifact = join(cwd, ".data", "v1", "unsafe.md");

      writeFileSync(artifact, "cookie: connect.sid=secret");
      expect(() =>
        recordV1Evidence({
          help: false,
          cwd,
          evidenceFile,
          gateId: 11,
          evidence: "ChatGPT connector acceptance passed.",
          artifact: ".data/v1/unsafe.md",
          replace: false,
          format: "text",
        }),
      ).toThrow(
        "V1 evidence artifact .data/v1/unsafe.md contains secret-like content",
      );

      writeFileSync(artifact, '{"draft_body":{"type":"doc"}}');
      expect(() =>
        recordV1Evidence({
          help: false,
          cwd,
          evidenceFile,
          gateId: 11,
          evidence: "ChatGPT connector acceptance passed.",
          artifact: ".data/v1/unsafe.md",
          replace: false,
          format: "text",
        }),
      ).toThrow(
        "Evidence artifact contains draft-body-like field draft_body: .data/v1/unsafe.md",
      );
    });
  });

  it("rejects unfilled evidence template artifacts", () => {
    withTempProject((cwd) => {
      const evidenceFile = join(cwd, ".data", "v1-acceptance-evidence.json");
      mkdirSync(join(cwd, ".data", "v1"), { recursive: true });
      const artifact = join(cwd, ".data", "v1", "template.md");

      writeFileSync(artifact, "- [ ] ChatGPT connector listed tools.\n");
      expect(() =>
        recordV1Evidence({
          help: false,
          cwd,
          evidenceFile,
          gateId: 11,
          evidence: "ChatGPT connector acceptance passed.",
          artifact: ".data/v1/template.md",
          replace: false,
          format: "text",
        }),
      ).toThrow(
        "Evidence artifact contains unchecked checklist items: .data/v1/template.md",
      );

      writeFileSync(artifact, "npm run v1:record -- --artifact <this file>\n");
      expect(() =>
        recordV1Evidence({
          help: false,
          cwd,
          evidenceFile,
          gateId: 11,
          evidence: "ChatGPT connector acceptance passed.",
          artifact: ".data/v1/template.md",
          replace: false,
          format: "text",
        }),
      ).toThrow(
        "Evidence artifact contains unfilled placeholder text: .data/v1/template.md",
      );
    });
  });

  it("rejects text artifacts that lack the gate detail section", () => {
    withTempProject((cwd) => {
      const evidenceFile = join(cwd, ".data", "v1-acceptance-evidence.json");
      mkdirSync(join(cwd, ".data", "v1"), { recursive: true });
      const artifact = join(cwd, ".data", "v1", "loose-notes.md");

      writeFileSync(artifact, "ChatGPT connector acceptance passed.\n");

      expect(() =>
        recordV1Evidence({
          help: false,
          cwd,
          evidenceFile,
          gateId: 11,
          evidence: "ChatGPT connector acceptance passed.",
          artifact: ".data/v1/loose-notes.md",
          replace: false,
          format: "text",
        }),
      ).toThrow(
        "Evidence artifact is missing a gate 11 detail section (## Gate 11 ChatGPT Connector Details or ## Manual ChatGPT Connector Acceptance): .data/v1/loose-notes.md",
      );
    });
  });

  it("rejects artifact paths that are not files", () => {
    withTempProject((cwd) => {
      const evidenceFile = join(cwd, ".data", "v1-acceptance-evidence.json");
      mkdirSync(join(cwd, ".data", "v1", "artifact-directory"), {
        recursive: true,
      });

      expect(() =>
        recordV1Evidence({
          help: false,
          cwd,
          evidenceFile,
          gateId: 11,
          evidence: "ChatGPT connector acceptance passed.",
          artifact: ".data/v1/artifact-directory",
          replace: false,
          format: "text",
        }),
      ).toThrow("Evidence artifact is not a file: .data/v1/artifact-directory");
    });
  });

  it("allows binary artifacts that cannot be scanned as text", () => {
    withTempProject((cwd) => {
      const evidenceFile = join(cwd, ".data", "v1-acceptance-evidence.json");
      mkdirSync(join(cwd, ".data", "v1"), { recursive: true });
      writeFileSync(
        join(cwd, ".data", "v1", "inspector.png"),
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]),
      );

      const result = recordV1Evidence({
        help: false,
        cwd,
        evidenceFile,
        gateId: 15,
        evidence: "Claude Code stdio acceptance artifact is a screenshot.",
        artifact: ".data/v1/inspector.png",
        replace: false,
        format: "text",
      });

      expect(result.recorded.artifact).toBe(".data/v1/inspector.png");
    });
  });

  it("uses current time when verified_at is omitted and renders text/json", () => {
    withTempProject((cwd) => {
      const evidenceFile = join(cwd, ".data", "v1-acceptance-evidence.json");
      mkdirSync(join(cwd, ".data", "v1"), { recursive: true });
      writeFileSync(
        join(cwd, ".data", "v1", "static-bearer.md"),
        manualArtifactText(14),
      );
      const result = recordV1Evidence(
        {
          help: false,
          cwd,
          evidenceFile,
          gateId: 14,
          evidence: "Remote static bearer smoke passed.",
          artifact: ".data/v1/static-bearer.md",
          replace: false,
          format: "text",
        },
        new Date("2026-07-08T14:00:00Z"),
      );
      const text = renderRecordV1EvidenceResult(result, "text");
      const json = JSON.parse(renderRecordV1EvidenceResult(result, "json")) as {
        readonly recorded: { readonly verified_at: string };
      };

      expect(result.recorded.verified_at).toBe("2026-07-08T14:00:00.000Z");
      expect(text).toContain("# V1 evidence recorded");
      expect(text).toContain("Status command:");
      expect(text).toContain("Release gate command:");
      expect(json.recorded.verified_at).toBe("2026-07-08T14:00:00.000Z");
    });
  });

  it("documents usage", () => {
    const usage = recordV1EvidenceUsage();

    expect(usage).toContain("npm run v1:record");
    expect(usage).toContain("--replace");
    expect(usage).toContain("--fixture-dir");
    expect(usage).toContain("fixtures/live");
    expect(usage).toContain(
      "npm run fixtures:status -- --fixture-dir fixtures/live --require-all",
    );
    expect(usage).toContain(
      "SUBSTACK_FIXTURE_DIR=fixtures/live npm test -- tests/content/substackFixtureCompatibility.test.ts",
    );
  });
});

function withTempProject(run: (cwd: string) => void): void {
  const tempRoot = mkdtempSync(join(tmpdir(), "substack-v1-record-"));
  const cwd = resolve(tempRoot, "repo");

  try {
    mkdirSync(cwd, { recursive: true });
    run(cwd);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function manualArtifactText(gateId: number): string {
  switch (gateId) {
    case 7:
      return completedGateArtifactText(7, "## Gate 7 Manual Review Details");
    case 11:
      return completedGateArtifactText(
        11,
        "## Gate 11 ChatGPT Connector Details",
      );
    case 14:
      return completedGateArtifactText(
        14,
        "## Gate 14 Header-Capable Client Details",
      );
    default:
      return "## Manual Evidence\n\nManual evidence passed.\n";
  }
}

function completedGateArtifactText(gateId: number, heading: string): string {
  return [heading, "", ...completedGateDetailLines(gateId), ""].join("\n");
}

function completedGateDetailLines(gateId: number): readonly string[] {
  return requiredDetailFields(gateId).map(
    (field) => `- ${field}: ${completedGateDetailValue(gateId, field)}`,
  );
}

function completedGateDetailValue(gateId: number, field: string): string {
  if (gateId === 7 && field === "Fixture readiness command") {
    return "npm run fixtures:status -- --require-all passed for fixtures/substack";
  }

  if (gateId === 7 && field === "Fixture compatibility command") {
    return "npm test -- tests/content/substackFixtureCompatibility.test.ts passed";
  }

  if (gateId === 7 && field === "Fixture provenance review") {
    return "captured from purpose-built live Substack drafts and manually reviewed in the editor";
  }

  if (gateId === 7 && field === "Draft URL or ID") {
    return "https://example.substack.com/p/fixture";
  }

  if (gateId === 7 && field === "Title/subtitle review") {
    return "title and subtitle matched the expected live fixture values";
  }

  if (gateId === 7 && field === "Text formatting review") {
    return "headings, rich text, links, lists, blockquote, and horizontal rule rendered correctly in Substack";
  }

  if (gateId === 7 && field === "Image rendering review") {
    return "uploaded image rendered correctly in the editor and preview";
  }

  if (gateId === 7 && field === "Native code block rendering review") {
    return "native code block rendered correctly with language formatting";
  }

  if (gateId === 7 && field === "Native LaTeX rendering review") {
    return "native LaTeX equation block rendered correctly";
  }

  if (gateId === 7 && field === "Substack preview review") {
    return "Substack preview reviewed and matched the expected rich draft rendering";
  }

  if (gateId === 7 && field === "Unpublished status review") {
    return "status=draft and is_published=false after creation";
  }

  if (gateId === 7 && field === "Cleanup decision") {
    return "kept private unpublished draft for further manual review without publishing";
  }

  if (gateId === 11 && field === "ChatGPT surface tested") {
    return "ChatGPT web connector in developer mode";
  }

  if (gateId === 11 && field === "Connector URL") {
    return "https://example.ngrok.app/mcp";
  }

  if (gateId === 11 && field === "Tool-list result") {
    return "exactly seven V1 draft-only tools listed through the ChatGPT connector";
  }

  if (gateId === 11 && field === "Manual flow result") {
    return "ChatGPT validate_newsletter_content and preview_draft succeeded, then create_draft created an unpublished draft after confirmation";
  }

  if (gateId === 11 && field === "Draft or review reference") {
    return "non-sensitive screenshot reference from the ChatGPT connector draft review";
  }

  if (gateId === 11 && field === "Tunnel exposure window") {
    return "bounded ngrok tunnel window from 2026-07-08T12:00:00Z to 2026-07-08T12:05:00Z";
  }

  if (gateId === 11 && field === "Unexpected traffic review") {
    return "ngrok traffic logs reviewed; no unexpected traffic observed";
  }

  if (gateId === 11 && field === "Rotation decision") {
    return "ngrok tunnel stopped after test; no rotation needed because no credential was exposed";
  }

  if (gateId === 12 && field === "GCP project/region/service") {
    return "GCP project substack-mcp-prod, region us-central1, Cloud Run service substack-mcp reviewed";
  }

  if (gateId === 12 && field === "Service URL checked") {
    return "deployed Cloud Run service URL https://substack-mcp-abc-uc.a.run.app/mcp checked";
  }

  if (gateId === 12 && field === "Deploy command source") {
    return "cloud-run:plan artifact reviewed with the gcloud run deploy command summary";
  }

  if (gateId === 12 && field === "Health check result") {
    return "/healthz returned HTTP 200 ok on the deployed service at 2026-07-08T12:00:00Z";
  }

  if (gateId === 12 && field === "Remote smoke result") {
    return "auth-mode matching remote MCP smoke test passed against the deployed service URL";
  }

  if (gateId === 12 && field === "Auth mode deployed") {
    return "static_bearer deployed from cloud-run:verify output with launch rationale recorded";
  }

  if (gateId === 12 && field === "Budget guard review") {
    return "Cloud Billing budget alert follow-up recorded with $5 monthly budget command";
  }

  if (gateId === 12 && field === "Path-secret review") {
    return "MCP_PATH_SECRET not used for this deployment";
  }

  if (gateId === 13 && field === "Literal env review") {
    return "Secret Manager references were used; no literal env values were present";
  }

  if (gateId === 13 && field === "Secret value handling") {
    return "no raw secret values were opened, pasted, or recorded";
  }

  if (gateId === 13 && field === "Secret references checked") {
    return "Secret Manager references checked for SUBSTACK_SESSION_TOKEN and PREVIEW_TOKEN_SECRET";
  }

  if (gateId === 13 && field === "Required secret names") {
    return "Secret Manager secret names: substack-session-token secret and preview-token-secret";
  }

  if (gateId === 13 && field === "Runtime service account") {
    return "Cloud Run runtime service account substack-mcp-runner@example.iam.gserviceaccount.com reviewed";
  }

  if (gateId === 13 && field === "Secret access bindings") {
    return "IAM roles/secretmanager.secretAccessor binding verified for the runtime service account";
  }

  if (gateId === 13 && field === "Version policy") {
    return "latest secret versions reviewed with rotation notes for redeploy after rotation";
  }

  if (gateId === 13 && field === "Rotation follow-up") {
    return "no rotation needed because no raw secret values were exposed";
  }

  if (gateId === 14 && field === "Header configuration method") {
    return "Authorization header configured by client settings without recording token value";
  }

  if (gateId === 14 && field === "Client tested") {
    return "curl 8.0 header-capable HTTP client";
  }

  if (gateId === 14 && field === "Endpoint tested") {
    return "https://example.ngrok.app/mcp tested through the header-capable client";
  }

  if (gateId === 14 && field === "Tool-list result") {
    return "exactly seven V1 draft-only tools listed through the header-capable client";
  }

  if (gateId === 14 && field === "Validation call result") {
    return "validate_newsletter_content succeeded through the header-capable client";
  }

  if (gateId === 14 && field === "Rejection proof") {
    return "missing bearer token and wrong bearer token were both rejected with HTTP 401";
  }

  if (gateId === 14 && field === "Token redaction review") {
    return "no bearer token value was included, recorded, printed, pasted, exposed, or logged";
  }

  if (gateId === 15 && field === "Client tested") {
    return "Claude Code 1.2.3";
  }

  if (gateId === 15 && field === "Config path or add command") {
    return "claude mcp add --transport stdio substack-drafts -- node /Users/example/substack-mcp/dist/stdio.js";
  }

  if (gateId === 15 && field === "Server entrypoint path") {
    return "/Users/example/substack-mcp/dist/stdio.js";
  }

  if (gateId === 15 && field === "Tool-list result") {
    return "exactly seven V1 draft-only tools listed through Claude Code";
  }

  if (gateId === 15 && field === "Validation call result") {
    return "validate_newsletter_content succeeded through Claude Code";
  }

  if (gateId === 15 && field === "Credential locality review") {
    return "Substack credentials came from local environment variables and were not recorded, committed, pasted into client config, or exposed remotely";
  }

  return `completed ${field.toLowerCase()} review`;
}

function requiredDetailFields(gateId: number): readonly string[] {
  switch (gateId) {
    case 7:
      return [
        "Fixture directory",
        "Fixture readiness command",
        "Fixture compatibility command",
        "Fixture provenance review",
        "Draft URL or ID",
        "Title/subtitle review",
        "Text formatting review",
        "Image rendering review",
        "Native code block rendering review",
        "Native LaTeX rendering review",
        "Substack preview review",
        "Unpublished status review",
        "Cleanup decision",
      ];
    case 11:
      return [
        "Connector URL",
        "ChatGPT surface tested",
        "Tool-list result",
        "Manual flow result",
        "Draft or review reference",
        "Tunnel exposure window",
        "Unexpected traffic review",
        "Rotation decision",
      ];
    case 14:
      return [
        "Client tested",
        "Endpoint tested",
        "Header configuration method",
        "Tool-list result",
        "Validation call result",
        "Rejection proof",
        "Token redaction review",
      ];
    default:
      return [];
  }
}
