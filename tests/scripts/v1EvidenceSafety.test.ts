import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  requiredRemoteOAuthLaunchChecklistLabels,
  scanEvidenceArtifactText,
} from "../../scripts/v1EvidenceSafety.js";

const acceptedGateHeadings: ReadonlyArray<{
  readonly gateId: number;
  readonly headings: readonly string[];
}> = [
  {
    gateId: 7,
    headings: ["## Gate 7 Manual Review Details", "## Manual Review Checklist"],
  },
  { gateId: 8, headings: ["## Gate 8 Update Review Details"] },
  { gateId: 9, headings: ["## Gate 9 Read Review Details"] },
  {
    gateId: 11,
    headings: [
      "## Gate 11 ChatGPT Connector Details",
      "## Manual ChatGPT Connector Acceptance",
    ],
  },
  {
    gateId: 12,
    headings: [
      "## Gate 12 Cloud Run Deployment Details",
      "## Gate 12 Deployment Review Details",
    ],
  },
  {
    gateId: 13,
    headings: [
      "## Gate 13 Secret Manager Details",
      "## Gate 13 Secret Manager Review Details",
    ],
  },
  {
    gateId: 14,
    headings: [
      "## Gate 14 Header-Capable Client Details",
      "## Manual Header-Capable Client Acceptance",
    ],
  },
  {
    gateId: 15,
    headings: [
      "## Gate 15 Manual Client Details",
      "## Manual Client Acceptance",
    ],
  },
  {
    gateId: 16,
    headings: [
      "## Gate 16 Cloud Run Log Review Details",
      "## Manual Log Review Details",
    ],
  },
];

