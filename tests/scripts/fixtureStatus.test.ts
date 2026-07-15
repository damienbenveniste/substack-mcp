import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  buildFixtureStatus,
  fixtureCompatibilityTestCommand,
  fixtureStatusUsage,
  parseFixtureStatusArgs,
  REQUIRED_SUBSTACK_FIXTURES,
  renderFixtureStatus,
  resolveProjectFixtureDir,
  shouldFailFixtureStatus,
} from "../../scripts/fixtureStatusCore.js";

describe("parseFixtureStatusArgs", () => {
  const cwd = "/repo/substack-mcp";

  it("uses the project fixture directory by default", () => {
    expect(parseFixtureStatusArgs([], cwd)).toEqual({
      help: false,
      fixtureDir: `${cwd}/fixtures/substack`,
      format: "text",
      requireAll: false,
    });
  });

  it("parses custom directory, JSON output, and release-gate mode", () => {
    expect(
      parseFixtureStatusArgs(
        ["--fixture-dir", "fixtures/live", "--json", "--require-all"],
        cwd,
      ),
    ).toEqual({
      help: false,
      fixtureDir: `${cwd}/fixtures/live`,
      format: "json",
      requireAll: true,
    });

    expect(parseFixtureStatusArgs(["--format", "json"], cwd)).toMatchObject({
      format: "json",
    });
  });

  it("allows help without validating other required inputs", () => {
    expect(parseFixtureStatusArgs(["--help"], cwd)).toEqual({ help: true });
    expect(parseFixtureStatusArgs(["-h"], cwd)).toEqual({ help: true });
  });

  it("rejects invalid options", () => {
    expect(() =>
      parseFixtureStatusArgs(["--fixture-dir", "../outside"], cwd),
    ).toThrow("--fixture-dir must stay inside the project directory.");
    expect(() => parseFixtureStatusArgs(["--format", "yaml"], cwd)).toThrow(
      "--format must be one of: text, json.",
    );
    expect(() => parseFixtureStatusArgs(["--format"], cwd)).toThrow(
      "--format requires a value.",
    );
    expect(() => parseFixtureStatusArgs(["--bogus"], cwd)).toThrow(
      "Unknown option: --bogus",
    );
  });
});

describe("resolveProjectFixtureDir", () => {
  const cwd = "/repo/substack-mcp";

  it("accepts only project-local fixture directories", () => {
    expect(resolveProjectFixtureDir(cwd, "fixtures/live")).toBe(
      `${cwd}/fixtures/live`,
    );
    expect(resolveProjectFixtureDir(cwd, `${cwd}/fixtures/live captures`)).toBe(
      `${cwd}/fixtures/live captures`,
    );
    expect(() => resolveProjectFixtureDir(cwd, ".")).toThrow(
      "--fixture-dir must stay inside the project directory.",
    );
    expect(() => resolveProjectFixtureDir(cwd, "/tmp/outside")).toThrow(
      "--fixture-dir must stay inside the project directory.",
    );
    expect(() =>
      resolveProjectFixtureDir(cwd, "../outside", "SUBSTACK_FIXTURE_DIR"),
    ).toThrow("SUBSTACK_FIXTURE_DIR must stay inside the project directory.");
  });
});

