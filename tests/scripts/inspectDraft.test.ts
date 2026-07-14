import { describe, expect, it } from "vitest";

import {
  buildInspectDraftWriteResult,
  buildInspectedDraftOutput,
  inspectDraftUsage,
  outputDirectory,
  parseInspectDraftArgs,
  parseMaybeJson,
  SUBSTACK_FIXTURE_FILES,
} from "../../scripts/inspectDraftCore.js";
import type { SubstackDraft } from "../../src/substack/types.js";

describe("parseInspectDraftArgs", () => {
  const cwd = "/repo/substack-mcp";

  it("parses the positional draft ID with safe defaults", () => {
    expect(parseInspectDraftArgs(["123"], cwd)).toEqual({
      help: false,
      draftId: 123,
      loadEnvFile: true,
      includeRaw: false,
      fixtureOutput: false,
      outputPath: undefined,
    });
  });

  it("supports fixture output and env-file disabling", () => {
    expect(
      parseInspectDraftArgs(
        ["123", "--fixture", "latex-block", "--no-env-file"],
        cwd,
      ),
    ).toEqual({
      help: false,
      draftId: 123,
      loadEnvFile: false,
      includeRaw: false,
      fixtureOutput: true,
      outputPath: `${cwd}/fixtures/substack/${SUBSTACK_FIXTURE_FILES["latex-block"]}`,
    });
  });

  it("supports fixture output in a custom fixture directory", () => {
    expect(
      parseInspectDraftArgs(
        ["123", "--fixture", "image", "--fixture-dir", "fixtures/live"],
        cwd,
      ),
    ).toMatchObject({
      help: false,
      draftId: 123,
      fixtureOutput: true,
      outputPath: `${cwd}/fixtures/live/${SUBSTACK_FIXTURE_FILES.image}`,
    });
  });

  it("supports a project-local output path", () => {
    expect(
      parseInspectDraftArgs(
        ["123", "--output", "fixtures/substack/custom.json"],
        cwd,
      ),
    ).toMatchObject({
      help: false,
      draftId: 123,
      includeRaw: false,
      fixtureOutput: false,
      outputPath: `${cwd}/fixtures/substack/custom.json`,
    });
  });

  it("allows raw response output only under the ignored .data directory", () => {
    expect(
      parseInspectDraftArgs(
        ["123", "--include-raw", "--output", ".data/inspect-draft-123.json"],
        cwd,
      ),
    ).toMatchObject({
      help: false,
      draftId: 123,
      includeRaw: true,
      fixtureOutput: false,
      outputPath: `${cwd}/.data/inspect-draft-123.json`,
    });
  });

  it("allows help without a draft ID", () => {
    expect(parseInspectDraftArgs(["--help"], cwd)).toEqual({
      help: true,
      loadEnvFile: true,
    });
    expect(parseInspectDraftArgs(["--no-env-file", "-h"], cwd)).toEqual({
      help: true,
      loadEnvFile: false,
    });
  });

  it("rejects invalid argument combinations and unsafe output paths", () => {
    expect(() => parseInspectDraftArgs([], cwd)).toThrow(
      "A positive numeric draft ID is required.",
    );
    expect(() => parseInspectDraftArgs(["0"], cwd)).toThrow(
      "A positive numeric draft ID is required.",
    );
    expect(() => parseInspectDraftArgs(["123abc"], cwd)).toThrow(
      "A positive numeric draft ID is required.",
    );
    expect(() => parseInspectDraftArgs(["123", "456"], cwd)).toThrow(
      "Only one draft ID may be provided.",
    );
    expect(() =>
      parseInspectDraftArgs(["123", "--fixture", "unknown"], cwd),
    ).toThrow(
      "--fixture must be one of: inline-marks, image, code-block, latex-block.",
    );
    expect(() =>
      parseInspectDraftArgs(
        ["123", "--fixture", "image", "--output", "fixtures/x.json"],
        cwd,
      ),
    ).toThrow("--output and --fixture cannot be used together.");
    expect(() =>
      parseInspectDraftArgs(
        ["123", "--fixture", "image", "--include-raw"],
        cwd,
      ),
    ).toThrow("--include-raw cannot be used with --fixture");
    expect(() =>
      parseInspectDraftArgs(
        ["123", "--include-raw", "--output", "fixtures/substack/custom.json"],
        cwd,
      ),
    ).toThrow("--include-raw output files must be written under .data/");
    expect(() =>
      parseInspectDraftArgs(
        [
          "123",
          "--output",
          "fixtures/x.json",
          "--fixture-dir",
          "fixtures/live",
        ],
        cwd,
      ),
    ).toThrow("--output and --fixture-dir cannot be used together.");
    expect(() =>
      parseInspectDraftArgs(["123", "--fixture-dir", "fixtures/live"], cwd),
    ).toThrow("--fixture-dir requires --fixture.");
    expect(() =>
      parseInspectDraftArgs(["123", "--output", "../outside.json"], cwd),
    ).toThrow("--output must stay inside the project directory.");
    expect(() =>
      parseInspectDraftArgs(
        ["123", "--fixture", "image", "--fixture-dir", "../outside"],
        cwd,
      ),
    ).toThrow("--fixture-dir must stay inside the project directory.");
    expect(() => parseInspectDraftArgs(["123", "--bogus"], cwd)).toThrow(
      "Unknown option: --bogus",
    );
    expect(() => parseInspectDraftArgs(["123", "--output"], cwd)).toThrow(
      "--output requires a value.",
    );
  });
});

