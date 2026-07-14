import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  type LiveSubstackEvidence,
  parseLiveSubstackEvidenceArtifacts,
  renderLiveSubstackEvidenceArtifact,
  resolveLiveSubstackEvidenceArtifact,
  writeLiveSubstackEvidenceArtifact,
  writeLiveSubstackEvidenceArtifacts,
} from "../../scripts/liveSubstackEvidence.js";

const baseEvidence: LiveSubstackEvidence = {
  verified_at: "2026-07-08T12:00:00Z",
  draft_id: 123,
  draft_url: "https://example.substack.com/p/123",
  created_title: "[MCP TEST] Rich draft",
  updated_title: "[MCP TEST] Rich draft updated",
  image_upload_verified: true,
  create_verified: true,
  list_verified: true,
  get_verified: true,
  update_verified: true,
  post_update_get_verified: true,
};

describe("renderLiveSubstackEvidenceArtifact", () => {
  it("renders sanitized live Substack metadata and manual review checklist", () => {
    const rendered = renderLiveSubstackEvidenceArtifact(baseEvidence);

    expect(rendered).toContain("# V1 Live Substack Draft Flow Evidence");
    expect(rendered).toContain("- Draft ID: 123");
    expect(rendered).toContain(
      "- [x] `upload_image` returned a hosted image URL.",
    );
    expect(rendered).toContain(
      "- [ ] Draft appears in the Substack dashboard.",
    );
    expect(rendered).toContain("- [ ] Draft remains unpublished in Substack.");
    expect(rendered).toContain(
      "- [ ] Text formatting renders correctly: headings, rich text, links, lists, blockquote, and horizontal rule.",
    );
    expect(rendered).toContain(
      "- [ ] Rich draft review confirmed native LaTeX rendering.",
    );
    expect(rendered).toContain(
      "- [ ] Substack preview opens and renders the draft correctly.",
    );
    expect(rendered).toContain("## Gate 7 Manual Review Details");
    expect(rendered).toContain("- Fixture directory: fixtures/substack");
    expect(rendered).toContain(
      "- Fixture readiness command: `npm run fixtures:status -- --require-all`",
    );
    expect(rendered).toContain(
      "- Fixture compatibility command: `npm test -- tests/content/substackFixtureCompatibility.test.ts`",
    );
    expect(rendered).toContain("- Fixture provenance review:");
    expect(rendered).toContain(
      "- Draft URL or ID: https://example.substack.com/p/123",
    );
    expect(rendered).toContain("- Native code block rendering review:");
    expect(rendered).toContain("- Native LaTeX rendering review:");
    expect(rendered).toContain("## Gate 8 Update Review Details");
    expect(rendered).toContain(
      "- Draft URL or ID: https://example.substack.com/p/123",
    );
    expect(rendered).toContain(
      "- Created title before update: [MCP TEST] Rich draft",
    );
    expect(rendered).toContain(
      "- Updated title after update: [MCP TEST] Rich draft updated",
    );
    expect(rendered).toContain("- Post-update `get_draft` review:");
    expect(rendered).toContain("- Draft body handling review:");
    expect(rendered).toContain("## Gate 9 Read Review Details");
    expect(rendered).toContain(
      "- Draft URL or ID read: https://example.substack.com/p/123",
    );
    expect(rendered).toContain("- `list_drafts` result:");
    expect(rendered).toContain("- Body inclusion review:");
    expect(rendered).toContain("- Raw body/content handling:");
    expect(rendered).not.toContain("documented the current fallback");
    expect(rendered).toContain("npm run v1:record -- --gate 7");
    expect(rendered).toContain("npm run v1:record -- --gate 8");
    expect(rendered).toContain("npm run v1:record -- --gate 9");
    expect(rendered).toContain("npm run fixtures:status -- --require-all");
    expect(rendered).toContain(
      "npm test -- tests/content/substackFixtureCompatibility.test.ts",
    );
    expect(rendered).toContain("V1_LIVE_SUBSTACK_EVIDENCE_ARTIFACTS=");
    expect(rendered).not.toContain("draft_body");
    expect(rendered).not.toContain("body_markdown");
    expect(rendered).not.toContain("SUBSTACK_SESSION_TOKEN=");
  });

  it("renders failed automated checks as unchecked boxes", () => {
    const rendered = renderLiveSubstackEvidenceArtifact({
      ...baseEvidence,
      list_verified: false,
    });

    expect(rendered).toContain("- [ ] `list_drafts` found the created draft.");
  });

  it("renders missing draft URLs without leaking placeholders", () => {
    const rendered = renderLiveSubstackEvidenceArtifact({
      ...baseEvidence,
      draft_url: undefined,
    });

    expect(rendered).toContain("- Draft URL: not returned");
    expect(rendered).toContain("- Draft URL or ID: 123");
    expect(rendered).toContain("- Draft URL or ID read: 123");
    expect(rendered).not.toContain("<draft");
  });
});