describe("scanEvidenceArtifactText gate structure", () => {
  it.each(
    acceptedGateHeadings.flatMap(({ gateId, headings }) =>
      headings.map((heading) => ({ gateId, heading })),
    ),
  )("accepts $heading for gate $gateId", ({ gateId, heading }) => {
    withTextArtifact(completedGateArtifactText(gateId, heading), (path) => {
      expect(
        scanEvidenceArtifactText(path, ".data/v1/evidence.md", gateId),
      ).toBeUndefined();
    });
  });

  it("rejects a known manual gate text artifact without its detail section", () => {
    withTextArtifact("Completed evidence.\n", (path) => {
      expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 11)).toBe(
        "Evidence artifact is missing a gate 11 detail section (## Gate 11 ChatGPT Connector Details or ## Manual ChatGPT Connector Acceptance): .data/v1/evidence.md.",
      );
    });
  });

  it("does not require gate structure when no manual gate is supplied", () => {
    withTextArtifact("Completed evidence.\n", (path) => {
      expect(
        scanEvidenceArtifactText(path, ".data/v1/evidence.md"),
      ).toBeUndefined();
      expect(
        scanEvidenceArtifactText(path, ".data/v1/evidence.md", 99),
      ).toBeUndefined();
    });
  });

  it("rejects manual gate artifacts with missing or empty detail fields", () => {
    withTextArtifact(
      [
        "## Gate 11 ChatGPT Connector Details",
        "",
        "- Connector URL: https://example.ngrok.app/mcp",
      ].join("\n"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 11)).toBe(
          "Evidence artifact is missing gate 11 detail field ChatGPT surface tested: .data/v1/evidence.md.",
        );
      },
    );

    withTextArtifact(
      [
        "## Gate 14 Header-Capable Client Details",
        "",
        "- Client tested: Claude Code 1.2.3",
        "- Endpoint tested:",
        "- Header configuration method: env header interpolation",
        "- Tool-list result: seven tools listed",
        "- Validation call result: validate_newsletter_content ok",
        "- Rejection proof: missing bearer returned 401",
        "- Token redaction review: no token value recorded",
      ].join("\n"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 14)).toBe(
          "Evidence artifact has empty gate 14 detail field Endpoint tested: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 7 live fixture evidence without fixture provenance review", () => {
    withTextArtifact(
      [
        "## Gate 7 Manual Review Details",
        "",
        "- Fixture directory: fixtures/substack",
        "- Fixture readiness command: npm run fixtures:status -- --require-all",
        "- Fixture compatibility command: npm test -- tests/content/substackFixtureCompatibility.test.ts",
        "- Draft URL or ID: https://example.substack.com/p/fixture",
        "- Title/subtitle review: title and subtitle matched expected fixture values",
        "- Text formatting review: completed",
        "- Image rendering review: completed",
        "- Native code block rendering review: completed",
        "- Native LaTeX rendering review: completed",
        "- Substack preview review: completed",
        "- Unpublished status review: completed",
        "- Cleanup decision: kept private draft for review",
      ].join("\n"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 7)).toBe(
          "Evidence artifact is missing gate 7 detail field Fixture provenance review: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 7 live fixture evidence that copies dry-run provenance", () => {
    withTextArtifact(
      [
        "## Gate 7 Manual Review Details",
        "",
        "- Fixture directory: fixtures/substack",
        "- Fixture readiness command: npm run fixtures:status -- --require-all",
        "- Fixture compatibility command: npm test -- tests/content/substackFixtureCompatibility.test.ts",
        "- Fixture provenance review: Dry run only; no live Substack fixture was created or captured.",
        "- Draft URL or ID: https://example.substack.com/p/fixture",
        "- Title/subtitle review: title and subtitle matched expected fixture values",
        "- Text formatting review: completed",
        "- Image rendering review: completed",
        "- Native code block rendering review: completed",
        "- Native LaTeX rendering review: completed",
        "- Substack preview review: completed",
        "- Unpublished status review: completed",
        "- Cleanup decision: kept private draft for review",
      ].join("\n"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 7)).toBe(
          "Gate 7 fixture provenance review describes dry-run output instead of live fixture capture or live editor review; run create:fixture with --kind all --capture or inspect live drafts before recording gate 7: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 7 evidence without require-all fixture readiness", () => {
    withTextArtifact(
      gate7EvidenceWithDetailOverride(
        "Fixture readiness command",
        "npm run fixtures:status",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 7)).toBe(
          "Gate 7 Fixture readiness command field must show fixtures:status ran with --require-all for the live fixture directory: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 7 evidence without fixture compatibility test command", () => {
    withTextArtifact(
      gate7EvidenceWithDetailOverride(
        "Fixture compatibility command",
        "npm test completed",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 7)).toBe(
          "Gate 7 Fixture compatibility command field must show the Substack fixture compatibility test command: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 7 evidence without a live draft reference", () => {
    withTextArtifact(
      gate7EvidenceWithDetailOverride(
        "Draft URL or ID",
        "local smoke artifact only",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 7)).toBe(
          "Gate 7 Draft URL or ID field must include a Substack draft URL or numeric draft ID from the live acceptance draft: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 7 evidence without title and subtitle review", () => {
    withTextArtifact(
      gate7EvidenceWithDetailOverride("Title/subtitle review", "completed"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 7)).toBe(
          "Gate 7 Title/subtitle review field must confirm the live draft title and subtitle matched the expected fixture values, or that no subtitle was expected: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 7 evidence without cleanup decision", () => {
    withTextArtifact(
      gate7EvidenceWithDetailOverride("Cleanup decision", "decision pending"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 7)).toBe(
          "Gate 7 Cleanup decision field must record whether the live draft was kept, deleted, or left for further review, with no publish action: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 7 evidence that does not confirm the created item remained unpublished", () => {
    withTextArtifact(
      [
        "## Gate 7 Manual Review Details",
        "",
        "- Fixture directory: fixtures/substack",
        "- Fixture readiness command: npm run fixtures:status -- --require-all",
        "- Fixture compatibility command: npm test -- tests/content/substackFixtureCompatibility.test.ts",
        "- Fixture provenance review: captured from purpose-built live Substack drafts and manually reviewed in the editor",
        "- Draft URL or ID: https://example.substack.com/p/fixture",
        "- Title/subtitle review: title and subtitle matched expected fixture values",
        "- Text formatting review: completed",
        "- Image rendering review: completed",
        "- Native code block rendering review: completed",
        "- Native LaTeX rendering review: completed",
        "- Substack preview review: completed",
        "- Unpublished status review: post was public in the dashboard",
        "- Cleanup decision: kept private draft for review",
      ].join("\n"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 7)).toBe(
          "Gate 7 Unpublished status review field must confirm the Substack item remained unpublished; published/public status evidence does not satisfy gate 7: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects contradictory gate 7 draft status wording", () => {
    withTextArtifact(
      [
        "## Gate 7 Manual Review Details",
        "",
        "- Fixture directory: fixtures/substack",
        "- Fixture readiness command: npm run fixtures:status -- --require-all",
        "- Fixture compatibility command: npm test -- tests/content/substackFixtureCompatibility.test.ts",
        "- Fixture provenance review: captured from purpose-built live Substack drafts and manually reviewed in the editor",
        "- Draft URL or ID: https://example.substack.com/p/fixture",
        "- Title/subtitle review: title and subtitle matched expected fixture values",
        "- Text formatting review: completed",
        "- Image rendering review: completed",
        "- Native code block rendering review: completed",
        "- Native LaTeX rendering review: completed",
        "- Substack preview review: completed",
        "- Unpublished status review: not a draft; reviewed the published draft URL",
        "- Cleanup decision: kept private draft for review",
      ].join("\n"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 7)).toBe(
          "Gate 7 Unpublished status review field must confirm the Substack item remained unpublished; published/public status evidence does not satisfy gate 7: .data/v1/evidence.md.",
        );
      },
    );
  });

  it.each([
    {
      field: "Text formatting review",
      value: "formatting failed; lists rendered as raw markdown",
      expected:
        "Gate 7 Text formatting review field must confirm successful Substack text formatting; vague, failed, missing, fallback, raw, or plain-output evidence does not satisfy gate 7: .data/v1/evidence.md.",
    },
    {
      field: "Image rendering review",
      value: "image appeared as a plain URL instead of rendering",
      expected:
        "Gate 7 Image rendering review field must confirm successful uploaded image rendering; vague, failed, missing, fallback, raw, or plain-output evidence does not satisfy gate 7: .data/v1/evidence.md.",
    },
    {
      field: "Native code block rendering review",
      value: "code block rendered as a plain paragraph, not native",
      expected:
        "Gate 7 Native code block rendering review field must confirm successful native code block rendering; vague, failed, missing, fallback, raw, or plain-output evidence does not satisfy gate 7: .data/v1/evidence.md.",
    },
    {
      field: "Native LaTeX rendering review",
      value: "LaTeX rendered as raw latex plain text",
      expected:
        "Gate 7 Native LaTeX rendering review field must confirm successful native LaTeX equation rendering; vague, failed, missing, fallback, raw, or plain-output evidence does not satisfy gate 7: .data/v1/evidence.md.",
    },
    {
      field: "Substack preview review",
      value: "preview was not opened",
      expected:
        "Gate 7 Substack preview review field must confirm successful Substack preview review; vague, failed, missing, fallback, raw, or plain-output evidence does not satisfy gate 7: .data/v1/evidence.md.",
    },
  ])("rejects gate 7 evidence whose $field reports failed rich rendering", ({
    field,
    value,
    expected,
  }) => {
    withTextArtifact(
      [
        "## Gate 7 Manual Review Details",
        "",
        ...completedGateDetailLines(7).map((line) =>
          line.startsWith(`- ${field}:`) ? `- ${field}: ${value}` : line,
        ),
      ].join("\n"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 7)).toBe(
          expected,
        );
      },
    );
  });

  it("rejects vague gate 7 rich-rendering review evidence", () => {
    withTextArtifact(
      gate7EvidenceWithDetailOverride("Text formatting review", "completed"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 7)).toBe(
          "Gate 7 Text formatting review field must confirm successful Substack text formatting; vague, failed, missing, fallback, raw, or plain-output evidence does not satisfy gate 7: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 8 evidence that does not confirm the updated item remained unpublished", () => {
    withTextArtifact(
      [
        "## Gate 8 Update Review Details",
        "",
        "- Draft URL or ID: https://example.substack.com/p/fixture",
        "- Created title before update: Before",
        "- Updated title after update: After",
        "- Update command: RUN_LIVE_SUBSTACK_TESTS=1 npm run test:live",
        "- Field update review: title and subtitle changed",
        "- Unpublished status after update: post was live after update",
        "- Post-update `get_draft` review: updated metadata read back",
        "- Draft body handling review: no raw draft body recorded",
        "- Cleanup decision: kept private draft for review",
      ].join("\n"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 8)).toBe(
          "Gate 8 Unpublished status after update field must confirm the Substack item remained unpublished; published/public status evidence does not satisfy gate 8: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 8 evidence without a live updated draft reference", () => {
    withTextArtifact(
      gate8EvidenceWithDetailOverride(
        "Draft URL or ID",
        "local smoke artifact only",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 8)).toBe(
          "Gate 8 Draft URL or ID field must include a Substack draft URL or numeric draft ID from the live updated draft: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 8 evidence whose title did not change", () => {
    withTextArtifact(
      [
        "## Gate 8 Update Review Details",
        "",
        ...completedGateDetailLines(8).map((line) =>
          line.startsWith("- Updated title after update:")
            ? "- Updated title after update: Original live fixture title"
            : line,
        ),
      ].join("\n"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 8)).toBe(
          "Gate 8 title fields must show a changed draft title before and after update; unchanged title evidence does not satisfy gate 8: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 8 evidence without a live update command", () => {
    withTextArtifact(
      gate8EvidenceWithDetailOverride("Update command", "npm test completed"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 8)).toBe(
          "Gate 8 Update command field must identify the guarded live update run or an explicit live update_draft MCP/client workflow; smoke-only, dry-run, mock, or generic test evidence does not satisfy gate 8: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 8 evidence whose field update failed", () => {
    withTextArtifact(
      [
        "## Gate 8 Update Review Details",
        "",
        ...completedGateDetailLines(8).map((line) =>
          line.startsWith("- Field update review:")
            ? "- Field update review: update failed and title was not changed"
            : line,
        ),
      ].join("\n"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 8)).toBe(
          "Gate 8 Field update review field must confirm at least one draft field changed successfully; failed, missing, or no-change evidence does not satisfy gate 8: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 8 evidence without post-update readback", () => {
    withTextArtifact(
      [
        "## Gate 8 Update Review Details",
        "",
        ...completedGateDetailLines(8).map((line) =>
          line.startsWith("- Post-update `get_draft` review:")
            ? "- Post-update `get_draft` review: get_draft was not fetched after update"
            : line,
        ),
      ].join("\n"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 8)).toBe(
          "Gate 8 Post-update `get_draft` review field must confirm the updated draft was read back after the update; missing or stale readback evidence does not satisfy gate 8: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 8 evidence that records raw draft body content", () => {
    withTextArtifact(
      [
        "## Gate 8 Update Review Details",
        "",
        ...completedGateDetailLines(8).map((line) =>
          line.startsWith("- Draft body handling review:")
            ? "- Draft body handling review: full raw draft content was copied into the notes"
            : line,
        ),
      ].join("\n"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 8)).toBe(
          "Gate 8 Draft body handling review field must confirm raw draft body/content was omitted, redacted, metadata-only, or otherwise not recorded in evidence: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects contradictory gate 8 raw body handling evidence", () => {
    withTextArtifact(
      [
        "## Gate 8 Update Review Details",
        "",
        ...completedGateDetailLines(8).map((line) =>
          line.startsWith("- Draft body handling review:")
            ? "- Draft body handling review: raw draft body/content omitted from evidence, but full raw content was copied into appendix notes"
            : line,
        ),
      ].join("\n"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 8)).toBe(
          "Gate 8 Draft body handling review field must confirm raw draft body/content was omitted, redacted, metadata-only, or otherwise not recorded in evidence: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 8 evidence without cleanup decision", () => {
    withTextArtifact(
      gate8EvidenceWithDetailOverride("Cleanup decision", "decision pending"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 8)).toBe(
          "Gate 8 Cleanup decision field must record whether the live draft was kept, deleted, or left for further review, with no publish action: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("accepts gate 8 evidence from an explicit live update_draft client workflow", () => {
    withTextArtifact(
      gate8EvidenceWithDetailOverride(
        "Update command",
        "Manual live MCP client workflow called update_draft against the Substack draft",
      ),
      (path) => {
        expect(
          scanEvidenceArtifactText(path, ".data/v1/evidence.md", 8),
        ).toBeUndefined();
      },
    );
  });

  it("accepts explicit gate 8 unpublished status flags", () => {
    withTextArtifact(
      [
        "## Gate 8 Update Review Details",
        "",
        "- Draft URL or ID: https://example.substack.com/p/fixture",
        "- Created title before update: Before",
        "- Updated title after update: After",
        "- Update command: RUN_LIVE_SUBSTACK_TESTS=1 npm run test:live",
        "- Field update review: title and subtitle changed",
        "- Unpublished status after update: status=draft and is_published=false after update",
        "- Post-update `get_draft` review: updated metadata read back",
        "- Draft body handling review: no raw draft body recorded",
        "- Cleanup decision: kept private draft for review",
      ].join("\n"),
      (path) => {
        expect(
          scanEvidenceArtifactText(path, ".data/v1/evidence.md", 8),
        ).toBeUndefined();
      },
    );
  });

  it("rejects gate 9 read evidence without a live draft reference", () => {
    withTextArtifact(
      gate9EvidenceWithDetailOverride(
        "Draft URL or ID read",
        "local smoke artifact only",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 9)).toBe(
          "Gate 9 Draft URL or ID read field must include a Substack draft URL or numeric draft ID from the live read flow: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 9 read evidence that does not confirm raw body/content was kept out of evidence", () => {
    withTextArtifact(
      [
        "## Gate 9 Read Review Details",
        "",
        "- Draft URL or ID read: https://example.substack.com/p/fixture",
        "- `list_drafts` result: expected draft appeared in the list",
        "- `get_draft` result: expected draft metadata returned",
        "- Metadata fields reviewed: id, title, url, status",
        "- Body inclusion review: include_body remained false",
        "- Post-update readback review: post-update get_draft readback confirmed updated title was visible",
        "- Raw body/content handling: full draft content was copied into review notes",
        "- Follow-up action: no follow-up",
      ].join("\n"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 9)).toBe(
          "Gate 9 Raw body/content handling field must confirm raw draft body/content was omitted, redacted, metadata-only, or otherwise not recorded in evidence: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects contradictory gate 9 raw body handling evidence", () => {
    withTextArtifact(
      [
        "## Gate 9 Read Review Details",
        "",
        ...completedGateDetailLines(9).map((line) =>
          line.startsWith("- Raw body/content handling:")
            ? "- Raw body/content handling: raw draft body/content omitted from evidence, but full draft body content was pasted into review notes"
            : line,
        ),
      ].join("\n"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 9)).toBe(
          "Gate 9 Raw body/content handling field must confirm raw draft body/content was omitted, redacted, metadata-only, or otherwise not recorded in evidence: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 9 evidence when list_drafts did not find the draft", () => {
    withTextArtifact(
      [
        "## Gate 9 Read Review Details",
        "",
        ...completedGateDetailLines(9).map((line) =>
          line.startsWith("- `list_drafts` result:")
            ? "- `list_drafts` result: list_drafts returned an empty result and the draft was not found"
            : line,
        ),
      ].join("\n"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 9)).toBe(
          "Gate 9 `list_drafts` result field must confirm the expected draft was listed, found, returned, included, or present: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 9 evidence when get_draft did not return draft metadata", () => {
    withTextArtifact(
      [
        "## Gate 9 Read Review Details",
        "",
        ...completedGateDetailLines(9).map((line) =>
          line.startsWith("- `get_draft` result:")
            ? "- `get_draft` result: get_draft failed with missing draft metadata"
            : line,
        ),
      ].join("\n"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 9)).toBe(
          "Gate 9 `get_draft` result field must confirm the expected draft metadata was fetched, read, returned, verified, or confirmed: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 9 evidence without core metadata fields", () => {
    withTextArtifact(
      [
        "## Gate 9 Read Review Details",
        "",
        ...completedGateDetailLines(9).map((line) =>
          line.startsWith("- Metadata fields reviewed:")
            ? "- Metadata fields reviewed: title only"
            : line,
        ),
      ].join("\n"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 9)).toBe(
          "Gate 9 Metadata fields reviewed field must name id, title, and url or status metadata: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 9 evidence that requested body inclusion", () => {
    withTextArtifact(
      [
        "## Gate 9 Read Review Details",
        "",
        ...completedGateDetailLines(9).map((line) =>
          line.startsWith("- Body inclusion review:")
            ? "- Body inclusion review: include_body=true returned the full body"
            : line,
        ),
      ].join("\n"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 9)).toBe(
          "Gate 9 Body inclusion review field must confirm draft body/content was not requested, not included, omitted, or metadata-only: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 9 evidence without post-update readback", () => {
    withTextArtifact(
      [
        "## Gate 9 Read Review Details",
        "",
        ...completedGateDetailLines(9).map((line) =>
          line.startsWith("- Post-update readback review:")
            ? "- Post-update readback review: post-update readback was skipped"
            : line,
        ),
      ].join("\n"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 9)).toBe(
          "Gate 9 Post-update readback review field must confirm the updated draft was read back after the update; missing or stale readback evidence does not satisfy gate 9: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 9 evidence without a reasoned follow-up action", () => {
    withTextArtifact(
      gate9EvidenceWithDetailOverride("Follow-up action", "no follow-up"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 9)).toBe(
          "Gate 9 Follow-up action field must record no-action reasoning, cleanup, or a concrete follow-up after the live read review: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("accepts gate 9 evidence with reasoned no-action follow-up", () => {
    withTextArtifact(
      gate9EvidenceWithDetailOverride(
        "Follow-up action",
        "no action needed because metadata-only read evidence was recorded and raw draft body content was omitted",
      ),
      (path) => {
        expect(
          scanEvidenceArtifactText(path, ".data/v1/evidence.md", 9),
        ).toBeUndefined();
      },
    );
  });

  it("rejects generated Cloud Run evidence without runtime verifier checks", () => {
    withTextArtifact(
      [
        "# V1 Cloud Run Deployment Evidence",
        "",
        "- Complete: yes",
        "",
        "## Gate 12 Deployment Review Details",
        "",
        ...completedGateDetailLines(12),
      ].join("\n"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-12.md", 12)).toBe(
          "Cloud Run evidence artifact is missing passing runtime-env verifier check(s) env_substack_publication_url, env_substack_user_id, env_max_body_bytes, env_max_image_bytes, env_substack_request_timeout_ms, env_confirmation_token_ttl_seconds; rerun cloud-run:verify from the generated cloud-run:plan follow-up before recording gate 12: .data/v1/gate-12.md.",
        );
      },
    );
  });

  it("rejects generated Cloud Run evidence with non-passing runtime verifier checks", () => {
    withTextArtifact(
      [
        "# V1 Cloud Run Deployment Evidence",
        "",
        "- Complete: yes",
        "",
        "## Checks",
        "",
        "- ok: env_substack_publication_url",
        "- [x] env_substack_user_id",
        "- [x] env_max_body_bytes",
        "- [x] env_max_image_bytes",
        "- [x] env_substack_request_timeout_ms",
        "- [x] env_confirmation_token_ttl_seconds",
        "",
        "## Gate 12 Deployment Review Details",
        "",
        ...completedGateDetailLines(12),
      ].join("\n"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-12.md", 12)).toBe(
          "Cloud Run evidence artifact is missing passing runtime-env verifier check(s) env_substack_publication_url; rerun cloud-run:verify from the generated cloud-run:plan follow-up before recording gate 12: .data/v1/gate-12.md.",
        );
      },
    );
  });

  it("rejects incomplete generated Cloud Run evidence with passing runtime verifier checks", () => {
    withTextArtifact(
      [
        "# V1 Cloud Run Deployment Evidence",
        "",
        "- Complete: no",
        "",
        "## Checks",
        "",
        "- [x] env_substack_publication_url",
        "- [x] env_substack_user_id",
        "- [x] env_max_body_bytes",
        "- [x] env_max_image_bytes",
        "- [x] env_substack_request_timeout_ms",
        "- [x] env_confirmation_token_ttl_seconds",
        "",
        "## Gate 13 Secret Manager Review Details",
        "",
        ...completedGateDetailLines(13),
      ].join("\n"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-13.md", 13)).toBe(
          "Cloud Run evidence artifact is not complete; rerun cloud-run:verify from the generated cloud-run:plan follow-up before recording gate 13: .data/v1/gate-13.md.",
        );
      },
    );
  });

  it("rejects generated Cloud Run evidence without completed deployment checklist items", () => {
    withTextArtifact(
      [
        "# V1 Cloud Run Deployment Evidence",
        "",
        "- Complete: yes",
        "- Auth mode: static_bearer",
        "",
        "## Checks",
        "",
        ...cloudRunRuntimeCheckLines(),
        "",
        "## Gate 12 Deployment Review Details",
        "",
        ...completedGateDetailLines(12),
      ].join("\n"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-12.md", 12)).toBe(
          "Cloud Run evidence artifact is missing completed deployment checklist item(s) Exported service JSON came from the intended GCP project, region, and Cloud Run service., `cloud-run:verify` completed with all checks passing., Cloud Run service URL was checked with `/healthz`., Remote MCP smoke passed against the deployed service URL., Evidence was reviewed to confirm no raw Secret Manager values, bearer tokens, or draft contents are included.; complete the generated Cloud Run review checklist before recording gate 12: .data/v1/gate-12.md.",
        );
      },
    );
  });

  it("rejects generated Cloud Run evidence without auth-mode proof", () => {
    withTextArtifact(
      [
        "# V1 Cloud Run Deployment Evidence",
        "",
        "- Complete: yes",
        "",
        "## Checks",
        "",
        ...cloudRunRuntimeCheckLines(),
        "",
        "## Required Evidence Checklist",
        "",
        ...completedCloudRunChecklistLines(12),
        "",
        "## Gate 12 Deployment Review Details",
        "",
        ...completedGateDetailLines(12),
      ].join("\n"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-12.md", 12)).toBe(
          "Cloud Run evidence artifact is missing generated auth-mode proof; rerun cloud-run:verify with the deployed --auth-mode before recording gate 12: .data/v1/gate-12.md.",
        );
      },
    );
  });

  it("rejects gate 12 evidence with an unsupported deployed auth mode", () => {
    withTextArtifact(
      [
        "## Gate 12 Deployment Review Details",
        "",
        "- GCP project/region/service: GCP project project, region us-central1, Cloud Run service substack-mcp",
        "- Service URL checked: https://service.example.run.app/healthz returned 200",
        "- Deploy command source: cloud-run:plan artifact reviewed",
        "- Health check result: /healthz returned 200",
        "- Remote smoke result: auth-mode matching remote MCP smoke test passed against the deployed service URL",
        "- Auth mode deployed: Cloud Run IAM-only service",
        "- Budget guard review: Cloud Billing budget alert follow-up recorded with $5 monthly command",
        "- Path-secret review: not used",
      ].join("\n"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 12)).toBe(
          "Gate 12 Auth mode deployed field must name one supported app auth mode: noauth, static_bearer, or oauth: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 12 evidence without project, region, and service identity", () => {
    withTextArtifact(
      gate12EvidenceWithDetailOverride(
        "GCP project/region/service",
        "deployment target reviewed",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 12)).toBe(
          "Gate 12 GCP project/region/service field must identify the deployed project, region, and Cloud Run service: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 12 evidence without a deployed HTTPS service URL", () => {
    withTextArtifact(
      gate12EvidenceWithDetailOverride(
        "Service URL checked",
        "deployed service endpoint reviewed",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 12)).toBe(
          "Gate 12 Service URL checked field must include the deployed HTTPS service URL or equivalent checked URL reference: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 12 evidence without deploy command provenance", () => {
    withTextArtifact(
      gate12EvidenceWithDetailOverride(
        "Deploy command source",
        "deployment was reviewed manually",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 12)).toBe(
          "Gate 12 Deploy command source field must reference the cloud-run:plan artifact or the gcloud run deploy command source: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 12 evidence without a successful /healthz check", () => {
    withTextArtifact(
      gate12EvidenceWithDetailOverride(
        "Health check result",
        "/healthz not checked yet",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 12)).toBe(
          "Gate 12 Health check result field must confirm /healthz succeeded on the deployed service: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 12 evidence without a passing remote MCP smoke", () => {
    withTextArtifact(
      gate12EvidenceWithDetailOverride(
        "Remote smoke result",
        "remote endpoint reachable but MCP smoke pending",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 12)).toBe(
          "Gate 12 Remote smoke result field must confirm an auth-mode matching remote MCP smoke passed against the deployed service URL: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 12 evidence with generic remote smoke wording", () => {
    withTextArtifact(
      gate12EvidenceWithDetailOverride(
        "Remote smoke result",
        "remote smoke passed",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 12)).toBe(
          "Gate 12 Remote smoke result field must confirm an auth-mode matching remote MCP smoke passed against the deployed service URL: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 12 evidence without a budget alert or follow-up decision", () => {
    withTextArtifact(
      [
        "## Gate 12 Deployment Review Details",
        "",
        "- GCP project/region/service: GCP project project, region us-central1, Cloud Run service substack-mcp",
        "- Service URL checked: https://service.example.run.app/healthz returned 200",
        "- Deploy command source: cloud-run:plan artifact reviewed",
        "- Health check result: /healthz returned 200",
        "- Remote smoke result: auth-mode matching remote MCP smoke test passed against the deployed service URL",
        "- Auth mode deployed: static_bearer deployed with private client rationale",
        "- Budget guard review: no budget alert configured",
        "- Path-secret review: not used",
      ].join("\n"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 12)).toBe(
          "Gate 12 Budget guard review field must confirm a Cloud Billing budget alert command/result, or an explicit budget-alert follow-up/decision: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 12 evidence that records a private MCP path segment", () => {
    withTextArtifact(
      gate12EvidenceWithDetailOverride(
        "Path-secret review",
        "private MCP path segment value was recorded in deployment notes",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 12)).toBe(
          "Gate 12 Path-secret review field must state MCP_PATH_SECRET was not used or that the private path segment was verified without recording its value: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects contradictory gate 12 path-secret evidence", () => {
    withTextArtifact(
      gate12EvidenceWithDetailOverride(
        "Path-secret review",
        "MCP_PATH_SECRET not used for this deployment, but the private path segment value was copied into review notes",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 12)).toBe(
          "Gate 12 Path-secret review field must state MCP_PATH_SECRET was not used or that the private path segment was verified without recording its value: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects generated OAuth Cloud Run evidence without metadata verifier checks", () => {
    withTextArtifact(
      [
        "# V1 Cloud Run Deployment Evidence",
        "",
        "- Complete: yes",
        "- Auth mode: oauth",
        "",
        "## Checks",
        "",
        ...cloudRunRuntimeCheckLines(),
        "",
        "## Required Evidence Checklist",
        "",
        ...completedCloudRunChecklistLines(13),
        "",
        "## Gate 13 Secret Manager Review Details",
        "",
        ...completedGateDetailLines(13),
      ].join("\n"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-13.md", 13)).toBe(
          "Cloud Run evidence artifact is missing passing runtime-env verifier check(s) env_mcp_public_base_url, env_oauth_authorization_server_url, env_oauth_jwks_url, env_oauth_jwt_algorithms; rerun cloud-run:verify from the generated cloud-run:plan follow-up before recording gate 13: .data/v1/gate-13.md.",
        );
      },
    );
  });

  it("accepts generated Cloud Run evidence with runtime verifier checks and checklist proof", () => {
    withTextArtifact(
      [
        "# V1 Cloud Run Deployment Evidence",
        "",
        "- Complete: yes",
        "- Auth mode: oauth",
        "",
        "## Checks",
        "",
        ...cloudRunRuntimeCheckLines(),
        ...cloudRunOAuthCheckLines(),
        "",
        "## Required Evidence Checklist",
        "",
        ...completedCloudRunChecklistLines(13),
        "",
        "## Gate 13 Secret Manager Review Details",
        "",
        ...completedGateDetailLines(13),
      ].join("\n"),
      (path) => {
        expect(
          scanEvidenceArtifactText(path, ".data/v1/gate-13.md", 13),
        ).toBeUndefined();
      },
    );
  });

  it("rejects gate 13 evidence that uses literal secret env values", () => {
    withTextArtifact(
      [
        "## Gate 13 Secret Manager Review Details",
        "",
        "- Secret references checked: Secret Manager references checked for SUBSTACK_SESSION_TOKEN and PREVIEW_TOKEN_SECRET",
        "- Required secret names: Secret Manager secret names: substack-session-token secret and preview-token-secret",
        "- Runtime service account: Cloud Run runtime service account substack-mcp-runner@example.iam.gserviceaccount.com reviewed",
        "- Secret access bindings: IAM roles/secretmanager.secretAccessor binding verified for the runtime service account",
        "- Version policy: latest secret versions reviewed with rotation notes for redeploy after rotation",
        "- Literal env review: runtime secrets were configured as literal env values",
        "- Secret value handling: no raw secret values were opened, pasted, or recorded",
        "- Rotation follow-up: no rotation needed because no raw secret values were exposed",
      ].join("\n"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 13)).toBe(
          "Gate 13 Literal env review field must confirm secrets are Secret Manager references, not literal environment values: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 13 evidence that opens or pastes raw secret values", () => {
    withTextArtifact(
      [
        "## Gate 13 Secret Manager Review Details",
        "",
        "- Secret references checked: Secret Manager references checked for SUBSTACK_SESSION_TOKEN and PREVIEW_TOKEN_SECRET",
        "- Required secret names: Secret Manager secret names: substack-session-token secret and preview-token-secret",
        "- Runtime service account: Cloud Run runtime service account substack-mcp-runner@example.iam.gserviceaccount.com reviewed",
        "- Secret access bindings: IAM roles/secretmanager.secretAccessor binding verified for the runtime service account",
        "- Version policy: latest secret versions reviewed with rotation notes for redeploy after rotation",
        "- Literal env review: Secret Manager references were used; no literal env values were present",
        "- Secret value handling: raw secret values were opened and pasted into review notes",
        "- Rotation follow-up: rotate secrets and redeploy after review follow-up",
      ].join("\n"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 13)).toBe(
          "Gate 13 Secret value handling field must confirm no raw secret values were opened, pasted, exposed, or recorded: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects contradictory gate 13 secret-value handling evidence", () => {
    withTextArtifact(
      gate13EvidenceWithDetailOverride(
        "Secret value handling",
        "no raw secret values were opened, pasted, or recorded, but raw secret values were copied into review notes",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 13)).toBe(
          "Gate 13 Secret value handling field must confirm no raw secret values were opened, pasted, exposed, or recorded: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 13 evidence without required Secret Manager env references", () => {
    withTextArtifact(
      gate13EvidenceWithDetailOverride(
        "Secret references checked",
        "required Secret Manager references checked",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 13)).toBe(
          "Gate 13 Secret references checked field must confirm Secret Manager references for SUBSTACK_SESSION_TOKEN and PREVIEW_TOKEN_SECRET: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 13 evidence without session and preview secret resource names", () => {
    withTextArtifact(
      gate13EvidenceWithDetailOverride(
        "Required secret names",
        "bearer-token only",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 13)).toBe(
          "Gate 13 Required secret names field must list Secret Manager resource names for the session and preview-token secrets without secret values: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 13 evidence without a runtime service account", () => {
    withTextArtifact(
      gate13EvidenceWithDetailOverride(
        "Runtime service account",
        "runtime reviewed",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 13)).toBe(
          "Gate 13 Runtime service account field must identify the deployed runtime service account or service identity: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 13 evidence without Secret Accessor binding proof", () => {
    withTextArtifact(
      gate13EvidenceWithDetailOverride(
        "Secret access bindings",
        "IAM binding verified",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 13)).toBe(
          "Gate 13 Secret access bindings field must confirm the runtime service account has Secret Manager Secret Accessor bindings: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 13 evidence with negated Secret Accessor binding wording", () => {
    withTextArtifact(
      gate13EvidenceWithDetailOverride(
        "Secret access bindings",
        "runtime service account Secret Manager Secret Accessor binding not verified",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 13)).toBe(
          "Gate 13 Secret access bindings field must confirm the runtime service account has Secret Manager Secret Accessor bindings: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 13 evidence without version policy and rotation notes", () => {
    withTextArtifact(
      gate13EvidenceWithDetailOverride(
        "Version policy",
        "latest secret versions reviewed",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 13)).toBe(
          "Gate 13 Version policy field must record latest/pinned version usage and rotation notes: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 13 evidence without rotation follow-up reasoning", () => {
    withTextArtifact(
      gate13EvidenceWithDetailOverride("Rotation follow-up", "no action"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 13)).toBe(
          "Gate 13 Rotation follow-up field must record no-action reasoning or the rotation/redeploy follow-up: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 13 no-rotation follow-up after secret exposure", () => {
    withTextArtifact(
      gate13EvidenceWithDetailOverride(
        "Rotation follow-up",
        "no rotation needed because raw secret values were exposed during review",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 13)).toBe(
          "Gate 13 Rotation follow-up field must record no-action reasoning or the rotation/redeploy follow-up: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 16 evidence without a concrete live log export window", () => {
    withTextArtifact(
      gate16EvidenceWithDetailOverride("Log export window", "recent logs"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 16)).toBe(
          "Gate 16 Log export window field must include the live Cloud Run log export start/end time or query window: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 16 evidence without Cloud Run service or revision provenance", () => {
    withTextArtifact(
      gate16EvidenceWithDetailOverride(
        "Cloud Run service/revision",
        "production service reviewed",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 16)).toBe(
          "Gate 16 Cloud Run service/revision field must identify the Cloud Run service and revision or service URL used for the log export: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 16 evidence without live Cloud Run traffic", () => {
    withTextArtifact(
      gate16EvidenceWithDetailOverride(
        "Live traffic exercised",
        "local dry run only; no deployed requests",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 16)).toBe(
          "Gate 16 Live traffic exercised field must confirm live Cloud Run acceptance traffic, request, or remote smoke activity before log export: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 16 evidence with negated live Cloud Run traffic wording", () => {
    withTextArtifact(
      gate16EvidenceWithDetailOverride(
        "Live traffic exercised",
        "remote smoke not run; no live Cloud Run traffic exercised",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 16)).toBe(
          "Gate 16 Live traffic exercised field must confirm live Cloud Run acceptance traffic, request, or remote smoke activity before log export: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 16 evidence without a Cloud Run log export command", () => {
    withTextArtifact(
      gate16EvidenceWithDetailOverride(
        "Log export command",
        "gcloud logging read completed",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 16)).toBe(
          "Gate 16 Log export command field must show the gcloud logging read command with a Cloud Run resource filter: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 16 evidence without the required log verifier flags", () => {
    withTextArtifact(
      gate16EvidenceWithDetailOverride(
        "Verifier command",
        "npm run cloud-run:logs:verify -- --require-audit-events",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 16)).toBe(
          "Gate 16 Verifier command field must show cloud-run:logs:verify with --logs-json and --require-audit-events: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 16 evidence without metadata-only audit review", () => {
    withTextArtifact(
      gate16EvidenceWithDetailOverride(
        "Audit event review",
        "audit events were present",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 16)).toBe(
          "Gate 16 Audit event review field must confirm audit events were metadata-only or limited to the allowed field set: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 16 evidence with negated metadata-only audit wording", () => {
    withTextArtifact(
      gate16EvidenceWithDetailOverride(
        "Audit event review",
        "audit events were not metadata-only; request body fields appeared",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 16)).toBe(
          "Gate 16 Audit event review field must confirm audit events were metadata-only or limited to the allowed field set: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 16 evidence without finding review results", () => {
    withTextArtifact(
      gate16EvidenceWithDetailOverride("Finding review", "reviewed output"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 16)).toBe(
          "Gate 16 Finding review field must record no findings or a sanitized finding-category summary: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 16 evidence with only narrow no-secret finding wording", () => {
    withTextArtifact(
      gate16EvidenceWithDetailOverride(
        "Finding review",
        "no secret findings were reported",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 16)).toBe(
          "Gate 16 Finding review field must record no findings or a sanitized finding-category summary: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 16 evidence that does not keep raw logs out of evidence", () => {
    withTextArtifact(
      gate16EvidenceWithDetailOverride(
        "Raw log handling",
        "raw log entries pasted into the evidence appendix",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 16)).toBe(
          "Gate 16 Raw log handling field must confirm raw log entries were not pasted, copied, exposed, or recorded in evidence: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 16 evidence with contradictory raw-log handling wording", () => {
    withTextArtifact(
      gate16EvidenceWithDetailOverride(
        "Raw log handling",
        "no raw log entries included in evidence, but raw log entries copied into appendix notes",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 16)).toBe(
          "Gate 16 Raw log handling field must confirm raw log entries were not pasted, copied, exposed, or recorded in evidence: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 16 evidence without a reasoned follow-up action", () => {
    withTextArtifact(
      gate16EvidenceWithDetailOverride("Follow-up action", "no action"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 16)).toBe(
          "Gate 16 Follow-up action field must record rotation/redeploy/deletion follow-up or no-action reasoning: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects gate 16 evidence with no-action despite log exposure", () => {
    withTextArtifact(
      gate16EvidenceWithDetailOverride(
        "Follow-up action",
        "no action because raw logs were exposed",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/evidence.md", 16)).toBe(
          "Gate 16 Follow-up action field must record rotation/redeploy/deletion follow-up or no-action reasoning: .data/v1/evidence.md.",
        );
      },
    );
  });

  it("rejects incomplete generated Cloud Run log evidence for gate 16", () => {
    withTextArtifact(
      [
        "# V1 Cloud Run Log Safety Evidence",
        "",
        "## Exported Log Verification",
        "",
        "- Complete: no",
        "- Audit events found: 1",
        "",
        "## Checks",
        "",
        "- [x] log entries present: 1 exported log entry parsed.",
        "- [x] no secret patterns or fields: No leaks were detected.",
        "- [x] no draft content fields: No draft fields were detected.",
        "- [x] audit events metadata only: 1 mcp_audit event uses the allowed metadata field set.",
        "",
        "## Manual Log Review Details",
        "",
        ...completedGateDetailLines(16),
      ].join("\n"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-16.md", 16)).toBe(
          "Cloud Run log evidence artifact is not complete; rerun cloud-run:logs:verify with --require-audit-events after live Cloud Run acceptance traffic before recording gate 16: .data/v1/gate-16.md.",
        );
      },
    );
  });

  it("rejects generated Cloud Run log evidence without audit events", () => {
    withTextArtifact(
      [
        "# V1 Cloud Run Log Safety Evidence",
        "",
        "## Exported Log Verification",
        "",
        "- Complete: yes",
        "- Audit events found: 0",
        "",
        "## Checks",
        "",
        "- [x] log entries present: 1 exported log entry parsed.",
        "- [x] no secret patterns or fields: No leaks were detected.",
        "- [x] no draft content fields: No draft fields were detected.",
        "- [x] audit events metadata only: 0 mcp_audit events use the allowed metadata field set.",
        "",
        "## Manual Log Review Details",
        "",
        ...completedGateDetailLines(16),
      ].join("\n"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-16.md", 16)).toBe(
          "Cloud Run log evidence artifact is missing required audit events; rerun cloud-run:logs:verify with --require-audit-events after live Cloud Run acceptance traffic before recording gate 16: .data/v1/gate-16.md.",
        );
      },
    );
  });

  it("rejects complete generated Cloud Run log evidence without completed review checklist items", () => {
    withTextArtifact(
      [
        "# V1 Cloud Run Log Safety Evidence",
        "",
        "## Exported Log Verification",
        "",
        "- Complete: yes",
        "- Audit events found: 1",
        "",
        "## Checks",
        "",
        ...cloudRunLogCheckLines(),
        "",
        "## Manual Log Review Details",
        "",
        ...completedGateDetailLines(16),
      ].join("\n"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-16.md", 16)).toBe(
          "Cloud Run log evidence artifact is missing completed log-review checklist item(s) Logs were exported after live Cloud Run acceptance traffic., `cloud-run:logs:verify` completed with required audit events., Exported logs contained no cookie, bearer-token, secret-environment, or private MCP path leaks., Exported logs contained no draft content or request/response body fields., Audit events were metadata-only and used the allowed field set., Evidence was reviewed to confirm no raw log entries or secret values are included.; complete the generated Cloud Run log review checklist before recording gate 16: .data/v1/gate-16.md.",
        );
      },
    );
  });

  it("accepts complete generated Cloud Run log evidence with passing verifier checks and checklist proof", () => {
    withTextArtifact(
      [
        "# V1 Cloud Run Log Safety Evidence",
        "",
        "## Exported Log Verification",
        "",
        "- Complete: yes",
        "- Audit events found: 1",
        "",
        "## Checks",
        "",
        ...cloudRunLogCheckLines(),
        "",
        "## Required Evidence Checklist",
        "",
        ...completedCloudRunLogChecklistLines(),
        "",
        "## Manual Log Review Details",
        "",
        ...completedGateDetailLines(16),
      ].join("\n"),
      (path) => {
        expect(
          scanEvidenceArtifactText(path, ".data/v1/gate-16.md", 16),
        ).toBeUndefined();
      },
    );
  });

  it("rejects stale generated live Substack evidence without current automated proof", () => {
    withTextArtifact(
      [
        "# V1 Live Substack Draft Flow Evidence",
        "",
        "## Automated Checks",
        "",
        "- [x] `create_draft` created a draft.",
        "",
        "## Gate 7 Manual Review Details",
        "",
        ...completedGateDetailLines(7),
      ].join("\n"),
      (path) => {
        const problem = scanEvidenceArtifactText(
          path,
          ".data/v1/gate-07.md",
          7,
        );

        expect(problem).toContain(
          "Live Substack evidence artifact is missing current automated proof(s)",
        );
        expect(problem).toContain(
          "- [x] `upload_image` returned a hosted image URL.",
        );
        expect(problem).toContain("before recording gate 7");
      },
    );
  });

  it.each([
    {
      gateId: 7,
      heading: "## Gate 7 Manual Review Details",
      proofs: [
        "- [x] `upload_image` returned a hosted image URL.",
        "- [x] `create_draft` created a draft.",
      ],
    },
    {
      gateId: 8,
      heading: "## Gate 8 Update Review Details",
      proofs: [
        "- [x] `update_draft` updated the same draft.",
        "- [x] `get_draft` fetched the updated draft metadata.",
      ],
    },
    {
      gateId: 9,
      heading: "## Gate 9 Read Review Details",
      proofs: [
        "- [x] `list_drafts` found the created draft.",
        "- [x] `get_draft` fetched the created draft metadata.",
        "- [x] `get_draft` fetched the updated draft metadata.",
      ],
    },
  ] as const)("accepts current generated live Substack evidence for gate $gateId", ({
    gateId,
    heading,
    proofs,
  }) => {
    withTextArtifact(
      [
        "# V1 Live Substack Draft Flow Evidence",
        "",
        "## Automated Checks",
        "",
        ...proofs,
        "",
        heading,
        "",
        ...completedGateDetailLines(gateId),
      ].join("\n"),
      (path) => {
        expect(
          scanEvidenceArtifactText(path, `.data/v1/gate-${gateId}.md`, gateId),
        ).toBeUndefined();
      },
    );
  });

  it("rejects stale generated ChatGPT ngrok evidence without current noauth smoke proof", () => {
    withTextArtifact(
      [
        "# V1 ChatGPT Ngrok Evidence",
        "",
        "## Automated Remote Smoke",
        "",
        "- Auth mode: noauth",
        "- Health status: 200",
        "",
        "## Manual ChatGPT Connector Acceptance",
        "",
        ...completedGateDetailLines(11),
      ].join("\n"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-11.md", 11)).toBe(
          "ChatGPT/ngrok evidence artifact is missing current remote-smoke proof(s) - Tool count: 7, - [x] Remote endpoint responded on `/healthz`., - [x] Remote noauth MCP endpoint listed exactly the seven V1 draft-workflow tools., - [x] `validate_newsletter_content` completed against the rich Markdown fixture., - [x] `preview_draft` completed without calling Substack or write tools.; rerun smoke:remote-noauth or smoke:ngrok-noauth before recording gate 11: .data/v1/gate-11.md.",
        );
      },
    );
  });

  it("accepts current generated ChatGPT ngrok evidence with noauth smoke proof", () => {
    withTextArtifact(
      [
        "# V1 ChatGPT Ngrok Evidence",
        "",
        "## Automated Remote Smoke",
        "",
        "- Auth mode: noauth",
        "- Health status: 200",
        "- Tool count: 7",
        "",
        "## Required Evidence Checklist",
        "",
        "- [x] Remote endpoint responded on `/healthz`.",
        "- [x] Remote noauth MCP endpoint listed exactly the seven V1 draft-workflow tools.",
        "- [x] `validate_newsletter_content` completed against the rich Markdown fixture.",
        "- [x] `preview_draft` completed without calling Substack or write tools.",
        "",
        "## Manual ChatGPT Connector Acceptance",
        "",
        ...completedGateDetailLines(11),
      ].join("\n"),
      (path) => {
        expect(
          scanEvidenceArtifactText(path, ".data/v1/gate-11.md", 11),
        ).toBeUndefined();
      },
    );
  });

  it("rejects ChatGPT/ngrok evidence when the manual surface is not ChatGPT", () => {
    withTextArtifact(
      [
        "# V1 ChatGPT Ngrok Evidence",
        "",
        "## Automated Remote Smoke",
        "",
        "- Auth mode: noauth",
        "- Health status: 200",
        "- Tool count: 7",
        "",
        "## Required Evidence Checklist",
        "",
        "- [x] Remote endpoint responded on `/healthz`.",
        "- [x] Remote noauth MCP endpoint listed exactly the seven V1 draft-workflow tools.",
        "- [x] `validate_newsletter_content` completed against the rich Markdown fixture.",
        "- [x] `preview_draft` completed without calling Substack or write tools.",
        "",
        "## Manual ChatGPT Connector Acceptance",
        "",
        "- Connector URL: https://example.ngrok.app/mcp",
        "- ChatGPT surface tested: MCP Inspector local noauth smoke",
        "- Tool-list result: seven V1 tools listed",
        "- Manual flow result: validation flow completed",
        "- Draft or review reference: local smoke artifact",
        "- Tunnel exposure window: short-lived developer tunnel",
        "- Unexpected traffic review: no unexpected requests observed",
        "- Rotation decision: tunnel stopped",
      ].join("\n"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-11.md", 11)).toBe(
          "Gate 11 ChatGPT surface tested field must name ChatGPT; noauth smoke-only or other client evidence does not satisfy gate 11: .data/v1/gate-11.md.",
        );
      },
    );
  });

  it("rejects ChatGPT/ngrok evidence with negated ChatGPT surface wording", () => {
    withTextArtifact(
      chatGptNgrokEvidenceWithDetailOverride(
        "ChatGPT surface tested",
        "not ChatGPT; remote noauth smoke only",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-11.md", 11)).toBe(
          "Gate 11 ChatGPT surface tested field must name ChatGPT; noauth smoke-only or other client evidence does not satisfy gate 11: .data/v1/gate-11.md.",
        );
      },
    );
  });

  it("rejects ChatGPT/ngrok evidence without a public connector URL reference", () => {
    withTextArtifact(
      chatGptNgrokEvidenceWithDetailOverride(
        "Connector URL",
        "http://localhost:8787/mcp local smoke endpoint",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-11.md", 11)).toBe(
          "Gate 11 Connector URL field must identify the public HTTPS /mcp connector URL or a screenshot/reference that proves that URL: .data/v1/gate-11.md.",
        );
      },
    );
  });

  it("rejects ChatGPT/ngrok evidence without exact ChatGPT tool-list proof", () => {
    withTextArtifact(
      chatGptNgrokEvidenceWithDetailOverride(
        "Tool-list result",
        "tools were visible in local smoke output",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-11.md", 11)).toBe(
          "Gate 11 Tool-list result field must confirm the ChatGPT connector listed exactly the seven V1 draft-workflow tools: .data/v1/gate-11.md.",
        );
      },
    );
  });

  it("rejects ChatGPT/ngrok evidence without V1 draft-workflow tool-list proof", () => {
    withTextArtifact(
      chatGptNgrokEvidenceWithDetailOverride(
        "Tool-list result",
        "seven tools listed through the ChatGPT connector",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-11.md", 11)).toBe(
          "Gate 11 Tool-list result field must confirm the ChatGPT connector listed exactly the seven V1 draft-workflow tools: .data/v1/gate-11.md.",
        );
      },
    );
  });

  it("rejects ChatGPT/ngrok evidence with contradictory tool-count proof", () => {
    withTextArtifact(
      chatGptNgrokEvidenceWithDetailOverride(
        "Tool-list result",
        "exactly seven V1 draft-workflow tools listed through the ChatGPT connector, but eight tools were visible",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-11.md", 11)).toBe(
          "Gate 11 Tool-list result field must confirm the ChatGPT connector listed exactly the seven V1 draft-workflow tools: .data/v1/gate-11.md.",
        );
      },
    );
  });

  it("rejects ChatGPT/ngrok evidence without ChatGPT draft creation in the manual flow", () => {
    withTextArtifact(
      chatGptNgrokEvidenceWithDetailOverride(
        "Manual flow result",
        "validate and preview succeeded",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-11.md", 11)).toBe(
          "Gate 11 Manual flow result field must confirm the ChatGPT connector completed validate, preview, and draft-creation steps; smoke-only or incomplete wording does not satisfy gate 11: .data/v1/gate-11.md.",
        );
      },
    );
  });

  it("rejects ChatGPT/ngrok evidence without a non-sensitive draft or review reference", () => {
    withTextArtifact(
      chatGptNgrokEvidenceWithDetailOverride(
        "Draft or review reference",
        "local smoke artifact only",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-11.md", 11)).toBe(
          "Gate 11 Draft or review reference field must provide a non-sensitive Substack draft URL, numeric draft ID, screenshot reference, or manual review reference from the ChatGPT connector flow: .data/v1/gate-11.md.",
        );
      },
    );
  });

  it("rejects ChatGPT/ngrok evidence with an unbounded tunnel exposure window", () => {
    withTextArtifact(
      chatGptNgrokEvidenceWithDetailOverride(
        "Tunnel exposure window",
        "left open overnight",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-11.md", 11)).toBe(
          "Gate 11 Tunnel exposure window field must give a bounded short-lived tunnel window with start/end times or a numeric duration: .data/v1/gate-11.md.",
        );
      },
    );
  });

  it("rejects ChatGPT/ngrok evidence without traffic review", () => {
    withTextArtifact(
      chatGptNgrokEvidenceWithDetailOverride(
        "Unexpected traffic review",
        "ngrok logs were not checked",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-11.md", 11)).toBe(
          "Gate 11 Unexpected traffic review field must confirm ngrok or local traffic logs were reviewed and no unexpected traffic was observed or unresolved: .data/v1/gate-11.md.",
        );
      },
    );
  });

  it("rejects ChatGPT/ngrok evidence that only asserts no unexpected traffic", () => {
    withTextArtifact(
      chatGptNgrokEvidenceWithDetailOverride(
        "Unexpected traffic review",
        "no unexpected requests observed",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-11.md", 11)).toBe(
          "Gate 11 Unexpected traffic review field must confirm ngrok or local traffic logs were reviewed and no unexpected traffic was observed or unresolved: .data/v1/gate-11.md.",
        );
      },
    );
  });

  it("rejects ChatGPT/ngrok evidence without a rotation or tunnel shutdown decision", () => {
    withTextArtifact(
      chatGptNgrokEvidenceWithDetailOverride(
        "Rotation decision",
        "decision pending",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-11.md", 11)).toBe(
          "Gate 11 Rotation decision field must record whether credentials or the tunnel were rotated, stopped, revoked, or intentionally not rotated with a reason: .data/v1/gate-11.md.",
        );
      },
    );
  });

  it("rejects ChatGPT/ngrok evidence with no rotation after credential exposure", () => {
    withTextArtifact(
      chatGptNgrokEvidenceWithDetailOverride(
        "Rotation decision",
        "no rotation needed because the session credential was exposed in connector notes",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-11.md", 11)).toBe(
          "Gate 11 Rotation decision field must record whether credentials or the tunnel were rotated, stopped, revoked, or intentionally not rotated with a reason: .data/v1/gate-11.md.",
        );
      },
    );
  });

  it("rejects stale generated static-bearer remote evidence without missing/wrong bearer proof", () => {
    withTextArtifact(
      [
        "# V1 Static Bearer Remote Evidence",
        "",
        "## Automated Remote Smoke",
        "",
        "- Auth mode: static_bearer",
        "- Health status: 200",
        "- Tool count: 7",
        "",
        "## Gate 14 Header-Capable Client Details",
        "",
        ...completedGateDetailLines(14),
      ].join("\n"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-14.md", 14)).toBe(
          "Static bearer remote evidence artifact is missing current bearer-rejection proof(s) - Missing bearer status: 401, - Wrong bearer status: 401, - [x] Missing bearer token was rejected with HTTP 401., - [x] Wrong bearer token was rejected with HTTP 401.; rerun smoke:remote or smoke:ngrok-static-bearer before recording gate 14: .data/v1/gate-14.md.",
        );
      },
    );
  });

  it("rejects static-bearer evidence without an Authorization header configuration", () => {
    withTextArtifact(
      [
        "# V1 Static Bearer Remote Evidence",
        "",
        "## Automated Remote Smoke",
        "",
        "- Auth mode: static_bearer",
        "- Health status: 200",
        "- Missing bearer status: 401",
        "- Wrong bearer status: 401",
        "- Tool count: 7",
        "",
        "## Required Evidence Checklist",
        "",
        "- [x] Missing bearer token was rejected with HTTP 401.",
        "- [x] Wrong bearer token was rejected with HTTP 401.",
        "",
        "## Gate 14 Header-Capable Client Details",
        "",
        "- Client tested: curl 8.0",
        "- Endpoint tested: https://example.com/mcp",
        "- Header configuration method: configured through client environment settings",
        "- Tool-list result: seven tools listed",
        "- Validation call result: validate_newsletter_content succeeded",
        "- Rejection proof: missing and wrong token checks returned 401",
        "- Token redaction review: no token value recorded",
      ].join("\n"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-14.md", 14)).toBe(
          "Gate 14 header configuration method must describe an Authorization header; smoke-only or token-free wording does not satisfy gate 14: .data/v1/gate-14.md.",
        );
      },
    );
  });

  it("rejects static-bearer evidence with negated Authorization header wording", () => {
    withTextArtifact(
      staticBearerEvidenceWithDetailOverride(
        "Header configuration method",
        "Authorization header not configured; token-free remote smoke only",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-14.md", 14)).toBe(
          "Gate 14 header configuration method must describe an Authorization header; smoke-only or token-free wording does not satisfy gate 14: .data/v1/gate-14.md.",
        );
      },
    );
  });

  it("rejects static-bearer evidence without a real header-capable client", () => {
    withTextArtifact(
      staticBearerEvidenceWithDetailOverride(
        "Client tested",
        "remote smoke only",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-14.md", 14)).toBe(
          "Gate 14 client tested field must name a real header-capable HTTP client, not smoke-only or pending evidence: .data/v1/gate-14.md.",
        );
      },
    );
  });

  it("rejects static-bearer evidence without a public HTTPS /mcp endpoint reference", () => {
    withTextArtifact(
      staticBearerEvidenceWithDetailOverride(
        "Endpoint tested",
        "local smoke endpoint only",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-14.md", 14)).toBe(
          "Gate 14 Endpoint tested field must identify the public HTTPS /mcp endpoint tested through the header-capable client: .data/v1/gate-14.md.",
        );
      },
    );
  });

  it("rejects static-bearer evidence without exact seven-tool client proof", () => {
    withTextArtifact(
      staticBearerEvidenceWithDetailOverride(
        "Tool-list result",
        "tools were visible",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-14.md", 14)).toBe(
          "Gate 14 Tool-list result field must confirm the header-capable client listed exactly the seven V1 draft-workflow tools: .data/v1/gate-14.md.",
        );
      },
    );
  });

  it("rejects static-bearer evidence without draft-workflow tool-list proof", () => {
    withTextArtifact(
      staticBearerEvidenceWithDetailOverride(
        "Tool-list result",
        "seven V1 tools listed through the header-capable client",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-14.md", 14)).toBe(
          "Gate 14 Tool-list result field must confirm the header-capable client listed exactly the seven V1 draft-workflow tools: .data/v1/gate-14.md.",
        );
      },
    );
  });

  it("rejects static-bearer evidence with contradictory tool-count proof", () => {
    withTextArtifact(
      staticBearerEvidenceWithDetailOverride(
        "Tool-list result",
        "exactly seven V1 draft-workflow tools listed through the header-capable client, but tool count: 8",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-14.md", 14)).toBe(
          "Gate 14 Tool-list result field must confirm the header-capable client listed exactly the seven V1 draft-workflow tools: .data/v1/gate-14.md.",
        );
      },
    );
  });

  it("rejects static-bearer evidence without validate_newsletter_content success", () => {
    withTextArtifact(
      staticBearerEvidenceWithDetailOverride(
        "Validation call result",
        "manual call completed",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-14.md", 14)).toBe(
          "Gate 14 Validation call result field must confirm validate_newsletter_content succeeded through the header-capable client: .data/v1/gate-14.md.",
        );
      },
    );
  });

  it("rejects static-bearer evidence without missing and wrong bearer rejection proof", () => {
    withTextArtifact(
      staticBearerEvidenceWithDetailOverride(
        "Rejection proof",
        "missing bearer token returned 401",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-14.md", 14)).toBe(
          "Gate 14 Rejection proof field must confirm missing and wrong bearer credentials were rejected with HTTP 401 or unauthorized responses: .data/v1/gate-14.md.",
        );
      },
    );
  });

  it("rejects static-bearer evidence without bearer token redaction review", () => {
    withTextArtifact(
      staticBearerEvidenceWithDetailOverride(
        "Token redaction review",
        "token redaction not reviewed",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-14.md", 14)).toBe(
          "Gate 14 Token redaction review field must confirm no bearer token or token value was included, recorded, printed, pasted, exposed, or logged: .data/v1/gate-14.md.",
        );
      },
    );
  });

  it("rejects contradictory static-bearer token redaction review", () => {
    withTextArtifact(
      staticBearerEvidenceWithDetailOverride(
        "Token redaction review",
        "no bearer token value was recorded, but token value was pasted into appendix notes",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-14.md", 14)).toBe(
          "Gate 14 Token redaction review field must confirm no bearer token or token value was included, recorded, printed, pasted, exposed, or logged: .data/v1/gate-14.md.",
        );
      },
    );
  });

  it("accepts current generated static-bearer remote evidence with missing/wrong bearer proof", () => {
    withTextArtifact(
      [
        "# V1 Static Bearer Remote Evidence",
        "",
        "## Automated Remote Smoke",
        "",
        "- Auth mode: static_bearer",
        "- Health status: 200",
        "- Missing bearer status: 401",
        "- Wrong bearer status: 401",
        "- Tool count: 7",
        "",
        "## Required Evidence Checklist",
        "",
        "- [x] Missing bearer token was rejected with HTTP 401.",
        "- [x] Wrong bearer token was rejected with HTTP 401.",
        "",
        "## Gate 14 Header-Capable Client Details",
        "",
        ...completedGateDetailLines(14),
      ].join("\n"),
      (path) => {
        expect(
          scanEvidenceArtifactText(path, ".data/v1/gate-14.md", 14),
        ).toBeUndefined();
      },
    );
  });

  it("rejects stale generated stdio client evidence without current local smoke proof", () => {
    withTextArtifact(
      [
        "# V1 Stdio Client Evidence",
        "",
        "## Automated Stdio Smoke",
        "",
        "- Transport: stdio",
        "",
        "## Manual Client Acceptance",
        "",
        ...completedGateDetailLines(15),
      ].join("\n"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-15.md", 15)).toBe(
          "Stdio client evidence artifact is missing current local-stdio smoke proof(s) - Tool count: 7, - [x] Built stdio entrypoint launched and exposed exactly the seven V1 draft-workflow tools., - [x] `validate_newsletter_content` completed against the rich Markdown fixture., - [x] `preview_draft` completed without calling Substack or write tools.; rerun smoke:stdio before recording gate 15: .data/v1/gate-15.md.",
        );
      },
    );
  });

  it("rejects stdio client evidence when the manual client is not Claude Code or Cursor", () => {
    withTextArtifact(
      [
        "# V1 Stdio Client Evidence",
        "",
        "## Automated Stdio Smoke",
        "",
        "- Transport: stdio",
        "- Tool count: 7",
        "",
        "## Required Evidence Checklist",
        "",
        "- [x] Built stdio entrypoint launched and exposed exactly the seven V1 draft-workflow tools.",
        "- [x] `validate_newsletter_content` completed against the rich Markdown fixture.",
        "- [x] `preview_draft` completed without calling Substack or write tools.",
        "",
        "## Manual Client Acceptance",
        "",
        "- Client tested: MCP Inspector local stdio check",
        "- Config path or add command: completed config review",
        "- Server entrypoint path: completed entrypoint review",
        "- Tool-list result: seven tools listed",
        "- Validation call result: validate_newsletter_content succeeded",
        "- Credential locality review: credentials stayed local",
      ].join("\n"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-15.md", 15)).toBe(
          "Gate 15 client tested field must name Claude Code or Cursor; smoke-only or other client evidence does not satisfy gate 15: .data/v1/gate-15.md.",
        );
      },
    );
  });

  it("rejects stdio client evidence with negated Claude Code/Cursor wording", () => {
    withTextArtifact(
      stdioEvidenceWithDetailOverride(
        "Client tested",
        "Claude Code not tested; MCP Inspector only",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-15.md", 15)).toBe(
          "Gate 15 client tested field must name Claude Code or Cursor; smoke-only or other client evidence does not satisfy gate 15: .data/v1/gate-15.md.",
        );
      },
    );
  });

  it("rejects stdio client evidence without a Claude Code/Cursor config path or add command", () => {
    withTextArtifact(
      stdioEvidenceWithDetailOverride(
        "Config path or add command",
        "local smoke artifact only",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-15.md", 15)).toBe(
          "Gate 15 Config path or add command field must identify the Claude Code/Cursor stdio config path or add command used for the client: .data/v1/gate-15.md.",
        );
      },
    );
  });

  it("rejects stdio client evidence without an absolute built entrypoint path", () => {
    withTextArtifact(
      stdioEvidenceWithDetailOverride(
        "Server entrypoint path",
        "dist/stdio.js",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-15.md", 15)).toBe(
          "Gate 15 Server entrypoint path field must identify an absolute path to dist/stdio.js for the built stdio package: .data/v1/gate-15.md.",
        );
      },
    );
  });

  it("rejects stdio client evidence without exact seven-tool client proof", () => {
    withTextArtifact(
      stdioEvidenceWithDetailOverride("Tool-list result", "tools were visible"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-15.md", 15)).toBe(
          "Gate 15 Tool-list result field must confirm Claude Code or Cursor listed exactly the seven V1 draft-workflow tools: .data/v1/gate-15.md.",
        );
      },
    );
  });

  it("rejects stdio client evidence without V1 draft-workflow tool-list proof", () => {
    withTextArtifact(
      stdioEvidenceWithDetailOverride(
        "Tool-list result",
        "seven tools listed through Claude Code",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-15.md", 15)).toBe(
          "Gate 15 Tool-list result field must confirm Claude Code or Cursor listed exactly the seven V1 draft-workflow tools: .data/v1/gate-15.md.",
        );
      },
    );
  });

  it("rejects stdio client evidence with contradictory tool-count proof", () => {
    withTextArtifact(
      stdioEvidenceWithDetailOverride(
        "Tool-list result",
        "exactly seven V1 draft-workflow tools listed through Claude Code, but six tools were listed in the client",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-15.md", 15)).toBe(
          "Gate 15 Tool-list result field must confirm Claude Code or Cursor listed exactly the seven V1 draft-workflow tools: .data/v1/gate-15.md.",
        );
      },
    );
  });

  it("rejects stdio client evidence without validate_newsletter_content success", () => {
    withTextArtifact(
      stdioEvidenceWithDetailOverride(
        "Validation call result",
        "manual call completed",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-15.md", 15)).toBe(
          "Gate 15 Validation call result field must confirm validate_newsletter_content succeeded through Claude Code or Cursor: .data/v1/gate-15.md.",
        );
      },
    );
  });

  it("rejects stdio client evidence without local env credential handling", () => {
    withTextArtifact(
      stdioEvidenceWithDetailOverride(
        "Credential locality review",
        "credentials stayed local",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-15.md", 15)).toBe(
          "Gate 15 Credential locality review field must confirm Substack credentials came from local environment variables and were not recorded, committed, pasted into client config, or exposed remotely: .data/v1/gate-15.md.",
        );
      },
    );
  });

  it("rejects contradictory stdio credential locality evidence", () => {
    withTextArtifact(
      stdioEvidenceWithDetailOverride(
        "Credential locality review",
        "Substack credentials came from local environment variables and were not recorded in client config, but credential values were pasted into the Cursor config notes",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/gate-15.md", 15)).toBe(
          "Gate 15 Credential locality review field must confirm Substack credentials came from local environment variables and were not recorded, committed, pasted into client config, or exposed remotely: .data/v1/gate-15.md.",
        );
      },
    );
  });

  it("accepts current generated stdio client evidence with local smoke proof", () => {
    withTextArtifact(
      [
        "# V1 Stdio Client Evidence",
        "",
        "## Automated Stdio Smoke",
        "",
        "- Transport: stdio",
        "- Tool count: 7",
        "",
        "## Required Evidence Checklist",
        "",
        "- [x] Built stdio entrypoint launched and exposed exactly the seven V1 draft-workflow tools.",
        "- [x] `validate_newsletter_content` completed against the rich Markdown fixture.",
        "- [x] `preview_draft` completed without calling Substack or write tools.",
        "",
        "## Manual Client Acceptance",
        "",
        ...completedGateDetailLines(15),
      ].join("\n"),
      (path) => {
        expect(
          scanEvidenceArtifactText(path, ".data/v1/gate-15.md", 15),
        ).toBeUndefined();
      },
    );
  });

  it("rejects generated remote OAuth launch evidence without current OAuth smoke proof", () => {
    withTextArtifact(
      [
        "# V1 Remote OAuth Evidence",
        "",
        "## Automated Remote Smoke",
        "",
        "- Auth mode: oauth",
        "- Health status: 200",
        "",
        "## Required OAuth Launch Checklist",
        "",
        ...completedRemoteOAuthLaunchChecklistLines(),
        "",
        "## Manual OAuth Launch Review",
        "",
        ...completedRemoteOAuthLaunchReviewLines(),
      ].join("\n"),
      (path) => {
        const problem = scanEvidenceArtifactText(
          path,
          ".data/v1/remote-oauth.md",
        );

        expect(problem).toContain(
          "Remote OAuth evidence artifact is missing current OAuth smoke proof(s)",
        );
        expect(problem).toContain("- Metadata CORS allow-origin: *");
        expect(problem).toContain("- Tool count: 7");
        expect(problem).toContain(
          "rerun smoke:remote-oauth or smoke:ngrok-oauth",
        );
      },
    );
  });

  it("rejects generated remote OAuth launch evidence without completed launch checklist items", () => {
    withTextArtifact(
      [
        "# V1 Remote OAuth Evidence",
        "",
        "## Automated Remote Smoke",
        "",
        ...completedRemoteOAuthProofLines(),
        "",
        "## Required OAuth Launch Checklist",
        "",
        ...requiredRemoteOAuthLaunchChecklistLabels()
          .slice(0, 8)
          .map((label) => `- [x] ${label}`),
        "",
        "## Manual OAuth Launch Review",
        "",
        ...completedRemoteOAuthLaunchReviewLines(),
      ].join("\n"),
      (path) => {
        const problem = scanEvidenceArtifactText(
          path,
          ".data/v1/remote-oauth.md",
        );

        expect(problem).toContain(
          "Remote OAuth evidence artifact is missing completed launch checklist item(s)",
        );
        expect(problem).toContain(
          "A real browser authorization-code login was completed against the intended authorization server.",
        );
        expect(problem).toContain(
          "complete the generated OAuth launch checklist",
        );
      },
    );
  });

  it("rejects generated remote OAuth launch evidence without authorization-server discovery proof", () => {
    withTextArtifact(
      [
        "# V1 Remote OAuth Evidence",
        "",
        "## Automated Remote Smoke",
        "",
        "- Auth mode: oauth",
        "- Health status: 200",
        "- Metadata CORS allow-origin: *",
        "- Metadata CORS preflight status: 204",
        "- Metadata CORS preflight allows authorization: yes",
        "- Metadata CORS preflight exposes WWW-Authenticate: yes",
        "- Tool count: 7",
        "",
        "## Required OAuth Launch Checklist",
        "",
        ...completedRemoteOAuthLaunchChecklistLines(),
        "",
        "## Manual OAuth Launch Review",
        "",
        ...completedRemoteOAuthLaunchReviewLines(),
      ].join("\n"),
      (path) => {
        const problem = scanEvidenceArtifactText(
          path,
          ".data/v1/remote-oauth.md",
        );

        expect(problem).toContain(
          "Remote OAuth evidence artifact is missing authorization-server discovery proof(s)",
        );
        expect(problem).toContain("authorization-server discovery URL");
        expect(problem).toContain("PKCE S256 support");
      },
    );
  });

  it("rejects generated remote OAuth launch evidence with missing manual review fields", () => {
    withTextArtifact(
      [
        "# V1 Remote OAuth Evidence",
        "",
        "## Automated Remote Smoke",
        "",
        ...completedRemoteOAuthProofLines(),
        "",
        "## Required OAuth Launch Checklist",
        "",
        ...completedRemoteOAuthLaunchChecklistLines(),
        "",
        "## Manual OAuth Launch Review",
        "",
        "- Evidence artifact: .data/v1/remote-oauth.md",
      ].join("\n"),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/remote-oauth.md")).toBe(
          "Remote OAuth evidence artifact is missing launch review field Authorization server tested: .data/v1/remote-oauth.md.",
        );
      },
    );
  });

  it("rejects remote OAuth launch evidence whose client field is not ChatGPT", () => {
    withTextArtifact(
      remoteOAuthEvidenceWithLaunchReviewOverride(
        "OAuth client tested",
        "MCP Inspector OAuth smoke client",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/remote-oauth.md")).toBe(
          "Remote OAuth OAuth client tested field must name the ChatGPT connector or client used for the launch check: .data/v1/remote-oauth.md.",
        );
      },
    );
  });

  it("rejects remote OAuth launch evidence without browser authorization-code PKCE login", () => {
    withTextArtifact(
      remoteOAuthEvidenceWithLaunchReviewOverride(
        "Browser login result",
        "machine token smoke passed",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/remote-oauth.md")).toBe(
          "Remote OAuth Browser login result field must confirm a real authorization-code + PKCE browser login completed: .data/v1/remote-oauth.md.",
        );
      },
    );
  });

  it("rejects remote OAuth launch evidence without token validation dimensions", () => {
    withTextArtifact(
      remoteOAuthEvidenceWithLaunchReviewOverride(
        "Token validation result",
        "access token accepted",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/remote-oauth.md")).toBe(
          "Remote OAuth Token validation result field must confirm issuer, audience/resource, expiry, and scope checks: .data/v1/remote-oauth.md.",
        );
      },
    );
  });

  it("rejects remote OAuth launch evidence without exact seven-tool review", () => {
    withTextArtifact(
      remoteOAuthEvidenceWithLaunchReviewOverride(
        "Tool-list result",
        "tools were listed",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/remote-oauth.md")).toBe(
          "Remote OAuth Tool-list result field must confirm exactly seven V1 draft-workflow tools were listed: .data/v1/remote-oauth.md.",
        );
      },
    );
  });

  it("rejects remote OAuth launch evidence without V1 draft-workflow tool-list review", () => {
    withTextArtifact(
      remoteOAuthEvidenceWithLaunchReviewOverride(
        "Tool-list result",
        "seven tools listed",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/remote-oauth.md")).toBe(
          "Remote OAuth Tool-list result field must confirm exactly seven V1 draft-workflow tools were listed: .data/v1/remote-oauth.md.",
        );
      },
    );
  });

  it("rejects remote OAuth launch evidence with contradictory tool-count review", () => {
    withTextArtifact(
      remoteOAuthEvidenceWithLaunchReviewOverride(
        "Tool-list result",
        "seven V1 draft-workflow tools listed, but more than seven tools were shown",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/remote-oauth.md")).toBe(
          "Remote OAuth Tool-list result field must confirm exactly seven V1 draft-workflow tools were listed: .data/v1/remote-oauth.md.",
        );
      },
    );
  });

  it("rejects remote OAuth launch evidence without validation call success", () => {
    withTextArtifact(
      remoteOAuthEvidenceWithLaunchReviewOverride(
        "Validation call result",
        "validation was attempted",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/remote-oauth.md")).toBe(
          "Remote OAuth Validation call result field must confirm validate_newsletter_content succeeded: .data/v1/remote-oauth.md.",
        );
      },
    );
  });

  it("rejects remote OAuth launch evidence without preview call success", () => {
    withTextArtifact(
      remoteOAuthEvidenceWithLaunchReviewOverride(
        "Preview call result",
        "preview was attempted",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/remote-oauth.md")).toBe(
          "Remote OAuth Preview call result field must confirm preview_draft succeeded: .data/v1/remote-oauth.md.",
        );
      },
    );
  });

  it("rejects remote OAuth launch evidence without OAuth error-path proof", () => {
    withTextArtifact(
      remoteOAuthEvidenceWithLaunchReviewOverride(
        "Error-path result",
        "happy path only",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/remote-oauth.md")).toBe(
          "Remote OAuth Error-path result field must confirm missing, expired, wrong-audience, or invalid token rejection: .data/v1/remote-oauth.md.",
        );
      },
    );
  });

  it("rejects remote OAuth launch evidence without token redaction review", () => {
    withTextArtifact(
      remoteOAuthEvidenceWithLaunchReviewOverride(
        "Token redaction review",
        "tokens were captured in debug output",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/remote-oauth.md")).toBe(
          "Remote OAuth Token redaction review field must confirm no token, code, credential, or secret value was included, recorded, pasted, exposed, or logged: .data/v1/remote-oauth.md.",
        );
      },
    );
  });

  it("rejects contradictory remote OAuth token redaction review", () => {
    withTextArtifact(
      remoteOAuthEvidenceWithLaunchReviewOverride(
        "Token redaction review",
        "no token or code values were recorded, but OAuth token values were pasted into launch notes",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/remote-oauth.md")).toBe(
          "Remote OAuth Token redaction review field must confirm no token, code, credential, or secret value was included, recorded, pasted, exposed, or logged: .data/v1/remote-oauth.md.",
        );
      },
    );
  });

  it("rejects remote OAuth launch evidence without a launch decision", () => {
    withTextArtifact(
      remoteOAuthEvidenceWithLaunchReviewOverride(
        "Launch decision",
        "decision pending",
      ),
      (path) => {
        expect(scanEvidenceArtifactText(path, ".data/v1/remote-oauth.md")).toBe(
          "Remote OAuth Launch decision field must record whether durable ChatGPT OAuth launch is ready or deferred with a reason/follow-up: .data/v1/remote-oauth.md.",
        );
      },
    );
  });

  it("accepts complete remote OAuth launch evidence with automated proof and manual review", () => {
    withTextArtifact(
      [
        "# V1 Remote OAuth Evidence",
        "",
        "## Automated Remote Smoke",
        "",
        ...completedRemoteOAuthProofLines(),
        "",
        "## Required OAuth Launch Checklist",
        "",
        ...completedRemoteOAuthLaunchChecklistLines(),
        "",
        "## Manual OAuth Launch Review",
        "",
        ...completedRemoteOAuthLaunchReviewLines(),
      ].join("\n"),
      (path) => {
        expect(
          scanEvidenceArtifactText(path, ".data/v1/remote-oauth.md"),
        ).toBeUndefined();
      },
    );
  });
});

function completedGateArtifactText(gateId: number, heading: string): string {
  return [heading, "", ...completedGateDetailLines(gateId), ""].join("\n");
}

function cloudRunRuntimeCheckLines(): readonly string[] {
  return [
    "- [x] env_substack_publication_url",
    "- [x] env_substack_user_id",
    "- [x] env_max_body_bytes",
    "- [x] env_max_image_bytes",
    "- [x] env_substack_request_timeout_ms",
    "- [x] env_confirmation_token_ttl_seconds",
  ];
}

function cloudRunOAuthCheckLines(): readonly string[] {
  return [
    "- [x] env_mcp_public_base_url",
    "- [x] env_oauth_authorization_server_url",
    "- [x] env_oauth_jwks_url",
    "- [x] env_oauth_jwt_algorithms",
  ];
}

function completedCloudRunChecklistLines(gateId: 12 | 13): readonly string[] {
  const shared = [
    "- [x] Exported service JSON came from the intended GCP project, region, and Cloud Run service.",
    "- [x] `cloud-run:verify` completed with all checks passing.",
    "- [x] Evidence was reviewed to confirm no raw Secret Manager values, bearer tokens, or draft contents are included.",
  ];
  if (gateId === 12) {
    return [
      ...shared,
      "- [x] Cloud Run service URL was checked with `/healthz`.",
      "- [x] Remote MCP smoke passed against the deployed service URL.",
    ];
  }

  return [
    ...shared,
    "- [x] Secret Manager references were verified without exposing secret values.",
    "- [x] Service account secret-access bindings were confirmed for the deployed runtime service account.",
  ];
}

function cloudRunLogCheckLines(): readonly string[] {
  return [
    "- [x] log entries present: 2 exported log entries parsed.",
    "- [x] no secret patterns or fields: No leaks were detected.",
    "- [x] no draft content fields: No draft fields were detected.",
    "- [x] audit events metadata only: 1 mcp_audit event uses the allowed metadata field set.",
  ];
}

function completedCloudRunLogChecklistLines(): readonly string[] {
  return [
    "- [x] Logs were exported after live Cloud Run acceptance traffic.",
    "- [x] `cloud-run:logs:verify` completed with required audit events.",
    "- [x] Exported logs contained no cookie, bearer-token, secret-environment, or private MCP path leaks.",
    "- [x] Exported logs contained no draft content or request/response body fields.",
    "- [x] Audit events were metadata-only and used the allowed field set.",
    "- [x] Evidence was reviewed to confirm no raw log entries or secret values are included.",
  ];
}

function completedRemoteOAuthProofLines(): readonly string[] {
  return [
    "- Auth mode: oauth",
    "- Health status: 200",
    "- Metadata CORS allow-origin: *",
    "- Metadata CORS preflight status: 204",
    "- Metadata CORS preflight allows authorization: yes",
    "- Metadata CORS preflight exposes WWW-Authenticate: yes",
    "- Authorization server discovery URL: https://issuer.example.com/.well-known/oauth-authorization-server",
    "- Authorization server discovery type: oauth-authorization-server",
    "- Authorization server issuer: https://issuer.example.com",
    "- Authorization endpoint: https://issuer.example.com/authorize",
    "- Token endpoint: https://issuer.example.com/token",
    "- JWKS URI: https://issuer.example.com/jwks.json",
    "- Authorization grant types: refresh_token, authorization_code",
    "- Authorization response types: code",
    "- PKCE methods: plain, S256",
    "- Tool count: 7",
  ];
}

function completedRemoteOAuthLaunchChecklistLines(): readonly string[] {
  return requiredRemoteOAuthLaunchChecklistLabels().map(
    (label) => `- [x] ${label}`,
  );
}

function completedRemoteOAuthLaunchReviewLines(): readonly string[] {
  return [
    "- Evidence artifact: .data/v1/remote-oauth.md",
    "- Authorization server tested: https://issuer.example.com authorization server issuer and discovery metadata reviewed",
    "- OAuth client tested: ChatGPT connector client registration reviewed",
    "- Browser login result: authorization-code with PKCE browser login completed",
    "- Connector registration result: ChatGPT connector linked and listed tools",
    "- Protected-resource metadata result: protected-resource metadata URL, CORS, and WWW-Authenticate challenge reviewed",
    "- Token validation result: issuer, audience, expiry, and scopes verified",
    "- Tool-list result: seven V1 draft-workflow tools listed",
    "- Validation call result: validate_newsletter_content returned ok",
    "- Preview call result: preview_draft returned a confirmation token",
    "- Error-path result: missing, expired, and wrong-audience tokens were rejected with 401",
    "- Token redaction review: no token or code values recorded",
    "- Launch decision: durable ChatGPT OAuth launch approved and ready for private use",
  ];
}

function remoteOAuthEvidenceWithLaunchReviewOverride(
  field: string,
  value: string,
): string {
  return [
    "# V1 Remote OAuth Evidence",
    "",
    "## Automated Remote Smoke",
    "",
    ...completedRemoteOAuthProofLines(),
    "",
    "## Required OAuth Launch Checklist",
    "",
    ...completedRemoteOAuthLaunchChecklistLines(),
    "",
    "## Manual OAuth Launch Review",
    "",
    ...completedRemoteOAuthLaunchReviewLines().map((line) =>
      line.startsWith(`- ${field}: `) ? `- ${field}: ${value}` : line,
    ),
  ].join("\n");
}

function completedGateDetailLines(gateId: number): readonly string[] {
  return requiredDetailFields(gateId).map(
    (field) => `- ${field}: ${completedGateDetailValue(gateId, field)}`,
  );
}

function gate7EvidenceWithDetailOverride(field: string, value: string): string {
  return [
    "## Gate 7 Manual Review Details",
    "",
    ...completedGateDetailLines(7).map((line) =>
      line.startsWith(`- ${field}: `) ? `- ${field}: ${value}` : line,
    ),
  ].join("\n");
}

function gate8EvidenceWithDetailOverride(field: string, value: string): string {
  return [
    "## Gate 8 Update Review Details",
    "",
    ...completedGateDetailLines(8).map((line) =>
      line.startsWith(`- ${field}: `) ? `- ${field}: ${value}` : line,
    ),
  ].join("\n");
}

function gate9EvidenceWithDetailOverride(field: string, value: string): string {
  return [
    "## Gate 9 Read Review Details",
    "",
    ...completedGateDetailLines(9).map((line) =>
      line.startsWith(`- ${field}: `) ? `- ${field}: ${value}` : line,
    ),
  ].join("\n");
}

function chatGptNgrokEvidenceWithDetailOverride(
  field: string,
  value: string,
): string {
  return [
    "# V1 ChatGPT Ngrok Evidence",
    "",
    "## Automated Remote Smoke",
    "",
    "- Auth mode: noauth",
    "- Health status: 200",
    "- Tool count: 7",
    "",
    "## Required Evidence Checklist",
    "",
    "- [x] Remote endpoint responded on `/healthz`.",
    "- [x] Remote noauth MCP endpoint listed exactly the seven V1 draft-workflow tools.",
    "- [x] `validate_newsletter_content` completed against the rich Markdown fixture.",
    "- [x] `preview_draft` completed without calling Substack or write tools.",
    "",
    "## Manual ChatGPT Connector Acceptance",
    "",
    ...completedGateDetailLines(11).map((line) =>
      line.startsWith(`- ${field}: `) ? `- ${field}: ${value}` : line,
    ),
  ].join("\n");
}

function staticBearerEvidenceWithDetailOverride(
  field: string,
  value: string,
): string {
  return [
    "# V1 Static Bearer Remote Evidence",
    "",
    "## Automated Remote Smoke",
    "",
    "- Auth mode: static_bearer",
    "- Health status: 200",
    "- Missing bearer status: 401",
    "- Wrong bearer status: 401",
    "- Tool count: 7",
    "",
    "## Required Evidence Checklist",
    "",
    "- [x] Missing bearer token was rejected with HTTP 401.",
    "- [x] Wrong bearer token was rejected with HTTP 401.",
    "",
    "## Gate 14 Header-Capable Client Details",
    "",
    ...completedGateDetailLines(14).map((line) =>
      line.startsWith(`- ${field}: `) ? `- ${field}: ${value}` : line,
    ),
  ].join("\n");
}

function gate12EvidenceWithDetailOverride(
  field: string,
  value: string,
): string {
  return [
    "## Gate 12 Deployment Review Details",
    "",
    ...completedGateDetailLines(12).map((line) =>
      line.startsWith(`- ${field}: `) ? `- ${field}: ${value}` : line,
    ),
  ].join("\n");
}

function gate13EvidenceWithDetailOverride(
  field: string,
  value: string,
): string {
  return [
    "## Gate 13 Secret Manager Review Details",
    "",
    ...completedGateDetailLines(13).map((line) =>
      line.startsWith(`- ${field}: `) ? `- ${field}: ${value}` : line,
    ),
  ].join("\n");
}

function stdioEvidenceWithDetailOverride(field: string, value: string): string {
  return [
    "# V1 Stdio Client Evidence",
    "",
    "## Automated Stdio Smoke",
    "",
    "- Transport: stdio",
    "- Tool count: 7",
    "",
    "## Required Evidence Checklist",
    "",
    "- [x] Built stdio entrypoint launched and exposed exactly the seven V1 draft-workflow tools.",
    "- [x] `validate_newsletter_content` completed against the rich Markdown fixture.",
    "- [x] `preview_draft` completed without calling Substack or write tools.",
    "",
    "## Manual Client Acceptance",
    "",
    ...completedGateDetailLines(15).map((line) =>
      line.startsWith(`- ${field}: `) ? `- ${field}: ${value}` : line,
    ),
  ].join("\n");
}

function gate16EvidenceWithDetailOverride(
  field: string,
  value: string,
): string {
  return [
    "## Manual Log Review Details",
    "",
    ...completedGateDetailLines(16).map((line) =>
      line.startsWith(`- ${field}: `) ? `- ${field}: ${value}` : line,
    ),
  ].join("\n");
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

  if (gateId === 8 && field === "Created title before update") {
    return "Original live fixture title";
  }

  if (gateId === 8 && field === "Draft URL or ID") {
    return "https://example.substack.com/p/fixture";
  }

  if (gateId === 8 && field === "Updated title after update") {
    return "Updated live fixture title";
  }

  if (gateId === 8 && field === "Update command") {
    return "RUN_LIVE_SUBSTACK_TESTS=1 npm run test:live";
  }

  if (gateId === 8 && field === "Field update review") {
    return "title and subtitle changed successfully";
  }

  if (gateId === 8 && field === "Unpublished status after update") {
    return "status=draft and is_published=false after update";
  }

  if (gateId === 8 && field === "Post-update `get_draft` review") {
    return "post-update get_draft readback confirmed the updated title";
  }

  if (gateId === 8 && field === "Draft body handling review") {
    return "raw draft body/content omitted from evidence; metadata-only update review recorded";
  }

  if (gateId === 8 && field === "Cleanup decision") {
    return "kept private unpublished draft for further manual review without publishing";
  }

  if (gateId === 9 && field === "Draft URL or ID read") {
    return "https://example.substack.com/p/fixture";
  }

  if (gateId === 9 && field === "`list_drafts` result") {
    return "expected draft appeared in the list and was found in recent drafts";
  }

  if (gateId === 9 && field === "`get_draft` result") {
    return "expected draft metadata was fetched and returned";
  }

  if (gateId === 9 && field === "Metadata fields reviewed") {
    return "id, title, url, and status metadata reviewed";
  }

  if (gateId === 9 && field === "Body inclusion review") {
    return "include_body remained false; metadata-only response reviewed";
  }

  if (gateId === 9 && field === "Post-update readback review") {
    return "post-update get_draft readback confirmed the updated title";
  }

  if (gateId === 9 && field === "Raw body/content handling") {
    return "raw draft body/content omitted from evidence; metadata-only review recorded";
  }

  if (gateId === 9 && field === "Follow-up action") {
    return "no action needed because metadata-only read evidence was recorded and raw draft body content was omitted";
  }

  if (gateId === 11 && field === "ChatGPT surface tested") {
    return "ChatGPT web connector in developer mode";
  }

  if (gateId === 11 && field === "Connector URL") {
    return "https://example.ngrok.app/mcp";
  }

  if (gateId === 11 && field === "Tool-list result") {
    return "exactly seven V1 draft-workflow tools listed through the ChatGPT connector";
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

  if (gateId === 12 && field === "Auth mode deployed") {
    return "static_bearer deployed from cloud-run:verify output with launch rationale recorded";
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
    return "exactly seven V1 draft-workflow tools listed through the header-capable client";
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
    return "exactly seven V1 draft-workflow tools listed through Claude Code";
  }

  if (gateId === 15 && field === "Validation call result") {
    return "validate_newsletter_content succeeded through Claude Code";
  }

  if (gateId === 15 && field === "Credential locality review") {
    return "Substack credentials came from local environment variables and were not recorded, committed, pasted into client config, or exposed remotely";
  }

  if (gateId === 16 && field === "Log export window") {
    return "2026-07-08T12:00Z to 2026-07-08T12:10Z live Cloud Run log query window";
  }

  if (gateId === 16 && field === "Cloud Run service/revision") {
    return "Cloud Run service substack-mcp revision substack-mcp-00001-abc";
  }

  if (gateId === 16 && field === "Live traffic exercised") {
    return "live Cloud Run acceptance traffic exercised through /healthz and MCP smoke";
  }

  if (gateId === 16 && field === "Log export command") {
    return 'gcloud logging read \'resource.type="cloud_run_revision" AND resource.labels.service_name="substack-mcp"\' --format=json > .data/cloud-run-logs.json';
  }

  if (gateId === 16 && field === "Verifier command") {
    return "npm run cloud-run:logs:verify -- --logs-json .data/cloud-run-logs.json --require-audit-events";
  }

  if (gateId === 16 && field === "Audit event review") {
    return "audit events reviewed as metadata-only with allowed field set";
  }

  if (gateId === 16 && field === "Finding review") {
    return "no findings, leaks, or sensitive log issues were reported";
  }

  if (gateId === 16 && field === "Raw log handling") {
    return "raw log export retained locally with restricted access; no raw log entries included or recorded in evidence";
  }

  if (gateId === 16 && field === "Follow-up action") {
    return "no action needed because no findings or leaks were detected";
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
    case 8:
      return [
        "Draft URL or ID",
        "Created title before update",
        "Updated title after update",
        "Update command",
        "Field update review",
        "Unpublished status after update",
        "Post-update `get_draft` review",
        "Draft body handling review",
        "Cleanup decision",
      ];
    case 9:
      return [
        "Draft URL or ID read",
        "`list_drafts` result",
        "`get_draft` result",
        "Metadata fields reviewed",
        "Body inclusion review",
        "Post-update readback review",
        "Raw body/content handling",
        "Follow-up action",
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
    case 12:
      return [
        "GCP project/region/service",
        "Service URL checked",
        "Deploy command source",
        "Health check result",
        "Remote smoke result",
        "Auth mode deployed",
        "Budget guard review",
        "Path-secret review",
      ];
    case 13:
      return [
        "Secret references checked",
        "Required secret names",
        "Runtime service account",
        "Secret access bindings",
        "Version policy",
        "Literal env review",
        "Secret value handling",
        "Rotation follow-up",
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
    case 15:
      return [
        "Client tested",
        "Config path or add command",
        "Server entrypoint path",
        "Tool-list result",
        "Validation call result",
        "Credential locality review",
      ];
    case 16:
      return [
        "Log export window",
        "Cloud Run service/revision",
        "Live traffic exercised",
        "Log export command",
        "Verifier command",
        "Audit event review",
        "Finding review",
        "Raw log handling",
        "Follow-up action",
      ];
    default:
      return [];
  }
}

function withTextArtifact(
  contents: string,
  run: (artifactPath: string) => void,
): void {
  const tempRoot = mkdtempSync(join(tmpdir(), "v1-evidence-safety-"));
  const artifactPath = join(tempRoot, "artifact.md");

  try {
    writeFileSync(artifactPath, contents);
    run(artifactPath);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}
