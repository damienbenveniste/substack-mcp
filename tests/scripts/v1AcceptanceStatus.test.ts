import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildV1AcceptanceStatus,
  parseV1AcceptanceStatusArgs,
  renderV1AcceptanceStatus,
  shouldFailV1AcceptanceStatus,
  v1AcceptanceStatusUsage,
} from "../../scripts/v1AcceptanceStatusCore.js";

const projectRoot = resolve(import.meta.dirname, "../..");

describe("parseV1AcceptanceStatusArgs", () => {
  const cwd = "/repo/substack-mcp";

  it("uses text output by default", () => {
    expect(parseV1AcceptanceStatusArgs([], cwd)).toEqual({
      help: false,
      cwd,
      fixtureDir: `${cwd}/fixtures/substack`,
      format: "text",
      requireComplete: false,
    });
  });

  it("parses JSON output and completion gate mode", () => {
    expect(
      parseV1AcceptanceStatusArgs(
        [
          "--evidence-file",
          ".data/v1-acceptance-evidence.json",
          "--fixture-dir",
          "fixtures/live",
          "--json",
          "--require-complete",
        ],
        cwd,
      ),
    ).toEqual({
      help: false,
      cwd,
      evidenceFile: `${cwd}/.data/v1-acceptance-evidence.json`,
      fixtureDir: `${cwd}/fixtures/live`,
      format: "json",
      requireComplete: true,
    });

    expect(
      parseV1AcceptanceStatusArgs(["--format", "json"], cwd),
    ).toMatchObject({
      format: "json",
    });
  });

  it("allows help and rejects invalid options", () => {
    expect(parseV1AcceptanceStatusArgs(["--help"], cwd)).toEqual({
      help: true,
    });
    expect(parseV1AcceptanceStatusArgs(["-h"], cwd)).toEqual({ help: true });
    expect(() =>
      parseV1AcceptanceStatusArgs(["--format", "yaml"], cwd),
    ).toThrow("--format must be one of: text, json.");
    expect(() => parseV1AcceptanceStatusArgs(["--format"], cwd)).toThrow(
      "--format requires a value.",
    );
    expect(() =>
      parseV1AcceptanceStatusArgs(["--evidence-file", "../outside.json"], cwd),
    ).toThrow("--evidence-file must stay inside the project directory.");
    expect(() =>
      parseV1AcceptanceStatusArgs(["--fixture-dir", "../outside"], cwd),
    ).toThrow("--fixture-dir must stay inside the project directory.");
    expect(() => parseV1AcceptanceStatusArgs(["--bogus"], cwd)).toThrow(
      "Unknown option: --bogus",
    );
  });
});