describe("inspect draft output helpers", () => {
  const draft: SubstackDraft = {
    id: 123,
    title: "Fixture",
    subtitle: "Purpose-built draft",
    audience: "everyone",
    draft_body: '{"type":"doc","content":[]}',
    raw: {
      id: 123,
      private_extra: "available only with --include-raw",
    },
  };

  it("parses JSON draft_body and omits raw response by default", () => {
    expect(
      buildInspectedDraftOutput(draft, {
        includeRaw: false,
        fixtureOutput: false,
      }),
    ).toEqual({
      id: 123,
      title: "Fixture",
      subtitle: "Purpose-built draft",
      audience: "everyone",
      draft_body: {
        type: "doc",
        content: [],
      },
    });
  });

  it("includes raw response only when explicitly requested", () => {
    expect(
      buildInspectedDraftOutput(draft, {
        includeRaw: true,
        fixtureOutput: false,
      }),
    ).toEqual({
      id: 123,
      title: "Fixture",
      subtitle: "Purpose-built draft",
      audience: "everyone",
      draft_body: {
        type: "doc",
        content: [],
      },
      raw: draft.raw,
    });
  });

  it("writes fixture captures as parsed draft_body only", () => {
    expect(
      buildInspectedDraftOutput(draft, {
        includeRaw: false,
        fixtureOutput: true,
      }),
    ).toEqual({
      type: "doc",
      content: [],
    });
  });

  it("leaves non-JSON draft_body strings intact", () => {
    expect(parseMaybeJson("not json")).toBe("not json");
  });

  it("returns the output directory for fixture writes", () => {
    expect(
      outputDirectory("/repo/substack-mcp/fixtures/substack/image.json"),
    ).toBe("/repo/substack-mcp/fixtures/substack");
  });

  it("builds a compact write result without draft content", () => {
    expect(
      buildInspectDraftWriteResult({
        draftId: 123,
        outputPath:
          "/repo/substack-mcp/fixtures/substack/image-draft-body.json",
        includeRaw: false,
      }),
    ).toEqual({
      ok: true,
      draft_id: 123,
      output_path: "/repo/substack-mcp/fixtures/substack/image-draft-body.json",
      include_raw: false,
    });
  });

  it("documents fixture capture options", () => {
    expect(inspectDraftUsage()).toContain("--fixture <kind>");
    expect(inspectDraftUsage()).toContain("--fixture-dir <path>");
    expect(inspectDraftUsage()).toContain(
      "Write only the parsed draft_body to fixtures/substack/<expected-file>.",
    );
    expect(inspectDraftUsage()).toContain(
      "--include-raw         Include the full raw Substack response. Only allowed with stdout or --output under .data/, not --fixture.",
    );
  });
});
