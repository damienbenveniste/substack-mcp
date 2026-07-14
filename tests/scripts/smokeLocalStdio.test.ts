import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  renderLocalStdioEvidenceArtifact,
  writeLocalStdioEvidenceArtifact,
} from "../../scripts/localStdioEvidence.js";
import {
  DEFAULT_STDIO_ARGS,
  DEFAULT_STDIO_COMMAND,
  type LocalStdioSmokeResult,
  localStdioUsage,
  parseLocalStdioArgs,
} from "../../scripts/smokeLocalStdioCore.js";

describe("parseLocalStdioArgs", () => {
  it("uses the built stdio entrypoint and safe smoke env by default", () => {
    const options = parseLocalStdioArgs([], {}, "/repo");

    expect(options).toMatchObject({
      help: false,
      command: DEFAULT_STDIO_COMMAND,
      args: [...DEFAULT_STDIO_ARGS],
      cwd: "/repo",
      artifactRoot: "/repo",
    });
    if (options.help) {
      throw new Error("Expected runnable stdio smoke-test options.");
    }
    expect(options.env).toMatchObject({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      MCP_TRANSPORT: "stdio",
      AUTH_MODE: "noauth",
      SUBSTACK_PUBLICATION_URL: "https://example.substack.com",
      SUBSTACK_SESSION_TOKEN: "stdio-smoke-session-token",
      SUBSTACK_USER_ID: "1",
    });
  });

  it("supports custom command, args, cwd, evidence artifact, and environment overrides", () => {
    const options = parseLocalStdioArgs(
      [
        "--command",
        "tsx",
        "--arg",
        "src/stdio.ts",
        "--arg",
        "--debug",
        "--cwd",
        "/custom",
        "--evidence-artifact",
        ".data/v1/gate-15-stdio-client.md",
        "--env",
        "AUTH_MODE=oauth",
        "--env",
        "MCP_PUBLIC_BASE_URL=https://mcp.example.test",
      ],
      {
        SUBSTACK_PUBLICATION_URL: "https://actual.substack.com",
        PREVIEW_TOKEN_SECRET: "actual-secret",
      },
      "/repo",
    );

    expect(options).toMatchObject({
      help: false,
      command: "tsx",
      args: ["src/stdio.ts", "--debug"],
      cwd: "/custom",
      artifactRoot: "/repo",
      evidenceArtifact: ".data/v1/gate-15-stdio-client.md",
    });
    if (options.help) {
      throw new Error("Expected runnable stdio smoke-test options.");
    }
    expect(options.env.SUBSTACK_PUBLICATION_URL).toBe(
      "https://actual.substack.com",
    );
    expect(options.env.PREVIEW_TOKEN_SECRET).toBe("actual-secret");
    expect(options.env.AUTH_MODE).toBe("oauth");
    expect(options.env.MCP_TRANSPORT).toBe("stdio");
    expect(options.env.MCP_PUBLIC_BASE_URL).toBe("https://mcp.example.test");
  });

  it("allows help without runnable configuration", () => {
    expect(parseLocalStdioArgs(["--help"], {}, "/repo")).toEqual({
      help: true,
    });
    expect(parseLocalStdioArgs(["-h"], {}, "/repo")).toEqual({
      help: true,
    });
  });

  it("rejects missing values, invalid env assignments, and unknown options", () => {
    expect(() => parseLocalStdioArgs(["--command"], {}, "/repo")).toThrow(
      "--command requires a value.",
    );
    expect(() => parseLocalStdioArgs(["--arg"], {}, "/repo")).toThrow(
      "--arg requires a value.",
    );
    expect(() => parseLocalStdioArgs(["--cwd"], {}, "/repo")).toThrow(
      "--cwd requires a value.",
    );
    expect(() => parseLocalStdioArgs(["--env"], {}, "/repo")).toThrow(
      "--env requires a value.",
    );
    expect(() =>
      parseLocalStdioArgs(["--evidence-artifact"], {}, "/repo"),
    ).toThrow("--evidence-artifact requires a value.");
    expect(() =>
      parseLocalStdioArgs(
        ["--evidence-artifact", "../outside.md"],
        {},
        "/repo",
      ),
    ).toThrow(
      "stdio evidence artifact must stay inside the project directory.",
    );
    expect(() =>
      parseLocalStdioArgs(["--env", "NOT-VALID=value"], {}, "/repo"),
    ).toThrow("Invalid environment variable name: NOT-VALID");
    expect(() =>
      parseLocalStdioArgs(["--env", "MISSING_VALUE"], {}, "/repo"),
    ).toThrow("--env requires NAME=value.");
    expect(() => parseLocalStdioArgs(["--bogus"], {}, "/repo")).toThrow(
      "Unknown option: --bogus",
    );
  });
});

describe("localStdioUsage", () => {
  it("describes the local stdio smoke command without embedding secrets", () => {
    expect(localStdioUsage()).toContain("npm run smoke:stdio");
    expect(localStdioUsage()).toContain("node dist/stdio.js");
    expect(localStdioUsage()).toContain("--evidence-artifact");
    expect(localStdioUsage()).not.toContain("SUBSTACK_SESSION_TOKEN=");
  });
});

