import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import { buildFixtureInspectCommand } from "../../scripts/fixtureCommandHelpers.js";

const execFileAsync = promisify(execFile);
const projectRoot = resolve(import.meta.dirname, "../..");
const tsxBin = resolve(projectRoot, "node_modules/.bin/tsx");

describe("createFixtureDraft script", () => {
  it("dry-runs fixture conversion without Substack credentials or network", async () => {
    const { stdout, stderr } = await execFileAsync(
      tsxBin,
      [
        "scripts/createFixtureDraft.ts",
        "--dry-run",
        "--no-env-file",
        "--title",
        "Dry run fixture",
        "--subtitle",
        "Script test",
      ],
      {
        cwd: projectRoot,
        env: {
          NODE_ENV: "test",
          PATH: process.env.PATH,
        },
      },
    );

    expect(stderr).toBe("");
    const output = JSON.parse(stdout) as {
      readonly ok: boolean;
      readonly dry_run: boolean;
      readonly title: string;
      readonly subtitle: string;
      readonly image_source: string;
      readonly provenance_review: string;
      readonly stats: {
        readonly images: number;
        readonly code_blocks: number;
        readonly latex_blocks: number;
      };
      readonly payload_debug: {
        readonly draft_body_doc_type: string;
      };
    };

    expect(output).toMatchObject({
      ok: true,
      dry_run: true,
      title: "Dry run fixture",
      subtitle: "Script test",
      image_source: "fixture",
      provenance_review:
        "Dry run only; no live Substack acceptance draft or reusable fixture was created.",
    });
    expect(output.stats).toMatchObject({
      images: 1,
      code_blocks: 1,
      latex_blocks: 1,
    });
    expect(output.payload_debug.draft_body_doc_type).toBe("doc");
  });

  it("dry-runs purpose-built fixture kinds for live capture", async () => {
    const inlineMarks = await runCreateFixture([
      "--dry-run",
      "--no-env-file",
      "--kind",
      "inline-marks",
      "--title",
      "Inline marks fixture",
    ]);
    const image = await runCreateFixture([
      "--dry-run",
      "--no-env-file",
      "--kind",
      "image",
      "--image-url",
      "https://cdn.example.com/fixture.png",
      "--title",
      "Image fixture",
    ]);
    const codeBlock = await runCreateFixture([
      "--dry-run",
      "--no-env-file",
      "--kind",
      "code-block",
      "--title",
      "Code block fixture",
    ]);
    const latexBlock = await runCreateFixture([
      "--dry-run",
      "--no-env-file",
      "--kind",
      "latex-block",
      "--title",
      "LaTeX block fixture",
    ]);

    expect(inlineMarks).toMatchObject({
      ok: true,
      dry_run: true,
      fixture_kind: "inline-marks",
      title: "Inline marks fixture",
      stats: {
        blocks: 1,
        words: 5,
      },
      provenance_review:
        "Dry run only for inline-marks; no live Substack fixture was created or captured.",
    });
    expect(inlineMarks).not.toHaveProperty("fixture_path");
    expect(image).toMatchObject({
      ok: true,
      dry_run: true,
      fixture_kind: "image",
      image_source: "provided-url",
      stats: {
        blocks: 1,
        images: 1,
      },
      provenance_review:
        "Dry run only for image; no live Substack fixture was created or captured.",
    });
    expect(codeBlock).toMatchObject({
      ok: true,
      dry_run: true,
      fixture_kind: "code-block",
      stats: {
        blocks: 1,
        code_blocks: 1,
      },
      provenance_review:
        "Dry run only for code-block; no live Substack fixture was created or captured.",
    });
    expect(latexBlock).toMatchObject({
      ok: true,
      dry_run: true,
      fixture_kind: "latex-block",
      stats: {
        blocks: 1,
        latex_blocks: 1,
      },
      provenance_review:
        "Dry run only for latex-block; no live Substack fixture was created or captured.",
    });
  });

  it("dry-runs the full required live fixture set in one command", async () => {
    const output = await runCreateFixtureSuite([
      "--dry-run",
      "--no-env-file",
      "--kind",
      "all",
      "--fixture-dir",
      "fixtures/live",
      "--title",
      "Fixture suite",
    ]);

    expect(output).toMatchObject({
      ok: true,
      dry_run: true,
      fixture_kind: "all",
      fixture_dir: `${projectRoot}/fixtures/live`,
      gate_7_fixture_provenance_review:
        "Dry run only; no live Substack fixture was created or captured. Run `npm run create:fixture -- --kind all --capture` with live credentials, then copy the emitted per-fixture provenance reviews into the gate 7 evidence artifact.",
    });
    expect(output.fixtures.map((fixture) => fixture.fixture_kind)).toEqual([
      "inline-marks",
      "image",
      "code-block",
      "latex-block",
    ]);
    expect(output.fixtures.map((fixture) => fixture.title)).toEqual([
      "Fixture suite - inline-marks fixture",
      "Fixture suite - image fixture",
      "Fixture suite - code-block fixture",
      "Fixture suite - latex-block fixture",
    ]);
    expect(
      output.fixtures.every(
        (fixture) =>
          fixture.ok &&
          fixture.dry_run &&
          fixture.fixture_path === undefined &&
          fixture.provenance_review.includes("Dry run only"),
      ),
    ).toBe(true);
  });

  it("rejects unknown fixture kinds", async () => {
    await expect(
      execFileAsync(
        tsxBin,
        ["scripts/createFixtureDraft.ts", "--kind", "unknown"],
        {
          cwd: projectRoot,
          env: {
            NODE_ENV: "test",
            PATH: process.env.PATH,
          },
        },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "--kind must be one of: rich, all, inline-marks, image, code-block, latex-block.",
      ),
    });
  });

  it("rejects fixture capture directories outside the project", async () => {
    await expect(
      execFileAsync(
        tsxBin,
        [
          "scripts/createFixtureDraft.ts",
          "--dry-run",
          "--fixture-dir",
          "../outside",
        ],
        {
          cwd: projectRoot,
          env: {
            NODE_ENV: "test",
            PATH: process.env.PATH,
          },
        },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "--fixture-dir must stay inside the project directory.",
      ),
    });
  });

  it("rejects fixture capture modes that cannot write live fixture files", async () => {
    await expect(
      execFileAsync(
        tsxBin,
        [
          "scripts/createFixtureDraft.ts",
          "--kind",
          "all",
          "--capture",
          "--dry-run",
        ],
        {
          cwd: projectRoot,
          env: {
            NODE_ENV: "test",
            PATH: process.env.PATH,
          },
        },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "--capture cannot be used with --dry-run.",
      ),
    });

    await expect(
      execFileAsync(tsxBin, ["scripts/createFixtureDraft.ts", "--capture"], {
        cwd: projectRoot,
        env: {
          NODE_ENV: "test",
          PATH: process.env.PATH,
        },
      }),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining(
        "--capture requires --kind inline-marks, image, code-block, latex-block, or all.",
      ),
    });
  });
});