describe("writeLiveSubstackEvidenceArtifact", () => {
  it("parses singular and plural artifact env vars with deduping", () => {
    expect(parseLiveSubstackEvidenceArtifacts({})).toEqual([]);
    expect(
      parseLiveSubstackEvidenceArtifacts({
        V1_LIVE_SUBSTACK_EVIDENCE_ARTIFACT:
          ".data/v1/gate-07-rich-draft-live-fixtures.md",
        V1_LIVE_SUBSTACK_EVIDENCE_ARTIFACTS:
          ".data/v1/gate-08-update-draft-live.md,\n.data/v1/gate-09-read-drafts-live.md, .data/v1/gate-08-update-draft-live.md",
      }),
    ).toEqual([
      ".data/v1/gate-07-rich-draft-live-fixtures.md",
      ".data/v1/gate-08-update-draft-live.md",
      ".data/v1/gate-09-read-drafts-live.md",
    ]);
  });

  it("writes a project-local artifact", () => {
    withTempProject((cwd) => {
      const result = writeLiveSubstackEvidenceArtifact({
        cwd,
        artifact: ".data/v1/live-substack.md",
        evidence: baseEvidence,
      });

      expect(result.artifact).toBe(".data/v1/live-substack.md");
      expect(existsSync(result.path)).toBe(true);
      const artifact = readFileSync(result.path, "utf8");

      expect(artifact).toContain("V1 Live Substack Draft Flow Evidence");
      expect(artifact).toContain("--artifact .data/v1/live-substack.md");
      expect(artifact).toContain(
        "V1_LIVE_SUBSTACK_EVIDENCE_ARTIFACT=.data/v1/live-substack.md",
      );
      expect(artifact).not.toContain("<this file>");
      expect(artifact).not.toContain("<gate 7,8,9 files>");
    });
  });

  it("writes multiple project-local artifacts from one live evidence payload", () => {
    withTempProject((cwd) => {
      const result = writeLiveSubstackEvidenceArtifacts({
        cwd,
        artifacts: [
          ".data/v1/gate-07-rich-draft-live-fixtures.md",
          ".data/v1/gate-08-update-draft-live.md",
          ".data/v1/gate-09-read-drafts-live.md",
        ],
        evidence: baseEvidence,
      });

      expect(result.map((artifact) => artifact.artifact)).toEqual([
        ".data/v1/gate-07-rich-draft-live-fixtures.md",
        ".data/v1/gate-08-update-draft-live.md",
        ".data/v1/gate-09-read-drafts-live.md",
      ]);
      for (const artifact of result) {
        const markdown = readFileSync(artifact.path, "utf8");

        expect(markdown).toContain("V1 Live Substack Draft Flow Evidence");
        expect(markdown).toContain(
          "V1_LIVE_SUBSTACK_EVIDENCE_ARTIFACTS=.data/v1/gate-07-rich-draft-live-fixtures.md,.data/v1/gate-08-update-draft-live.md,.data/v1/gate-09-read-drafts-live.md",
        );
        expect(markdown).toContain(
          "--gate 7 --evidence 'Live rich draft flow passed, fixtures were adapter-compatible, and manual formatting review completed'",
        );
        expect(markdown).toContain(
          "npm run fixtures:status -- --require-all; npm test -- tests/content/substackFixtureCompatibility.test.ts; V1_LIVE_SUBSTACK_EVIDENCE_ARTIFACTS=",
        );
        expect(markdown).toContain(
          "--artifact .data/v1/gate-07-rich-draft-live-fixtures.md",
        );
        expect(markdown).toContain(
          "--gate 8 --evidence 'Live update_draft flow updated an unpublished draft'",
        );
        expect(markdown).toContain(
          "--artifact .data/v1/gate-08-update-draft-live.md",
        );
        expect(markdown).toContain(
          "--gate 9 --evidence 'Live list_drafts and get_draft flow read the expected draft'",
        );
        expect(markdown).toContain(
          "--artifact .data/v1/gate-09-read-drafts-live.md",
        );
        expect(markdown).not.toContain("<this file>");
      }
    });
  });

  it("preserves a project-local live fixture directory in gate 7 commands", () => {
    withTempProject((cwd) => {
      const result = writeLiveSubstackEvidenceArtifacts({
        cwd,
        artifacts: [
          ".data/v1/gate-07-rich-draft-live-fixtures.md",
          ".data/v1/gate-08-update-draft-live.md",
          ".data/v1/gate-09-read-drafts-live.md",
        ],
        fixtureDir: join(cwd, "fixtures", "live"),
        evidence: baseEvidence,
      });
      const firstArtifact = result[0];
      if (!firstArtifact) {
        throw new Error("Expected at least one live evidence artifact.");
      }

      const markdown = readFileSync(firstArtifact.path, "utf8");

      expect(markdown).toContain(
        "npm run fixtures:status -- --fixture-dir fixtures/live --require-all; SUBSTACK_FIXTURE_DIR=fixtures/live npm test -- tests/content/substackFixtureCompatibility.test.ts",
      );
      expect(markdown).toContain("- Fixture directory: fixtures/live");
      expect(markdown).toContain(
        "- Fixture readiness command: `npm run fixtures:status -- --fixture-dir fixtures/live --require-all`",
      );
      expect(markdown).toContain(
        "- Fixture compatibility command: `SUBSTACK_FIXTURE_DIR=fixtures/live npm test -- tests/content/substackFixtureCompatibility.test.ts`",
      );
    });
  });

  it("maps unnamed multi-artifact paths to gates in order", () => {
    withTempProject((cwd) => {
      const result = writeLiveSubstackEvidenceArtifacts({
        cwd,
        artifacts: [
          ".data/v1/rich.md",
          ".data/v1/update.md",
          ".data/v1/read.md",
        ],
        evidence: baseEvidence,
      });
      const firstArtifact = result[0];
      if (!firstArtifact) {
        throw new Error("Expected at least one live evidence artifact.");
      }
      const markdown = readFileSync(firstArtifact.path, "utf8");

      expect(markdown).toContain("--gate 7");
      expect(markdown).toContain("--artifact .data/v1/rich.md");
      expect(markdown).toContain("--gate 8");
      expect(markdown).toContain("--artifact .data/v1/update.md");
      expect(markdown).toContain("--gate 9");
      expect(markdown).toContain("--artifact .data/v1/read.md");
    });
  });

  it("falls back to default gate artifacts when plural mappings are incomplete", () => {
    withTempProject((cwd) => {
      const gate8And9 = writeLiveSubstackEvidenceArtifacts({
        cwd,
        artifacts: [
          ".data/v1/case-a/gate-08-update-draft-live.md",
          ".data/v1/case-a/gate-09-read-drafts-live.md",
        ],
        evidence: baseEvidence,
      });
      const gate7And9 = writeLiveSubstackEvidenceArtifacts({
        cwd,
        artifacts: [
          ".data/v1/case-b/gate-07-rich-draft-live-fixtures.md",
          ".data/v1/case-b/gate-09-read-drafts-live.md",
        ],
        evidence: baseEvidence,
      });
      const gate7And8 = writeLiveSubstackEvidenceArtifacts({
        cwd,
        artifacts: [
          ".data/v1/case-c/gate-07-rich-draft-live-fixtures.md",
          ".data/v1/case-c/gate-08-update-draft-live.md",
        ],
        evidence: baseEvidence,
      });
      const mixedNamedAndUnnamed = writeLiveSubstackEvidenceArtifacts({
        cwd,
        artifacts: [
          ".data/v1/case-d/gate-08-update-draft-live.md",
          ".data/v1/case-d/rich.md",
        ],
        evidence: baseEvidence,
      });
      const first = gate8And9[0];
      const second = gate7And9[0];
      const third = gate7And8[0];
      const mixed = mixedNamedAndUnnamed[0];
      if (!first || !second || !third || !mixed) {
        throw new Error("Expected live evidence artifacts.");
      }

      expect(readFileSync(first.path, "utf8")).toContain(
        "--artifact .data/v1/gate-07-rich-draft-live-fixtures.md",
      );
      expect(readFileSync(second.path, "utf8")).toContain(
        "--artifact .data/v1/gate-08-update-draft-live.md",
      );
      expect(readFileSync(third.path, "utf8")).toContain(
        "--artifact .data/v1/gate-09-read-drafts-live.md",
      );
      expect(readFileSync(mixed.path, "utf8")).toContain(
        "--artifact .data/v1/case-d/rich.md",
      );
    });
  });

  it("rejects paths outside the project", () => {
    withTempProject((cwd) => {
      expect(
        resolveLiveSubstackEvidenceArtifact(
          cwd,
          join(cwd, ".data", "v1", "live-substack.md"),
        ),
      ).toMatchObject({
        artifact: ".data/v1/live-substack.md",
      });
      expect(() =>
        writeLiveSubstackEvidenceArtifact({
          cwd,
          artifact: "../outside.md",
          evidence: baseEvidence,
        }),
      ).toThrow(
        "V1 live evidence artifact must stay inside the project directory.",
      );
    });
  });

  it("rejects live fixture directories outside the project", () => {
    withTempProject((cwd) => {
      expect(() =>
        writeLiveSubstackEvidenceArtifacts({
          cwd,
          artifacts: [".data/v1/gate-07-rich-draft-live-fixtures.md"],
          fixtureDir: "../fixtures-live",
          evidence: baseEvidence,
        }),
      ).toThrow(
        "V1 live fixture directory must stay inside the project directory.",
      );
    });
  });

  it("rejects secret-like rendered content before writing", () => {
    withTempProject((cwd) => {
      expect(() =>
        writeLiveSubstackEvidenceArtifact({
          cwd,
          artifact: ".data/v1/live-substack.md",
          evidence: {
            ...baseEvidence,
            updated_title: "Authorization: Bearer abcdefghijklmnop",
          },
        }),
      ).toThrow(
        "V1 evidence artifact .data/v1/live-substack.md contains secret-like content",
      );
    });
  });
});

function withTempProject(run: (cwd: string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), "live-substack-evidence-"));
  try {
    run(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
