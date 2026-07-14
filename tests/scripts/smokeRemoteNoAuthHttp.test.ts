import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  renderRemoteNoAuthEvidenceArtifact,
  writeRemoteNoAuthEvidenceArtifact,
} from "../../scripts/remoteNoAuthEvidence.js";
import {
  isNoAuthHelp,
  noAuthUsage,
  parseNoAuthArgs,
  type RemoteNoAuthSmokeResult,
  redactNoAuthRemoteUrl,
  shouldLoadNoAuthEnvFile,
} from "../../scripts/smokeRemoteNoAuthHttpCore.js";

describe("parseNoAuthArgs", () => {
  it("uses MCP_REMOTE_URL without requiring a bearer token", () => {
    const options = parseNoAuthArgs([], {
      MCP_REMOTE_URL: "https://example.ngrok.app/mcp",
      MCP_BEARER_TOKEN: "ignored",
    });

    expect(options).toMatchObject({
      help: false,
      loadEnvFile: true,
      artifactRoot: process.cwd(),
    });
    if (options.help) {
      throw new Error("Expected runnable noauth smoke-test options.");
    }
    expect(options.url.href).toBe("https://example.ngrok.app/mcp");
  });

  it("supports explicit URL, evidence artifact, and disabling env files", () => {
    const options = parseNoAuthArgs(
      [
        "--url",
        "https://example.com/mcp/private-path",
        "--evidence-artifact",
        ".data/v1/gate-11-chatgpt-ngrok.md",
        "--no-env-file",
      ],
      {
        MCP_REMOTE_URL: "https://ignored.example/mcp",
      },
      "/repo",
    );

    expect(options).toMatchObject({
      help: false,
      loadEnvFile: false,
      artifactRoot: "/repo",
      evidenceArtifact: ".data/v1/gate-11-chatgpt-ngrok.md",
    });
    if (options.help) {
      throw new Error("Expected runnable noauth smoke-test options.");
    }
    expect(options.url.href).toBe("https://example.com/mcp/private-path");
  });

  it("rejects missing URL, wrong URL shape, missing option values, and unknown options", () => {
    expect(() => parseNoAuthArgs([], {})).toThrow(
      "MCP_REMOTE_URL or --url is required.",
    );
    expect(() =>
      parseNoAuthArgs(["--url", "ftp://example.com/mcp"], {}),
    ).toThrow("Remote MCP URL must use https.");
    expect(() =>
      parseNoAuthArgs(["--url", "http://example.com/mcp"], {}),
    ).toThrow("Remote MCP URL must use https.");
    expect(() =>
      parseNoAuthArgs(["--url", "https://user:pass@example.com/mcp"], {}),
    ).toThrow("Remote MCP URL must not include username or password.");
    expect(() =>
      parseNoAuthArgs(["--url", "https://example.com/not-mcp"], {}),
    ).toThrow("Remote MCP URL path must be /mcp or /mcp/<secret>.");
    expect(() =>
      parseNoAuthArgs(["--url", "https://example.com/mcp/private/nested"], {}),
    ).toThrow("<secret> must be one URL-safe path segment");
    expect(() => parseNoAuthArgs(["--url"], {})).toThrow(
      "--url requires a value.",
    );
    expect(() => parseNoAuthArgs(["--evidence-artifact"], {})).toThrow(
      "--evidence-artifact requires a value.",
    );
    expect(() =>
      parseNoAuthArgs(
        [
          "--url",
          "https://example.com/mcp",
          "--evidence-artifact",
          "../outside.md",
        ],
        {},
        "/repo",
      ),
    ).toThrow(
      "remote noauth evidence artifact must stay inside the project directory.",
    );
    expect(() => parseNoAuthArgs(["--bogus"], {})).toThrow(
      "Unknown option: --bogus",
    );
  });

  it("allows help without URL configuration", () => {
    expect(parseNoAuthArgs(["--help"], {})).toEqual({
      help: true,
      loadEnvFile: true,
    });
    expect(parseNoAuthArgs(["--no-env-file", "-h"], {})).toEqual({
      help: true,
      loadEnvFile: false,
    });
  });
});

describe("remote noauth helpers", () => {
  it("redacts custom MCP path suffixes from output", () => {
    expect(redactNoAuthRemoteUrl(new URL("https://example.com/mcp"))).toBe(
      "https://example.com/mcp",
    );
    expect(
      redactNoAuthRemoteUrl(new URL("https://example.com/mcp/private")),
    ).toBe("https://example.com/mcp/<redacted>");
  });

  it("detects help and env-loading flags", () => {
    expect(isNoAuthHelp(["--help"])).toBe(true);
    expect(isNoAuthHelp(["-h"])).toBe(true);
    expect(isNoAuthHelp([])).toBe(false);
    expect(shouldLoadNoAuthEnvFile([])).toBe(true);
    expect(shouldLoadNoAuthEnvFile(["--no-env-file"])).toBe(false);
  });

  it("describes noauth remote smoke without asking for bearer tokens", () => {
    expect(noAuthUsage()).toContain("npm run smoke:remote-noauth");
    expect(noAuthUsage()).toContain("AUTH_MODE=noauth");
    expect(noAuthUsage()).toContain("checks /healthz");
    expect(noAuthUsage()).toContain("--evidence-artifact");
    expect(noAuthUsage()).not.toContain("MCP_BEARER_TOKEN");
  });
});