describe("buildFixtureStatus", () => {
  it("reports missing fixtures without failing the normal status command", () => {
    withTempFixtureDir((fixtureDir) => {
      const status = buildFixtureStatus({ fixtureDir });

      expect(status).toMatchObject({
        required_count: REQUIRED_SUBSTACK_FIXTURES.length,
        present_count: 0,
        valid_count: 0,
        compatible_count: 0,
        all_present: false,
        all_valid: true,
        all_compatible: true,
        ready: false,
      });
      expect(status.missing).toEqual([
        "inline-marks",
        "image",
        "code-block",
        "latex-block",
      ]);
      expect(status.fixtures[0]?.next_action).toContain(
        "npm run create:fixture -- --kind inline-marks --capture",
      );
      expect(shouldFailFixtureStatus(status, { requireAll: false })).toBe(
        false,
      );
      expect(shouldFailFixtureStatus(status, { requireAll: true })).toBe(true);
    });
  });

  it("keeps custom project-local fixture directories in capture commands", () => {
    const cwd = "/repo/substack-mcp";
    const status = buildFixtureStatus({
      fixtureDir: `${cwd}/fixtures/live`,
      cwd,
    });
    const text = renderFixtureStatus(status, "text");

    expect(status.capture_fixture_dir_arg).toBe("fixtures/live");
    expect(status.fixtures[0]?.next_action).toContain(
      "npm run create:fixture -- --kind inline-marks --capture --fixture-dir fixtures/live",
    );
    expect(status.fixtures[0]?.next_action).toContain(
      "npm run inspect:draft -- <draft_id> --fixture inline-marks --fixture-dir fixtures/live",
    );
    expect(text).toContain(
      "npm run create:fixture -- --kind all --capture --fixture-dir fixtures/live",
    );
    expect(text).toContain(
      "npm run inspect:draft -- <draft_id> --fixture <kind> --fixture-dir fixtures/live",
    );
    expect(text).toContain(
      "npm run fixtures:status -- --fixture-dir fixtures/live --require-all",
    );

    const statusWithSpace = buildFixtureStatus({
      fixtureDir: `${cwd}/fixtures/live captures`,
      cwd,
    });
    expect(statusWithSpace.fixtures[0]?.next_action).toContain(
      "npm run create:fixture -- --kind inline-marks --capture --fixture-dir 'fixtures/live captures'",
    );
    expect(statusWithSpace.fixtures[0]?.next_action).toContain(
      "npm run inspect:draft -- <draft_id> --fixture inline-marks --fixture-dir 'fixtures/live captures'",
    );
  });

  it("renders fixture compatibility test commands for default and custom fixture directories", () => {
    expect(fixtureCompatibilityTestCommand(undefined)).toBe(
      "npm test -- tests/content/substackFixtureCompatibility.test.ts",
    );
    expect(fixtureCompatibilityTestCommand("fixtures/live")).toBe(
      "SUBSTACK_FIXTURE_DIR=fixtures/live npm test -- tests/content/substackFixtureCompatibility.test.ts",
    );
    expect(fixtureCompatibilityTestCommand("fixtures/live captures")).toBe(
      "SUBSTACK_FIXTURE_DIR='fixtures/live captures' npm test -- tests/content/substackFixtureCompatibility.test.ts",
    );
  });

  it("parses direct and compact wrapped Substack draft-body fixtures and checks adapter compatibility", () => {
    withTempFixtureDir((fixtureDir) => {
      writeAllFixtureDocs(fixtureDir);

      const status = buildFixtureStatus({ fixtureDir });

      expect(status).toMatchObject({
        present_count: REQUIRED_SUBSTACK_FIXTURES.length,
        valid_count: REQUIRED_SUBSTACK_FIXTURES.length,
        compatible_count: REQUIRED_SUBSTACK_FIXTURES.length,
        all_present: true,
        all_valid: true,
        all_compatible: true,
        ready: true,
      });
      expect(status.incompatible).toEqual([]);
      expect(renderFixtureStatus(status, "text")).toContain(
        "Adapter compatible: 4/4",
      );
      expect(status.fixtures[0]?.summary?.mark_types).toMatchObject({
        code: 1,
        em: 1,
        link: 1,
        strong: 1,
      });
      expect(status.fixtures[1]?.summary?.image_node_types).toEqual([
        "captionedImage",
        "image2",
      ]);
      expect(status.fixtures[3]?.summary?.latex_candidate_node_types).toEqual([
        "latex_block",
      ]);
      expect(status.fixtures[3]?.compatibility_error).toBeUndefined();
    });
  });

  it("reports alternate inline mark names as valid but adapter-incompatible", () => {
    withTempFixtureDir((fixtureDir) => {
      writeAllFixtureDocs(fixtureDir);
      writeFileSync(
        join(fixtureDir, "inline-marks-draft-body.json"),
        JSON.stringify({
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                { type: "text", text: "Plain " },
                { type: "text", text: "bold", marks: [{ type: "bold" }] },
                { type: "text", text: " " },
                { type: "text", text: "italic", marks: [{ type: "italic" }] },
                { type: "text", text: " " },
                { type: "text", text: "code", marks: [{ type: "code" }] },
                { type: "text", text: " " },
                {
                  type: "text",
                  text: "link",
                  marks: [
                    {
                      type: "link",
                      attrs: { href: "https://example.com" },
                    },
                  ],
                },
              ],
            },
          ],
        }),
      );

      const status = buildFixtureStatus({ fixtureDir });

      expect(status.invalid).toEqual([]);
      expect(status.incompatible).toEqual(["inline-marks"]);
      expect(status.fixtures[0]).toMatchObject({
        kind: "inline-marks",
        valid: true,
        compatible: false,
      });
      expect(status.fixtures[0]?.compatibility_error).toContain(
        "First difference: doc.content[0].content[1].marks[0].type",
      );
      expect(status.fixtures[0]?.compatibility_error).toContain(
        "Adapter summary: top_level_nodes=1; node_types={paragraph:1, text:8}; mark_types={code:1, em:1, link:1, strong:1}",
      );
      expect(status.fixtures[0]?.compatibility_error).toContain(
        "Captured summary: top_level_nodes=1; node_types={paragraph:1, text:8}; mark_types={bold:1, code:1, italic:1, link:1}",
      );
    });
  });

  it("rejects reusable fixture files that include draft metadata", () => {
    withTempFixtureDir((fixtureDir) => {
      writeAllFixtureDocs(fixtureDir);
      writeFileSync(
        join(fixtureDir, "inline-marks-draft-body.json"),
        JSON.stringify({
          id: 123,
          title: "Fixture title",
          subtitle: "Fixture subtitle",
          audience: "everyone",
          draft_body: {
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
                    marks: [
                      {
                        type: "link",
                        attrs: { href: "https://example.com" },
                      },
                    ],
                  },
                ],
              },
            ],
          },
          raw: { private: true },
        }),
      );

      const status = buildFixtureStatus({ fixtureDir });

      expect(status.ready).toBe(false);
      expect(status.invalid).toContain("inline-marks");
      expect(status.fixtures[0]).toMatchObject({
        kind: "inline-marks",
        present: true,
        valid: false,
        compatible: false,
      });
      expect(status.fixtures[0]?.error).toContain(
        "Reusable fixture files must contain only draft_body",
      );
      expect(status.fixtures[0]?.error).toContain(
        "id, title, subtitle, audience, raw",
      );
    });
  });

  it("reports fallback image caption paragraphs as adapter-incompatible", () => {
    withTempFixtureDir((fixtureDir) => {
      writeAllFixtureDocs(fixtureDir);
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
                    alt: "Example alt",
                    title: "Example title",
                    width: 640,
                    height: 360,
                    imageSize: "normal",
                    fullscreen: false,
                    belowTheFold: false,
                  },
                },
              ],
            },
            {
              type: "paragraph",
              content: [{ type: "text", text: "Fallback caption" }],
            },
          ],
        }),
      );

      const status = buildFixtureStatus({ fixtureDir });

      expect(status.fixtures[1]).toMatchObject({
        kind: "image",
        valid: true,
        compatible: false,
      });
      expect(status.incompatible).toEqual(["image"]);
    });
  });

  it("rejects parseable code and LaTeX fixtures that omit the expected samples", () => {
    withTempFixtureDir((fixtureDir) => {
      writeAllFixtureDocs(fixtureDir);
      writeFileSync(
        join(fixtureDir, "code-block-draft-body.json"),
        JSON.stringify({
          type: "doc",
          content: [
            {
              type: "code_block",
              attrs: { lang: "python" },
              content: [{ type: "text", text: "print('wrong')" }],
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
              attrs: { latex: "a^2 + b^2 = c^2" },
            },
          ],
        }),
      );

      const status = buildFixtureStatus({ fixtureDir });

      expect(status.invalid).toEqual(["code-block", "latex-block"]);
      expect(status.fixtures[2]?.error).toContain("expected sample code");
      expect(status.fixtures[3]?.error).toContain("expected sample equation");
    });
  });

  it("treats native image captions as adapter-compatible", () => {
    withTempFixtureDir((fixtureDir) => {
      writeAllFixtureDocs(fixtureDir);
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
                {
                  type: "caption",
                  content: [{ type: "text", text: "Native caption" }],
                },
              ],
            },
          ],
        }),
      );

      const status = buildFixtureStatus({ fixtureDir });

      expect(status.fixtures[1]).toMatchObject({
        kind: "image",
        valid: true,
        compatible: true,
      });
      expect(status.incompatible).toEqual([]);
      expect(renderFixtureStatus(status, "text")).toContain(
        "image: valid and compatible",
      );
    });
  });

  it("reports present but invalid fixture files", () => {
    withTempFixtureDir((fixtureDir) => {
      writeAllFixtureDocs(fixtureDir);
      writeFileSync(join(fixtureDir, "inline-marks-draft-body.json"), "{");
      writeFileSync(
        join(fixtureDir, "image-draft-body.json"),
        JSON.stringify({ draft_body: { type: "paragraph", content: [] } }),
      );
      writeFileSync(
        join(fixtureDir, "latex-block-draft-body.json"),
        '{"draft_body":"not json"}',
      );

      const status = buildFixtureStatus({ fixtureDir });
      const text = renderFixtureStatus(status, "text");

      expect(status.ready).toBe(false);
      expect(status.invalid).toEqual(["inline-marks", "image", "latex-block"]);
      expect(status.fixtures[0]).toMatchObject({
        kind: "inline-marks",
        present: true,
        valid: false,
      });
      expect(status.fixtures[0]?.next_action).toContain(
        "Replace inline-marks-draft-body.json",
      );
      expect(status.fixtures[0]?.error).toContain("Invalid JSON");
      expect(status.fixtures[0]?.compatible).toBe(false);
      expect(status.fixtures[1]).toMatchObject({
        kind: "image",
        present: true,
        valid: false,
      });
      expect(status.fixtures[1]?.error).toContain(
        "Fixture does not contain a Substack draft_body doc.",
      );
      expect(status.fixtures.at(-1)).toMatchObject({
        kind: "latex-block",
        present: true,
        valid: false,
      });
      expect(status.fixtures.at(-1)?.error).toContain(
        "draft_body string is not valid JSON",
      );
      expect(text).toContain("inline-marks: invalid");
    });
  });

  it("rejects parseable fixtures that lack the expected feature shape", () => {
    withTempFixtureDir((fixtureDir) => {
      writeAllFixtureDocs(fixtureDir);
      writeFileSync(
        join(fixtureDir, "inline-marks-draft-body.json"),
        JSON.stringify({
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Plain text only" }],
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
              content: [{ type: "paragraph" }],
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
              type: "paragraph",
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
              type: "code_block",
              attrs: { lang: "latex" },
              content: [{ type: "text", text: "E = mc^2" }],
            },
          ],
        }),
      );

      const status = buildFixtureStatus({ fixtureDir });

      expect(status.ready).toBe(false);
      expect(status.invalid).toEqual([
        "inline-marks",
        "image",
        "code-block",
        "latex-block",
      ]);
      expect(status.fixtures[0]?.error).toContain("bold mark");
      expect(status.fixtures[1]?.error).toContain("string src");
      expect(status.fixtures[2]?.error).toContain("code-like block node");
      expect(status.fixtures[3]?.error).toContain(
        "native LaTeX/equation node candidate",
      );
    });
  });

  it("rejects parseable fixtures when the captured shape no longer round-trips through the adapter", () => {
    withTempFixtureDir((fixtureDir) => {
      writeAllFixtureDocs(fixtureDir);
      writeFileSync(
        join(fixtureDir, "code-block-draft-body.json"),
        JSON.stringify({
          type: "doc",
          content: [
            {
              type: "code_block",
              attrs: { language: "python" },
              content: [{ type: "text", text: "print('hello')" }],
            },
          ],
        }),
      );

      const status = buildFixtureStatus({ fixtureDir });

      expect(status.ready).toBe(false);
      expect(status.invalid).toEqual([]);
      expect(status.incompatible).toEqual(["code-block"]);
      expect(status.fixtures[2]).toMatchObject({
        kind: "code-block",
        valid: true,
        compatible: false,
      });
      expect(status.fixtures[2]?.compatibility_error).toContain(
        "adapter output does not match",
      );
      expect(status.fixtures[2]?.compatibility_error).toContain(
        "First difference: doc.content[0].type",
      );
    });
  });

  it("describes structural type differences without printing captured values", () => {
    const cases: ReadonlyArray<{
      readonly attrs: unknown;
      readonly expected: string;
    }> = [
      {
        attrs: [],
        expected: "doc.content[0].attrs: adapter is object, captured is array",
      },
      {
        attrs: null,
        expected: "doc.content[0].attrs: adapter is object, captured is null",
      },
      {
        attrs: { language: 123, nodeId: "captured-code-id" },
        expected:
          "doc.content[0].attrs.language: adapter string length 6, captured number",
      },
      {
        attrs: { language: true, nodeId: "captured-code-id" },
        expected:
          "doc.content[0].attrs.language: adapter string length 6, captured boolean",
      },
      {
        attrs: { language: null, nodeId: "captured-code-id" },
        expected:
          "doc.content[0].attrs.language: adapter string length 6, captured null",
      },
    ];

    for (const { attrs, expected } of cases) {
      withTempFixtureDir((fixtureDir) => {
        writeAllFixtureDocs(fixtureDir);
        writeFileSync(
          join(fixtureDir, "code-block-draft-body.json"),
          JSON.stringify({
            type: "doc",
            content: [
              {
                type: "highlighted_code_block",
                attrs,
                content: [{ type: "text", text: "print('hello')" }],
              },
            ],
          }),
        );

        const status = buildFixtureStatus({ fixtureDir });
        const error = status.fixtures[2]?.compatibility_error;

        expect(status.fixtures[2]).toMatchObject({
          kind: "code-block",
          valid: true,
          compatible: false,
        });
        expect(error).toContain(expected);
        expect(error).not.toContain("print('hello')");
        expect(error).not.toContain("123");
      });
    }
  });
});

