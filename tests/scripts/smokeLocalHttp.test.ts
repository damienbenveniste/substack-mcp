import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  renderLocalHttpEvidenceArtifact,
  writeLocalHttpEvidenceArtifact,
} from "../../scripts/localHttpEvidence.js";
import {
  DEFAULT_HTTP_ARGS,
  DEFAULT_HTTP_COMMAND,
  DEFAULT_HTTP_HOST,
  DEFAULT_HTTP_MCP_PATH,
  DEFAULT_INSPECTOR_ARGS,
  DEFAULT_INSPECTOR_COMMAND,
  type LocalHttpSmokeResult,
  localHttpUsage,
  parseLocalHttpArgs,
  withPort,
} from "../../scripts/smokeLocalHttpCore.js";

describe("parseLocalHttpArgs", () => {
  it("uses the built HTTP entrypoint and safe smoke env by default", () => {
    const options = parseLocalHttpArgs([], {}, "/repo");

    expect(options).toMatchObject({
      help: false,
      command: DEFAULT_HTTP_COMMAND,
      args: [...DEFAULT_HTTP_ARGS],
      cwd: "/repo",
      artifactRoot: "/repo",
      runInspectorCli: false,
      inspectorCommand: DEFAULT_INSPECTOR_COMMAND,
      inspectorArgs: [...DEFAULT_INSPECTOR_ARGS],
      host: DEFAULT_HTTP_HOST,
      port: 0,
      mcpPath: DEFAULT_HTTP_MCP_PATH,
    });
    if (options.help) {
      throw new Error("Expected runnable local HTTP smoke-test options.");
    }
    expect(options.env).toMatchObject({
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      MCP_TRANSPORT: "http",
      AUTH_MODE: "noauth",
      PORT: "0",
      SUBSTACK_PUBLICATION_URL: "https://example.substack.com",
      SUBSTACK_SESSION_TOKEN: "http-smoke-session-token",
      SUBSTACK_USER_ID: "1",
    });
  });

  it("supports custom command, args, cwd, endpoint, evidence artifact, and environment overrides", () => {
    const options = parseLocalHttpArgs(
      [
        "--command",
        "tsx",
        "--arg",
        "src/http.ts",
        "--arg",
        "--debug",
        "--cwd",
        "/custom",
        "--host",
        "localhost",
        "--port",
        "9876",
        "--mcp-path",
        "/mcp/private",
        "--evidence-artifact",
        ".data/v1/gate-03-mcp-inspector.md",
        "--inspector-cli",
        "--inspector-command",
        "mcp-inspector",
        "--inspector-arg",
        "--no-update-notifier",
        "--env",
        "AUTH_MODE=static_bearer",
        "--env",
        "MCP_BEARER_TOKEN=custom-token",
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
      args: ["src/http.ts", "--debug"],
      cwd: "/custom",
      artifactRoot: "/repo",
      evidenceArtifact: ".data/v1/gate-03-mcp-inspector.md",
      runInspectorCli: true,
      inspectorCommand: "mcp-inspector",
      inspectorArgs: ["--no-update-notifier"],
      host: "localhost",
      port: 9876,
      mcpPath: "/mcp/private",
    });
    if (options.help) {
      throw new Error("Expected runnable local HTTP smoke-test options.");
    }
    expect(options.env.SUBSTACK_PUBLICATION_URL).toBe(
      "https://actual.substack.com",
    );
    expect(options.env.PREVIEW_TOKEN_SECRET).toBe("actual-secret");
    expect(options.env.AUTH_MODE).toBe("static_bearer");
    expect(options.env.MCP_BEARER_TOKEN).toBe("custom-token");
    expect(options.env.MCP_TRANSPORT).toBe("http");
    expect(options.env.PORT).toBe("9876");
  });

  it("replaces the auto port placeholder consistently", () => {
    const options = parseLocalHttpArgs([], {}, "/repo");
    if (options.help) {
      throw new Error("Expected runnable local HTTP smoke-test options.");
    }

    expect(withPort(options, 54321)).toMatchObject({
      port: 54321,
      env: {
        PORT: "54321",
      },
    });
  });

  it("allows help without runnable configuration", () => {
    expect(parseLocalHttpArgs(["--help"], {}, "/repo")).toEqual({
      help: true,
    });
    expect(parseLocalHttpArgs(["-h"], {}, "/repo")).toEqual({
      help: true,
    });
  });

  it("rejects missing values, invalid endpoints, invalid env assignments, and unknown options", () => {
    expect(() => parseLocalHttpArgs(["--command"], {}, "/repo")).toThrow(
      "--command requires a value.",
    );
    expect(() => parseLocalHttpArgs(["--arg"], {}, "/repo")).toThrow(
      "--arg requires a value.",
    );
    expect(() => parseLocalHttpArgs(["--cwd"], {}, "/repo")).toThrow(
      "--cwd requires a value.",
    );
    expect(() => parseLocalHttpArgs(["--host"], {}, "/repo")).toThrow(
      "--host requires a value.",
    );
    expect(() => parseLocalHttpArgs(["--port", "0"], {}, "/repo")).toThrow(
      "--port must be an integer from 1 to 65535.",
    );
    expect(() =>
      parseLocalHttpArgs(["--port", "8787abc"], {}, "/repo"),
    ).toThrow("--port must be an integer from 1 to 65535.");
    expect(() =>
      parseLocalHttpArgs(["--mcp-path", "/not-mcp"], {}, "/repo"),
    ).toThrow("--mcp-path must be /mcp or /mcp/<secret>.");
    expect(() =>
      parseLocalHttpArgs(["--mcp-path", "/mcp/private/nested"], {}, "/repo"),
    ).toThrow("<secret> must be one URL-safe path segment");
    expect(() =>
      parseLocalHttpArgs(["--mcp-path", "/mcp/"], {}, "/repo"),
    ).toThrow("<secret> must be one URL-safe path segment");
    expect(() => parseLocalHttpArgs(["--env"], {}, "/repo")).toThrow(
      "--env requires a value.",
    );
    expect(() =>
      parseLocalHttpArgs(["--evidence-artifact"], {}, "/repo"),
    ).toThrow("--evidence-artifact requires a value.");
    expect(() =>
      parseLocalHttpArgs(["--inspector-command"], {}, "/repo"),
    ).toThrow("--inspector-command requires a value.");
    expect(() => parseLocalHttpArgs(["--inspector-arg"], {}, "/repo")).toThrow(
      "--inspector-arg requires a value.",
    );
    expect(() =>
      parseLocalHttpArgs(["--evidence-artifact", "../outside.md"], {}, "/repo"),
    ).toThrow(
      "local HTTP evidence artifact must stay inside the project directory.",
    );
    expect(() =>
      parseLocalHttpArgs(["--env", "NOT-VALID=value"], {}, "/repo"),
    ).toThrow("Invalid environment variable name: NOT-VALID");
    expect(() =>
      parseLocalHttpArgs(["--env", "MISSING_VALUE"], {}, "/repo"),
    ).toThrow("--env requires NAME=value.");
    expect(() => parseLocalHttpArgs(["--bogus"], {}, "/repo")).toThrow(
      "Unknown option: --bogus",
    );
  });
});