describe("renderRemoteNoAuthEvidenceArtifact", () => {
  it("renders sanitized remote smoke metadata and ChatGPT checklist", () => {
    const rendered = renderRemoteNoAuthEvidenceArtifact(
      baseNoAuthSmokeResult,
      "2026-07-08T12:00:00Z",
    );

    expect(rendered).toContain("# V1 ChatGPT Ngrok Evidence");
    expect(rendered).toContain("- Auth mode: noauth");
    expect(rendered).toContain("- Health status: 200");
    expect(rendered).toContain("validate_newsletter_content");
    expect(rendered).toContain(
      "ChatGPT connector was registered with the same HTTPS `/mcp` endpoint.",
    );
    expect(rendered).toContain("## Manual ChatGPT Connector Acceptance");
    expect(rendered).toContain(
      "- Connector URL: <replace with public HTTPS /mcp URL or screenshot reference>",
    );
    expect(rendered).toContain(
      "- ChatGPT surface tested: <replace with workspace/account or connector screen reference>",
    );
    expect(rendered).toContain(
      "- Tool-list result: <replace with exactly seven V1 draft-only tools listed through the ChatGPT connector>",
    );
    expect(rendered).toContain(
      "- Manual flow result: <replace with ChatGPT validate/preview/create draft summary>",
    );
    expect(rendered).toContain(
      "- Draft or review reference: <replace with non-sensitive Substack draft URL, numeric draft ID, screenshot reference, or manual review reference>",
    );
    expect(rendered).toContain(
      "- Tunnel exposure window: <replace with bounded start/end time or numeric duration>",
    );
    expect(rendered).toContain(
      "- Unexpected traffic review: <replace with checked ngrok/local logs and no unexpected traffic or handled findings>",
    );
    expect(rendered).toContain(
      "- Rotation decision: <replace with rotated/stopped/not rotated plus reason>",
    );
    expect(rendered).toContain("npm run v1:record -- --gate 11");
    expect(rendered).not.toContain("draft_body");
    expect(rendered).not.toContain("body_markdown");
    expect(rendered).not.toContain("SUBSTACK_SESSION_TOKEN=");
  });
});

describe("writeRemoteNoAuthEvidenceArtifact", () => {
  it("writes a project-local artifact", () => {
    withTempProject((cwd) => {
      const result = writeRemoteNoAuthEvidenceArtifact({
        cwd,
        artifact: ".data/v1/gate-11-chatgpt-ngrok.md",
        result: baseNoAuthSmokeResult,
        verifiedAt: "2026-07-08T12:00:00Z",
      });

      expect(result.artifact).toBe(".data/v1/gate-11-chatgpt-ngrok.md");
      expect(existsSync(result.path)).toBe(true);
      const artifact = readFileSync(result.path, "utf8");

      expect(artifact).toContain("V1 ChatGPT Ngrok Evidence");
      expect(artifact).toContain(
        "--artifact .data/v1/gate-11-chatgpt-ngrok.md",
      );
      expect(artifact).toContain(
        "npm run smoke:remote-noauth -- --url https://example.ngrok.app/mcp",
      );
      expect(artifact).not.toContain("<this file>");
      expect(artifact).not.toContain("<https://host/mcp>");
    });
  });

  it("rejects paths outside the project", () => {
    withTempProject((cwd) => {
      expect(() =>
        writeRemoteNoAuthEvidenceArtifact({
          cwd,
          artifact: "../outside.md",
          result: baseNoAuthSmokeResult,
        }),
      ).toThrow(
        "V1 remote noauth evidence artifact must stay inside the project directory.",
      );
    });
  });

  it("rejects secret-like rendered content before writing", () => {
    withTempProject((cwd) => {
      expect(() =>
        writeRemoteNoAuthEvidenceArtifact({
          cwd,
          artifact: ".data/v1/gate-11-chatgpt-ngrok.md",
          result: {
            ...baseNoAuthSmokeResult,
            endpoint:
              "https://example.com/mcp Authorization: Bearer abcdefghijklmnop",
          },
        }),
      ).toThrow(
        "V1 evidence artifact .data/v1/gate-11-chatgpt-ngrok.md contains secret-like content",
      );
    });
  });
});

const baseNoAuthSmokeResult: RemoteNoAuthSmokeResult = {
  ok: true,
  auth_mode: "noauth",
  endpoint: "https://example.ngrok.app/mcp",
  health: {
    url: "https://example.ngrok.app/healthz",
    status: 200,
  },
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
  const cwd = mkdtempSync(join(tmpdir(), "remote-noauth-evidence-"));
  try {
    run(cwd);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