describe("buildV1AcceptanceStatus", () => {
  it("reports current repo-local evidence separately from manual/live gates", () => {
    const status = buildV1AcceptanceStatus(projectRoot);

    expect(status.complete).toBe(false);
    expect(status.summary.total).toBe(17);
    expect(status.summary.missing_local_artifact).toBe(0);
    expect(status.summary.local_evidence_available).toBe(8);
    expect(status.summary.manual_or_live_evidence_recorded).toBe(0);
    expect(status.summary.manual_or_live_evidence_required).toBe(9);
    expect(status.fixture_ready).toBe(false);
    expect(status.fixture_present_count).toBe(0);
    expect(status.fixture_valid_count).toBe(0);
    expect(status.fixture_compatible_count).toBe(0);
    expect(status.fixture_dir).toBe(`${projectRoot}/fixtures/substack`);

    expect(status.gates.find((gate) => gate.id === 7)).toMatchObject({
      status: "manual_or_live_evidence_required",
    });
    expect(status.gates.find((gate) => gate.id === 7)?.next_action).toContain(
      "Run `npm run fixtures:status` for per-fixture capture commands",
    );
    expect(status.gates.find((gate) => gate.id === 7)?.next_action).toContain(
      "`npm test -- tests/content/substackFixtureCompatibility.test.ts`",
    );
    expect(status.gates.find((gate) => gate.id === 7)?.next_action).toContain(
      "complete the gate 7 fixture provenance review",
    );
    expect(status.gates.find((gate) => gate.id === 7)?.next_action).toContain(
      "V1_LIVE_SUBSTACK_EVIDENCE_ARTIFACTS=.data/v1/gate-07-rich-draft-live-fixtures.md,.data/v1/gate-08-update-draft-live.md,.data/v1/gate-09-read-drafts-live.md",
    );
    expect(status.gates.find((gate) => gate.id === 17)).toMatchObject({
      status: "local_evidence_available",
    });
    expect(status.gates.find((gate) => gate.id === 17)?.evidence).toContain(
      "formatting",
    );
    expect(status.gates.find((gate) => gate.id === 17)?.evidence).toContain(
      "credential",
    );
    expect(status.gates.find((gate) => gate.id === 3)).toMatchObject({
      status: "local_evidence_available",
    });
    expect(status.gates.find((gate) => gate.id === 3)?.evidence).toContain(
      "`npm run smoke:inspector`",
    );
    expect(status.gates.find((gate) => gate.id === 3)?.next_action).toContain(
      "npm run smoke:inspector -- --evidence-artifact .data/v1/gate-03-mcp-inspector.md",
    );
    expect(status.gates.find((gate) => gate.id === 12)?.evidence).toContain(
      "gate 16 log-verification follow-ups",
    );
    expect(status.gates.find((gate) => gate.id === 12)?.next_action).toContain(
      ".data/v1/gate-12-cloud-run-deployment.md",
    );
    expect(status.gates.find((gate) => gate.id === 13)?.evidence).toContain(
      "gate 13 evidence follow-up",
    );
    expect(status.gates.find((gate) => gate.id === 13)?.next_action).toContain(
      ".data/v1/gate-13-cloud-run-secrets.md",
    );
    expect(status.gates.find((gate) => gate.id === 9)?.evidence).toContain(
      "guarded live flow cover `list_drafts` plus `get_draft`",
    );
    expect(status.gates.find((gate) => gate.id === 14)?.evidence).toContain(
      "verify remote bearer rejection",
    );
    expect(status.gates.find((gate) => gate.id === 14)?.next_action).toContain(
      "npm run smoke:ngrok-static-bearer",
    );
    expect(status.gates.find((gate) => gate.id === 15)?.next_action).toContain(
      "npm run smoke:stdio -- --evidence-artifact .data/v1/gate-15-stdio-client.md",
    );
    expect(status.gates.find((gate) => gate.id === 16)?.next_action).toContain(
      "npm run cloud-run:logs:verify",
    );
    expect(status.gates.find((gate) => gate.id === 16)?.next_action).toContain(
      "--evidence-artifact .data/v1/gate-16-cloud-run-logs.md",
    );
    expect(status.gates.find((gate) => gate.id === 16)?.evidence).toContain(
      "Cloud Run plan follow-ups for gate 16",
    );
    expect(status.gates.find((gate) => gate.id === 16)).toMatchObject({
      status: "manual_or_live_evidence_required",
    });
  });

  it("flags missing repo-local artifacts when a minimal project is inspected", () => {
    withTempProject((cwd) => {
      writeFileSync(
        join(cwd, "package.json"),
        JSON.stringify({
          scripts: {
            test: "vitest run",
          },
        }),
      );
      writeFileSync(join(cwd, "README.md"), "# Minimal\n");

      const status = buildV1AcceptanceStatus(cwd);

      expect(status.complete).toBe(false);
      expect(status.summary.missing_local_artifact).toBeGreaterThan(0);
      expect(status.gates.find((gate) => gate.id === 2)).toMatchObject({
        status: "missing_local_artifact",
      });
      expect(status.gates.find((gate) => gate.id === 3)).toMatchObject({
        status: "missing_local_artifact",
      });
      expect(status.gates.find((gate) => gate.id === 17)).toMatchObject({
        status: "missing_local_artifact",
      });
    });
  });

  it("keeps rich draft acceptance open when fixtures are present and valid but adapter-incompatible", () => {
    withTempProject((cwd) => {
      writeFileSync(
        join(cwd, "package.json"),
        JSON.stringify({
          scripts: {
            test: "vitest run",
            build: "tsc -p tsconfig.build.json",
          },
        }),
      );
      writeFileSync(
        join(cwd, "README.md"),
        "npx @modelcontextprotocol/inspector@latest\n",
      );
      writeFileSync(
        join(cwd, "IMPLEMENTATION_NOTES.md"),
        "Guarded live integration harness is documented.\n",
      );
      writeAllFixtureDocs(join(cwd, "fixtures", "substack"));

      const status = buildV1AcceptanceStatus(cwd);
      const richDraftGate = status.gates.find((gate) => gate.id === 7);

      expect(status.fixture_ready).toBe(false);
      expect(status.fixture_present_count).toBe(4);
      expect(status.fixture_valid_count).toBe(4);
      expect(status.fixture_compatible_count).toBe(3);
      expect(richDraftGate).toMatchObject({
        status: "manual_or_live_evidence_required",
      });
      expect(richDraftGate?.evidence).toContain(
        "4/4 present, 4/4 valid, 3/4 adapter-compatible",
      );
    });
  });

  it("checks a custom project-local fixture directory", () => {
    withTempProject((cwd) => {
      const customFixtureDir = join(cwd, "fixtures", "live");
      writeFileSync(
        join(cwd, "package.json"),
        JSON.stringify({
          scripts: {
            test: "vitest run",
            build: "tsc -p tsconfig.build.json",
          },
        }),
      );
      writeFileSync(
        join(cwd, "README.md"),
        "npx @modelcontextprotocol/inspector@latest\n",
      );
      writeFileSync(
        join(cwd, "IMPLEMENTATION_NOTES.md"),
        "Guarded live integration harness is documented.\n",
      );
      writeAllFixtureDocs(customFixtureDir);

      const status = buildV1AcceptanceStatus({
        cwd,
        fixtureDir: customFixtureDir,
      });
      const richDraftGate = status.gates.find((gate) => gate.id === 7);

      expect(status.fixture_dir).toBe(customFixtureDir);
      expect(status.fixture_capture_dir_arg).toBe("fixtures/live");
      expect(status.fixture_present_count).toBe(4);
      expect(status.fixture_valid_count).toBe(4);
      expect(status.fixture_compatible_count).toBe(3);
      expect(richDraftGate?.next_action).toContain(
        "npm run fixtures:status -- --fixture-dir fixtures/live",
      );
      expect(richDraftGate?.next_action).toContain(
        "npm run fixtures:status -- --fixture-dir fixtures/live --require-all",
      );
      expect(richDraftGate?.next_action).toContain(
        "SUBSTACK_FIXTURE_DIR=fixtures/live npm test -- tests/content/substackFixtureCompatibility.test.ts",
      );
      expect(richDraftGate?.next_action).toContain(
        "complete the gate 7 fixture provenance review",
      );
    });
  });

  it("records supplied manual evidence without bypassing fixture readiness", () => {
    withProjectArtifact("manual-acceptance.md", (artifact) => {
      withTempEvidenceFile(
        {
          version: 1,
          gates: [
            {
              id: 11,
              verified_at: "2026-07-08T12:00:00Z",
              evidence: "ChatGPT connector acceptance passed.",
              artifact,
            },
            {
              id: 7,
              verified_at: "2026-07-08T12:05:00Z",
              evidence: "Manual draft review passed.",
              artifact,
            },
          ],
        },
        (evidenceFile) => {
          const status = buildV1AcceptanceStatus({
            cwd: projectRoot,
            evidenceFile,
          });

          expect(status.evidence_file).toBe(evidenceFile);
          expect(status.complete).toBe(false);
          expect(status.summary.manual_or_live_evidence_recorded).toBe(1);
          expect(status.gates.find((gate) => gate.id === 11)).toMatchObject({
            status: "manual_or_live_evidence_recorded",
          });
          expect(status.gates.find((gate) => gate.id === 7)).toMatchObject({
            status: "manual_or_live_evidence_required",
          });
          expect(
            status.gates.find((gate) => gate.id === 7)?.evidence,
          ).toContain("Fixture readiness is still required");
        },
      );
    });
  });

  it("loads the default recorded evidence file when it exists", () => {
    withTempProject((cwd) => {
      const artifact = ".data/v1/gate-11-chatgpt-ngrok.md";
      const evidenceFile = join(cwd, ".data", "v1-acceptance-evidence.json");

      mkdirSync(join(cwd, ".data", "v1"), { recursive: true });
      writeFileSync(join(cwd, artifact), validManualArtifactText());
      writeFileSync(
        evidenceFile,
        JSON.stringify({
          version: 1,
          gates: [
            {
              id: 11,
              verified_at: "2026-07-08T12:00:00Z",
              evidence: "ChatGPT connector acceptance passed.",
              artifact,
            },
          ],
        }),
      );

      const status = buildV1AcceptanceStatus(cwd);

      expect(status.evidence_file).toBe(evidenceFile);
      expect(status.summary.manual_or_live_evidence_recorded).toBe(1);
      expect(status.gates.find((gate) => gate.id === 11)).toMatchObject({
        status: "manual_or_live_evidence_recorded",
      });
    });
  });

  it("lets an explicit evidence file override the default path", () => {
    withTempProject((cwd) => {
      const artifact = ".data/v1/gate-11-chatgpt-ngrok.md";
      const defaultEvidenceFile = join(
        cwd,
        ".data",
        "v1-acceptance-evidence.json",
      );
      const explicitEvidenceFile = join(cwd, ".data", "custom-evidence.json");

      mkdirSync(join(cwd, ".data", "v1"), { recursive: true });
      writeFileSync(join(cwd, artifact), validManualArtifactText());
      writeFileSync(defaultEvidenceFile, "{not json");
      writeFileSync(
        explicitEvidenceFile,
        JSON.stringify({
          version: 1,
          gates: [
            {
              id: 11,
              verified_at: "2026-07-08T12:00:00Z",
              evidence: "Explicit evidence file passed.",
              artifact,
            },
          ],
        }),
      );

      const status = buildV1AcceptanceStatus({
        cwd,
        evidenceFile: explicitEvidenceFile,
      });

      expect(status.evidence_file).toBe(explicitEvidenceFile);
      expect(status.summary.manual_or_live_evidence_recorded).toBe(1);
      expect(status.gates.find((gate) => gate.id === 11)?.evidence).toContain(
        "Explicit evidence file passed.",
      );
    });
  });

  it("requires recorded evidence to include an artifact path", () => {
    withTempEvidenceFile(
      {
        version: 1,
        gates: [
          {
            id: 11,
            verified_at: "2026-07-08T12:00:00Z",
            evidence: "ChatGPT connector acceptance passed.",
          },
        ],
      },
      (evidenceFile) => {
        const status = buildV1AcceptanceStatus({
          cwd: projectRoot,
          evidenceFile,
        });
        const chatgptGate = status.gates.find((gate) => gate.id === 11);

        expect(status.summary.manual_or_live_evidence_recorded).toBe(0);
        expect(chatgptGate).toMatchObject({
          status: "manual_or_live_evidence_required",
        });
        expect(chatgptGate?.evidence).toContain("is missing an artifact path");
        expect(chatgptGate?.next_action).toContain(
          "re-record this gate with --artifact",
        );
      },
    );
  });

  it("rejects repo-local gate entries in hand-edited evidence files", () => {
    withTempEvidenceFile(
      {
        version: 1,
        gates: [
          {
            id: 3,
            verified_at: "2026-07-08T12:00:00Z",
            evidence: "MCP Inspector listed all seven tools.",
          },
        ],
      },
      (evidenceFile) => {
        expect(() =>
          buildV1AcceptanceStatus({ cwd: projectRoot, evidenceFile }),
        ).toThrow(
          "V1 evidence gate 3 is repo-local and cannot be recorded in the manual/live evidence file. Record one of: 7, 8, 9, 11, 12, 13, 14, 15, 16.",
        );
      },
    );
  });

  it("requires recorded evidence artifacts to remain available", () => {
    withTempEvidenceFile(
      {
        version: 1,
        gates: [
          {
            id: 11,
            verified_at: "2026-07-08T12:00:00Z",
            evidence: "ChatGPT connector acceptance passed.",
            artifact: ".data/v1/missing-chatgpt.md",
          },
        ],
      },
      (evidenceFile) => {
        const status = buildV1AcceptanceStatus({
          cwd: projectRoot,
          evidenceFile,
        });

        expect(status.summary.manual_or_live_evidence_recorded).toBe(0);
        expect(status.gates.find((gate) => gate.id === 11)).toMatchObject({
          status: "manual_or_live_evidence_required",
        });
        expect(status.gates.find((gate) => gate.id === 11)?.evidence).toContain(
          "Artifact is missing: .data/v1/missing-chatgpt.md",
        );
      },
    );
  });

  it("requires recorded evidence artifacts to be files", () => {
    const dataDir = resolve(projectRoot, ".data");
    mkdirSync(dataDir, { recursive: true });
    const artifactDir = mkdtempSync(join(dataDir, "v1-directory-artifact-"));

    try {
      withTempEvidenceFile(
        {
          version: 1,
          gates: [
            {
              id: 11,
              verified_at: "2026-07-08T12:00:00Z",
              evidence: "ChatGPT connector acceptance passed.",
              artifact: relative(projectRoot, artifactDir),
            },
          ],
        },
        (evidenceFile) => {
          const status = buildV1AcceptanceStatus({
            cwd: projectRoot,
            evidenceFile,
          });
          const chatgptGate = status.gates.find((gate) => gate.id === 11);

          expect(status.summary.manual_or_live_evidence_recorded).toBe(0);
          expect(chatgptGate).toMatchObject({
            status: "manual_or_live_evidence_required",
          });
          expect(chatgptGate?.evidence).toContain(
            `Evidence artifact is not a file: ${relative(projectRoot, artifactDir)}`,
          );
        },
      );
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  it("does not count future-dated recorded evidence", () => {
    withProjectArtifact("future-chatgpt.md", (artifact) => {
      const futureVerifiedAt = new Date(Date.now() + 3_600_000).toISOString();

      withTempEvidenceFile(
        {
          version: 1,
          gates: [
            {
              id: 11,
              verified_at: futureVerifiedAt,
              evidence: "ChatGPT connector acceptance passed.",
              artifact,
            },
          ],
        },
        (evidenceFile) => {
          const status = buildV1AcceptanceStatus({
            cwd: projectRoot,
            evidenceFile,
          });
          const chatgptGate = status.gates.find((gate) => gate.id === 11);

          expect(status.summary.manual_or_live_evidence_recorded).toBe(0);
          expect(chatgptGate).toMatchObject({
            status: "manual_or_live_evidence_required",
          });
          expect(chatgptGate?.evidence).toContain(
            `V1 evidence verified_at is in the future: ${futureVerifiedAt}.`,
          );
        },
      );
    });
  });

  it("does not count recorded evidence with unsafe text or artifacts", () => {
    withProjectArtifactContents(
      "unsafe-chatgpt.md",
      "cookie: connect.sid=secret",
      (artifact) => {
        withTempEvidenceFile(
          {
            version: 1,
            gates: [
              {
                id: 15,
                verified_at: "2026-07-08T12:00:00Z",
                evidence:
                  "Claude Code listed tools with Bearer abcdefghijklmnopqrstuvwxyz",
              },
              {
                id: 11,
                verified_at: "2026-07-08T12:01:00Z",
                evidence: "ChatGPT connector acceptance passed.",
                artifact,
              },
              {
                id: 14,
                verified_at: "2026-07-08T12:02:00Z",
                evidence: "Remote static bearer smoke passed.",
                command:
                  "curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz' https://example.com/mcp",
              },
              {
                id: 12,
                verified_at: "2026-07-08T12:03:00Z",
                evidence: "Cloud Run deployment passed at <cloud-run-host>.",
              },
              {
                id: 13,
                verified_at: "2026-07-08T12:04:00Z",
                evidence: "Cloud Run Secret Manager references passed.",
                command:
                  "npm run cloud-run:verify -- --service-json <service-json>",
              },
            ],
          },
          (evidenceFile) => {
            const status = buildV1AcceptanceStatus({
              cwd: projectRoot,
              evidenceFile,
            });
            const stdioGate = status.gates.find((gate) => gate.id === 15);
            const chatgptGate = status.gates.find((gate) => gate.id === 11);
            const staticBearerGate = status.gates.find(
              (gate) => gate.id === 14,
            );
            const cloudRunGate = status.gates.find((gate) => gate.id === 12);
            const cloudRunSecretsGate = status.gates.find(
              (gate) => gate.id === 13,
            );
            const rendered = renderV1AcceptanceStatus(status, "text");

            expect(status.summary.manual_or_live_evidence_recorded).toBe(0);
            expect(stdioGate).toMatchObject({
              status: "manual_or_live_evidence_required",
            });
            expect(stdioGate?.evidence).toContain(
              "V1 evidence summary contains secret-like content",
            );
            expect(chatgptGate?.evidence).toContain("V1 evidence artifact");
            expect(staticBearerGate?.evidence).toContain(
              "V1 evidence command contains secret-like content",
            );
            expect(cloudRunGate?.evidence).toContain(
              "V1 evidence summary contains unfilled placeholder text",
            );
            expect(cloudRunSecretsGate?.evidence).toContain(
              "V1 evidence command contains unfilled placeholder text",
            );
            expect(rendered).not.toContain("abcdefghijklmnopqrstuvwxyz");
            expect(rendered).not.toContain("connect.sid=secret");
          },
        );
      },
    );
  });

  it("does not count recorded evidence with draft-body artifact fields", () => {
    withProjectArtifactContents(
      "draft-body.md",
      '{"draft_body":{"type":"doc"}}',
      (artifact) => {
        withTempEvidenceFile(
          {
            version: 1,
            gates: [
              {
                id: 11,
                verified_at: "2026-07-08T12:00:00Z",
                evidence: "ChatGPT connector acceptance passed.",
                artifact,
              },
            ],
          },
          (evidenceFile) => {
            const status = buildV1AcceptanceStatus({
              cwd: projectRoot,
              evidenceFile,
            });

            expect(status.summary.manual_or_live_evidence_recorded).toBe(0);
            expect(
              status.gates.find((gate) => gate.id === 11)?.evidence,
            ).toContain(
              "Evidence artifact contains draft-body-like field draft_body",
            );
          },
        );
      },
    );
  });

  it("does not count recorded evidence that still points at an unfilled template", () => {
    const dataDir = resolve(projectRoot, ".data");
    mkdirSync(dataDir, { recursive: true });
    const artifactDir = mkdtempSync(join(dataDir, "v1-template-artifact-"));
    const checklistArtifact = relative(
      projectRoot,
      join(artifactDir, "unchecked.md"),
    );
    const placeholderArtifact = relative(
      projectRoot,
      join(artifactDir, "placeholder.md"),
    );

    try {
      writeFileSync(
        resolve(projectRoot, checklistArtifact),
        "- [ ] ChatGPT connector listed tools.\n",
      );
      writeFileSync(
        resolve(projectRoot, placeholderArtifact),
        "npm run v1:record -- --artifact <this file>\n",
      );

      withTempEvidenceFile(
        {
          version: 1,
          gates: [
            {
              id: 11,
              verified_at: "2026-07-08T12:00:00Z",
              evidence: "ChatGPT connector acceptance passed.",
              artifact: checklistArtifact,
            },
            {
              id: 14,
              verified_at: "2026-07-08T12:01:00Z",
              evidence: "Remote static bearer acceptance passed.",
              artifact: placeholderArtifact,
            },
          ],
        },
        (evidenceFile) => {
          const status = buildV1AcceptanceStatus({
            cwd: projectRoot,
            evidenceFile,
          });
          const chatgptGate = status.gates.find((gate) => gate.id === 11);
          const staticBearerGate = status.gates.find((gate) => gate.id === 14);

          expect(status.summary.manual_or_live_evidence_recorded).toBe(0);
          expect(chatgptGate).toMatchObject({
            status: "manual_or_live_evidence_required",
          });
          expect(chatgptGate?.evidence).toContain(
            `Evidence artifact contains unchecked checklist items: ${checklistArtifact}`,
          );
          expect(staticBearerGate?.evidence).toContain(
            `Evidence artifact contains unfilled placeholder text: ${placeholderArtifact}`,
          );
        },
      );
    } finally {
      rmSync(artifactDir, { recursive: true, force: true });
    }
  });

  it("does not count text evidence artifacts missing the gate detail section", () => {
    withProjectArtifactContents(
      "loose-chatgpt.md",
      "ChatGPT connector acceptance passed.\n",
      (artifact) => {
        withTempEvidenceFile(
          {
            version: 1,
            gates: [
              {
                id: 11,
                verified_at: "2026-07-08T12:00:00Z",
                evidence: "ChatGPT connector acceptance passed.",
                artifact,
              },
            ],
          },
          (evidenceFile) => {
            const status = buildV1AcceptanceStatus({
              cwd: projectRoot,
              evidenceFile,
            });
            const chatgptGate = status.gates.find((gate) => gate.id === 11);

            expect(status.summary.manual_or_live_evidence_recorded).toBe(0);
            expect(chatgptGate).toMatchObject({
              status: "manual_or_live_evidence_required",
            });
            expect(chatgptGate?.evidence).toContain(
              "Evidence artifact is missing a gate 11 detail section",
            );
          },
        );
      },
    );
  });

  it("records supplied manual evidence when the referenced artifact exists", () => {
    withProjectArtifact("chatgpt-acceptance.md", (artifact) => {
      withTempEvidenceFile(
        {
          version: 1,
          gates: [
            {
              id: 11,
              verified_at: "2026-07-08T12:00:00Z",
              evidence: "ChatGPT connector acceptance passed.",
              artifact,
            },
          ],
        },
        (evidenceFile) => {
          const status = buildV1AcceptanceStatus({
            cwd: projectRoot,
            evidenceFile,
          });

          expect(status.summary.manual_or_live_evidence_recorded).toBe(1);
          expect(status.gates.find((gate) => gate.id === 11)).toMatchObject({
            status: "manual_or_live_evidence_recorded",
          });
        },
      );
    });
  });

  it("rejects malformed manual evidence files", () => {
    withTempEvidenceFile(
      {
        version: 1,
      },
      (evidenceFile) => {
        expect(() =>
          buildV1AcceptanceStatus({ cwd: projectRoot, evidenceFile }),
        ).toThrow(
          "V1 evidence file must contain { version: 1, gates: [...] }.",
        );
      },
    );

    withTempEvidenceFile(
      {
        version: 1,
        gates: ["not an object"],
      },
      (evidenceFile) => {
        expect(() =>
          buildV1AcceptanceStatus({ cwd: projectRoot, evidenceFile }),
        ).toThrow("Each V1 evidence gate entry must be an object.");
      },
    );

    withTempEvidenceFile(
      {
        version: 1,
        gates: [
          {
            id: 18,
            verified_at: "2026-07-08T12:00:00Z",
            evidence: "Out of range gate.",
          },
        ],
      },
      (evidenceFile) => {
        expect(() =>
          buildV1AcceptanceStatus({ cwd: projectRoot, evidenceFile }),
        ).toThrow("V1 evidence gate id must be an integer from 1 to 17.");
      },
    );

    withTempEvidenceFile(
      {
        version: 1,
        gates: [
          {
            id: 3,
            verified_at: "2026-07-08T12:00:00Z",
            evidence: "",
          },
        ],
      },
      (evidenceFile) => {
        expect(() =>
          buildV1AcceptanceStatus({ cwd: projectRoot, evidenceFile }),
        ).toThrow("V1 evidence field evidence must be a non-empty string.");
      },
    );

    withTempEvidenceFile(
      {
        version: 1,
        gates: [
          {
            id: 3,
            verified_at: "not a date",
            evidence: "MCP Inspector listed all seven tools.",
          },
        ],
      },
      (evidenceFile) => {
        expect(() =>
          buildV1AcceptanceStatus({ cwd: projectRoot, evidenceFile }),
        ).toThrow("V1 evidence verified_at must be a parseable timestamp.");
      },
    );

    withTempEvidenceFile(
      {
        version: 1,
        gates: [
          {
            id: 11,
            verified_at: "2026-07-08T12:00:00Z",
            evidence: "first",
          },
          {
            id: 11,
            verified_at: "2026-07-08T12:01:00Z",
            evidence: "second",
          },
        ],
      },
      (evidenceFile) => {
        expect(() =>
          buildV1AcceptanceStatus({ cwd: projectRoot, evidenceFile }),
        ).toThrow("Duplicate V1 evidence entry for gate 11.");
      },
    );
  });
});

describe("renderV1AcceptanceStatus", () => {
  it("renders text and JSON status output", () => {
    const status = buildV1AcceptanceStatus(projectRoot);
    const text = renderV1AcceptanceStatus(status, "text");
    const json = JSON.parse(renderV1AcceptanceStatus(status, "json")) as {
      readonly complete: boolean;
      readonly gates: readonly unknown[];
    };

    expect(text).toContain("# V1 acceptance status");
    expect(text).toContain("Manual/live evidence required:");
    expect(text).toContain(
      "Live fixture readiness: no (0/4 present, 0/4 valid, 0/4 adapter-compatible)",
    );
    expect(text).toContain("Operator-supplied evidence files");
    expect(json.complete).toBe(false);
    expect(json.gates).toHaveLength(17);
  });

  it("fails only when completion is required and incomplete", () => {
    const status = buildV1AcceptanceStatus(projectRoot);

    expect(
      shouldFailV1AcceptanceStatus(status, { requireComplete: false }),
    ).toBe(false);
    expect(
      shouldFailV1AcceptanceStatus(status, { requireComplete: true }),
    ).toBe(true);
  });

  it("documents usage", () => {
    expect(v1AcceptanceStatusUsage()).toContain("npm run v1:status");
    expect(v1AcceptanceStatusUsage()).toContain("--evidence-file");
    expect(v1AcceptanceStatusUsage()).toContain(
      "Defaults to .data/v1-acceptance-evidence.json when it exists.",
    );
    expect(v1AcceptanceStatusUsage()).toContain("--fixture-dir");
    expect(v1AcceptanceStatusUsage()).toContain("--require-complete");
  });
});

function withTempProject(run: (cwd: string) => void): void {
  const tempRoot = mkdtempSync(join(tmpdir(), "substack-v1-status-"));
  const cwd = resolve(tempRoot, "repo");

  try {
    mkdirSync(cwd, { recursive: true });
    run(cwd);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function withTempEvidenceFile(
  contents: unknown,
  run: (evidenceFile: string) => void,
): void {
  const tempRoot = mkdtempSync(join(tmpdir(), "substack-v1-evidence-"));
  const evidenceFile = join(tempRoot, "evidence.json");

  try {
    writeFileSync(evidenceFile, JSON.stringify(contents));
    run(evidenceFile);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function withProjectArtifact(
  fileName: string,
  run: (artifactPath: string) => void,
): void {
  withProjectArtifactContents(fileName, validManualArtifactText(), run);
}

function withProjectArtifactContents(
  fileName: string,
  contents: string,
  run: (artifactPath: string) => void,
): void {
  const dataDir = resolve(projectRoot, ".data");
  mkdirSync(dataDir, { recursive: true });
  const artifactDir = mkdtempSync(join(dataDir, "v1-status-artifact-"));
  const artifactFile = join(artifactDir, fileName);

  try {
    writeFileSync(artifactFile, contents);
    run(relative(projectRoot, artifactFile));
  } finally {
    rmSync(artifactDir, { recursive: true, force: true });
  }
}

function validManualArtifactText(): string {
  return [
    "## Gate 7 Manual Review Details",
    "",
    "- Fixture directory: fixtures/substack",
    "- Fixture readiness command: npm run fixtures:status -- --require-all",
    "- Fixture compatibility command: npm test -- tests/content/substackFixtureCompatibility.test.ts",
    "- Fixture provenance review: captured from purpose-built live Substack drafts and manually reviewed in the editor",
    "- Draft URL or ID: https://example.substack.com/p/fixture",
    "- Title/subtitle review: title and subtitle matched the expected live fixture values",
    "- Text formatting review: formatting matched",
    "- Image rendering review: image rendered",
    "- Native code block rendering review: code block rendered",
    "- Native LaTeX rendering review: LaTeX rendered",
    "- Substack preview review: preview matched",
    "- Unpublished status review: draft stayed unpublished",
    "- Cleanup decision: kept private unpublished draft for further manual review without publishing",
    "",
    "## Gate 11 ChatGPT Connector Details",
    "",
    "- Connector URL: https://example.ngrok.app/mcp",
    "- ChatGPT surface tested: ChatGPT developer mode connector",
    "- Tool-list result: exactly seven V1 draft-only tools listed through the ChatGPT connector",
    "- Manual flow result: ChatGPT validate_newsletter_content and preview_draft succeeded, then create_draft created an unpublished draft after confirmation",
    "- Draft or review reference: non-sensitive screenshot reference from the ChatGPT connector draft review",
    "- Tunnel exposure window: bounded ngrok tunnel window from 2026-07-08T12:00:00Z to 2026-07-08T12:05:00Z",
    "- Unexpected traffic review: ngrok traffic logs reviewed; no unexpected traffic observed",
    "- Rotation decision: ngrok tunnel stopped after test; no rotation needed because no credential was exposed",
    "",
  ].join("\n");
}

function writeAllFixtureDocs(fixtureDir: string): void {
  mkdirSync(fixtureDir, { recursive: true });
  writeFileSync(
    join(fixtureDir, "inline-marks-draft-body.json"),
    JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Plain " },
            { type: "text", text: "bold", marks: [{ type: "strong" }] },
            { type: "text", text: " " },
            { type: "text", text: "italic", marks: [{ type: "em" }] },
            { type: "text", text: " " },
            { type: "text", text: "code", marks: [{ type: "code" }] },
            { type: "text", text: " " },
            {
              type: "text",
              text: "link",
              marks: [{ type: "link", attrs: { href: "https://example.com" } }],
            },
          ],
        },
      ],
    }),
  );
  writeFileSync(
    join(fixtureDir, "image-draft-body.json"),
    JSON.stringify({
      type: "doc",
      content: [
        {
          type: "captionedImage",
          content: [
            {
              type: "image2",
              attrs: {
                src: "https://example.com/image.png",
                imageSize: "normal",
                fullscreen: false,
                belowTheFold: false,
              },
            },
          ],
        },
      ],
    }),
  );
  writeFileSync(
    join(fixtureDir, "code-block-draft-body.json"),
    JSON.stringify({
      type: "doc",
      content: [
        {
          type: "code_block",
          attrs: { lang: "python" },
          content: [{ type: "text", text: "print('hello')" }],
        },
      ],
    }),
  );
  writeFileSync(
    join(fixtureDir, "latex-block-draft-body.json"),
    JSON.stringify({
      type: "doc",
      content: [
        {
          type: "math",
          attrs: { latex: "E = mc^2" },
        },
      ],
    }),
  );
}