describe("localHttpUsage", () => {
  it("describes the local HTTP smoke command without embedding secrets", () => {
    expect(localHttpUsage()).toContain("npm run smoke:http-local");
    expect(localHttpUsage()).toContain("node dist/http.js");
    expect(localHttpUsage()).toContain("--evidence-artifact");
    expect(localHttpUsage()).toContain("--inspector-cli");
    expect(localHttpUsage()).not.toContain("SUBSTACK_SESSION_TOKEN=");
  });
});

describe("renderLocalHttpEvidenceArtifact", () => {
  it("renders sanitized local HTTP metadata and MCP Inspector checklist", () => {
    const rendered = renderLocalHttpEvidenceArtifact(
      baseLocalHttpSmokeResult,
      "2026-07-08T12:00:00Z",
    );

    expect(rendered).toContain("# V1 MCP Inspector Evidence");
    expect(rendered).toContain("- Transport: http");
    expect(rendered).toContain("- Health status: 200");
    expect(rendered).toContain("- Status: not run");
    expect(rendered).toContain("validate_newsletter_content");
    expect(rendered).toContain(
      "MCP Inspector CLI connected to the local HTTP `/mcp` endpoint.",
    );
    expect(rendered).toContain(
      "npx --yes @modelcontextprotocol/inspector@latest --cli http://localhost:8787/mcp --method tools/list --transport http",
    );
    expect(rendered).toContain(
      "Gate 3 is tracked as repo-local evidence by `npm run v1:status`",
    );
    expect(rendered).not.toContain("npm run v1:record -- --gate 3");
    expect(rendered).not.toContain("draft_body");
    expect(rendered).not.toContain("body_markdown");
    expect(rendered).not.toContain("SUBSTACK_SESSION_TOKEN=");
  });

  it("redacts custom MCP path suffixes", () => {
    const rendered = renderLocalHttpEvidenceArtifact(
      {
        ...baseLocalHttpSmokeResult,
        endpoint: "http://127.0.0.1:8787/mcp/private",
      },
      "2026-07-08T12:00:00Z",
    );

    expect(rendered).toContain("http://127.0.0.1:8787/mcp/<redacted>");
    expect(rendered).not.toContain("/mcp/private");
  });

  it("renders successful Inspector CLI tool-list evidence", () => {
    const rendered = renderLocalHttpEvidenceArtifact(
      {
        ...baseLocalHttpSmokeResult,
        inspector: {
          ok: true,
          command: "npx",
          args: [
            "--yes",
            "@modelcontextprotocol/inspector@latest",
            "--cli",
            "http://127.0.0.1:8787/mcp/private",
            "--method",
            "tools/list",
            "--transport",
            "http",
          ],
          method: "tools/list",
          tool_count: 7,
          tools: baseLocalHttpSmokeResult.tools,
        },
      },
      "2026-07-08T12:00:00Z",
    );

    expect(rendered).toContain("## MCP Inspector CLI");
    expect(rendered).toContain("- Command: npx");
    expect(rendered).toContain("- Method: tools/list");
    expect(rendered).toContain("- Tool count: 7");
    expect(rendered).toContain(
      "- [x] MCP Inspector CLI listed the same seven V1 draft-only tools.",
    );
    expect(rendered).toContain("http://127.0.0.1:8787/mcp/<redacted>");
    expect(rendered).not.toContain("/mcp/private");
  });
});