describe("renderLocalStdioEvidenceArtifact", () => {
  it("renders sanitized stdio metadata and the manual client checklist", () => {
    const rendered = renderLocalStdioEvidenceArtifact(
      baseSmokeResult,
      "2026-07-08T12:00:00Z",
    );

    expect(rendered).toContain("# V1 Stdio Client Evidence");
    expect(rendered).toContain("- Transport: stdio");
    expect(rendered).toContain("- Tool count: 7");
    expect(rendered).toContain("validate_newsletter_content");
    expect(rendered).toContain(
      "Built package configured in Claude Code or Cursor through stdio.",
    );
    expect(rendered).toContain("## Manual Client Acceptance");
    expect(rendered).toContain(
      "- Client tested: <replace with Claude Code or Cursor version>",
    );
    expect(rendered).toContain(
      "- Config path or add command: <replace with Claude Code/Cursor stdio config path or add command>",
    );
    expect(rendered).toContain(
      "- Tool-list result: <replace with exact seven V1 draft-only tools listed through Claude Code or Cursor>",
    );
    expect(rendered).toContain(
      "- Validation call result: <replace with validate_newsletter_content success through Claude Code or Cursor>",
    );
    expect(rendered).toContain(
      "- Credential locality review: <replace with confirmation that Substack credentials came from local environment variables and were not recorded, committed, pasted into client config, or exposed remotely>",
    );
    expect(rendered).toContain("npm run v1:record -- --gate 15");
    expect(rendered).not.toContain("draft_body");
    expect(rendered).not.toContain("body_markdown");
    expect(rendered).not.toContain("SUBSTACK_SESSION_TOKEN=");
  });
});

describe("writeLocalStdioEvidenceArtifact", () => {
  it("writes a project-local artifact", () => {
    withTempProject((cwd) => {
      const result = writeLocalStdioEvidenceArtifact({
        cwd,
        artifact: ".data/v1/gate-15-stdio-client.md",
        result: baseSmokeResult,
        verifiedAt: "2026-07-08T12:00:00Z",
      });

      expect(result.artifact).toBe(".data/v1/gate-15-stdio-client.md");
      expect(existsSync(result.path)).toBe(true);
      const artifact = readFileSync(result.path, "utf8");

      expect(artifact).toContain("V1 Stdio Client Evidence");
      expect(artifact).toContain("--artifact .data/v1/gate-15-stdio-client.md");
      expect(artifact).toContain(
        "npm run smoke:stdio -- --evidence-artifact .data/v1/gate-15-stdio-client.md",
      );
      expect(artifact).not.toContain("<this file>");
    });
  });

  it("rejects paths outside the project", () => {
    withTempProject((cwd) => {
      expect(() =>
        writeLocalStdioEvidenceArtifact({
          cwd,
          artifact: "../outside.md",
          result: baseSmokeResult,
        }),
      ).toThrow(
        "V1 stdio evidence artifact must stay inside the project directory.",
      );
    });
  });

  it("rejects secret-like rendered content before writing", () => {
    withTempProject((cwd) => {
      expect(() =>
        writeLocalStdioEvidenceArtifact({
          cwd,
          artifact: ".data/v1/gate-15-stdio-client.md",
          result: {
            ...baseSmokeResult,
            command: "Authorization: Bearer abcdefghijklmnop",
          },
        }),
      ).toThrow(
        "V1 evidence artifact .data/v1/gate-15-stdio-client.md contains secret-like content",
      );
    });
  });
});

const baseSmokeResult: LocalStdioSmokeResult = {
  ok: true,
  transport: "stdio",
  command: "node",
  args: ["dist/stdio.js"],
  tool_count: 7,
  tools: [
    "create_draft",
    "get_draft",
    "list_drafts",
    "preview_draft",
    "update_draft",
    "upload_image",
    "validate_newsletter_content",
  ],
  validation: {
    ok: true,
    fixture: "fixtures/markdown/full-rich-draft.md",
    blocks: 16,
    words: 100,
    images: 1,
    code_blocks: 1,
    latex_blocks: 1,
    links: 1,
    warning_count: 1,
    unsupported_features: ["table"],
  },
  preview: {
    ok: true,
    fixture: "fixtures/markdown/full-rich-draft.md",
    action: "create",
    title: "[MCP SMOKE] Rich Draft Preview",
    blocks: 16,
    words: 100,
    images: 1,
    code_blocks: 1,
    latex_blocks: 1,
    warning_count: 1,
    confirmation_token_parts: 2,
    confirmation_expires_at: "2026-07-08T13:00:00Z",
    preview_text_chars: 500,
    payload_debug_doc_type: "doc",
    payload_debug_top_level_nodes: 16,
  },
};

function withTempProject(run: (cwd: string) => void): void {
  const cwd = mkdtempSync(join(tmpdir(), "stdio-evidence-"));
  try {
    run(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