describe("buildFixtureInspectCommand", () => {
  it("builds default and custom fixture inspection commands", () => {
    expect(
      buildFixtureInspectCommand(
        123,
        "image",
        `${projectRoot}/fixtures/substack`,
        projectRoot,
      ),
    ).toBe("npm run inspect:draft -- 123 --fixture image");
    expect(
      buildFixtureInspectCommand(
        123,
        "image",
        `${projectRoot}/fixtures/live`,
        projectRoot,
      ),
    ).toBe(
      "npm run inspect:draft -- 123 --fixture image --fixture-dir fixtures/live",
    );
    expect(
      buildFixtureInspectCommand(
        123,
        "image",
        `${projectRoot}/fixtures/live captures`,
        projectRoot,
      ),
    ).toBe(
      "npm run inspect:draft -- 123 --fixture image --fixture-dir 'fixtures/live captures'",
    );
    expect(
      buildFixtureInspectCommand(
        123,
        "rich",
        `${projectRoot}/fixtures/live`,
        projectRoot,
      ),
    ).toBe("npm run inspect:draft -- 123");
  });
});

async function runCreateFixture(args: readonly string[]): Promise<{
  readonly ok: boolean;
  readonly dry_run: boolean;
  readonly fixture_kind: string;
  readonly fixture_dir: string;
  readonly fixture_path?: string | undefined;
  readonly title: string;
  readonly image_source: string;
  readonly provenance_review: string;
  readonly stats: {
    readonly blocks: number;
    readonly images: number;
    readonly code_blocks: number;
    readonly latex_blocks: number;
    readonly words: number;
  };
}> {
  const { stdout, stderr } = await execFileAsync(
    tsxBin,
    ["scripts/createFixtureDraft.ts", ...args],
    {
      cwd: projectRoot,
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH,
      },
    },
  );

  expect(stderr).toBe("");
  return JSON.parse(stdout) as {
    readonly ok: boolean;
    readonly dry_run: boolean;
    readonly fixture_kind: string;
    readonly fixture_dir: string;
    readonly fixture_path?: string | undefined;
    readonly title: string;
    readonly image_source: string;
    readonly provenance_review: string;
    readonly stats: {
      readonly blocks: number;
      readonly images: number;
      readonly code_blocks: number;
      readonly latex_blocks: number;
      readonly words: number;
    };
  };
}

async function runCreateFixtureSuite(args: readonly string[]): Promise<{
  readonly ok: boolean;
  readonly dry_run: boolean;
  readonly fixture_kind: "all";
  readonly fixture_dir: string;
  readonly fixtures: ReadonlyArray<{
    readonly ok: boolean;
    readonly dry_run: boolean;
    readonly fixture_kind: string;
    readonly fixture_path?: string | undefined;
    readonly title: string;
    readonly provenance_review: string;
  }>;
  readonly gate_7_fixture_provenance_review: string;
}> {
  const { stdout, stderr } = await execFileAsync(
    tsxBin,
    ["scripts/createFixtureDraft.ts", ...args],
    {
      cwd: projectRoot,
      env: {
        NODE_ENV: "test",
        PATH: process.env.PATH,
      },
    },
  );

  expect(stderr).toBe("");
  return JSON.parse(stdout) as {
    readonly ok: boolean;
    readonly dry_run: boolean;
    readonly fixture_kind: "all";
    readonly fixture_dir: string;
    readonly fixtures: ReadonlyArray<{
      readonly ok: boolean;
      readonly dry_run: boolean;
      readonly fixture_kind: string;
      readonly fixture_path?: string | undefined;
      readonly title: string;
      readonly provenance_review: string;
    }>;
    readonly gate_7_fixture_provenance_review: string;
  };
}