describe("renderFixtureStatus", () => {
  it("renders text and JSON status output", () => {
    withTempFixtureDir((fixtureDir) => {
      const status = buildFixtureStatus({ fixtureDir });
      const text = renderFixtureStatus(status, "text");
      const json = JSON.parse(renderFixtureStatus(status, "json")) as {
        readonly ready: boolean;
        readonly fixtures: readonly unknown[];
      };

      expect(text).toContain("# Substack fixture status");
      expect(text).toContain("inline-marks: missing");
      expect(text).toContain("Next: Run `npm run create:fixture");
      expect(text).toContain("Adapter compatible: 0/4");
      expect(json.ready).toBe(false);
      expect(json.fixtures[0]).toMatchObject({
        next_action: expect.stringContaining(
          "npm run create:fixture -- --kind inline-marks --capture",
        ),
      });
      expect(json.fixtures).toHaveLength(REQUIRED_SUBSTACK_FIXTURES.length);
    });
  });

  it("documents usage", () => {
    expect(fixtureStatusUsage()).toContain("npm run fixtures:status");
    expect(fixtureStatusUsage()).toContain("--fixture-dir fixtures/live");
    expect(fixtureStatusUsage()).toContain("--require-all");
  });
});

function withTempFixtureDir(run: (fixtureDir: string) => void): void {
  const tempRoot = mkdtempSync(join(tmpdir(), "substack-fixtures-"));
  const fixtureDir = resolve(tempRoot, "fixtures", "substack");

  try {
    mkdirSync(fixtureDir, { recursive: true });
    run(fixtureDir);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function writeAllFixtureDocs(fixtureDir: string): void {
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
      draft_body: {
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
      },
    }),
  );
  writeFileSync(
    join(fixtureDir, "code-block-draft-body.json"),
    JSON.stringify({
      draft_body: JSON.stringify({
        type: "doc",
        content: [
          {
            type: "highlighted_code_block",
            attrs: {
              language: "python",
              nodeId: "captured-code-id",
            },
            content: [{ type: "text", text: "print('hello')" }],
          },
        ],
      }),
    }),
  );
  writeFileSync(
    join(fixtureDir, "latex-block-draft-body.json"),
    JSON.stringify({
      draft_body: {
        type: "doc",
        content: [
          {
            type: "latex_block",
            attrs: {
              persistentExpression: "E = mc^2",
              id: "captured-latex-id",
            },
          },
        ],
      },
    }),
  );
}