describe("writeLocalHttpEvidenceArtifact", () => {
  it("writes a project-local artifact", () => {
    withTempProject((cwd) => {
      const result = writeLocalHttpEvidenceArtifact({
        cwd,
        artifact: ".data/v1/gate-03-mcp-inspector.md",
        result: baseLocalHttpSmokeResult,
        verifiedAt: "2026-07-08T12:00:00Z",
      });

      expect(result.artifact).toBe(".data/v1/gate-03-mcp-inspector.md");
      expect(existsSync(result.path)).toBe(true);
      expect(readFileSync(result.path, "utf8")).toContain(
        "V1 MCP Inspector Evidence",
      );
    });
  });

  it("rejects paths outside the project", () => {
    withTempProject((cwd) => {
      expect(() =>
        writeLocalHttpEvidenceArtifact({
          cwd,
          artifact: "../outside.md",
          result: baseLocalHttpSmokeResult,
        }),
      ).toThrow(
        "V1 local HTTP evidence artifact must stay inside the project directory.",
      );
    });
  });

  it("rejects secret-like rendered content before writing", () => {
    withTempProject((cwd) => {
      expect(() =>
        writeLocalHttpEvidenceArtifact({
          cwd,
          artifact: ".data/v1/gate-03-mcp-inspector.md",
          result: {
            ...baseLocalHttpSmokeResult,
            command: "Authorization: Bearer abcdefghijklmnop",
          },
        }),
      ).toThrow(
        "V1 evidence artifact .data/v1/gate-03-mcp-inspector.md contains secret-like content",
      );
    });
  });
});

const baseLocalHttpSmokeResult: LocalHttpSmokeResult = {
  ok: true,
  transport: "http",
  endpoint: "http://127.0.0.1:8787/mcp",
  health: {
    url: "http://127.0.0.1:8787/healthz",
    status: 200,
  },
  command: "node",
  args: ["dist/http.js"],
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
  const cwd = mkdtempSync(join(tmpdir(), "local-http-evidence-"));
  try {
    run(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
